// @vitest-environment jsdom
//
// HEROVIDEO.1 / HEROHEADER.1 — the coach video's framing and its sound
// default. jsdom has no media playback (HTMLMediaElement.play is "not
// implemented"), so play() is stubbed per test to answer like a browser that
// allows, refuses, or answers-but-stalls autoplay with sound, and currentTime
// is driven by hand. The fake clock moves INSIDE act() (CLAUDE.md).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import CampaignHero, { heroFocusClass, PLAYBACK_CHECK_MS, HERO_SCRIM_ALPHA, HERO_SCRIM_FADE, HERO_WORDS_SCRIM_CLS } from './CampaignHero'

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

// FUNNELPREVIEW.1 — the words stay legible whatever the footage shows behind
// them (a burned-in handle, captions, a white wall). jsdom lays nothing out,
// so this pins the two things that make it true: the scrim is on the words'
// own box at EVERY width (no breakpoint prefix), and its black is strong
// enough for the faintest line over the brightest possible frame.
describe('CampaignHero words scrim', () => {
  const srgb = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = (grey) => srgb(grey) // r = g = b
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  // White at `alpha` over the backdrop `under` (both 0-1 greys, sRGB blending as CSS does it).
  const over = (alpha, under) => alpha * 1 + (1 - alpha) * under

  it('sits behind the eyebrow, heading and sub-copy at every width, fading out over the top padding', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    const { container } = render(<CampaignHero videoUrl={VIDEO} eyebrow="The 50+ Club" heading="Strong at 60" subhead="Coach-led." />)
    const words = container.querySelector('[data-hero-words]')
    const classes = words.className.split(/\s+/)
    // Unprefixed: a `sm:` or `lg:` scrim would leave the other widths bare.
    expect(classes).toContain(HERO_WORDS_SCRIM_CLS)
    expect(HERO_WORDS_SCRIM_CLS).toContain(`rgb(0_0_0/${HERO_SCRIM_ALPHA})_calc(100%-${HERO_SCRIM_FADE})`)
    expect(HERO_WORDS_SCRIM_CLS).toContain('to_top')
    // The fade zone is top padding (4rem = pt-16) at every width, so no line of text sits in it.
    expect(HERO_SCRIM_FADE).toBe('4rem')
    expect(classes).toContain('pt-16')
    expect(classes.some((c) => /^(sm|md|lg|xl):(p|pt|py)-/.test(c)), 'a breakpoint must not shrink the fade zone').toBe(false)
    // All three lines are inside the scrimmed box.
    for (const t of ['The 50+ Club', 'Strong at 60', 'Coach-led.']) expect(words.textContent).toContain(t)
    // The phone box is no taller than before: same minimum, same paddings.
    expect(container.querySelector('[data-hero-media]').className).toContain('min-h-[240px]')
    expect(classes).toEqual(expect.arrayContaining(['px-5', 'pb-5']))
  })

  it('keeps every line above WCAG AA (4.5:1) over pure white footage', () => {
    const backdrop = over(0, 1) * (1 - HERO_SCRIM_ALPHA) // white footage seen through the scrim
    for (const [line, alpha] of [['heading (white)', 1], ['sub-copy (white/85)', 0.85], ['eyebrow (white/75)', 0.75]]) {
      const contrast = ratio(luminance(over(alpha, backdrop)), luminance(backdrop))
      expect(contrast, line).toBeGreaterThan(4.5)
    }
    // The weakest line clears AAA for body text too.
    expect(ratio(luminance(over(0.75, backdrop)), luminance(backdrop))).toBeGreaterThan(7)
  })

  it('the text opacities the contrast sum assumes are the ones rendered', () => {
    const { container } = render(<CampaignHero posterUrl="https://cdn/p.jpg" eyebrow="E" heading="H" subhead="S" />)
    const words = container.querySelector('[data-hero-words]')
    expect(words.querySelector('h1').className).not.toMatch(/text-white\//)
    expect(words.querySelector('p').className).toContain('text-white/85')
    expect(words.querySelector('div').className).toContain('text-white/75')
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

describe('CampaignHero layout on phones (MOBILEFUNNEL.1)', () => {
  it('clamps the single column so a sideways-scrolling day strip cannot widen the page', () => {
    const { container } = render(<CampaignHero heading="H" offer={<div />} />)
    const grid = container.querySelector('[data-hero-media]').parentElement
    expect(grid.className).toContain('grid-cols-[minmax(0,1fr)]')
    expect(grid.className).toContain('lg:grid-cols-[1.3fr_1fr]')
  })
})
