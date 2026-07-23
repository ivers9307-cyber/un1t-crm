// HYROX-TC.2/3 — server orchestration, split into two BOUNDED steps so no single
// request does a multi-minute fan-out (estate invariant: long fan-outs run on a
// cron / their own bounded request, not one request thread):
//   createBlockWithArc — one arc call + insert the block (fast, ~one call).
//   expandBlockWeek     — generate ONE week's sessions IN PARALLEL + insert them
//                         (wall-clock ≈ one call regardless of sessions_per_week).
// `caller` is the metered anthropic caller injected by the route/cron.
import { generateArc, expandSession, HYROX_MODEL } from './generate'
import { slotsForWeek, blockRowFrom, sessionRowFrom } from './plan-block'

// Fast path: generate the 12-week arc and insert the block. No session fan-out.
// Returns { ok, block } | { ok:false, error }.
export async function createBlockWithArc(db, { input, charter, houseStyle, caller }) {
  const arcRes = await generateArc(
    { weeks: input.weeks ?? 12, sessionsPerWeek: input.sessions_per_week ?? 2, dial: input.difficulty_dial ?? 'mixed', charter, houseStyle },
    { caller },
  )
  if (!arcRes.ok) return { ok: false, error: 'arc_generation_failed' }

  const { data: block, error: blockErr } = await db
    .from('hyrox_blocks')
    .insert(blockRowFrom(input, arcRes.data, input.created_by, HYROX_MODEL))
    .select('*')
    .single()
  if (blockErr || !block) return { ok: false, error: blockErr?.message || 'block_insert_failed' }
  return { ok: true, block }
}

// Expand ONE week of a block: generate its sessions in parallel and insert the
// drafts. Idempotent — a week that already has sessions returns skipped:true.
// Returns { ok, sessionsCreated, skipped? } | { ok:false, error }.
export async function expandBlockWeek(db, { block, weekNo, charter, houseStyle, styleExamples, caller, locationLabel = 'UN1T' }) {
  const week = (block.arc?.plan || []).find((w) => w.week_no === weekNo)
  if (!week) return { ok: false, error: 'no_arc_week' }

  const { data: existing } = await db
    .from('hyrox_sessions')
    .select('id')
    .eq('block_id', block.id)
    .eq('week_no', weekNo)
    .limit(1)
  if (existing && existing.length) return { ok: true, sessionsCreated: 0, skipped: true }

  const slots = slotsForWeek(block.sessions_per_week ?? 2)
  const built = await Promise.all(
    slots.map((slot) =>
      expandSession(
        { week, slot, dial: block.difficulty_dial ?? 'mixed', locationLabel, charter, houseStyle, styleExamples, autoTuneSignal: null },
        { caller },
      ).then((sRes) => (sRes.ok ? sessionRowFrom(block.id, block.location_id, { ...sRes.data, week_no: weekNo, slot }) : null)),
    ),
  )
  const rows = built.filter(Boolean)
  if (!rows.length) return { ok: false, error: 'session_generation_failed' }

  const { error: sessErr } = await db.from('hyrox_sessions').insert(rows)
  if (sessErr) return { ok: false, error: sessErr.message }
  return { ok: true, sessionsCreated: rows.length }
}
