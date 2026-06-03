import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { runFlowAgent } from '@/lib/sequences/agent/run'

// FLOW-GRAPH Phase 3 — POST /api/sequences/[id]/graph/agent
// Turn a plain-English ask into a flow graph and save it as a DRAFT for review.
// The agent self-corrects against validateGraph; the result is only ever written
// to draft_graph (never published) — the operator reviews + publishes in the
// builder. The runner is untouched.
export const runtime = 'nodejs'
export const maxDuration = 120 // up to a few opus calls in the self-correct loop

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: sequence } = await db.from('email_sequences')
    .select('location_id, name, trigger_type, trigger_config').eq('id', params.id).single()
  if (!sequence) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccess(user, sequence.location_id)
  if (guard) return guard

  const body = await request.json().catch(() => ({}))
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) return NextResponse.json({ success: false, error: 'Describe the sequence you want.' }, { status: 400 })
  if (prompt.length > 4000) return NextResponse.json({ success: false, error: 'That description is too long.' }, { status: 400 })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ success: false, error: 'AI is not configured.' }, { status: 500 })

  const trigger = { type: sequence.trigger_type || 'manual', config: sequence.trigger_config || {} }
  const result = await runFlowAgent({ apiKey, prompt, trigger })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error || 'The AI could not build a flow.' }, { status: 502 })

  // Save the agent's draft + its RECOMMENDED trigger + name so the settings
  // panel shows them. The graph goes to draft_graph (never published — the
  // operator reviews + Publishes). The trigger is a recommendation persisted to
  // the sequence's columns; if the agent picks the webhook trigger, the settings
  // panel's Regenerate generates the token (none is created here).
  const update = {
    draft_graph: result.graph,
    trigger_type: result.graph.trigger?.type || sequence.trigger_type,
    trigger_config: result.graph.trigger?.config || {},
  }
  // Adopt the AI's name only while the sequence is still untitled — don't clobber a name the operator chose.
  const isUntitled = !sequence.name || /^untitled/i.test(sequence.name)
  if (result.name && isUntitled) update.name = result.name

  const { error } = await db.from('email_sequences').update(update).eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, graph: result.graph, validation: result.validation, name: update.name || sequence.name, exhausted: !!result.exhausted })
}
