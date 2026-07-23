// HYROX-EVAL.1 — LIVE model eval for Hyrox Training Club generation. NOT part of
// `npm test` / CI (real Anthropic calls, cost money, need ANTHROPIC_API_KEY).
// Run: `npm run eval:agent` (add ANTHROPIC_API_KEY to .env.local first).
//
// Why this exists: every hyrox unit test uses CANNED JSON, so none exercise how
// the model actually behaves. Every generation bug this project hit (arc
// max_tokens truncation, session schema mismatch, nested-object `main`, the arc
// bloat under a long charter, and the "text dump" board) shipped green and only
// failed on a real click. This eval makes real arcs + sessions and asserts they
// parse AND are well-formed — including that the BOARD is a glanceable scoreboard.
import { describe, it, expect } from 'vitest'
import { generateArc, expandSession } from '@/lib/hyrox/generate'
import { DEFAULT_CHARTER } from '@/lib/hyrox/constants'

const API_KEY = process.env.ANTHROPIC_API_KEY

// A realistic, detail-heavy operator charter — the kind Stillorgan actually uses,
// and the kind that triggered both the arc token-overrun AND the text-dump board
// (the model over-applies "be detailed" to fields meant to be short). The fix has
// to hold under THIS, not just the terse default charter.
const DETAILED_CHARTER = [
  DEFAULT_CHARTER,
  'Catering for 32 people in groups of 1 or 2 with a 45 minute target.',
  'Be exhaustive about honest intensity, progressive overload, safe scalable movements,',
  'energy-system targeting, pacing, transitions, and coaching cues so every week is a real stimulus and never a token session.',
  'Spell out the reasoning for each progression and each tier in full.',
].join('\n\n')

// The board is a glanceable TV scoreboard: every field is a SHORT value, and the
// coaching prose lives in full_session, never on the board. This is the exact
// property that was broken (sentences crammed into format / performance / elite).
function expectGlanceableBoard(s) {
  expect(s.board.format.length).toBeLessThan(40)
  expect(s.board.focus.length).toBeLessThan(40)
  expect(s.board.target.length).toBeLessThan(70)
  expect(s.board.stations.length).toBeGreaterThanOrEqual(1)
  for (const st of s.board.stations) {
    expect(st.name.length).toBeGreaterThan(0)
    expect(st.name.length).toBeLessThan(32)      // "Wall Balls", not "Wall Balls - 5 min max reps"
    expect(st.performance.length).toBeGreaterThan(0)
    expect(st.elite.length).toBeGreaterThan(0)
    expect(st.performance.length).toBeLessThan(28) // "9kg x 20", not a coaching sentence
    expect(st.elite.length).toBeLessThan(28)
  }
  // The how-to must live in the coach's view, not on the board.
  expect(s.full_session.main.length).toBeGreaterThan(80)
}

describe.skipIf(!API_KEY)('Hyrox generation evals (live model)', () => {
  if (!API_KEY) return

  it('generates a valid, coherent 12-week arc', { timeout: 90_000, retry: 1 }, async () => {
    const res = await generateArc({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed', charter: DEFAULT_CHARTER })
    if (!res.ok) console.error('[hyrox-eval] arc invalid:', JSON.stringify(res.error?.issues?.slice(0, 8)))
    expect(res.ok).toBe(true)
    expect(res.data.weeks).toBe(12)
    expect(res.data.plan.length).toBe(12)
    expect(res.data.plan.every((w) => ['base', 'build', 'peak', 'taper'].includes(w.phase))).toBe(true)
    // At least one benchmark week so progress is measurable.
    expect(res.data.plan.some((w) => w.is_benchmark)).toBe(true)
  })

  // Regression for the arc_generation_failed truncation: a long, detailed charter
  // made the model write paragraph-long weeks until the arc truncated at the cap.
  it('keeps the arc terse and complete under a long, detailed charter', { timeout: 120_000, retry: 1 }, async () => {
    const res = await generateArc({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed', charter: DETAILED_CHARTER })
    if (!res.ok) console.error('[hyrox-eval] long-charter arc invalid:', JSON.stringify(res.error?.issues?.slice(0, 8)))
    expect(res.ok).toBe(true)                    // parsed = did not truncate
    expect(res.data.plan.length).toBe(12)        // complete, not a partial arc
    for (const w of res.data.plan) {             // terse skeleton, not paragraphs
      expect(w.stimulus.length).toBeLessThan(140)
      expect(w.progression.length).toBeLessThan(140)
    }
  })

  it('expands a session with readable prose AND a glanceable board', { timeout: 90_000, retry: 1 }, async () => {
    const week = { week_no: 5, phase: 'build', stimulus: 'Engine and compromised running', progression: 'Add one round vs week 4', is_benchmark: false }
    const res = await expandSession({ week, slot: 1, dial: 'mixed', locationLabel: 'UN1T STILLORGAN', charter: DEFAULT_CHARTER, autoTuneSignal: null })
    if (!res.ok) console.error('[hyrox-eval] session invalid:', JSON.stringify(res.error?.issues?.slice(0, 8)))
    expect(res.ok).toBe(true)
    const s = res.data

    // full_session fields are readable prose strings, NOT nested-object/JSON blobs.
    for (const key of ['warmup', 'main', 'why']) {
      expect(typeof s.full_session[key]).toBe('string')
      expect(s.full_session[key].length).toBeGreaterThan(30)
      expect(s.full_session[key].trim().startsWith('{')).toBe(false)
    }
    expect(typeof s.board.cap_minutes).toBe('number')
    expect(s.board.cap_minutes).toBeLessThanOrEqual(45)
    expectGlanceableBoard(s)
  })

  // Regression for the 2026-07-23 "text dump" board: the model wrote coaching
  // sentences into board.format / stations[].performance / elite. Under a detailed
  // charter the board must STILL be short values, prose in full_session.
  it('keeps the board glanceable under a long, detailed charter', { timeout: 90_000, retry: 1 }, async () => {
    const week = { week_no: 1, phase: 'base', stimulus: 'Aerobic base and movement quality', progression: 'Establish baselines at RPE 6', is_benchmark: false }
    const res = await expandSession({ week, slot: 1, dial: 'mixed', locationLabel: 'UN1T STILLORGAN', charter: DETAILED_CHARTER, autoTuneSignal: null })
    if (!res.ok) console.error('[hyrox-eval] detailed-charter session invalid:', JSON.stringify(res.error?.issues?.slice(0, 8)))
    if (res.ok) console.error('[hyrox-eval] board sample:', JSON.stringify({ format: res.data.board.format, station0: res.data.board.stations[0], target: res.data.board.target }))
    expect(res.ok).toBe(true)
    expectGlanceableBoard(res.data)
  })
})

if (!API_KEY) {
  it('skipped — no ANTHROPIC_API_KEY', () => {
    console.warn(
      '[hyrox-evals] ANTHROPIC_API_KEY is not set. Add it to .env.local '
      + '(same key the Vercel deployment uses) and re-run `npm run eval:agent`.',
    )
    expect(true).toBe(true)
  })
}
