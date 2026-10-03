// MIA-DUNNING.1 — get_my_payment_reminder: the customer agent can see whether
// the verified member has a live overdue-payment reminder run (the Pay now
// WhatsApp + emails, PAYLINK/#1683) and whether Glofox STILL lists that
// invoice as overdue. Read-only: the tool never exits or edits the run —
// the pre-send gate (PRESEND.1) does that before the next send.
//
// The Glofox inference rules are the SAME as dunningPresendGate's: listed →
// true; ok + absent + under the page cap → false; anything else → 'unknown'.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  getGlofoxOverdueInvoices: vi.fn(),
  GLOFOX_OVERDUE_INVOICES_PAGE_CAP: 20,
}))
// dunning-payment statically pulls the enrolment-status helper, which opens a
// service client (next). Mocked so the module loads in the unit env; the tool
// must never call it anyway (read-only).
vi.mock('@/lib/sequences/enrollment-status', () => ({ setEnrollmentStatus: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const { glofoxCredentialsForLocation, getGlofoxOverdueInvoices } = await import('@/lib/glofox')
const { setEnrollmentStatus } = await import('@/lib/sequences/enrollment-status')
const { executeAccountTool, ACCOUNT_TOOLS, ACCOUNT_TOOL_NAMES } = await import('./account-tools')

const INVOICE = '0f187762-acc8-42d2-860c-43cbe1477df0'
const LINK = `https://pay.glofox.com/payment-collector/v2/#/i/${INVOICE}`
const MEMBER = '64aa00000000000000000001'
const CREDS = { branchId: 'b', apiKey: 'k', apiToken: 't' }

const payment = (over = {}) => ({
  invoice_id: INVOICE, link: LINK, link_suffix: INVOICE, amount: '€209', currency: 'EUR',
  retriable: true, fetched_at: '2026-09-12T10:00:00.000Z', error: null, ...over,
})
const enrol = (over = {}) => ({
  id: 'e1', contact_id: 'c1', status: 'active', exit_reason: null, source_type: 'invoice_past_due',
  enrolled_at: '2026-09-12T10:00:00.000Z', metadata: { payment: payment() }, ...over,
})

// A thenable query double: person_group_members resolves the person group,
// contacts answers eq/in on id, sequence_enrollments answers the newest
// transactional row for the contact ids it was asked for. `trace` captures
// the select column strings so a phantom column (ENROLFIX.1) is caught here,
// not by a 400 in production.
function stubDb({ groupId = null, members = [], contacts = [], enrollments = [], groupError = null, enrolError = null, trace = {} } = {}) {
  return {
    from(table) {
      const st = { cols: '', filters: {}, order: null, limit: null }
      const settle = (single) => {
        if (table === 'person_group_members') {
          if (groupError) return { data: null, error: groupError }
          if (st.cols.includes('group_id')) return { data: groupId ? { group_id: groupId } : null, error: null }
          return { data: members.map((id) => ({ contact_id: id })), error: null }
        }
        if (table === 'contacts') {
          const want = st.filters.id
          const list = Array.isArray(want) ? contacts.filter((c) => want.includes(c.id)) : contacts.filter((c) => c.id === want)
          return single ? { data: list[0] || null, error: null } : { data: list, error: null }
        }
        if (table === 'sequence_enrollments') {
          trace.enrolSelect = st.cols
          trace.enrolFilters = st.filters
          trace.enrolOrder = st.order
          trace.enrolLimit = st.limit
          if (enrolError) return { data: null, error: enrolError }
          const ids = st.filters.contact_id || []
          const types = st.filters.source_type || []
          const rows = enrollments
            .filter((e) => ids.includes(e.contact_id) && types.includes(e.source_type))
            .sort((a, b) => (a.enrolled_at < b.enrolled_at ? 1 : -1))
          return single ? { data: rows[0] || null, error: null } : { data: rows, error: null }
        }
        return single ? { data: null, error: null } : { data: [], error: null }
      }
      const b = {
        select(cols) { st.cols = cols || ''; return b },
        eq(col, val) { st.filters[col] = val; return b },
        in(col, vals) { st.filters[col] = vals; return b },
        order(col, opts) { st.order = { col, ...(opts || {}) }; return b },
        limit(n) { st.limit = n; return b },
        async maybeSingle() { return settle(true) },
        async single() { return settle(true) },
        then(resolve, reject) { return Promise.resolve(settle(false)).then(resolve, reject) },
      }
      return b
    },
  }
}

const ctx = (db, over = {}) => ({
  db, conversationId: 'conv1', conversationsTable: 'whatsapp_conversations',
  contactId: 'c1', verifiedContactId: 'c1', locationId: 'loc1', channel: 'whatsapp', ...over,
})
const run = (db, over) => executeAccountTool('get_my_payment_reminder', {}, ctx(db, over))

beforeEach(() => {
  vi.mocked(glofoxCredentialsForLocation).mockReset().mockResolvedValue(CREDS)
  vi.mocked(getGlofoxOverdueInvoices).mockReset().mockResolvedValue({ ok: true, status: 200, invoiceIds: [INVOICE], error: null })
  vi.mocked(setEnrollmentStatus).mockReset()
})

describe('get_my_payment_reminder · registry', () => {
  it('is declared in ACCOUNT_TOOLS with the before-answering instruction', () => {
    const tool = ACCOUNT_TOOLS.find((t) => t.name === 'get_my_payment_reminder')
    expect(tool).toBeTruthy()
    expect(tool.description).toMatch(/payment reminder/i)
    expect(tool.description).toMatch(/Pay now/)
    expect(tool.description).toMatch(/still shows the payment as outstanding/i)
    expect(ACCOUNT_TOOL_NAMES.has('get_my_payment_reminder')).toBe(true)
  })
})

describe('get_my_payment_reminder · executor', () => {
  it('refuses before verification, same shape as get_my_membership', async () => {
    const db = stubDb()
    const res = await run(db, { verifiedContactId: null })
    expect(res).toEqual({ error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' })
    expect(getGlofoxOverdueInvoices).not.toHaveBeenCalled()
  })

  it('no reminder row → has_reminder false, status none, and no Glofox call', async () => {
    const db = stubDb({ contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }] })
    const res = await run(db)
    expect(res).toEqual({
      has_reminder: false, status: 'none', amount: null, currency: null, pay_link: null,
      first_sent_at: null, exit_reason: null, still_overdue: 'unknown',
    })
    expect(getGlofoxOverdueInvoices).not.toHaveBeenCalled()
  })

  it('ignores a MARKETING enrolment — only transactional source types count', async () => {
    const db = stubDb({
      contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }],
      enrollments: [enrol({ source_type: 'manual' })],
    })
    const res = await run(db)
    expect(res.has_reminder).toBe(false)
  })

  it('active run + invoice still in the overdue list → still_overdue true with amount and link', async () => {
    const db = stubDb({
      contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }],
      enrollments: [enrol()],
    })
    const res = await run(db)
    expect(res).toEqual({
      has_reminder: true, status: 'active', amount: '€209', currency: 'EUR', pay_link: LINK,
      first_sent_at: '2026-09-12T10:00:00.000Z', exit_reason: null, still_overdue: true,
    })
    expect(glofoxCredentialsForLocation).toHaveBeenCalledWith(db, 'loc1')
    expect(getGlofoxOverdueInvoices).toHaveBeenCalledWith(CREDS, { memberId: MEMBER })
  })

  it('invoice absent from an under-cap list → still_overdue false (settled)', async () => {
    vi.mocked(getGlofoxOverdueInvoices).mockResolvedValue({ ok: true, status: 200, invoiceIds: ['some-other'], error: null })
    const db = stubDb({
      contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }],
      enrollments: [enrol()],
    })
    const res = await run(db)
    expect(res.has_reminder).toBe(true)
    expect(res.still_overdue).toBe(false)
  })

  it('never exits or edits the run, even when the invoice reads as settled', async () => {
    vi.mocked(getGlofoxOverdueInvoices).mockResolvedValue({ ok: true, status: 200, invoiceIds: [], error: null })
    const db = stubDb({
      contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }],
      enrollments: [enrol()],
    })
    await run(db)
    expect(setEnrollmentStatus).not.toHaveBeenCalled()
  })

  it('Glofox !ok → still_overdue unknown (never infers settlement from a failure)', async () => {
    vi.mocked(getGlofoxOverdueInvoices).mockResolvedValue({ ok: false, status: 0, invoiceIds: [], error: 'timeout' })
    const db = stubDb({
      contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }],
      enrollments: [enrol()],
    })
    const res = await run(db)
    expect(res.has_reminder).toBe(true)
    expect(res.still_overdue).toBe('unknown')
  })

  it('a list at the page cap without the invoice → unknown (page may be truncated)', async () => {
    vi.mocked(getGlofoxOverdueInvoices).mockResolvedValue({
      ok: true, status: 200, invoiceIds: Array.from({ length: 20 }, (_, i) => `inv-${i}`), error: null,
    })
    const db = stubDb({
      contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }],
      enrollments: [enrol()],
    })
    expect((await run(db)).still_overdue).toBe('unknown')
  })

  it('no glofox_member_id on the owning contact → unknown, no Glofox call', async () => {
    const db = stubDb({
      contacts: [{ id: 'c1', glofox_member_id: null, location_id: 'loc1' }],
      enrollments: [enrol()],
    })
    const res = await run(db)
    expect(res.has_reminder).toBe(true)
    expect(res.still_overdue).toBe('unknown')
    expect(getGlofoxOverdueInvoices).not.toHaveBeenCalled()
  })

  it('no invoice_id on the run → unknown, no Glofox call', async () => {
    const db = stubDb({
      contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }],
      enrollments: [enrol({ metadata: { payment: payment({ invoice_id: null, link: null, amount: '' }) } })],
    })
    const res = await run(db)
    expect(res.has_reminder).toBe(true)
    expect(res.pay_link).toBeNull()
    expect(res.amount).toBeNull()
    expect(res.still_overdue).toBe('unknown')
    expect(getGlofoxOverdueInvoices).not.toHaveBeenCalled()
  })

  it('missing Glofox credentials → unknown, no Glofox call', async () => {
    vi.mocked(glofoxCredentialsForLocation).mockResolvedValue({ branchId: null, apiKey: null, apiToken: null })
    const db = stubDb({
      contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }],
      enrollments: [enrol()],
    })
    expect((await run(db)).still_overdue).toBe('unknown')
    expect(getGlofoxOverdueInvoices).not.toHaveBeenCalled()
  })

  it('an exited run reports status exited with its exit_reason; a completed run reports completed', async () => {
    vi.mocked(getGlofoxOverdueInvoices).mockResolvedValue({ ok: true, status: 200, invoiceIds: [], error: null })
    const exited = stubDb({
      contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }],
      enrollments: [enrol({ status: 'exited', exit_reason: 'invoice_settled_presend' })],
    })
    expect(await run(exited)).toMatchObject({ has_reminder: true, status: 'exited', exit_reason: 'invoice_settled_presend', still_overdue: false })
    const completed = stubDb({
      contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }],
      enrollments: [enrol({ status: 'completed' })],
    })
    expect(await run(completed)).toMatchObject({ has_reminder: true, status: 'completed' })
  })

  it('picks the NEWEST run by enrolled_at across the person group (sibling contact holds it)', async () => {
    const trace = {}
    const db = stubDb({
      groupId: 'g1', members: ['c1', 'c2'],
      contacts: [
        { id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' },
        { id: 'c2', glofox_member_id: '64aa00000000000000000002', location_id: 'loc1' },
      ],
      enrollments: [
        enrol({ id: 'old', contact_id: 'c1', enrolled_at: '2026-08-01T10:00:00.000Z', status: 'completed', metadata: { payment: payment({ invoice_id: 'inv-old', amount: '€99' }) } }),
        enrol({ id: 'new', contact_id: 'c2', enrolled_at: '2026-09-12T10:00:00.000Z' }),
      ],
      trace,
    })
    const res = await run(db)
    expect(res).toMatchObject({ has_reminder: true, status: 'active', amount: '€209' })
    expect(trace.enrolFilters.contact_id.sort()).toEqual(['c1', 'c2'])
    expect(trace.enrolOrder).toEqual({ col: 'enrolled_at', ascending: false })
    expect(trace.enrolLimit).toBe(1)
    // The Glofox check runs against the contact that OWNS the run, not the anchor.
    expect(getGlofoxOverdueInvoices).toHaveBeenCalledWith(CREDS, { memberId: '64aa00000000000000000002' })
  })

  it('person-group read failure falls back to the verified id alone', async () => {
    const trace = {}
    const db = stubDb({
      groupError: { message: 'pg down' },
      contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }],
      enrollments: [enrol()],
      trace,
    })
    const res = await run(db)
    expect(res.has_reminder).toBe(true)
    expect(trace.enrolFilters.contact_id).toEqual(['c1'])
  })

  it('selects only real sequence_enrollments columns — never created_at (ENROLFIX.1)', async () => {
    const trace = {}
    const db = stubDb({ contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }], trace })
    await run(db)
    expect(trace.enrolSelect).not.toMatch(/created_at/)
    for (const col of ['contact_id', 'status', 'exit_reason', 'enrolled_at', 'metadata']) {
      expect(trace.enrolSelect).toContain(col)
    }
    expect(trace.enrolFilters.source_type).toEqual(['invoice_past_due', 'churn_radar'])
  })

  it('a DB error returns a model-facing hand-off message, never throws, never leaks the raw error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = stubDb({
      contacts: [{ id: 'c1', glofox_member_id: MEMBER, location_id: 'loc1' }],
      enrolError: { message: 'relation "sequence_enrollments" violates policy xyz' },
    })
    const res = await run(db)
    expect(res.error).toBeTruthy()
    expect(res.error).toMatch(/hand off/i)
    expect(res.error).not.toContain('policy xyz')
    expect(res.has_reminder).toBeUndefined()
    spy.mockRestore()
  })
})
