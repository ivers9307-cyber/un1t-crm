// @vitest-environment jsdom
//
// HEROVIDEO.1 — the coach video's framing and its sound default. jsdom has no
// media playback (HTMLMediaElement.play is "not implemented"), so play() is
// stubbed per test to answer like a browser that allows or refuses autoplay
// with sound.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import CampaignHero, { heroFocusClass } from './CampaignHero'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const VIDEO = 'https://cdn/pages/p1/coach.mp4'
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

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
  it('sound on: asks to play unmuted and keeps the sound when the browser allows it', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    const { container } = render(<CampaignHero videoUrl={VIDEO} heading="H" />)
    const video = container.querySelector('video')
    await flush()
    expect(play).toHaveBeenCalled()
    expect(video.muted).toBe(false)
    expect(screen.getByRole('button', { name: /Sound on/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('sound on: falls back to muted autoplay with the Tap for sound button when the browser refuses', async () => {
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
    // The visitor's tap still unmutes.
    fireEvent.click(button)
    expect(video.muted).toBe(false)
    expect(screen.getByRole('button', { name: /Sound on/ })).toBeTruthy()
  })

  it('start muted: never asks for sound, renders muted with the Tap for sound button', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    const { container } = render(<CampaignHero videoUrl={VIDEO} heading="H" soundDefault="muted" />)
    await flush()
    expect(container.querySelector('video').muted).toBe(true)
    expect(play).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Tap for sound/ }).getAttribute('aria-pressed')).toBe('false')
  })
})
