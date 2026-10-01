// Tests for POST /api/sequences/[id]/graph/publish
//
// SEQ-URLBUTTON.1 — the publish gate for a dynamic URL button's per-send value.
//
// A WhatsApp template whose link ends in a variable needs that value or Meta
// rejects EVERY message with 132012. The flow graph stores only a template id,
// so nothing in the pure validator could see the button — which is how a step
// mapping nothing could be published and then fail one contact at a time, weeks
// later, with nobody watching. The route loads the location's template rows and
// runs the same rule the send path does, returning the route's existing 422
// `issues` shape so the builder lists the problem next to Publish.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'
import { compileGraphToSteps } from '@/lib/sequences/graph/compile'
import { STEP_IDENTITY_COLUMNS } from '@/lib/sequences/graph/step-identity'

const SEQ_ID = 'a0000000-0000-0000-0000-000000000001'
const LOC_ID = 'c0000000-0000-0000-0000-000000000003'
const OWNER = { id: 'b0000000-0000-0000-0000-000000000002', role: 'owner', locations: [{ id: LOC_ID, role: 'owner' }] }

const DYNAMIC_TPL = {
  id: 'wt-dyn',
  name: 'Overdue pay link',
  components: [
    { type: 'BODY', text: 'Hi {{1}}, {{2}} is outstanding.' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay now', url: 'https://pay.repset.ie/{{1}}', example: ['x'] }] },
  ],
}

const waGraph = (variables) => ({
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [{ id: 'n1', type: 'whatsapp', config: { template_id: 'wt-dyn', variables } }],
  edges: [{ from: 'trigger', to: 'n1' }],
})
const emailGraph = () => ({
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [{ id: 'n1', type: 'email', config: { subject: 'hi' } }],
  edges: [{ from: 'trigger', to: 'n1' }],
})

// email_sequences row load → whatsapp_templates lookup → current step rows →
// publish_sequence_steps (one transaction) → promote the graph.
function mockDb({
  templates = [], templateError = null,
  stored = { location_id: LOC_ID, graph: null, draft_graph: null },
  stepRows = [], stepsError = null, rpcError = null,
} = {}) {
  const rpcSpy = vi.fn(() => Promise.resolve({ data: rpcError ? null : { updated: 0, inserted: 1, deleted: 0 }, error: rpcError }))
  const templateSelect = vi.fn(() => ({
    eq: vi.fn(() => ({ in: vi.fn(() => Promise.resolve({ data: templateError ? null : templates, error: templateError })) })),
  }))
  const stepsSelect = vi.fn(() => ({
    eq: vi.fn(() => Promise.resolve({ data: stepsError ? null : stepRows, error: stepsError })),
  }))
  const stepsDelete = vi.fn()
  const stepsInsert = vi.fn()
  const sequenceUpdate = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }))
  const db = {
    rpc: rpcSpy,
    from: vi.fn((table) => {
      if (table === 'email_sequences') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: stored, error: null })),
            })),
          })),
          update: sequenceUpdate,
        }
      }
      if (table === 'whatsapp_templates') return { select: templateSelect }
      if (table === 'sequence_steps') {
        return { select: stepsSelect, delete: stepsDelete, insert: stepsInsert }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
  return { db, rpcSpy, templateSelect, stepsSelect, stepsDelete, stepsInsert, sequenceUpdate }
}

