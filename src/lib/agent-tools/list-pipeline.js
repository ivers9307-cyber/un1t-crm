// MCP.1 — `list_pipeline`: the studio's open deals, grouped by stage. The
// board's own reads (src/app/(sales)/pipeline/page.js): the studio's enabled
// pipelines, their non-archived stages in display order, and per stage the
// open deals plus an exact count, in parallel. Each card is shaped by the
// board's mapper for its pipeline (boardDealMapper, which strips the heavy
// recent_bookings and derives the next-class badge), capped at 50 a stage.
// A pipeline id that is not one of this studio's answers not_found.

import { z } from 'zod'
import { defineTool, ToolRefusal } from './registry.js'
import { hasPermissionForLocation } from '@/lib/permissions'
import { pipelineDealSelect, boardDealMapper, boardCardOptionsForModule } from '@/lib/pipeline-board'

const MAX_PER_STAGE = 50

export default defineTool({
  name: 'list_pipeline',
  title: 'Pipeline',
  description: 'Open deals at a studio grouped by pipeline stage, for every enabled pipeline or one '
    + '(pipeline_id) and optionally one stage (stage_slug). Each stage carries its exact count; at most 50 deals '
    + 'are listed a stage (capped is true when there are more). Needs the Pipeline permission.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    pipeline_id: z.string().uuid().optional().describe('One pipeline; omit for every enabled pipeline.'),
    stage_slug: z.string().min(1).max(100).optional().describe('One stage by slug, e.g. new_lead.'),
  }),
  gate: (user, studioId) => hasPermissionForLocation(user, studioId, 'pipeline'),
  run: async (input, ctx) => {
    const { db, studio } = ctx

    const { data: pipelineRows, error: pipelinesError } = await db.from('pipelines')
      .select('id, name, module')
      .eq('location_id', studio.id)
      .eq('enabled', true)
      .order('display_order', { ascending: true })
    if (pipelinesError) throw new Error(`Failed to load pipelines: ${pipelinesError.message}`)
    const pipelines = (pipelineRows || []).filter((p) => !input.pipeline_id || p.id === input.pipeline_id)
    if (input.pipeline_id && pipelines.length === 0) throw new ToolRefusal('not_found', 'Pipeline not found at this studio.')
    const result = { studio: { id: studio.id, name: studio.name }, stages: [] }
    if (pipelines.length === 0) return result
    const pipelineById = new Map(pipelines.map((p) => [p.id, p]))

    const { data: stageRows, error: stagesError } = await db.from('pipeline_stages')
      .select('id, name, slug, position:display_order, pipeline_id')
      .eq('location_id', studio.id)
      .eq('archived', false)
      .in('pipeline_id', [...pipelineById.keys()])
      .order('display_order', { ascending: true })
    if (stagesError) throw new Error(`Failed to load pipeline stages: ${stagesError.message}`)
    const stages = (stageRows || []).filter((s) => !input.stage_slug || s.slug === input.stage_slug)

    result.stages = await Promise.all(stages.map(async (stage) => {
      const { data, error, count } = await db.from('deals')
        .select(pipelineDealSelect('active'), { count: 'exact' })
        .eq('location_id', studio.id)
        .eq('status', 'open')
        .eq('stage_id', stage.id)
        .order('created_at', { ascending: false })
        .order('id')
        .limit(MAX_PER_STAGE)
      if (error) throw new Error(`Failed to load deals: ${error.message}`)
      const pipeline = pipelineById.get(stage.pipeline_id)
      const toCard = boardDealMapper(boardCardOptionsForModule(pipeline?.module ?? null))
      const deals = (data || []).map(toCard).map((d) => ({
        id: d.id,
        title: d.title,
        created_at: d.created_at,
        stage_entered_at: d.stage_entered_at,
        age: d.age,
        contact: d.contacts,
      }))
      const total = count ?? deals.length
      return {
        id: stage.id,
        name: stage.name,
        slug: stage.slug,
        position: stage.position,
        pipeline_id: stage.pipeline_id,
        pipeline: pipeline?.name ?? null,
        count: total,
        capped: total > deals.length,
        deals,
      }
    }))
    return result
  },
})
