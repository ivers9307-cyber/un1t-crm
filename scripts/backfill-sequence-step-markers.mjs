// scripts/backfill-sequence-step-markers.mjs
// SEQ-TERMINAL one-time healing: stamp config.next_step_order onto
// sequence_steps rows compiled before the compiler emitted the marker
// (terminal branch arms fell through into the other arm — seq 21983d6c).
// Idempotent: already-marked rows produce no update; sequences whose live
// rows diverge from their stored graph are skipped and listed (republish
// those from the builder instead). The marker is inert to the pre-fix
// runner, so stamping before the code deploys is safe.
//
// Dry run (default):  node scripts/backfill-sequence-step-markers.mjs
// Apply:              node scripts/backfill-sequence-step-markers.mjs --apply
import { createClient } from '@supabase/supabase-js'
import { buildMarkerBackfillUpdates } from '../src/lib/sequences/graph/backfill.js'

const apply = process.argv.includes('--apply')
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const { data: seqs, error } = await db
  .from('email_sequences')
  .select('id, name, graph, sequence_steps(id, step_order, step_type, config)')
  .not('graph', 'is', null)
if (error) { console.error(error); process.exit(1) }

const rows = (seqs || []).map(s => ({ ...s, steps: s.sequence_steps }))
const { updates, skipped } = buildMarkerBackfillUpdates(rows)

console.log(`${rows.length} graph-backed sequences — ${updates.length} step rows need a marker, ${skipped.length} sequences skipped`)
for (const s of skipped) console.log(`  SKIPPED ${s.id}: ${s.reason}`)
for (const u of updates) console.log(`  ${u.sequenceId} step ${u.stepId} → next_step_order=${JSON.stringify(u.config.next_step_order)}`)

if (!apply) { console.log('Dry run — re-run with --apply to write.'); process.exit(0) }

let failed = 0
for (const u of updates) {
  const { error: e } = await db.from('sequence_steps').update({ config: u.config }).eq('id', u.stepId)
  if (e) { failed++; console.error(`  FAILED ${u.stepId}: ${e.message}`) }
}
console.log(failed ? `Done with ${failed} failures.` : 'Done.')
process.exit(failed ? 1 : 0)
