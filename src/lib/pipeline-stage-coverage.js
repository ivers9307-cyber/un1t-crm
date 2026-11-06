// PIPEBUILD.1e — which pipeline stages have a live follow-up aimed at them.
//
// Follow-ups were missed because nothing showed a stage with no sequence. One
// read: each ENABLED board at a studio, its live (not archived) stages, and the
// ACTIVE sequences that fire on a lead reaching that stage. The sequence editor
// builds its From/To stage pickers from it, and the pipeline page's coverage
// strip (next task) draws from the same route.
//
// A sequence is aimed at a stage when it is `status = 'active'` and either
//   - trigger_type 'pipeline_stage_change' with trigger_config.to_status = slug, or
//   - it is an ENTRY trigger for that stage (see ENTRY_TRIGGERS_BY_STAGE).
//
// Every read destructures `error` and returns { ok: false } rather than "no
// boards": an unreadable list must never read as "nothing is covered".

// PR 1 STOP-GAP. These are the triggers that start a flow for someone who is
// CREATED straight onto a stage (a create is not a stage move, so no
// pipeline_stage_change fires). Stage roles replace this hard-coded map in
// PR 2; until then it is the only place that knows it.
export const ENTRY_TRIGGERS_BY_STAGE = {
  new_lead: ['contact_created'],
  paid_trial_new_lead: ['paid_trial_checkout_purchased', 'un1t_paid_trial_purchased'],
}

const PAGE = 1000

export async function loadStageCoverage(db, locationId) {
  const { data: boards, error: boardsError } = await db
    .from('pipelines')
    .select('id, key, name, display_order')
    .eq('location_id', locationId)
    .eq('enabled', true)
    .order('display_order', { ascending: true })
    .range(0, PAGE - 1)
  if (boardsError) return { ok: false, error: boardsError.message || 'Could not read pipelines' }
  const boardRows = boards || []
  if (boardRows.length === 0) return { ok: true, boards: [] }

  const { data: stages, error: stagesError } = await db
    .from('pipeline_stages')
    .select('id, pipeline_id, slug, name, display_order, is_dormant')
    .eq('location_id', locationId)
    .in('pipeline_id', boardRows.map((b) => b.id))
    .eq('archived', false)
    .order('display_order', { ascending: true })
    .range(0, PAGE - 1)
  if (stagesError) return { ok: false, error: stagesError.message || 'Could not read pipeline stages' }

  const { data: sequences, error: sequencesError } = await db
    .from('email_sequences')
    .select('id, name, trigger_type, trigger_config')
    .eq('location_id', locationId)
    .eq('status', 'active')
    .order('name', { ascending: true })
    .range(0, PAGE - 1)
  if (sequencesError) return { ok: false, error: sequencesError.message || 'Could not read sequences' }

  const followupsFor = (slug) => {
    const entry = ENTRY_TRIGGERS_BY_STAGE[slug] || []
    return (sequences || [])
      .filter((s) => {
        if (s.trigger_type === 'pipeline_stage_change') return s.trigger_config?.to_status === slug
        return entry.includes(s.trigger_type)
      })
      .map((s) => ({ id: s.id, name: s.name, trigger: s.trigger_type }))
  }

  return {
    ok: true,
    boards: boardRows.map((b) => ({
      id: b.id,
      key: b.key,
      name: b.name,
      stages: (stages || [])
        .filter((s) => s.pipeline_id === b.id)
        .map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          isPile: s.is_dormant === true,
          followups: followupsFor(s.slug),
        })),
    })),
  }
}
