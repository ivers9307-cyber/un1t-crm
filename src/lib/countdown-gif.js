// countdown-gif.js — server-rendered ticking countdown as an animated GIF,
// for EMAIL (COUNTDOWN.1). Email clients run no JavaScript, so a live timer
// has to be an image the server re-renders on every open.
//
// Why raw pixels and not SVG/text: libvips renders SVG text through
// fontconfig, and the fonts present in a serverless runtime are not
// guaranteed — a missing face silently changes or drops the glyphs. The
// digits here are drawn as 7-segment rectangles into a raw RGB buffer, so
// output is byte-deterministic everywhere. The HOURS/MINUTES/SECONDS labels
// deliberately live in the email's HTML instead: real text, styleable, and
// still readable when images are blocked.
//
// The GIF plays ONCE and freezes on its last frame (loop: 1). Looping would
// snap the clock back up to +60s, which reads as broken.

import sharp from 'sharp'

// Segment layout per digit — A top, B upper-right, C lower-right, D bottom,
// E lower-left, F upper-left, G middle.
const SEGMENTS = Object.freeze({
  0: 'ABCDEF', 1: 'BC', 2: 'ABGED', 3: 'ABGCD', 4: 'FGBC',
  5: 'AFGCD', 6: 'AFGECD', 7: 'ABC', 8: 'ABCDEFG', 9: 'ABCDFG',
})

export const COLOURS = Object.freeze({
  bg: [0, 0, 0],
  on: [239, 68, 68],   // #ef4444 — the sale red, same as the site countdown
  off: [38, 16, 16],   // faint unlit segment; makes it read as a real display
})

/**
 * Split a millisecond remainder into clamped display parts. Never negative;
 * hours saturate at 99 so the layout can't overflow its six digits.
 */
export function remainingParts(msLeft) {
  const ms = Number.isFinite(msLeft) && msLeft > 0 ? msLeft : 0
  const total = Math.floor(ms / 1000)
  return {
    hours: Math.min(99, Math.floor(total / 3600)),
    minutes: Math.floor(total / 60) % 60,
    seconds: total % 60,
    expired: ms <= 0,
  }
}

/** Zero-padded two-digit string. */
export function pad2(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0')
}

/** "HH:MM:SS" for the frame at `secondsElapsed` into the animation. */
export function frameDigits(msLeft, secondsElapsed = 0) {
  const p = remainingParts(msLeft - secondsElapsed * 1000)
  return `${pad2(p.hours)}:${pad2(p.minutes)}:${pad2(p.seconds)}`
}

// ── geometry ──────────────────────────────────────────────────────────────
export function layoutFor({ digitW = 70, digitH = 120, thickness = 14, gap = 10, colonW = 24, padX = 31, padY = 35 } = {}) {
  const cells = []
  let x = padX
  const order = ['d', 'd', 'c', 'd', 'd', 'c', 'd', 'd']
  for (const kind of order) {
    const w = kind === 'd' ? digitW : colonW
    cells.push({ kind, x, w })
    x += w + gap
  }
  const width = x - gap + padX
  const height = digitH + padY * 2
  return { cells, width, height, digitW, digitH, thickness, padY }
}

function fillRect(buf, W, H, x, y, w, h, rgb) {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y))
  const x1 = Math.min(W, Math.round(x + w)), y1 = Math.min(H, Math.round(y + h))
  for (let py = y0; py < y1; py++) {
    let o = (py * W + x0) * 3
    for (let px = x0; px < x1; px++) {
      buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]
      o += 3
    }
  }
}

function drawDigit(buf, W, H, char, x, y, L) {
  const { digitW: w, digitH: h, thickness: t } = L
  const half = (h - 3 * t) / 2
  const lit = SEGMENTS[char] || ''
  const seg = {
    A: [x + t, y, w - 2 * t, t],
    B: [x + w - t, y + t, t, half],
    C: [x + w - t, y + (h + t) / 2, t, half],
    D: [x + t, y + h - t, w - 2 * t, t],
    E: [x, y + (h + t) / 2, t, half],
    F: [x, y + t, t, half],
    G: [x + t, y + (h - t) / 2, w - 2 * t, t],
  }
  for (const [name, r] of Object.entries(seg)) {
    fillRect(buf, W, H, r[0], r[1], r[2], r[3], lit.includes(name) ? COLOURS.on : COLOURS.off)
  }
}

function drawColon(buf, W, H, x, w, y, L) {
  const { digitH: h, thickness: t } = L
  const cx = x + (w - t) / 2 // centre the dots in the colon cell
  fillRect(buf, W, H, cx, y + h / 3 - t / 2, t, t, COLOURS.on)
  fillRect(buf, W, H, cx, y + (2 * h) / 3 - t / 2, t, t, COLOURS.on)
}

/** Render one "HH:MM:SS" frame into a fresh raw RGB buffer. */
export function renderFrame(text, L) {
  const { width: W, height: H, padY: y } = L
  const buf = Buffer.alloc(W * H * 3)
  for (let i = 0; i < W * H; i++) {
    const o = i * 3
    buf[o] = COLOURS.bg[0]; buf[o + 1] = COLOURS.bg[1]; buf[o + 2] = COLOURS.bg[2]
  }
  const chars = text.split('')
  L.cells.forEach((cell, i) => {
    const ch = chars[i]
    if (cell.kind === 'c') drawColon(buf, W, H, cell.x, cell.w, y, L)
    else drawDigit(buf, W, H, ch, cell.x, y, L)
  })
  return buf
}

/**
 * Encode the animated countdown.
 *
 * @param {number} msLeft   milliseconds remaining at request time
 * @param {number} frames   how many 1-second frames to render
 * @returns {Promise<Buffer>} image/gif
 */
export async function buildCountdownGif({ msLeft, frames = 60, layout } = {}) {
  const L = layout || layoutFor()
  const { width: W, height: H } = L
  const count = remainingParts(msLeft).expired ? 1 : Math.max(1, frames)

  const stacked = Buffer.alloc(W * H * 3 * count)
  for (let f = 0; f < count; f++) {
    renderFrame(frameDigits(msLeft, f), L).copy(stacked, f * W * H * 3)
  }

  // pageHeight MUST live inside the `raw` options — passing it as a sibling
  // of `raw` is silently accepted and yields ONE tall static frame instead of
  // an animation (it encodes, it's a valid GIF, it just doesn't move). Assert
  // page count in tests, never just the magic bytes.
  return sharp(stacked, { raw: { width: W, height: H * count, channels: 3, pageHeight: H } })
    .gif({ loop: 1, delay: 1000, colours: 8 })
    .toBuffer()
}
