// HYROX-TC.2/3 — server orchestration, split into two BOUNDED steps so no single
// request does a multi-minute fan-out (estate invariant: long fan-outs run on a
// cron / their own bounded request, not one request thread):
//   createBlockWithArc — one arc call + insert the block (fast, ~one call).
//   expandBlockWeek     — generate ONE week's sessions IN PARALLEL + insert them
//                         (wall-clock ≈ one call regardless of sessions_per_week).
// `caller` is the metered anthropic caller injected by the route/cron.
import { generateArc, expandSession, HYROX_MODEL } from './generate'
import { slotsForWeek, blockRowFrom, sessionRowFrom } from './plan-block'

// Pure helper: fold last week's generated sessions into one line the model can
// read as "here's what already happened" (block-context awareness — HYROX-TC).
export function summarizePrevWeek(sessions) {
  const items = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && s.focus)
    .map((s) => `session ${s.slot}: ${s.focus}${s.board?.format ? ` (${s.board.format})` : ''}`)
  return items.length ? items.join('; ') : null
}

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

  let prevWeekSummary = null
  if (weekNo > 1) {
    const { data: prev } = await db
      .from('hyrox_sessions').select('slot, focus, board').eq('block_id', block.id).eq('week_no', weekNo - 1).order('slot', { ascending: true })
    prevWeekSummary = summarizePrevWeek(prev)
  }

  const slots = slotsForWeek(block.sessions_per_week ?? 2)
  const built = await Promise.all(
    slots.map((slot) =>
      expandSession(
        { week, slot, dial: block.difficulty_dial ?? 'mixed', locationLabel, charter, houseStyle, styleExamples, autoTuneSignal: null, arcPlan: block.arc?.plan, sessionsPerWeek: block.sessions_per_week, prevWeekSummary },
        { caller },
      ).then((sRes) => (sRes.ok ? sessionRowFrom(block.id, block.location_id, { ...sRes.data, week_no: weekNo, slot }) : null)),
    ),
  )
  const rows = built.filter(Boolean)
  if (!rows.length) return { ok: false, error: 'session_generation_failed' }

  // Race-safe: two expansions of the same week running at once (e.g. the
  // post-create auto-loop overlapping a manual Generate click) both pass the
  // check above, so a plain insert would collide on the (block_id, week_no, slot)
  // unique constraint. ON CONFLICT DO NOTHING makes the loser a no-op instead of
  // a duplicate-key error; sessionsCreated reflects what THIS call actually wrote.
  const { data: insertedRows, error: sessErr } = await db
    .from('hyrox_sessions')
    .upsert(rows, { onConflict: 'block_id,week_no,slot', ignoreDuplicates: true })
    .select('id')
  if (sessErr) return { ok: false, error: sessErr.message }
  return { ok: true, sessionsCreated: (insertedRows || []).length }
}
