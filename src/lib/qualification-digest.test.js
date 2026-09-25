// QUALS.1 — the weekly qualification digest: who gets one (owners, and
// masters linked to a studio; never another organisation's people), what it
// lists, quiet hours, the weekly claim key, the run's reads, and its failure
// posture (a read failure throws before anything is sent; one recipient's
// failure costs nobody else theirs).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./push-dedup', () => ({ notifyUsersOnce: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { notifyUsersOnce } = await import('./push-dedup')
const { logWarn } = await import('./log')
const { mockDb, byTable, filter } = await import('./qualifications-mock-db.test-helpers')
const {
  QUALIFICATION_DIGEST_CATEGORY, QUALIFICATION_DIGEST_TYPE,
  digestEventKey, digestAttemptKey, planQualificationDigests, runQualificationDigest, digestEmailHtml,
} = await import('./qualification-digest')

const ORG = 'org-1'
const ORG2 = 'org-2'
const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const GARAGE = 'loc-garage'
const LOCATIONS = [
  { id: STILL, name: 'Stillorgan', organization_id: ORG, timezone: 'Europe/Dublin' },
  { id: HATCH, name: 'Hatch Street', organization_id: ORG, timezone: null },
  { id: GARAGE, name: 'Garage', organization_id: ORG2, timezone: 'Europe/Dublin' },
]
const ORGS = [{ id: ORG, name: 'Studio Group' }, { id: ORG2, name: 'Garage Co' }]
const person = (id, full_name, over = {}) => ({ id, full_name, role: 'staff', active: true, deleted_at: null, ...over })
const link = (profile_id, location_id, role, profile) => ({ profile_id, location_id, role, profiles: profile })
const LINKS = [
  link('owner', STILL, 'owner', person('owner', 'Olive Owner')),
  link('owner', HATCH, 'staff', person('owner', 'Olive Owner')), // owner at Stillorgan only
  link('master', STILL, 'manager', person('master', 'Max Master', { role: 'master' })), // a linked master is a recipient
  link('ann', STILL, 'staff', person('ann', 'Ann Coach')),
  link('bob', HATCH, 'staff', person('bob', 'Bob Coach')),
  link('howner', HATCH, 'owner', person('howner', 'Hattie Owner')),
  link('off', STILL, 'owner', person('off', 'Off Owner', { active: false })), // deactivated: nobody
  link('gone', STILL, 'staff', person('gone', 'Gone Coach', { active: false, deleted_at: '2026-09-01T00:00:00Z' })),
  link('gowner', GARAGE, 'owner', person('gowner', 'Gary Garage')),
]
const TYPES = [
  { id: 'fa', organization_id: ORG, name: 'First aid', active: true },
  { id: 'ins', organization_id: ORG, name: 'Insurance', active: true },
  { id: 'old', organization_id: ORG, name: 'Old cert', active: false },
  { id: 'gfa', organization_id: ORG2, name: 'First aid', active: true },
]
const rec = (profile_id, qualification_type_id, expires_on, organization_id = ORG) =>
  ({ id: `${profile_id}-${qualification_type_id}`, organization_id, profile_id, qualification_type_id, expires_on })
const RECORDS = [
  rec('ann', 'fa', '2026-09-20'), // expired
  rec('ann', 'ins', '2026-10-20'), // expiring
  rec('bob', 'fa', '2026-10-05'), // expiring (Hatch Street)
  rec('ann', 'old', '2026-09-01'), // archived type: never reported
  rec('gone', 'fa', '2026-09-01'), // a tombstone: never reported
]
const TODAY = '2026-09-28' // a Monday
const MON_0800Z = Date.parse('2026-09-28T08:00:00Z') // 09:00 in Dublin
const input = (over = {}) => ({
  locations: LOCATIONS, organizations: ORGS, links: LINKS, types: TYPES, records: RECORDS,
  todayISO: TODAY, nowMs: MON_0800Z, ...over,
})
const summary = (plans) => plans.map((pl) => [pl.recipientId, pl.organizationId, pl.rows.map((r) => `${r.profile_id}:${r.type_id}:${r.status}`)])

