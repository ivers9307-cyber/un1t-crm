// HYROX-TC.2 — server orchestration: arc -> insert block -> expand the initial
// window of sessions -> insert draft sessions. `caller` is the metered
// anthropic caller injected by the route. Returns { ok, block, sessionsCreated } | { ok:false, error }.
import { generateArc, expandSession, HYROX_MODEL } from './generate'
import { weeksToExpand, slotsForWeek, blockRowFrom, sessionRowFrom } from './plan-block'

export async function generateBlock(db, { input, charter, caller, expandWeeks = 2 }) {
  const arcRes = await generateArc(
    { weeks: input.weeks ?? 12, sessionsPerWeek: input.sessions_per_week ?? 2, dial: input.difficulty_dial ?? 'mixed', charter },
    { caller },
  )
  if (!arcRes.ok) return { ok: false, error: 'arc_generation_failed' }
  const arc = arcRes.data

  const { data: block, error: blockErr } = await db
    .from('hyrox_blocks')
    .insert(blockRowFrom(input, arc, input.created_by, HYROX_MODEL))
    .select('*')
    .single()
  if (blockErr || !block) return { ok: false, error: blockErr?.message || 'block_insert_failed' }

  const rows = []
  for (const week of weeksToExpand(arc, expandWeeks)) {
    for (const slot of slotsForWeek(input.sessions_per_week ?? 2)) {
      const sRes = await expandSession(
        { week, slot, dial: input.difficulty_dial ?? 'mixed', locationLabel: input.location_label || 'UN1T', charter, autoTuneSignal: null },
        { caller },
      )
      if (sRes.ok) rows.push(sessionRowFrom(block.id, input.location_id, { ...sRes.data, week_no: week.week_no, slot }))
    }
  }
  if (rows.length) {
    const { error: sessErr } = await db.from('hyrox_sessions').insert(rows)
    if (sessErr) return { ok: false, error: sessErr.message, block }
  }
  return { ok: true, block, sessionsCreated: rows.length }
}
