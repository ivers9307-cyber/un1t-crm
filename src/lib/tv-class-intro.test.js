import { describe, it, expect } from 'vitest'
import {
  shouldPlayIntro,
  planIntroTimers,
  isIntroPreview,
  demoIntroClass,
  INTRO_WINDOW_MS,
  INTRO_DURATION_MS,
  INTRO_SHOW_DELAY_MS,
  INTRO_FADE_DELAY_MS,
  INTRO_HIDE_DELAY_MS,
} from './tv-class-intro.js'

const start = '2026-06-27T17:00:00Z'
const startMs = Date.parse(start)
const cls = { glofox_event_id: 'e1', class_name: 'TEMPO', starts_at: start }

describe('shouldPlayIntro', () => {
  it('plays right at the scheduled start (new occurrence)', () => {
    expect(shouldPlayIntro({ currentClass: cls, lastPlayedKey: null, nowMs: startMs + 1000 })).toBe(true)
  })
  it('does NOT play before the scheduled start', () => {
    expect(shouldPlayIntro({ currentClass: cls, lastPlayedKey: null, nowMs: startMs - 60_000 })).toBe(false)
  })
  it('does NOT play past the window (e.g. a mid-class page load)', () => {
    expect(shouldPlayIntro({ currentClass: cls, lastPlayedKey: null, nowMs: startMs + INTRO_WINDOW_MS + 1000 })).toBe(false)
  })
  it('does NOT replay for the same occurrence key', () => {
    expect(shouldPlayIntro({ currentClass: cls, lastPlayedKey: 'e1', nowMs: startMs + 1000 })).toBe(false)
  })
  it('plays again for a different occurrence key', () => {
    const next = { glofox_event_id: 'e2', class_name: 'RIDE', starts_at: start }
    expect(shouldPlayIntro({ currentClass: next, lastPlayedKey: 'e1', nowMs: startMs + 1000 })).toBe(true)
  })
  it('false for null / malformed current class', () => {
    expect(shouldPlayIntro({ currentClass: null, lastPlayedKey: null, nowMs: startMs })).toBe(false)
    expect(shouldPlayIntro({ currentClass: { glofox_event_id: 'e1' }, lastPlayedKey: null, nowMs: startMs })).toBe(false)
  })
  it('exposes sane constants', () => {
    expect(INTRO_WINDOW_MS).toBe(120_000)
    expect(INTRO_DURATION_MS).toBe(8_000)
  })
})

describe('planIntroTimers (the effect-wiring controller)', () => {
  const eventId = 'e1'

  it('plans the show→fade→hide sequence for a fresh occurrence', () => {
    const plan = planIntroTimers({ eventId, startsAt: start, lastPlayedKey: null, nowMs: startMs + 1000 })
    expect(plan.play).toBe(true)
    expect(plan.key).toBe(eventId)
    expect(plan.timers).toEqual({
      showMs: INTRO_SHOW_DELAY_MS,
      fadeMs: INTRO_FADE_DELAY_MS,
      hideMs: INTRO_HIDE_DELAY_MS,
    })
    // Fade/hide sit inside INTRO_DURATION_MS with the fade 600ms before hide.
    expect(plan.timers.fadeMs).toBe(INTRO_DURATION_MS - 600)
    expect(plan.timers.hideMs).toBe(INTRO_DURATION_MS)
  })

  it('does NOT plan anything with no current occurrence', () => {
    const plan = planIntroTimers({ eventId: null, startsAt: null, lastPlayedKey: null, nowMs: startMs + 1000 })
    expect(plan).toEqual({ play: false, key: null, timers: null })
  })

  // THE REGRESSION GUARD for the stuck-overlay bug (P0-2):
  // the 2s poll re-runs the decision with the SAME occurrence already marked
  // played. It must be a no-op — play:false — so the component's effect does
  // NOT clear the in-flight fade/hide timers. If a re-poll re-armed or (via a
  // serverTime-keyed effect) tore them down without rearming, the overlay would
  // stick over the live board all class.
  it('a re-poll for the SAME occurrence does not restart the sequence', () => {
    // First tick: fresh occurrence → plays, marks played.
    const first = planIntroTimers({ eventId, startsAt: start, lastPlayedKey: null, nowMs: startMs + 1000 })
    expect(first.play).toBe(true)

    // ~2s later the poll advances nowMs; occurrence is now the lastPlayedKey.
    const second = planIntroTimers({ eventId, startsAt: start, lastPlayedKey: first.key, nowMs: startMs + 3000 })
    expect(second.play).toBe(false)
    expect(second.timers).toBeNull()

    // And a much later tick (still same occurrence) also stays a no-op.
    const later = planIntroTimers({ eventId, startsAt: start, lastPlayedKey: first.key, nowMs: startMs + INTRO_DURATION_MS + 5000 })
    expect(later.play).toBe(false)
  })

  it('plans again for a genuinely NEW occurrence', () => {
    const plan = planIntroTimers({ eventId: 'e2', startsAt: start, lastPlayedKey: 'e1', nowMs: startMs + 1000 })
    expect(plan.play).toBe(true)
    expect(plan.key).toBe('e2')
  })
})

describe('isIntroPreview', () => {
  it('is true only for introPreview=1', () => {
    expect(isIntroPreview('?introPreview=1')).toBe(true)
    expect(isIntroPreview('?kiosk=1&introPreview=1')).toBe(true)
    expect(isIntroPreview('?introPreview=0')).toBe(false)
    expect(isIntroPreview('?kiosk=1')).toBe(false)
    expect(isIntroPreview('')).toBe(false)
    expect(isIntroPreview(undefined)).toBe(false)
  })
})

describe('demoIntroClass', () => {
  it('emits the live-feed current_class shape for the preview card', () => {
    const c = demoIntroClass(Date.parse('2026-07-03T17:00:00Z'))
    expect(c.glofox_event_id).toBe('preview')
    expect(typeof c.class_name).toBe('string')
    expect(c.class_name.length).toBeGreaterThan(0)
    expect(typeof c.starts_at_label).toBe('string')
    expect(c.starts_at).toBe('2026-07-03T17:00:00.000Z')
    // Dublin (IST, UTC+1) label for 17:00 UTC = 18:00.
    expect(c.starts_at_label).toBe('18:00')
  })
})