describe('planQualificationDigests', () => {
  it('one digest per recipient per organisation, listing only the people at the studios where THEY qualify', () => {
    const out = planQualificationDigests(input())
    expect(summary(out.plans)).toEqual([
      ['howner', ORG, ['bob:fa:expiring']],
      ['master', ORG, ['ann:fa:expired', 'ann:ins:expiring']],
      ['owner', ORG, ['ann:fa:expired', 'ann:ins:expiring']],
    ])
    expect(out).toMatchObject({ recipients: 4, nothing_due: 1, quiet_hours: 0, timezoneFallbackLocationIds: [] })
  })

  it('the payload: the registered category, the weekly key, a headline push, the list in the email', () => {
    const plan = planQualificationDigests(input()).plans.find((pl) => pl.recipientId === 'owner')
    expect(plan.eventKey).toBe('qualification_digest:org-1:2026-09-28')
    expect(plan.eventKey).toBe(digestEventKey(ORG, '2026-09-28'))
    // The attempt key is fresh each day; the week key is only ever stamped.
    expect(plan.attemptKey).toBe('qualification_digest:org-1:2026-09-28:d2026-09-28')
    expect(plan.attemptKey).toBe(digestAttemptKey(ORG, '2026-09-28', '2026-09-28'))
    expect(plan.payload).toMatchObject({
      title: 'Qualifications to renew',
      body: '1 qualification has expired and 1 more expires in the next 30 days. The list is under Schedule, Qualifications on the web.',
      category: QUALIFICATION_DIGEST_CATEGORY,
      emailSubject: 'Qualifications to renew at Studio Group',
      data: { type: QUALIFICATION_DIGEST_TYPE, organization_id: ORG, week_start: '2026-09-28' },
    })
    expect(plan.payload.emailHtml).toContain('Ann Coach')
    expect(plan.payload.emailHtml).toContain('Expired 20 Sep 2026')
    expect(plan.payload.emailHtml).toContain('Expires 20 Oct 2026')
  })

  it('the key is the Monday of the Dublin week, whichever day the run finds something', () => {
    const sunday = planQualificationDigests(input({ todayISO: '2026-10-04', nowMs: Date.parse('2026-10-04T08:00:00Z') }))
    expect(sunday.plans.map((pl) => pl.eventKey)).toEqual(Array(3).fill('qualification_digest:org-1:2026-09-28'))
    expect(sunday.plans.map((pl) => pl.attemptKey)).toEqual(Array(3).fill('qualification_digest:org-1:2026-09-28:d2026-10-04'))
  })

  it('quiet hours: outside 07:00-22:00 at any studio a list covers, nothing is planned, so nothing is claimed', () => {
    const late = planQualificationDigests(input({ nowMs: Date.parse('2026-09-28T21:30:00Z') })) // 22:30 Dublin
    expect(late.plans).toEqual([])
    expect(late.quiet_hours).toBe(3)
  })

  it('an unreadable studio timezone reads as Dublin and is reported once', () => {
    const odd = planQualificationDigests(input({ locations: LOCATIONS.map((l) => (l.id === HATCH ? { ...l, timezone: 'Mars/Base' } : l)) }))
    expect(odd.plans).toHaveLength(3)
    expect(odd.timezoneFallbackLocationIds).toEqual([HATCH])
  })

  it('nothing expired or expiring: no plan at all (a quiet week sends nothing)', () => {
    const out = planQualificationDigests(input({ records: [rec('ann', 'fa', '2027-06-01')] }))
    expect(out.plans).toEqual([])
    expect(out.nothing_due).toBe(4)
  })

  it('escapes what people typed', () => {
    const html = digestEmailHtml({ orgName: 'A & B', headline: '1 qualification has expired.', rows: [{ full_name: '<b>Eve</b>', type_name: 'First aid', expires_on: '2026-09-01', status: 'expired' }] })
    expect(html).toContain('&lt;b&gt;Eve&lt;/b&gt;')
    expect(html).toContain('A &amp; B')
    expect(html).not.toContain('<b>Eve</b>')
  })
})

