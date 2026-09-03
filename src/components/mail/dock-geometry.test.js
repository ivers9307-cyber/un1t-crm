// MAILFIX-DOCK.1 — the width-term equality pin, and the derivation of every
// dock geometry constant from the shell's own numbers.
//
// The dock width vocabulary lives in SEVERAL class strings across two files,
// and they are full Tailwind literals ON PURPOSE — Tailwind's scanner cannot
// see an interpolated class, so the strings cannot be built from one shared
// constant. The last width change (MAIL-DOCK.3) edited every site by hand;
// the audit's MEDIUM is that the next one can half-land silently. This test
// regex-extracts the terms from the exported class maps and pins every
// agreement the geometry rests on, so a literal changed in one place and not
// its partners fails HERE, in words, before any card renders wrong.
//
// TWO FRAMES. MailDock is `md:absolute` inside the pane shell's `relative`
// (MailSurface's shellClasses), so its `%` and its `right-` resolve against
// the PANE's padding box. ComposeDock renders at fragment level with no
// positioned ancestor up to the root, so its `vw` and `right-` resolve
// against the VIEWPORT. The pane's right-4 edge sits 41px inside the
// viewport's (24 hub pad + 1 shell border + 16) against a compose card's 16,
// and every compose-side constant carries that difference explicitly — which
// is why the constants below are DERIVED, not frozen: a frozen 672 would let
// "360 → 400 at every bar site" pass while clipping the shifted bar by 40px.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CONTAINER as READER } from './MailDock.jsx'
import { DOCK_BY_READER, MIN_BY_READER } from './ComposeDock.jsx'

// ── The shell numbers every compose-side constant is derived from ─────────
const SIDEBAR_PX = 224      // Sidebar.jsx `md:w-56`
const HUB_PAD_PX = 48       // CommsShell.jsx `p-6` — 24 each side
const MARGIN_PX = 16        // the cards' right-4, mirrored as a left margin
const GAP_PX = 32           // the visual gap between a bar and the card beside it
const SHELL_BORDER_PX = 1   // shellClasses `border` — the padding box is 1px in
const REM_PX = 16
const MD_PX = 768           // Tailwind's md breakpoint — the narrowest dock window

// The reader's right-4 edge vs the compose card's, both measured from the
// viewport's right edge: 41 vs 16.
const READER_EDGE_INSET_PX = HUB_PAD_PX / 2 + SHELL_BORDER_PX + MARGIN_PX
const FRAME_OFFSET_PX = READER_EDGE_INSET_PX - MARGIN_PX

const HERE = path.dirname(fileURLToPath(import.meta.url))
const source = (rel) => readFileSync(path.resolve(HERE, rel), 'utf8')

// ── Extraction (null on a miss — the FIRST test names every miss) ─────────

// The arbitrary value of one Tailwind utility: arb(cls, 'md:w-') →
// 'min(1120px,calc(100%-2rem))'. Arbitrary values never contain ']'.
function arb(cls, prefix) {
  const start = cls.indexOf(`${prefix}[`)
  if (start < 0) return null
  const from = start + prefix.length + 1
  return cls.slice(from, cls.indexOf(']', from))
}

// The innermost min(<N>px,calc(…)) width term and its px cap.
function minTerm(value) {
  const m = value?.match(/min\((\d+)px,calc\([^()]+\)\)/)
  return m ? { term: m[0], cap: Number(m[1]) } : null
}

// The `<N>px` a viewport term subtracts: calc(100vw-672px) → 672. Matched
// non-anchored so it is found inside an outer min(…) too.
function vwFallbackPx(value) {
  const m = value?.match(/calc\(100vw-(\d+)px\)/)
  return m ? Number(m[1]) : null
}