const publish = (graph) => POST(
  new Request(`http://localhost/api/sequences/${SEQ_ID}/graph/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph }),
  }),
  { params: { id: SEQ_ID } },
)

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER)
})

describe('publish gate — dynamic URL button value', () => {
  it('refuses with 422 and names the button when url_button is unmapped', async () => {
    const { db, rpcSpy } = mockDb({ templates: [DYNAMIC_TPL] })
    createServerClient.mockReturnValue(db)

    const res = await publish(waGraph({ 1: 'first_name' }))
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.success).toBe(false)
    const issue = body.issues.find(i => i.code === 'url_button_value_missing')
    expect(issue).toBeTruthy()
    expect(issue.message).toContain('Pay now')
    expect(issue.message).toContain('on this step before publishing')
    // Nothing was written — a refused publish must not replace the live steps.
    expect(rpcSpy).not.toHaveBeenCalled()
  })

  it('publishes once url_button is mapped, carrying the key into the step row', async () => {
    const { db, rpcSpy } = mockDb({ templates: [DYNAMIC_TPL] })
    createServerClient.mockReturnValue(db)

    const res = await publish(waGraph({ 1: 'first_name', url_button: 'pay_link_suffix' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, steps: 1 })
    expect(rpcSpy).toHaveBeenCalledTimes(1)
    expect(rpcSpy.mock.calls[0][1].p_steps[0].whatsapp_variables)
      .toEqual({ 1: 'first_name', url_button: 'pay_link_suffix' })
  })

  it('scopes the template lookup to the sequence own location and the ids in the graph', async () => {
    const { db, templateSelect } = mockDb({ templates: [DYNAMIC_TPL] })
    createServerClient.mockReturnValue(db)

    await publish(waGraph({ url_button: 'x' }))

    expect(templateSelect).toHaveBeenCalledWith('id, name, components')
    const eqCall = templateSelect.mock.results[0].value.eq
    expect(eqCall).toHaveBeenCalledWith('location_id', LOC_ID)
    expect(eqCall.mock.results[0].value.in).toHaveBeenCalledWith('id', ['wt-dyn'])
  })

  it('does not query templates at all for a graph with no WhatsApp step', async () => {
    const { db } = mockDb()
    createServerClient.mockReturnValue(db)

    const res = await publish(emailGraph())

    expect(res.status).toBe(200)
    expect(db.from).not.toHaveBeenCalledWith('whatsapp_templates')
  })

  // Failing open is right — a template read that fell over must not block an
  // otherwise-fine publish — but a gate that silently stops running is a gate
  // that will later look like it never worked.
  it('logs a warning when the template read fails, and still publishes', async () => {
    const { db } = mockDb({ templateError: { message: 'connection reset' } })
    createServerClient.mockReturnValue(db)

    const res = await publish(waGraph({}))

    expect(res.status).toBe(200)
    expect(logWarn).toHaveBeenCalledWith(
      'sequences',
      expect.stringContaining('URL-button gate skipped'),
      expect.objectContaining({ sequenceId: SEQ_ID, err: 'connection reset' }),
    )
  })

  it('does not warn on a clean read', async () => {
    const { db } = mockDb({ templates: [DYNAMIC_TPL] })
    createServerClient.mockReturnValue(db)
    await publish(waGraph({ url_button: 'x' }))
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('publishes when the template row cannot be read — it must not block on an unknown template', async () => {
    // A template belonging to another location, or deleted: the rule has no
    // opinion. The send path still refuses per-step, which is the right place.
    const { db } = mockDb({ templates: [] })
    createServerClient.mockReturnValue(db)

    const res = await publish(waGraph({}))
    expect(res.status).toBe(200)
  })
})

// STEPATTRIB.1 — a publish keeps step rows' ids. It used to delete every row
// and insert the compiled ones; email_sends.sequence_step_id is ON DELETE SET
// NULL, so every earlier send lost its step (22,771 of 22,793 on 30 Sep) and a
// runner tick between the two calls found no step and completed the enrolment.
// Now the route plans which row each node updates in place and hands the whole
// publish to publish_sequence_steps (mig 698), one transaction.
describe('publish keeps step identity (STEPATTRIB.1)', () => {
  const rid = (n) => `d0000000-0000-0000-0000-${String(n).padStart(12, '0')}`
  const trial = (subject3 = 'Last one') => ({
    version: 1,
    trigger: { type: 'manual', config: {} },
    nodes: [
      { id: 'e1', type: 'email', config: { subject: 'Welcome', html_content: '<p>1</p>' } },
      { id: 'w1', type: 'wait', config: { days: 2 } },
      { id: 'e2', type: 'email', config: { subject: subject3, html_content: '<p>2</p>' } },
    ],
    edges: [{ from: 'trigger', to: 'e1' }, { from: 'e1', to: 'w1' }, { from: 'w1', to: 'e2' }],
  })
  // The rows a publish of `graph` wrote, as the route reads them back.
  const rowsOf = (graph, { withNodeIds }) => compileGraphToSteps(graph, { withNodeIds: true }).map((r, i) => ({
    id: rid(i + 1), subject: null, html_content: null, template_id: null, whatsapp_template_id: null,
    whatsapp_variables: {}, whatsapp_header_media_url: null, sms_body: null, config: {},
    ...r, graph_node_id: withNodeIds ? r.graph_node_id : null,
  }))
  const storedWith = (graph) => ({ location_id: LOC_ID, graph, draft_graph: null })

  it('republishing updates every row in place through publish_sequence_steps, never delete + insert', async () => {
    const m = mockDb({ stored: storedWith(trial()), stepRows: rowsOf(trial(), { withNodeIds: true }) })
    createServerClient.mockReturnValue(m.db)

    const res = await publish(trial('Last one, edited'))

    expect(res.status).toBe(200)
    expect(m.stepsDelete).not.toHaveBeenCalled()
    expect(m.stepsInsert).not.toHaveBeenCalled()
    expect(m.rpcSpy).toHaveBeenCalledTimes(1)
    const [fn, args] = m.rpcSpy.mock.calls[0]
    expect(fn).toBe('publish_sequence_steps')
    expect(args.p_sequence_id).toBe(SEQ_ID)
    expect(args.p_steps.map(s => [s.id, s.graph_node_id, s.step_order])).toEqual(
      [[rid(1), 'e1', 1], [rid(2), 'w1', 2], [rid(3), 'e2', 3]])
    expect(args.p_steps[2].subject).toBe('Last one, edited')
  })

  it('adopts rows written before mig 698 when the stored published graph reproduces them', async () => {
    const m = mockDb({ stored: storedWith(trial()), stepRows: rowsOf(trial(), { withNodeIds: false }) })
    createServerClient.mockReturnValue(m.db)

    await publish(trial())

    expect(m.rpcSpy.mock.calls[0][1].p_steps.map(s => s.id)).toEqual([rid(1), rid(2), rid(3)])
  })

  it('reads the current rows of THIS sequence, naming every column the plan compares', async () => {
    const m = mockDb()
    createServerClient.mockReturnValue(m.db)

    await publish(emailGraph())

    const cols = m.stepsSelect.mock.calls[0][0].split(',').map(c => c.trim())
    expect(cols.sort()).toEqual(STEP_IDENTITY_COLUMNS.split(',').map(c => c.trim()).sort())
    expect(m.stepsSelect.mock.results[0].value.eq).toHaveBeenCalledWith('sequence_id', SEQ_ID)
  })

  it('a failed step-row read writes nothing (500)', async () => {
    const m = mockDb({ stepsError: { message: 'connection reset' } })
    createServerClient.mockReturnValue(m.db)

    const res = await publish(emailGraph())

    expect(res.status).toBe(500)
    expect(m.rpcSpy).not.toHaveBeenCalled()
    expect(m.sequenceUpdate).not.toHaveBeenCalled()
  })

  it('a failed publish_sequence_steps leaves the graph unpromoted (500): the live steps are untouched', async () => {
    const m = mockDb({ rpcError: { message: 'Could not find the function public.publish_sequence_steps' } })
    createServerClient.mockReturnValue(m.db)

    const res = await publish(emailGraph())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(m.sequenceUpdate).not.toHaveBeenCalled()
  })
})
