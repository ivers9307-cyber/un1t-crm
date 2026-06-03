import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import { resolveSequenceGraph } from '@/lib/sequences/graph/persist'
import SequenceFlowBuilder from '@/components/sequences/SequenceFlowBuilder'

// FLOW-GRAPH Phase 2 (PR2) — the canonical sequence detail route. Loads the
// sequence + its steps, resolves the flow graph server-side (draft → published →
// lazily decompiled from steps, so legacy sequences just work), and renders the
// guided-rail builder. The classic editor still lives at /email/sequences/[id].
export const dynamic = 'force-dynamic'

export default async function SequenceBuilderPage(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: sequence } = await db.from('email_sequences')
    .select('*, sequence_steps(*)')
    .eq('id', params.id)
    .single()

  if (!sequence) notFound()
  const guard = assertLocationAccess(user, sequence.location_id)
  if (guard) notFound() // don't leak existence across tenants

  const graph = resolveSequenceGraph(sequence)

  return <SequenceFlowBuilder graph={graph} sequence={sequence} />
}