describe('runQualificationDigest', () => {
  const runDb = (over = {}) => mockDb(byTable({
    locations: { data: LOCATIONS, error: null },
    organizations: { data: ORGS, error: null },
    profile_locations: { data: LINKS, error: null },
    staff_qualification_types: { data: TYPES.filter((t) => t.active), error: null },
    staff_qualifications: { data: RECORDS, error: null },
    'push_event_sends.select': { data: [], error: null },
    'push_event_sends.upsert': { data: null, error: null },
    ...over,
  }))
  const WEEK = 'qualification_digest:org-1:2026-09-28'
  const ATTEMPT = 'qualification_digest:org-1:2026-09-28:d2026-09-28'
  const stamps = (db) => db.log.filter((q) => q.table === 'push_event_sends' && q.op === 'upsert')

  beforeEach(() => {
    notifyUsersOnce.mockReset().mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0, emailed: 0, email_failed: 0, deduped: 0 })
  })

  it('reads active studios, their links, active types, records expiring by today + 30 and the week\'s stamps; one attempt per recipient', async () => {
    const db = runDb()
    const out = await runQualificationDigest(db, { nowMs: MON_0800Z })
    const locQ = db.log.find((q) => q.table === 'locations')
    expect(filter(locQ, 'eq', 'active')).toBe(true)
    expect(filter(locQ, 'eq', 'is_host_anchor')).toBe(false)
    const recQ = db.log.find((q) => q.table === 'staff_qualifications')
    expect(filter(recQ, 'lte', 'expires_on')).toBe('2026-10-28')
    expect(filter(recQ, 'in', 'organization_id')).toEqual([ORG, ORG2])
    expect(filter(db.log.find((q) => q.table === 'profile_locations'), 'in', 'location_id')).toEqual([STILL, HATCH, GARAGE])
    expect(filter(db.log.find((q) => q.table === 'staff_qualification_types'), 'eq', 'active')).toBe(true)
    expect(filter(db.log.find((q) => q.table === 'push_event_sends' && q.op === 'select'), 'in', 'event_key')).toEqual([WEEK])
    expect(notifyUsersOnce.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [ATTEMPT, ['howner']],
      [ATTEMPT, ['master']],
      [ATTEMPT, ['owner']],
    ])
    expect(out).toEqual({
      organizations: 2, recipients: 4, rows: 5, nothing_due: 1, quiet_hours: 0,
      sent: 3, emailed: 0, email_failed: 0, deduped: 0, failed: 0, stamp_failed: 0,
    })
  })

  it('stamps the WEEK key only AFTER a send that did not fail outright', async () => {
    const db = runDb()
    const stampsSeenAtSend = []
    notifyUsersOnce.mockImplementation(async () => {
      stampsSeenAtSend.push(stamps(db).length)
      return { sent: 1, failed: 0, emailed: 0, email_failed: 0, deduped: 0 }
    })
    await runQualificationDigest(db, { nowMs: MON_0800Z })
    expect(stampsSeenAtSend).toEqual([0, 1, 2])
    expect(stamps(db).map((q) => q.payload)).toEqual([
      { event_key: WEEK, recipient_id: 'howner' },
      { event_key: WEEK, recipient_id: 'master' },
      { event_key: WEEK, recipient_id: 'owner' },
    ])
    expect(stamps(db)[0].options).toEqual({ onConflict: 'event_key,recipient_id', ignoreDuplicates: true })
  })

  it('a push or an email fallback that LANDED stamps the week', async () => {
    notifyUsersOnce
      .mockResolvedValueOnce({ sent: 0, failed: 1, emailed: 1, email_failed: 0, deduped: 0 }) // push failed, email landed
      .mockResolvedValueOnce({ sent: 1, failed: 0, emailed: 0, email_failed: 0, deduped: 0 })
      .mockResolvedValueOnce({ sent: 0, failed: 0, emailed: 1, email_failed: 0, deduped: 0 })
    const db = runDb()
    const out = await runQualificationDigest(db, { nowMs: MON_0800Z })
    expect(stamps(db).map((q) => q.payload.recipient_id)).toEqual(['howner', 'master', 'owner'])
    expect(out).toMatchObject({ sent: 1, emailed: 2, stamp_failed: 0 })
  })

  // QUALS.1 review — the week is stamped ONLY when something was delivered.
  // Anything else costs a harmless daily attempt row, never the week.
  it('a FAILED email fallback does not stamp: the next day retries', async () => {
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, failed: 0, emailed: 0, email_failed: 1, deduped: 0 })
    const db = runDb()
    const out = await runQualificationDigest(db, { nowMs: MON_0800Z })
    expect(stamps(db).map((q) => q.payload.recipient_id)).toEqual(['master', 'owner'])
    expect(out).toMatchObject({ email_failed: 1, sent: 2 })
  })

  it('a send that threw inside push-dedup (reported as failed, nothing delivered) does not stamp', async () => {
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, skipped: 0, invalidated: 0, failed: 1, deduped: 0 })
    const db = runDb()
    const out = await runQualificationDigest(db, { nowMs: MON_0800Z })
    expect(stamps(db).map((q) => q.payload.recipient_id)).toEqual(['master', 'owner'])
    expect(out).toMatchObject({ failed: 1, sent: 2 })
  })

  it('nothing delivered and nothing failed (no device, fallback off or opted out) does not stamp either', async () => {
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, failed: 0, emailed: 0, email_failed: 0, deduped: 0 })
    const db = runDb()
    await runQualificationDigest(db, { nowMs: MON_0800Z })
    expect(stamps(db).map((q) => q.payload.recipient_id)).toEqual(['master', 'owner'])
  })

  it('a recipient already stamped this week is not sent again', async () => {
    const db = runDb({ 'push_event_sends.select': { data: [{ id: 's1', event_key: WEEK, recipient_id: 'master' }], error: null } })
    const out = await runQualificationDigest(db, { nowMs: MON_0800Z })
    expect(notifyUsersOnce.mock.calls.map((c) => c[2])).toEqual([['howner'], ['owner']])
    expect(stamps(db).map((q) => q.payload.recipient_id)).toEqual(['howner', 'owner'])
    expect(out).toMatchObject({ sent: 2, deduped: 1, rows: 3 })
  })

  it('an outright failure is NOT stamped, so the next day retries', async () => {
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, failed: 1, emailed: 0, email_failed: 0, deduped: 0 })
    const db = runDb()
    const out = await runQualificationDigest(db, { nowMs: MON_0800Z })
    expect(stamps(db).map((q) => q.payload.recipient_id)).toEqual(['master', 'owner'])
    expect(out).toMatchObject({ failed: 1, sent: 2 })
  })

  it('an attempt deduped against a concurrent run (it holds today\'s claim) is not stamped by this run', async () => {
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, failed: 0, emailed: 0, email_failed: 0, deduped: 1 })
    const db = runDb()
    const out = await runQualificationDigest(db, { nowMs: MON_0800Z })
    expect(stamps(db).map((q) => q.payload.recipient_id)).toEqual(['master', 'owner'])
    expect(out).toMatchObject({ deduped: 1, sent: 2 })
  })

  it('a lost stamp is logged and counted (a duplicate tomorrow, never a loss), and costs nobody else anything', async () => {
    let n = 0
    const db = runDb({ 'push_event_sends.upsert': () => (n++ === 0 ? { data: null, error: { message: 'ledger down' } } : { data: null, error: null }) })
    const out = await runQualificationDigest(db, { nowMs: MON_0800Z })
    expect(notifyUsersOnce).toHaveBeenCalledTimes(3)
    expect(out).toMatchObject({ sent: 3, stamp_failed: 1 })
    expect(logWarn).toHaveBeenCalledWith('qualification-digest', expect.stringMatching(/week stamp failed/), expect.objectContaining({ recipientId: 'howner' }))
  })

  it('quiet hours: nothing is read from the ledger, sent or stamped', async () => {
    const db = runDb()
    const out = await runQualificationDigest(db, { nowMs: Date.parse('2026-09-28T21:30:00Z') })
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(db.log.some((q) => q.table === 'push_event_sends')).toBe(false)
    expect(out).toMatchObject({ quiet_hours: 3, sent: 0 })
  })

  it('one recipient failing costs nobody else their digest', async () => {
    notifyUsersOnce.mockRejectedValueOnce(new Error('expo down'))
    const db = runDb()
    const out = await runQualificationDigest(db, { nowMs: MON_0800Z })
    expect(notifyUsersOnce).toHaveBeenCalledTimes(3)
    expect(out).toMatchObject({ failed: 1, sent: 2 })
    expect(stamps(db).map((q) => q.payload.recipient_id)).toEqual(['master', 'owner'])
    expect(logWarn).toHaveBeenCalledWith('qualification-digest', 'send failed for a recipient', expect.anything())
  })

  it.each(['locations', 'organizations', 'profile_locations', 'staff_qualification_types', 'staff_qualifications', 'push_event_sends.select'])(
    'a failed %s read throws before anything is sent (the cron records it; the heartbeat is not stamped)', async (table) => {
      await expect(runQualificationDigest(runDb({ [table]: { data: null, error: { message: 'down' } } }), { nowMs: MON_0800Z }))
        .rejects.toThrow(/read failed/)
      expect(notifyUsersOnce).not.toHaveBeenCalled()
    })

  it('no studios: a clean, empty outcome', async () => {
    const out = await runQualificationDigest(runDb({ locations: { data: [], error: null } }), { nowMs: MON_0800Z })
    expect(out).toMatchObject({ organizations: 0, recipients: 0, sent: 0 })
  })
})