// The leading `calc(<R>rem+` step of an offset, in px: calc(1.5rem+…) → 24.
// Matched non-anchored so it is found inside an outer min(…) too.
function stepPx(value) {
  const m = value?.match(/calc\((\d+(?:\.\d+)?)rem\+/)
  return m ? Number(m[1]) * REM_PX : null
}

// A fixed-length step: calc(4.5rem+1120px) → 1120.
function stepFixedPx(value) {
  const m = value?.match(/calc\(\d+(?:\.\d+)?rem\+(\d+)px\)/)
  return m ? Number(m[1]) : null
}

const g = {}

beforeAll(() => {
  g.readerCardWidth = minTerm(arb(READER.dock, 'md:w-'))
  g.readerBarWidth = minTerm(arb(READER.min, 'md:w-'))
  g.shiftedBarWidth = minTerm(arb(READER.minShifted, 'md:w-'))
  g.shiftedBarOffsetRaw = arb(READER.minShifted, 'md:right-')
  g.shiftedBarOffset = minTerm(g.shiftedBarOffsetRaw)
  g.readerStepPx = stepPx(g.shiftedBarOffsetRaw)

  g.composeFreeWidth = minTerm(arb(DOCK_BY_READER.none, 'md:w-'))
  g.composeReservedWidth = minTerm(arb(DOCK_BY_READER.bar, 'md:w-'))

  g.composeBarWidths = ['none', 'bar', 'card'].map(k => minTerm(arb(MIN_BY_READER[k], 'md:w-')))
  g.stepOverBarRaw = arb(MIN_BY_READER.bar, 'md:right-')
  g.stepOverBarPx = stepPx(g.stepOverBarRaw)
  g.stepOverBarCapPx = stepFixedPx(g.stepOverBarRaw)
  g.stepOverBarClampPx = vwFallbackPx(g.stepOverBarRaw)
  g.stepOverCardRaw = arb(MIN_BY_READER.card, 'md:right-')
  g.stepOverCardPx = stepPx(g.stepOverCardRaw)
  g.stepOverCardCapPx = stepFixedPx(g.stepOverCardRaw)
  g.stepOverCardClampPx = vwFallbackPx(g.stepOverCardRaw)
})

describe('dock geometry — the width terms that must agree (MAILFIX-DOCK.1)', () => {
  it('every width and offset literal parses into the shared vocabulary', () => {
    // A malformed literal fails HERE, by name, rather than as a null
    // dereference three tests down.
    const parsed = {
      'MailDock.dock width': g.readerCardWidth,
      'MailDock.min width': g.readerBarWidth,
      'MailDock.minShifted width': g.shiftedBarWidth,
      'MailDock.minShifted offset term': g.shiftedBarOffset,
      'MailDock.minShifted rem step': g.readerStepPx,
      'ComposeDock DOCK_BY_READER.none width': g.composeFreeWidth,
      'ComposeDock DOCK_BY_READER.bar width': g.composeReservedWidth,
      'ComposeDock MIN_BY_READER.none width': g.composeBarWidths[0],
      'ComposeDock MIN_BY_READER.bar width': g.composeBarWidths[1],
      'ComposeDock MIN_BY_READER.card width': g.composeBarWidths[2],
      'ComposeDock MIN_BY_READER.bar rem step': g.stepOverBarPx,
      'ComposeDock MIN_BY_READER.bar fixed step cap': g.stepOverBarCapPx,
      'ComposeDock MIN_BY_READER.bar clamp': g.stepOverBarClampPx,
      'ComposeDock MIN_BY_READER.card rem step': g.stepOverCardPx,
      'ComposeDock MIN_BY_READER.card fixed step cap': g.stepOverCardCapPx,
      'ComposeDock MIN_BY_READER.card clamp': g.stepOverCardClampPx,
    }
    for (const [name, value] of Object.entries(parsed)) {
      expect(value, name).not.toBeNull()
      expect(value, name).not.toBeUndefined()
    }
  })

  it('the reader’s shifted-bar offset steps by the COMPOSE card’s RESERVED width term, exactly', () => {
    // This equality is the off-canvas fix itself: offset = 1.5rem + the width
    // of what is actually beside the bar. Same expression, same branch of the
    // min() at every viewport, so the geometric proof in ComposeDock's
    // DOCK_BY_READER comment holds at every width. The reserved term is the
    // ONLY compose width the bar ever sits beside (a compose card with no
    // reader parked has no shifted bar to agree with).
    expect(g.shiftedBarOffset.term).toBe(g.composeReservedWidth.term)
  })

  it('one 1120px cap across the reader card, both compose cards, and both steps', () => {
    for (const [name, cap] of [
      ['ComposeDock free-corner card', g.composeFreeWidth.cap],
      ['ComposeDock reserved card', g.composeReservedWidth.cap],
      ['MailDock shifted-bar offset', g.shiftedBarOffset.cap],
      ['ComposeDock step over the reader card', g.stepOverCardCapPx],
    ]) {
      expect(cap, name).toBe(g.readerCardWidth.cap)
    }
  })

  it('one 360px cap across every minimised-bar WIDTH and the bar-over-bar step', () => {
    for (const site of [g.shiftedBarWidth, ...g.composeBarWidths]) {
      expect(site.cap).toBe(g.readerBarWidth.cap)
    }
    // The bar-over-bar step is no longer a width-shaped min(360px,calc(…))
    // — it is min(calc(4.5rem+360px),calc(100vw-624px)), the card step's
    // shape — so its 360 lives in the FIXED step, and is the same cap.
    expect(g.stepOverBarCapPx).toBe(g.readerBarWidth.cap)
  })

  it('the RESERVED compose width is derived: sidebar + hub pad + step + bar cap + margin', () => {
    // 672 today. Frozen, "make the bar 400 wide" would pass every equality
    // above while the shifted bar overran the pane by 40px.
    expect(vwFallbackPx(g.composeReservedWidth.term)).toBe(
      SIDEBAR_PX + HUB_PAD_PX + g.readerStepPx + g.readerBarWidth.cap + MARGIN_PX,
    )
  })

  it('the FREE-CORNER compose width is derived: sidebar + hub pad + margin', () => {
    // 288 today: the card fills the pane like the reader card and never
    // touches the sidebar.
    expect(vwFallbackPx(g.composeFreeWidth.term)).toBe(SIDEBAR_PX + HUB_PAD_PX + MARGIN_PX)
  })

  it('the compose bar beside the reader BAR is min(step, clamp) too — floored at the PANE’s left margin', () => {
    // right-[min(calc(4.5rem+360px),calc(100vw-624px))]. The UNCLAMPED
    // calc(4.5rem+360px) is a constant 432px offset, so the bar's left edge
    // is 100vw − 792: under the sidebar's 224 below 1,016px and past the
    // viewport's own left edge below 792px, painting a parked draft over
    // the sidebar's account/Sign-out footer. Same clamp, same constant, and
    // derived from the same named numbers as the card step's below.
    expect(g.stepOverBarRaw.startsWith('min(')).toBe(true)
    expect(g.stepOverBarClampPx).toBe(SIDEBAR_PX + HUB_PAD_PX / 2 + MARGIN_PX + g.readerBarWidth.cap)
    // Floored left edge = clamp − bar cap = the pane's left margin, 264 —
    // right of the sidebar, and never past the viewport's 0.
    const flooredLeftPx = g.stepOverBarClampPx - g.readerBarWidth.cap
    expect(flooredLeftPx).toBe(SIDEBAR_PX + HUB_PAD_PX / 2 + MARGIN_PX)
    expect(flooredLeftPx).toBeGreaterThan(SIDEBAR_PX)
  })

  it('the accepted cost of that clamp is pinned: the two parked bars overlap below ~1,025px', () => {
    // The reader's own parked bar is pane-anchored at right-4, so its left
    // edge is 100vw − 41 − 360. The clamped compose bar's right edge floors
    // at 624. They overlap while 100vw − 401 < 624, i.e. below 1,025px.
    expect(g.stepOverBarClampPx + READER_EDGE_INSET_PX + g.readerBarWidth.cap).toBe(1025)
    // Both keep their right-end controls: at the md edge the compose bar is
    // [264, 624] on top and the reader's [367, 727], showing its right 103.
    // Strictly better than the unclamped step, which covered Sign-out.
    expect(MD_PX - READER_EDGE_INSET_PX - g.stepOverBarClampPx).toBe(103)
  })

  it('the compose bar beside the reader CARD is min(step, clamp), clamp derived to the PANE’s left margin', () => {
    // right-[min(calc(4.5rem+1120px),calc(100vw-624px))]. `min(` — a min→max
    // inversion would park the bar off-viewport and previously died only on
    // an exact-string pin elsewhere. The clamp floors the bar at the pane's
    // left margin (viewport-x 264), never the viewport's, which put a parked
    // draft over the sidebar's footer.
    expect(g.stepOverCardRaw.startsWith('min(')).toBe(true)
    expect(g.stepOverCardClampPx).toBe(SIDEBAR_PX + HUB_PAD_PX / 2 + MARGIN_PX + g.readerBarWidth.cap)
  })

  it('two frames, two step constants: 1.5rem reader-side, 4.5rem compose-side, equal gaps within the borders', () => {
    // The reader's bar steps in the PANE frame; the compose bar steps in the
    // VIEWPORT frame, whose right-4 edge is FRAME_OFFSET_PX (25) further
    // right. Each step lands its bar GAP_PX from the card beside it once the
    // frame difference is carried — so the two constants differ, and must.
    expect(g.readerStepPx).toBe(1.5 * REM_PX)
    expect(g.stepOverBarPx).toBe(4.5 * REM_PX)
    expect(g.stepOverCardPx).toBe(g.stepOverBarPx)
    expect(g.stepOverBarPx).toBe(HUB_PAD_PX / 2 + MARGIN_PX + GAP_PX)
    // Reader-side gap: (compose card left) − (shifted bar right)
    //   = (100vw − 16 − C) − (100vw − 25 − step − C) = step + 25 − 16.
    const readerSideGap = g.readerStepPx + FRAME_OFFSET_PX - MARGIN_PX
    // Compose-side gap: (reader bar left) − (compose bar right)
    //   = (100vw − 41 − 360) − (100vw − step − 360) = step − 41.
    const composeSideGap = g.stepOverBarPx - READER_EDGE_INSET_PX
    expect(Math.abs(readerSideGap - composeSideGap)).toBeLessThanOrEqual(2 * SHELL_BORDER_PX)
    expect(Math.abs(readerSideGap - GAP_PX)).toBeLessThanOrEqual(SHELL_BORDER_PX)
  })

  it('the md-edge consequence of the reservation is known: a 96px compose card at 768px', () => {
    // The reserved term is the price of keeping the parked reader bar inside
    // the pane; at the md edge that price is a 96px card (960 → 288, 1024 →
    // 352). Accepted and documented at DOCK_BY_READER — ⤢ full is the path
    // below ~1,000px — and pinned so the next change to the reservation
    // meets this edge in a test rather than on an iPad.
    expect(MD_PX - vwFallbackPx(g.composeReservedWidth.term)).toBe(96)
  })

  it('the pane-clamped widths use %, the viewport-anchored terms use vw', () => {
    // The unit IS the geometry: a % on ComposeDock would silently mean the
    // viewport, a vw on MailDock would silently overflow the pane again.
    for (const site of [g.readerCardWidth, g.readerBarWidth, g.shiftedBarWidth]) {
      expect(site.term).toContain('100%')
      expect(site.term).not.toContain('100vw')
    }
    for (const term of [
      g.composeFreeWidth.term,
      g.composeReservedWidth.term,
      g.shiftedBarOffset.term,
      ...g.composeBarWidths.map(w => w.term),
      g.stepOverBarRaw,  // carries the clamp's 100vw
      g.stepOverCardRaw, // carries the clamp's 100vw
    ]) {
      expect(term).toContain('100vw')
      expect(term).not.toContain('100%')
    }
    // BOTH compose-bar steps are min(fixed length, viewport clamp) — the
    // fixed branch carries no 100vw at all, so exactly one each. The card
    // step's old 100vw inner branch was dead and is gone; the bar step's
    // was live and is what parked the bar over the sidebar.
    expect(g.stepOverBarRaw.match(/100vw/g)).toHaveLength(1)
    expect(g.stepOverCardRaw.match(/100vw/g)).toHaveLength(1)
  })

  it('the shell numbers the constants derive from are still what the shell says', () => {
    // A sidebar or hub-padding change invalidates every compose-side
    // constant; a shell that stops being `relative` silently turns
    // MailDock's % into the viewport. Each is pinned to its source.
    expect(source('../Sidebar.jsx')).toMatch(/\bmd:w-56\b/)
    expect(source('../communications/CommsShell.jsx')).toMatch(/'p-6'/)
    const surface = source('./MailSurface.jsx')
    expect(surface).toMatch(/const shellClasses =\s*'relative flex flex-col [^']*\bborder\b[^']*\boverflow-hidden\b/)
  })
})
