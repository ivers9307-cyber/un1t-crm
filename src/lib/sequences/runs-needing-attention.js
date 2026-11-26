// STUCKRUNS.1 — automation runs at a studio that need a person to look, for
// the Automations page. READ ONLY.
//
// Two kinds, both rare in practice (26 Nov 2026: none overdue, ~44 stopped on
// an error in 30 days, 32 of them one re-engagement flow mailing addresses
// Postmark had marked inactive):
//   overdue  an active run whose next step was due over OVERDUE_HOURS ago and
//            has not gone: the runner is not reaching it
//   stopped  a run that ended in the last STOPPED_DAYS on an error (the
//            runner's own exit, or an undeliverable address), not on purpose
//
// Scoped by the sequence ids the caller passes, which the page has already
// read at the active studio, so no extra tenant filter is needed here.

export const OVERDUE_HOURS = 2
export const STOPPED_DAYS = 30
const STOPPED_REASONS = ['undeliverable']

/**
 * @param {any} db service-role client
 * @param {Array<{ id: string, name: string }>} sequences the studio's sequences
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<{ ok: boolean, rows: Array<{ sequence_id: string, name: string, overdue: number, stopped: number, sample_error: string|null }> }>}
 */
export async function loadRunsNeedingAttention(db, sequences, { now = new Date() } = {}) {
  const ids = (sequences || []).map((s) => s.id).filter(Boolean)
  if (ids.length === 0) return { ok: true, rows: [] }
  const overdueBefore = new Date(now.getTime() - OVERDUE_HOURS * 3600_000).toISOString()
  const stoppedSince = new Date(now.getTime() - STOPPED_DAYS * 86400_000).toISOString()

  const [overdue, stopped] = await Promise.all([
    db.from('sequence_enrollments')
      .select('sequence_id')
      .in('sequence_id', ids)
      .eq('status', 'active')
      .lt('next_step_at', overdueBefore)
      .limit(1000),
    db.from('sequence_enrollments')
      .select('sequence_id, exit_reason, last_error')
      .in('sequence_id', ids)
      .eq('status', 'exited')
      .not('last_error', 'is', null)
      .gte('last_processed_at', stoppedSince)
      .limit(1000),
  ])
  if (overdue.error || stopped.error) {
    console.error('[runs needing attention] read failed:', (overdue.error || stopped.error)?.message)
    return { ok: false, rows: [] }
  }

  const names = new Map(sequences.map((s) => [s.id, s.name]))
  const by = new Map()
  const row = (id) => {
    if (!by.has(id)) by.set(id, { sequence_id: id, name: names.get(id) || 'Automation', overdue: 0, stopped: 0, sample_error: null })
    return by.get(id)
  }
  for (const r of overdue.data || []) row(r.sequence_id).overdue += 1
  for (const r of stopped.data || []) {
    if (r.exit_reason != null && !STOPPED_REASONS.includes(r.exit_reason)) continue
    const x = row(r.sequence_id)
    x.stopped += 1
    if (!x.sample_error && r.last_error) x.sample_error = String(r.last_error).slice(0, 160)
  }
  const rows = [...by.values()]
    .filter((r) => r.overdue > 0 || r.stopped > 0)
    .sort((a, b) => (b.overdue - a.overdue) || (b.stopped - a.stopped))
  return { ok: true, rows }
}
