// scripts/backfill-sequence-graphs.mjs
// One-time: populate email_sequences.graph from existing sequence_steps.
// Idempotent (skips sequences that already have a graph). Run with the prod
// env vars loaded:  node scripts/backfill-sequence-graphs.mjs
import { createClient } from '@supabase/supabase-js'
import { buildBackfillUpdates } from '../src/lib/sequences/graph/backfill.js'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const { data: seqs, error } = await db
  .from('email_sequences')
  .select('id, trigger_type, trigger_config, graph, sequence_steps(*)')
if (error) { console.error(error); process.exit(1) }

const rows = (seqs || []).map(s => ({ ...s, steps: s.sequence_steps }))
const updates = buildBackfillUpdates(rows)
console.log(`Backfilling ${updates.length} of ${rows.length} sequences…`)
for (const u of updates) {
  const { error: e } = await db.from('email_sequences').update({ graph: u.graph }).eq('id', u.id)
  if (e) console.error(`  ${u.id}: ${e.message}`)
}
console.log('Done.')
