// MAIL-ARCH.2 — the dock width LITERALS, pinned as strings.
//
// dock-geometry.test.js proves the width terms AGREE with each other and are
// DERIVED from the shell's numbers — it is a relational check, and by design
// it would pass a coordinated change of every site (the reader card and the
// compose cards all moving to 1000px together). This file is the other half:
// the exact Tailwind utility each site must carry, so a change to the approved
// widths (Richard, 2 Sep: 1120 "twice the width"; the 360 bar; the 288/672
// viewport reservations) is a deliberate edit to THESE constants in the same
// PR, never a drive-by in one class string. The literals stay full Tailwind
// utilities in the components because Tailwind's scanner cannot see an
// interpolated class — that is why they cannot simply be built from one
// constant, and why a test has to hold the line instead.
import { describe, it, expect } from 'vitest'
import { CONTAINER as READER } from './MailDock.jsx'
import { DOCK_BY_READER, MIN_BY_READER } from './ComposeDock.jsx'

// ── The pinned vocabulary ────────────────────────────────────────────────────
// Pane frame (MailDock is md:absolute inside the pane shell: % and right-4
// resolve against the pane's padding box).
const READER_CARD_WIDTH = 'md:w-[min(1120px,calc(100%-2rem))]'
const READER_BAR_WIDTH = 'md:w-[min(360px,calc(100%-2rem))]'
const READER_BAR_SHIFTED_OFFSET = 'md:right-[calc(1.5rem+min(1120px,calc(100vw-672px)))]'
// Viewport frame (ComposeDock renders at fragment level: vw and right-4
// resolve against the viewport).
const COMPOSE_CARD_FREE_WIDTH = 'md:w-[min(1120px,calc(100vw-288px))]'
const COMPOSE_CARD_RESERVED_WIDTH = 'md:w-[min(1120px,calc(100vw-672px))]'
const COMPOSE_BAR_WIDTH = 'md:w-[min(360px,calc(100vw-2rem))]'
const COMPOSE_BAR_OVER_READER_BAR_OFFSET = 'md:right-[min(calc(4.5rem+360px),calc(100vw-624px))]'
const COMPOSE_BAR_OVER_READER_CARD_OFFSET = 'md:right-[min(calc(4.5rem+1120px),calc(100vw-624px))]'

/** The md: width utility a class string carries — exactly one, or the test names the site. */
function mdWidth(cls) {
  const all = cls.match(/md:w-\[[^\]]+\]/g) || []
  return all
}
function mdRight(cls) {
  return cls.match(/md:right-\[[^\]]+\]/g) || []
}

describe('MailDock width literals equal their pinned constants', () => {
  it('the reader card', () => {
    expect(mdWidth(READER.dock)).toEqual([READER_CARD_WIDTH])
  })

  it('the minimised bar, in place and shifted beside a compose card', () => {
    expect(mdWidth(READER.min)).toEqual([READER_BAR_WIDTH])
    expect(mdWidth(READER.minShifted)).toEqual([READER_BAR_WIDTH])
    expect(mdRight(READER.minShifted)).toEqual([READER_BAR_SHIFTED_OFFSET])
    // The in-place bar sits at the pane's right-4, not an arbitrary offset.
    expect(mdRight(READER.min)).toEqual([])
    expect(READER.min).toMatch(/\bmd:right-4\b/)
    expect(READER.dock).toMatch(/\bmd:right-4\b/)
  })

  it('full has no width literal at all — it is an inset overlay, not a card', () => {
    expect(mdWidth(READER.full || '')).toEqual([])
  })
})

describe('ComposeDock width literals equal their pinned constants', () => {
  it('the compose card: free corner vs reserved beside a parked reader bar', () => {
    expect(mdWidth(DOCK_BY_READER.none)).toEqual([COMPOSE_CARD_FREE_WIDTH])
    expect(mdWidth(DOCK_BY_READER.bar)).toEqual([COMPOSE_CARD_RESERVED_WIDTH])
    for (const k of ['none', 'bar']) {
      expect(DOCK_BY_READER[k], k).toMatch(/\bmd:right-4\b/)
      expect(mdRight(DOCK_BY_READER[k]), k).toEqual([])
    }
  })

  it('the compose bar: one width at every reader occupancy, offset by what it sits beside', () => {
    for (const k of ['none', 'bar', 'card']) {
      expect(mdWidth(MIN_BY_READER[k]), k).toEqual([COMPOSE_BAR_WIDTH])
    }
    expect(mdRight(MIN_BY_READER.none)).toEqual([])
    expect(MIN_BY_READER.none).toMatch(/\bmd:right-4\b/)
    expect(mdRight(MIN_BY_READER.bar)).toEqual([COMPOSE_BAR_OVER_READER_BAR_OFFSET])
    expect(mdRight(MIN_BY_READER.card)).toEqual([COMPOSE_BAR_OVER_READER_CARD_OFFSET])
  })
})

describe('the pinned constants are themselves coherent', () => {
  // A guard on the guard: if someone edits a constant above, the numbers in
  // it must still tell the geometry story dock-geometry.test.js derives.
  it('the reader’s shifted offset steps by the compose card’s RESERVED width term', () => {
    const reserved = COMPOSE_CARD_RESERVED_WIDTH.match(/\[(.+)\]/)[1]
    expect(READER_BAR_SHIFTED_OFFSET).toBe(`md:right-[calc(1.5rem+${reserved})]`)
  })

  it('one 1120 cap and one 360 cap across every constant that carries one', () => {
    const caps = (s) => [...s.matchAll(/(\d+)px/g)].map(m => Number(m[1]))
    expect(caps(READER_CARD_WIDTH)).toEqual([1120])
    expect(caps(READER_BAR_WIDTH)).toEqual([360])
    expect(caps(COMPOSE_BAR_WIDTH)).toEqual([360])
    expect(caps(COMPOSE_CARD_FREE_WIDTH)).toEqual([1120, 288])
    expect(caps(COMPOSE_CARD_RESERVED_WIDTH)).toEqual([1120, 672])
    expect(caps(READER_BAR_SHIFTED_OFFSET)).toEqual([1120, 672])
    expect(caps(COMPOSE_BAR_OVER_READER_BAR_OFFSET)).toEqual([360, 624])
    expect(caps(COMPOSE_BAR_OVER_READER_CARD_OFFSET)).toEqual([1120, 624])
  })
})
