// MCPEMAIL.1 — POST /api/communications/campaigns/approve/[token]: the ONLY way
// an agent-prepared campaign is released. It must release exactly the content,
// audience and timing that were tested, exactly once, only for the person the
// approval was issued to. The real approval, view and release libs run here
// against an in-memory table store that evaluates the filters the way Postgres
// would, so a missing compare-and-set filter is a failing test, not a mock.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

let db
let user
let eligibleNow
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => user) }))
vi.mock('@/lib/permissions', () => ({
  hasPermissionForLocation: vi.fn((u, loc, key) => key === 'email' && (u?.emailAt || []).includes(loc)),
}))
vi.mock('@/lib/email-audience-counts', () => ({
  emailAudienceCounts: vi.fn(async () => ({
    matched: eligibleNow, eligible: eligibleNow, excluded: { not_opted_in: 0, bounced_or_complained: 0, suppressed: 0 },
  })),
}))
vi.mock('@/lib/from-address', () => ({ describeFromAddress: vi.fn(async () => ({ sends_as: 'hello@studio.test' })) }))
vi.mock('@/lib/usage-caps', () => ({ getEmailCapStatus: vi.fn(async () => ({ capped: false })) }))
vi.mock('@/lib/wallet-enforcement', () => ({ checkSpend: vi.fn(async () => ({ allow: true, reason: 'unpinned' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

import { POST } from './route.js'
import { campaignContentKey } from '@/lib/campaign-approval'
import { logError } from '@/lib/log'

const NOW = new Date('2026-11-12T10:00:00.000Z')
const LOC_A = 'a0000000-0000-4000-8000-00000000000a'
const LOC_B = 'b0000000-0000-4000-8000-00000000000b'
const CAMPAIGN_ID = 'c0000000-0000-4000-8000-000000000001'
const OWNER = '10000000-0000-4000-8000-000000000001'
const OTHER = '10000000-0000-4000-8000-000000000002'
const TOKEN = 'tok_owner_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_TOKEN = 'tok_other_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const READ_AT = '2026-11-12T09:00:00.000001+00:00'
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

// ── an in-memory table store that evaluates filters like Postgres ──────────
function cols(row, list) {
  if (!list || list === '*') return { ...row }
  return Object.fromEntries(list.split(',').map((c) => c.trim()).filter(Boolean).map((c) => [c, row[c]]))
}
function matches(row, [op, col, v]) {
  const x = row[col]
  if (op === 'eq') return x === v
  if (op === 'in') return v.includes(x)
  if (op === 'is') return v === null ? x === null || x === undefined : x === v
  if (op === 'gt') return x != null && Date.parse(x) > Date.parse(v)
  throw new Error(`unmodelled filter ${op}`)
}
let bumps = 0
function memDb(tables) {
  const calls = []
  const store = {
    calls,
    tables,
    beforeWrite: null, // (table, query) => void — lets a test land a concurrent edit
    writeError: null,  // (table, query) => error | null
    from(table) {
      const q = { table, op: 'select', columns: null, patch: null, filters: [] }
      const run = (terminal) => {
        calls.push({ ...q, terminal })
        if (q.op === 'update') {
          store.beforeWrite?.(table, q)
          const err = store.writeError?.(table, q)
          if (err) return { data: null, error: err }
        }
        const hit = (tables[table] || []).filter((r) => q.filters.every((f) => matches(r, f)))
        if (q.op === 'update') {
          for (const r of hit) {
            Object.assign(r, q.patch)
            // campaigns_updated_at (mig 005) bumps the version on every update.
            if (table === 'campaigns') r.updated_at = `2026-11-12T09:30:00.00000${++bumps}+00:00`
          }
          return { data: hit.map((r) => cols(r, q.columns)), error: null }
        }
        const rows = hit.map((r) => cols(r, q.columns))
        if (terminal === 'maybeSingle') return { data: rows[0] ?? null, error: null }
        return { data: rows, error: null }
      }
      const b = {
        select(c) { if (q.op === 'select' || q.columns === null) q.columns = c ?? '*'; return b },
        update(p) { q.op = 'update'; q.patch = p; return b },
        eq(c, v) { q.filters.push(['eq', c, v]); return b },
        in(c, v) { q.filters.push(['in', c, v]); return b },
        is(c, v) { q.filters.push(['is', c, v]); return b },
        gt(c, v) { q.filters.push(['gt', c, v]); return b },
        order() { return b },
        limit() { return b },
        maybeSingle() { return Promise.resolve(run('maybeSingle')) },
        then(res, rej) { return Promise.resolve(run('many')).then(res, rej) },
      }
      return b
    },
  }
  return store
}

const campaignRow = (over = {}) => ({
  id: CAMPAIGN_ID, location_id: LOC_A, name: 'November newsletter', status: 'draft', scheduled_at: null,
  updated_at: READ_AT, subject: 'News from the studio', preview_text: 'A short note', from_name: 'Test Studio',
  from_email: null, reply_to: null, html_content: '<p>Hello</p>',
  audience_filter: { logic: 'and', filters: [{ field: 'tag', op: 'eq', value: 'members' }] },
  postmark_stream: 'broadcast', ab_subject_b: null, ab_test_pct: 10, ab_wait_hours: 4, parent_campaign_id: null,
  last_error: null, cancel_requested_at: null, ...over,
})
const approvalRow = (over = {}) => ({
  id: 'ap000000-0000-4000-8000-000000000001', campaign_id: CAMPAIGN_ID, profile_id: OWNER,
  token_hash: sha256(TOKEN), content_key: campaignContentKey(campaignRow()), audience_eligible: 100,
  send_at: null, expires_at: '2026-11-13T09:00:00.000Z', used_at: null, voided_at: null,
  created_at: '2026-11-12T09:00:00.000Z', ...over,
})
function world({ campaign = {}, approval = {}, extraApprovals = [] } = {}) {
  return memDb({
    campaigns: [campaignRow(campaign)],
    campaign_release_approvals: [approvalRow(approval), ...extraApprovals],
    locations: [{ id: LOC_A, name: 'Test Studio', timezone: 'Europe/Dublin' }],
  })
}
const owner = (over = {}) => ({ id: OWNER, locations: [{ id: LOC_A }], emailAt: [LOC_A], ...over })

const press = (token = TOKEN, headers = {}) => POST(
  new Request(`http://test.local/api/communications/campaigns/approve/${token}`, { method: 'POST', headers }),
  { params: Promise.resolve({ token }) },
)
const campaign = () => db.tables.campaigns[0]
const approval = () => db.tables.campaign_release_approvals[0]
const campaignWrites = () => db.calls.filter((c) => c.table === 'campaigns' && c.op === 'update')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  user = owner()
  eligibleNow = 100
  db = world()
})
afterEach(() => { vi.useRealTimers() })

describe('POST /api/communications/campaigns/approve/[token]', () => {
  it('releases now when the approval has no send_at, and schedules at send_at when it has one', async () => {
    let res = await press()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { status: 'queued', scheduled_at: null } })
    expect(campaign().status).toBe('queued')
    expect(approval().used_at).toBe(NOW.toISOString())

    const SEND_AT = '2026-11-13T09:00:00.000Z'
    db = world({ approval: { send_at: SEND_AT, expires_at: '2026-11-14T09:00:00.000Z' } })
    res = await press()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { status: 'scheduled', scheduled_at: SEND_AT } })
    expect(campaign()).toMatchObject({ status: 'scheduled', scheduled_at: SEND_AT })
    // The compare-and-set names the statuses AND the version of the row whose content was checked.
    expect(campaignWrites()[0].filters).toEqual([
      ['eq', 'id', CAMPAIGN_ID], ['in', 'status', ['draft', 'scheduled']], ['eq', 'updated_at', READ_AT],
    ])
  })

  it('refuses when the campaign content changed since the test, and does not consume the approval', async () => {
    for (const change of [{ subject: 'A different subject' }, { html_content: '<p>Other</p>' }, { from_email: 'x@studio.test' },
      { audience_filter: { logic: 'and', filters: [{ field: 'tag', op: 'eq', value: 'everyone-else' }] } }]) {
      db = world({ campaign: change })
      const res = await press()
      expect(res.status, JSON.stringify(change)).toBe(409)
      expect((await res.json()).error).toMatch(/changed since the test/)
      expect(approval().used_at).toBeNull()
      expect(campaign().status).toBe('draft')
      expect(campaignWrites()).toEqual([])
    }
  })

  it('refuses a campaign that became an A/B test, a resend or a utility send, even when the content key still matches', async () => {
    const cases = [
      [{ ab_subject_b: 'Subject B' }, /subject A\/B test/],
      [{ parent_campaign_id: 'c0000000-0000-4000-8000-000000000009' }, /is a resend/],
      [{ postmark_stream: 'outbound' }, /not on the marketing stream/],
    ]
    for (const [change, words] of cases) {
      // The approval's key is taken over the changed row, so only the blocker stands in the way.
      db = world({ campaign: change, approval: { content_key: campaignContentKey(campaignRow(change)) } })
      const res = await press()
      expect(res.status, JSON.stringify(change)).toBe(409)
      expect((await res.json()).error).toMatch(words)
      expect(approval().used_at).toBeNull()
      expect(campaign().status).toBe('draft')
      expect(campaignWrites()).toEqual([])
    }
  })

  it('refuses when the A/B, resend or stream fields changed since the test (content key)', async () => {
    for (const change of [{ ab_test_pct: 50 }, { ab_wait_hours: 1 }]) {
      db = world({ campaign: change })
      const res = await press()
      expect(res.status, JSON.stringify(change)).toBe(409)
      expect((await res.json()).error).toMatch(/changed since the test/)
      expect(campaignWrites()).toEqual([])
    }
  })

  it('answers 404 for another signed-in person\'s token, identical to a random token', async () => {
    db = world({ extraApprovals: [approvalRow({ id: 'ap000000-0000-4000-8000-000000000002', profile_id: OTHER, token_hash: sha256(OTHER_TOKEN) })] })
    const theirs = await press(OTHER_TOKEN)
    const random = await press('tok_random_cccccccccccccccccccccccccccccccccc')
    expect(theirs.status).toBe(404)
    expect(random.status).toBe(404)
    expect(await theirs.json()).toEqual(await random.json())
    expect(db.tables.campaign_release_approvals.every((a) => a.used_at === null)).toBe(true)
    expect(campaignWrites()).toEqual([])
  })

  it('answers 404 when the person has no access to the campaign\'s studio, identical to a random token', async () => {
    user = owner({ locations: [{ id: LOC_B }], emailAt: [LOC_B] })
    const res = await press()
    const random = await press('tok_random_cccccccccccccccccccccccccccccccccc')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(await random.json())
    expect(approval().used_at).toBeNull()
  })

  it('a second press answers 409 and releaseCampaign is called once', async () => {
    expect((await press()).status).toBe(200)
    const again = await press()
    expect(again.status).toBe(409)
    expect((await again.json()).error).toMatch(/already been used/)
    expect(campaignWrites()).toHaveLength(1)
  })

  it('two presses at once: one releases, the other answers 409 and writes nothing', async () => {
    const [a, b] = await Promise.all([press(), press()])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(campaignWrites()).toHaveLength(1)
  })

  it('a press whose consume loses the race answers 409 "already approved" and never reaches the release', async () => {
    db.beforeWrite = (table, q) => {
      if (table === 'campaign_release_approvals' && 'used_at' in (q.patch || {})) {
        approval().used_at = '2026-11-12T09:59:59.000Z' // the other press spent it first
      }
    }
    const res = await press()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already approved/)
    expect(campaignWrites()).toEqual([])
    expect(campaign().status).toBe('draft')
  })

  it('a consume lost to a void or an expiry says which, and that this press sent nothing', async () => {
    const cases = [
      [{ voided_at: '2026-11-12T09:59:59.000Z' }, /withdrawn.*Nothing was sent by this press\./],
      [{ expires_at: '2026-11-12T09:59:59.000Z' }, /has expired/],
    ]
    for (const [landed, words] of cases) {
      db = world()
      db.beforeWrite = (table, q) => {
        if (table === 'campaign_release_approvals' && 'used_at' in (q.patch || {})) Object.assign(approval(), landed)
      }
      const res = await press()
      expect(res.status, JSON.stringify(landed)).toBe(409)
      const { error } = await res.json()
      expect(error).toMatch(words)
      expect(error).not.toMatch(/already approved/)
      expect(campaignWrites()).toEqual([])
      expect(campaign().status).toBe('draft')
    }
  })

  it('a release that errors after the consume says something went wrong and nothing was sent', async () => {
    db.writeError = (table) => (table === 'campaigns' ? { message: 'db down' } : null)
    const res = await press()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Something went wrong releasing the campaign. Nothing was sent. Ask Claude to send a new test.')
    expect(campaign().status).toBe('draft')
  })

  it('refuses when send_at has passed', async () => {
    db = world({ approval: { send_at: '2026-11-12T09:59:00.000Z' } })
    const res = await press()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/has passed/)
    expect(approval().used_at).toBeNull()
    expect(campaignWrites()).toEqual([])
  })

  it('refuses when the audience grew from 100 to 130, passes at 100 to 105', async () => {
    eligibleNow = 130
    let res = await press()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/grown from 100 to 130/)
    expect(approval().used_at).toBeNull()
    expect(campaignWrites()).toEqual([])

    eligibleNow = 105
    res = await press()
    expect(res.status).toBe(200)
  })

  it('refuses when nobody can be emailed any more', async () => {
    eligibleNow = 0
    const res = await press()
    expect(res.status).toBe(409)
    expect(approval().used_at).toBeNull()
    expect(campaignWrites()).toEqual([])
  })

  it('refuses a person who has lost the email permission since the test', async () => {
    user = owner({ emailAt: [] })
    const res = await press()
    expect(res.status).toBe(403)
    expect(approval().used_at).toBeNull()
    expect(campaign().status).toBe('draft')
    expect(campaignWrites()).toEqual([])
  })

  it('refuses a "View as" (impersonated) or support session with 403 before any approval lookup', async () => {
    for (const over of [
      { impersonatingFrom: { masterId: OTHER, masterName: 'Master', masterEmail: 'm@x.test' } },
      { supportSession: { mode: 'act_on_behalf', organizationId: 'org-1', impersonatedUserId: OWNER } },
    ]) {
      db = world()
      user = owner(over)
      const res = await press()
      expect(res.status, JSON.stringify(over)).toBe(403)
      const body = await res.json()
      expect(body.error).toMatch(/your own session/)
      expect(JSON.stringify(body)).not.toMatch(/November newsletter|News from the studio/)
      expect(db.calls.filter((c) => c.table === 'campaign_release_approvals')).toEqual([])
      expect(db.calls.filter((c) => c.table === 'campaigns')).toEqual([])
      expect(approval().used_at).toBeNull()
      expect(campaign().status).toBe('draft')
    }
  })

  it('refuses an OAuth-issued bearer (no cookie session) with 401', async () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ sub: OWNER, client_id: 'mcp-client' })).toString('base64url'), 'sig'].join('.')
    user = null
    let res = await press(TOKEN, { authorization: `Bearer ${jwt}` })
    expect(res.status).toBe(401)
    // Cookie session only: a Bearer header is refused even beside a session.
    user = owner()
    res = await press(TOKEN, { authorization: `Bearer ${jwt}` })
    expect(res.status).toBe(401)
    user = null
    res = await press()
    expect(res.status).toBe(401)
    expect(approval().used_at).toBeNull()
    expect(campaignWrites()).toEqual([])
  })

  it('refuses a campaign that is no longer draft or scheduled', async () => {
    for (const status of ['queued', 'sending', 'sent', 'cancelled', 'failed']) {
      db = world({ campaign: { status } })
      const res = await press()
      expect(res.status, status).toBe(409)
      expect(approval().used_at).toBeNull()
      expect(campaign().status).toBe(status)
      expect(campaignWrites()).toEqual([])
    }
  })

  it('an edit that lands after the content check makes the release touch no row; nothing is sent; the person is told to ask for a new test', async () => {
    db.beforeWrite = (table) => {
      if (table !== 'campaigns') return
      // An agent edit lands between the route's content check and its release write.
      Object.assign(campaign(), { html_content: '<p>Untested</p>', updated_at: '2026-11-12T09:45:00.000000+00:00' })
      db.beforeWrite = null
    }
    const res = await press()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/new test/)
    expect(campaign().status).toBe('draft')
    expect(campaignWrites()).toHaveLength(1)
    // The approval stays spent: a spent approval with no send is the safe failure.
    expect(approval().used_at).toBe(NOW.toISOString())
  })

  it('voids any other live approval after a release; a failed void is logged and does not fail the press', async () => {
    db.writeError = (table, q) => (table === 'campaign_release_approvals' && 'voided_at' in (q.patch || {}) ? { message: 'void down' } : null)
    const res = await press()
    expect(res.status).toBe(200)
    expect(campaign().status).toBe('queued')
    expect(logError).toHaveBeenCalledTimes(1)
    expect(db.calls.some((c) => c.table === 'campaign_release_approvals' && c.op === 'update' && 'voided_at' in c.patch)).toBe(true)
  })
})
