// HYROX-EVAL.1 — LIVE model eval for Hyrox Training Club generation. NOT part of
// `npm test` / CI (real Anthropic calls, costs money, needs ANTHROPIC_API_KEY).
// Run: `npm run eval:agent` (add ANTHROPIC_API_KEY to .env.local first).
//
// Why this exists: every hyrox unit test uses CANNED JSON, so none exercise how
// the model actually behaves. The 2026-07-23 trio (arc max_tokens truncation,
// session schema mismatch, nested-object `main` rendering as JSON) all shipped
// green and only failed on a real click. This eval makes ONE real arc + ONE real
// session and asserts they parse AND are well-formed — catching all three.
import { describe, it, expect } from 'vitest'
import { generateArc, expandSession } from '@/lib/hyrox/generate'
import { DEFAULT_CHARTER } from '@/lib/hyrox/constants'

const API_KEY = process.env.ANTHROPIC_API_KEY

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

  // Regression for the 2026-07-23 arc_generation_failed: a long, detailed
  // operator charter made the model write paragraph-long weeks until the arc
  // truncated at the max_tokens cap (output_tokens pinned at 8000). The arc must
  // stay a terse, COMPLETE skeleton regardless of how verbose the charter is.
  it('stays terse and complete under a long, detailed charter', { timeout: 120_000, retry: 1 }, async () => {
    const detailedCharter = [
      DEFAULT_CHARTER,
      'Catering for 32 people in groups of 1 or 2 with a 45 minute target.',
      'Be exhaustive about honest intensity, progressive overload, safe scalable movements,',
      'energy-system targeting, pacing, transitions, and coaching cues so every week is a real stimulus and never a token session.',
      'Spell out the reasoning for each progression in full.',
    ].join('\n\n')
    const res = await generateArc({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed', charter: detailedCharter })
    if (!res.ok) console.error('[hyrox-eval] long-charter arc invalid:', JSON.stringify(res.error?.issues?.slice(0, 8)))
    expect(res.ok).toBe(true)                         // parsed = did not truncate
    expect(res.data.plan.length).toBe(12)             // complete, not a partial arc
    for (const w of res.data.plan) {                  // terse skeleton, not paragraphs
      expect(w.stimulus.length).toBeLessThan(140)
      expect(w.progression.length).toBeLessThan(140)
    }
  })

  it('expands a well-formed session: readable prose + a tiered board', { timeout: 90_000, retry: 1 }, async () => {
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

    // The board carries both tiers per station as SHORT values (not paragraphs).
    expect(s.board.stations.length).toBeGreaterThanOrEqual(1)
    for (const st of s.board.stations) {
      expect(st.performance.length).toBeGreaterThan(0)
      expect(st.elite.length).toBeGreaterThan(0)
      expect(st.performance.length).toBeLessThan(40)
      expect(st.elite.length).toBeLessThan(40)
    }
    expect(typeof s.board.cap_minutes).toBe('number')
    expect(s.board.cap_minutes).toBeLessThanOrEqual(45)
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
