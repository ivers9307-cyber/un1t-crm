import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/email-audience-counts', () => ({ emailAudienceCounts: vi.fn() }))
vi.mock('@/lib/from-address', () => ({ describeFromAddress: vi.fn() }))
vi.mock('@/lib/email-templates-for-agents', async (orig) => ({
  ...(await orig()),
  listMarketingTemplates: vi.fn(),
  loadMarketingTemplate: vi.fn(),
}))

import { runTool } from './registry.js'
import { TOOLS } from './index.js'
import listEmailTemplates from './list-email-templates.js'
import createFromTemplate from './create-email-draft-from-template.js'
import { listMarketingTemplates, loadMarketingTemplate } from '@/lib/email-templates-for-agents'
import { describeFromAddress } from '@/lib/from-address'

const DUB = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a01'
const NOEMAIL = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a02'
const ME = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1b01'
const CAMP = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1c01'
const TPL = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1d01'

function auth() {
  const loc = (id, name) => ({ id, name, timezone: 'Europe/Dublin', organization_id: 'org-1' })
  const locations = [loc(DUB, 'Dublin Studio'), loc(NOEMAIL, 'No Email')]
  const mk = (perms) => ({ role: 'manager', permissions: { mcp_access: true, ...perms } })
  return {
    token: 't', clientId: 'client-1', scopes: [],
    extra: {
      user: {
        id: ME, full_name: 'Pat', role: 'manager', isMaster: false, locations, activeLocation: locations[0],
        rolesByLocation: { [DUB]: 'manager', [NOEMAIL]: 'manager' },
        assignmentsByLocation: { [DUB]: mk({ email: true }), [NOEMAIL]: mk({ email: false }) },
      },
      enabledOrgIds: ['org-1'],
      mcpAccessAnywhere: true,
    },
  }
}

function makeDb() {
  const ops = []
  const db = {
    rpc: vi.fn(async () => ({ data: [], error: null })),
    from: vi.fn((table) => {
      const q = { table, kind: 'select', payload: null }
      ops.push(q)
      const b = {}
      b.insert = (p) => { q.kind = 'insert'; q.payload = p; return b }
      b.select = () => b
      b.single = async () => ({ data: { id: CAMP, name: q.payload?.name, status: 'draft' }, error: null })
      return b
    }),
  }
  return { db, ops }
}

const TEMPLATE = { id: TPL, name: 'Promo', subject: 'Hello {{first_name}}', html_content: '<p>Hi {{first_name}}</p>', design_json: { v: 1 } }
const call = (db, name, input, a = auth()) => runTool(TOOLS.find((t) => t.name === name), input, a, { db })

beforeEach(() => {
  vi.clearAllMocks()
  describeFromAddress.mockResolvedValue({ sends_as: 'Dublin <hi@d.test>', on_verified_domain: true, verified_domain: 'd.test' })
})

describe('email template tools', () => {
  it('lists marketing templates and reports a cap', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, name: `n${i}`, subject: 's', category: null, description: null }))
    listMarketingTemplates.mockResolvedValue(rows)
    const r = await call(makeDb().db, 'list_email_templates', { studio_id: DUB })
    expect(r.ok).toBe(true)
    expect(r.data.templates).toHaveLength(50)
    expect(r.data.capped).toBe(true)
    expect(listMarketingTemplates).toHaveBeenCalledWith(expect.anything(), DUB)
  })

  it('creates a draft from a template with the body editable in the CRM only', async () => {
    loadMarketingTemplate.mockResolvedValue(TEMPLATE)
    const { db, ops } = makeDb()
    const r = await call(db, 'create_email_draft_from_template', {
      studio_id: DUB, template_id: TPL, name: 'Autumn', resend: { after_hours: 48 },
    })
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ campaign: { id: CAMP, status: 'draft' }, sends_as: 'Dublin <hi@d.test>', audience: null, body_editable_from_claude: false })
    const ins = ops.find((o) => o.kind === 'insert' && o.table === 'campaigns')
    expect(ins.table).toBe('campaigns')
    expect(ins.payload).toMatchObject({
      location_id: DUB, status: 'draft', created_via: 'mcp', postmark_stream: 'broadcast', created_by: ME,
      subject: 'Hello {{first_name}}', html_content: TEMPLATE.html_content, design_json: TEMPLATE.design_json,
      template_id: TPL, agent_blocks: null, resend_enabled: true, resend_wait_hours: 48,
    })
  })

  it('refuses a template whose body carries {{booking_time}} or another tag a campaign cannot fill', async () => {
    loadMarketingTemplate.mockResolvedValue({ ...TEMPLATE, html_content: '<p>At {{booking_time}}</p>' })
    const { db, ops } = makeDb()
    const r = await call(db, 'create_email_draft_from_template', { studio_id: DUB, template_id: TPL, name: 'x' })
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(JSON.stringify(r)).toContain('booking_time')
    expect(ops.some((o) => o.kind === 'insert' && o.table === 'campaigns')).toBe(false)
  })

  it('refuses a spaced tag in the template subject or an override subject', async () => {
    loadMarketingTemplate.mockResolvedValue({ ...TEMPLATE, subject: 'Hi {{ first_name }}' })
    let r = await call(makeDb().db, 'create_email_draft_from_template', { studio_id: DUB, template_id: TPL, name: 'x' })
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' })
    loadMarketingTemplate.mockResolvedValue(TEMPLATE)
    r = await call(makeDb().db, 'create_email_draft_from_template', { studio_id: DUB, template_id: TPL, name: 'x', subject: 'Yo {{nope}}' })
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('answers not_found for another studio\'s template', async () => {
    loadMarketingTemplate.mockResolvedValue(null)
    const { db, ops } = makeDb()
    const r = await call(db, 'create_email_draft_from_template', { studio_id: DUB, template_id: TPL, name: 'x' })
    expect(r).toMatchObject({ ok: false, code: 'not_found' })
    expect(ops.some((o) => o.kind === 'insert' && o.table === 'campaigns')).toBe(false)
  })

  it('is closed to a studio without the email permission', async () => {
    const r = await call(makeDb().db, 'list_email_templates', { studio_id: NOEMAIL })
    expect(r.ok).toBe(false)
    expect(listEmailTemplates.writes).toBeFalsy()
    expect(createFromTemplate.writes).toBe(true)
  })
})
