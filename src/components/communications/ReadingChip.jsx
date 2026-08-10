// REPORT-SOT.1 — the band chip, in one place.
//
// Lifted out of ListHealthTrend so the campaign table and the non-campaign
// panel below it cannot drift into rendering the same reading two different
// ways. It takes a reading object straight from readRate (list-health-trend.js)
// and does nothing but colour it: the WORDS come from the helper, never from
// here, so there is exactly one sentence per level in the codebase.
//
// Colours follow the repo's chip recipe (bg-<c>-500/10 text-<c>-700) — the
// light-theme ramp, lint-enforced by check:guardrails.

const TONE = {
  serious: 'bg-rose-500/10 text-rose-700',
  warn: 'bg-amber-500/10 text-amber-700',
  ok: 'bg-emerald-500/10 text-emerald-700',
}

export default function ReadingChip({ reading }) {
  if (!reading) return null
  const cls = TONE[reading.level] || 'bg-slate-500/10 text-slate-700'
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] ${cls}`}>{reading.text}</span>
}
