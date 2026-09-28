import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { canBuildSequencesAt, canBuildSequencesSomewhere } from '@/lib/sequence-access'
import { redirect, notFound } from 'next/navigation'
import { resolveSequenceGraph } from '@/lib/sequences/graph/persist'
import SequenceFlowBuilder from '@/components/sequences/SequenceFlowBuilder'
import AutomationPerformance from '@/components/automations/AutomationPerformance'
import { logError } from '@/lib/log'
import { uuidLike } from '@/lib/schemas'
import { SEQUENCE_BUILDER_PAGE_SELECT, toBuilderSequence, toPerformanceSteps } from '@/lib/sequences/builder-shape'

// FLOW-GRAPH Phase 2 (PR2) — the canonical sequence detail route. Loads the
// sequence + its steps, resolves the flow graph server-side (draft → published →
// lazily decompiled from steps, so legacy sequences just work), and renders the
// guided-rail builder — the one sequence editor (the classic editor is retired;
// /email/sequences/[id] now redirects here).
export const dynamic = 'force-dynamic'

export default async function SequenceBuilderPage(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // SEC-AUTOMATION-BUILDER-GATE.1 — this page had auth + tenant checks but
  // no permission gate at all. The /automations index only ever links here
  // from AutomationsFlowList, which it renders behind `canFlows =
  // hasPermission('email') || hasPermission('whatsapp')` — the curated
  // toggle cards (`automations`) and the Devices link (`device_control`)
  // are unrelated surfaces that never route to a sequence id, so they're
  // deliberately excluded from this gate.
  // SEQROUTEGATE.1 — the same `email || whatsapp` rule every /api/sequences
  // route applies (src/lib/sequence-access.js): coarse here (at SOME studio),
  // then at the sequence's own studio below.
  if (!canBuildSequencesSomewhere(user)) redirect('/')
  // SEQPAGEGATE.1 — a garbage id is "not found" without a read (PostgREST
  // would answer 22P02, which the read below now treats as an error).
  if (!uuidLike.safeParse(params.id).success) notFound()

  const db = createServerClient()
  // SEQPAGEGATE.1 — named columns; webhook_secret is read only so
  // toBuilderSequence can say whether one is set. A failed read is an error
  // page (logged), never "not found": the sequence may well exist.
  const { data: sequence, error } = await db.from('email_sequences')
    .select(SEQUENCE_BUILDER_PAGE_SELECT)
    .eq('id', params.id)
    .maybeSingle()
  if (error) {
    logError('sequences', 'builder page: sequence read failed', { sequenceId: params.id, code: error.code || null })
    throw new Error('Could not load the sequence')
  }

  if (!sequence) notFound()
  const guard = assertLocationAccess(user, sequence.location_id)
  if (guard) notFound() // don't leak existence across tenants
  // SEQROUTEGATE.1 — judged at the SEQUENCE's studio, not the active one: a
  // manager at A who is staff at B would otherwise open B's builder and have
  // every save, publish and settings call refused by the routes.
  if (!canBuildSequencesAt(user, sequence.location_id)) notFound()

  const graph = resolveSequenceGraph(sequence)
  // SEQPAGEGATE.1 — both components are 'use client': they get the builder
  // shape (has_webhook_secret, never the secret) and id/step_type/config per
  // step, not the row and the email bodies.
  const builderSequence = toBuilderSequence(sequence)

  return (
    <>
      <SequenceFlowBuilder
        graph={graph}
        sequence={builderSequence}
        isDraft={sequence.draft_graph != null}
        isPublished={sequence.graph != null}
      />
      <AutomationPerformance sequenceId={sequence.id} steps={toPerformanceSteps(sequence.sequence_steps)} />
    </>
  )
}
