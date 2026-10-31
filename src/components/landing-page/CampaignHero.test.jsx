// @vitest-environment jsdom
//
// HEROVIDEO.1 / HEROHEADER.1 — the coach video's framing and its sound
// default. jsdom has no media playback (HTMLMediaElement.play is "not
// implemented"), so play() is stubbed per test to answer like a browser that
// allows, refuses, or answers-but-stalls autoplay with sound, and currentTime
// is driven by hand. The fake clock moves INSIDE act() (CLAUDE.md).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import CampaignHero, { heroFocusClass, PLAYBACK_CHECK_MS } from './CampaignHero'

const VIDEO = 'https://cdn/pages/p1/coach.mp4'
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const tick = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

// A clip that advances while it "plays": currentTime grows on every read.
function advancingClock(video) {
  let t = 0
  Object.defineProperty(video, 'currentTime', { configurable: true, get: () => { t += 0.5; return t }, set: (v) => { t = v } })
}
function stalledClock(video) {
  Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 0.02, set: () => {} })
}
const notPaused = (video) => Object.defineProperty(video, 'paused', { configurable: true, get: () => false })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('heroFocusClass', () => {
  it('maps the three framings to literal object-position classes, unknown to top', () => {
    expect(heroFocusClass('top')).toBe('object-top')
    expect(heroFocusClass('center')).toBe('object-center')
    expect(heroFocusClass('bottom')).toBe('object-bottom')
    expect(heroFocusClass(undefined)).toBe('object-top')
    expect(heroFocusClass('left')).toBe('object-top')
  })
})

describe('CampaignHero framing', () => {
  it('frames the video from the top by default and honours the operator\'s choice', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    const { container, rerender } = render(<CampaignHero videoUrl={VIDEO} heading="H" />)
    expect(container.querySelector('video').className).toContain('object-top')
    rerender(<CampaignHero videoUrl={VIDEO} heading="H" videoFocus="center" />)
    expect(container.querySelector('video').className).toContain('object-center')
  })

  it('frames the poster the same way when there is no video', () => {
    const { container } = render(<CampaignHero posterUrl="https://cdn/p.jpg" heading="H" videoFocus="bottom" />)
    expect(container.querySelector('img').className).toContain('object-bottom')
    expect(container.querySelector('video')).toBeNull()
  })
})

describe('CampaignHero sound', () => {
  it('sound on: plays unmuted and keeps the sound when the clip is seen to advance', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    const { container } = render(<CampaignHero videoUrl={VIDEO} heading="H" />)
    const video = container.querySelector('video')
    advancingClock(video); notPaused(video)
    await flush()
    await tick(PLAYBACK_CHECK_MS + 100)
    expect(play).toHaveBeenCalledTimes(1)
    expect(video.muted).toBe(false)
    expect(screen.getByRole('button', { name: /Sound on/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('sound on: a refusal falls back to muted autoplay with the Tap for sound button, and the tap unmutes', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () {
      return this.muted ? Promise.resolve() : Promise.reject(new DOMException('autoplay', 'NotAllowedError'))
    })
    const { container } = render(<CampaignHero videoUrl={VIDEO} heading="H" soundLabel="Tap for sound" />)
    const video = container.querySelector('video')
    await flush()
    expect(video.muted).toBe(true)
    expect(play).toHaveBeenCalledTimes(2) // unmuted attempt, then the muted fallback
    const button = screen.getByRole('button', { name: /Tap for sound/ })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(video.muted).toBe(false)
    expect(screen.getByRole('button', { name: /Sound on/ })).toBeTruthy()
  })

  it('sound on: a browser that answers play() but never advances is a stall, and falls back to muted', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    const { container } = render(<CampaignHero videoUrl={VIDEO} heading="H" soundLabel="Tap for sound" />)
    const video = container.querySelector('video')
    stalledClock(video); notPaused(video)
    await flush()
    expect(video.muted).toBe(false) // still trying
    await tick(PLAYBACK_CHECK_MS + 100)
    expect(video.muted).toBe(true)
    expect(play).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /Tap for sound/ })).toBeTruthy()
  })

  it('after a forced fallback, the first tap anywhere on the page unmutes; a tap on the button itself only toggles', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () {
      return this.muted ? Promise.resolve() : Promise.reject(new DOMException('autoplay', 'NotAllowedError'))
    })
    const { container } = render(<CampaignHero videoUrl={VIDEO} heading="H" soundLabel="Tap for sound"><p>card</p></CampaignHero>)
    const video = container.querySelector('video')
    await flush()
    expect(video.muted).toBe(true)
    // A tap on the booking card.
    await act(async () => { fireEvent.pointerDown(screen.getByText('card')) })
    expect(video.muted).toBe(false)
    expect(screen.getByRole('button', { name: /Sound on/ })).toBeTruthy()
    // The visitor mutes with the button: a later tap elsewhere leaves it muted.
    const button = screen.getByRole('button', { name: /Sound on/ })
    await act(async () => { fireEvent.pointerDown(button); fireEvent.click(button) })
    expect(video.muted).toBe(true)
    await act(async () => { fireEvent.pointerDown(screen.getByText('card')) })
    expect(video.muted).toBe(true)
    expect(screen.getByRole('button', { name: /Tap for sound/ })).toBeTruthy()
  })

  it('start muted: never asks for sound, renders muted with the Tap for sound button, and no gesture unmutes', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    const { container } = render(<CampaignHero videoUrl={VIDEO} heading="H" soundDefault="muted"><p>card</p></CampaignHero>)
    await flush()
    const video = container.querySelector('video')
    expect(video.muted).toBe(true)
    expect(play).not.toHaveBeenCalled()
    await act(async () => { fireEvent.pointerDown(screen.getByText('card')) })
    expect(video.muted).toBe(true)
    expect(screen.getByRole('button', { name: /Tap for sound/ }).getAttribute('aria-pressed')).toBe('false')
  })
})
