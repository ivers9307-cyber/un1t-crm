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

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const SEQ_ID = 'a0000000-0000-0000-0000-000000000001'
const LOC_ID = 'c0000000-0000-0000-0000-000000000003'
const OWNER = { id: 'b0000000-0000-0000-0000-000000000002', role: 'owner', locations: [{ id: LOC_ID }] }

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
const smsGraph = () => ({
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [{ id: 'n1', type: 'sms', config: { body: 'hi' } }],
  edges: [{ from: 'trigger', to: 'n1' }],
})

// email_sequences row load → whatsapp_templates lookup → steps replace → update.
function mockDb({ templates = [] } = {}) {
  const insertSpy = vi.fn(() => Promise.resolve({ error: null }))
  const templateSelect = vi.fn(() => ({
    eq: vi.fn(() => ({ in: vi.fn(() => Promise.resolve({ data: templates, error: null })) })),
  }))
  const db = {
    from: vi.fn((table) => {
      if (table === 'email_sequences') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: { location_id: LOC_ID, graph: null, draft_graph: null }, error: null })),
            })),
          })),
          update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })),
        }
      }
      if (table === 'whatsapp_templates') return { select: templateSelect }
      if (table === 'sequence_steps') {
        return {
          delete: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })),
          insert: insertSpy,
        }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
  return { db, insertSpy, templateSelect }
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
    const { db, insertSpy } = mockDb({ templates: [DYNAMIC_TPL] })
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
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('publishes once url_button is mapped, carrying the key into the step row', async () => {
    const { db, insertSpy } = mockDb({ templates: [DYNAMIC_TPL] })
    createServerClient.mockReturnValue(db)

    const res = await publish(waGraph({ 1: 'first_name', url_button: 'pay_link_suffix' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, steps: 1 })
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy.mock.calls[0][0][0].whatsapp_variables)
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

    const res = await publish(smsGraph())

    expect(res.status).toBe(200)
    expect(db.from).not.toHaveBeenCalledWith('whatsapp_templates')
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
