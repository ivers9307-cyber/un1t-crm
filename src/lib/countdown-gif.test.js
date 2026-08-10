import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import {
  remainingParts, pad2, frameDigits, layoutFor, renderFrame, buildCountdownGif, COLOURS,
} from './countdown-gif'

describe('remainingParts', () => {
  it('splits a remainder into h/m/s', () => {
    expect(remainingParts((5 * 3600 + 9 * 60 + 38) * 1000)).toEqual({
      hours: 5, minutes: 9, seconds: 38, expired: false,
    })
  })
  it('clamps to zero and flags expired at or past the deadline', () => {
    expect(remainingParts(0)).toEqual({ hours: 0, minutes: 0, seconds: 0, expired: true })
    expect(remainingParts(-60_000)).toEqual({ hours: 0, minutes: 0, seconds: 0, expired: true })
    expect(remainingParts(undefined)).toEqual({ hours: 0, minutes: 0, seconds: 0, expired: true })
  })
  it('saturates hours at 99 so six digits always fit', () => {
    expect(remainingParts(500 * 3600 * 1000).hours).toBe(99)
  })
  it('rolls minutes/seconds rather than exceeding 59', () => {
    const p = remainingParts((3600 + 59 * 60 + 59) * 1000)
    expect(p).toEqual({ hours: 1, minutes: 59, seconds: 59, expired: false })
  })
})

describe('pad2', () => {
  it('zero-pads to two digits', () => {
    expect(pad2(0)).toBe('00')
    expect(pad2(7)).toBe('07')
    expect(pad2(42)).toBe('42')
  })
})

describe('frameDigits', () => {
  it('renders HH:MM:SS for the requested frame offset', () => {
    const ms = (5 * 3600 + 0 * 60 + 3) * 1000
    expect(frameDigits(ms, 0)).toBe('05:00:03')
    expect(frameDigits(ms, 3)).toBe('05:00:00')
  })
  it('never counts below zero once the deadline passes mid-animation', () => {
    expect(frameDigits(2000, 30)).toBe('00:00:00')
  })
})

describe('layoutFor', () => {
  it('lays out 6 digit cells and 2 colon cells in HH:MM:SS order', () => {
    const L = layoutFor()
    expect(L.cells.map((c) => c.kind).join('')).toBe('ddcddcdd')
    expect(L.width).toBe(600)
    expect(L.height).toBe(190)
  })
  it('cells never overlap and stay inside the canvas', () => {
    const L = layoutFor()
    for (let i = 1; i < L.cells.length; i++) {
      expect(L.cells[i].x).toBeGreaterThanOrEqual(L.cells[i - 1].x + L.cells[i - 1].w)
    }
    const last = L.cells[L.cells.length - 1]
    expect(last.x + last.w).toBeLessThanOrEqual(L.width)
  })
})

// Count lit (on-colour) pixels — a proxy for "which segments are drawn".
function litPixels(buf) {
  let n = 0
  for (let o = 0; o < buf.length; o += 3) {
    if (buf[o] === COLOURS.on[0] && buf[o + 1] === COLOURS.on[1] && buf[o + 2] === COLOURS.on[2]) n++
  }
  return n
}

describe('renderFrame', () => {
  const L = layoutFor()

  it('produces a full-canvas RGB buffer', () => {
    expect(renderFrame('00:00:00', L)).toHaveLength(L.width * L.height * 3)
  })

  it('lights more pixels for 8 (all segments) than for 1 (two segments)', () => {
    expect(litPixels(renderFrame('88:88:88', L))).toBeGreaterThan(litPixels(renderFrame('11:11:11', L)))
  })

  it('distinguishes every digit — no two glyphs render identically', () => {
    const seen = new Map()
    for (let d = 0; d <= 9; d++) {
      const key = renderFrame(`${d}${d}:${d}${d}:${d}${d}`, L).toString('base64')
      expect(seen.has(key)).toBe(false)
      seen.set(key, d)
    }
    expect(seen.size).toBe(10)
  })

  it('draws on a black ground (corner pixel is background)', () => {
    const buf = renderFrame('12:34:56', L)
    expect([buf[0], buf[1], buf[2]]).toEqual(COLOURS.bg)
  })
})

describe('buildCountdownGif', () => {
  it('encodes an animated GIF (GIF89a magic) for a live countdown', async () => {
    const gif = await buildCountdownGif({ msLeft: 5 * 3600e3, frames: 3 })
    expect(gif.subarray(0, 6).toString('latin1')).toBe('GIF89a')
    expect(gif.length).toBeGreaterThan(100)
  })

  // THE test that matters: a mis-set pageHeight still produces a valid GIF of
  // the right byte-size — it is just one tall motionless frame. Magic bytes
  // and length cannot tell the two apart; page count can.
  it('genuinely ANIMATES — one page per frame, each the canvas height', async () => {
    const L = layoutFor()
    const gif = await buildCountdownGif({ msLeft: 5 * 3600e3, frames: 5, layout: L })
    const meta = await sharp(gif, { animated: true }).metadata()
    expect(meta.pages).toBe(5)
    expect(meta.pageHeight).toBe(L.height)
    expect(meta.width).toBe(L.width)
  })

  // A scalar `delay` reaches only frame 1; the rest get 0 and flash past, so
  // the clock ticks once and stops. EVERY frame must hold for one second.
  it('holds every frame for one second, not just the first', async () => {
    const gif = await buildCountdownGif({ msLeft: 5 * 3600e3, frames: 6 })
    const { delay } = await sharp(gif, { animated: true }).metadata()
    expect(delay).toHaveLength(6)
    expect(delay.every((d) => d === 1000)).toBe(true)
  })

  it('collapses to a single frame once expired', async () => {
    const many = await buildCountdownGif({ msLeft: 5 * 3600e3, frames: 30 })
    const expired = await buildCountdownGif({ msLeft: 0, frames: 30 })
    expect(expired.length).toBeLessThan(many.length)
    expect(expired.subarray(0, 6).toString('latin1')).toBe('GIF89a')
    expect((await sharp(expired, { animated: true }).metadata()).pages).toBe(1)
  })
})
