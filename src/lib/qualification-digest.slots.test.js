// TZ follow-up — the qualification digest acts for an organisation once a day,
// at its ANCHOR studio's daily slot (the lowest id: the studio whose zone is
// already the organisation's day, digestDaysByOrg). Driven here through the
// REAL daily-slot gate (DAILY_SLOTS['qualification-digest']) hour by hour, the
// way contract-reminders drives it, so an organisation whose studios span two
// zones is proved to get one run a day, not one per studio.
// The host zone is neither zone under test.
process.env.TZ = 'America/Los_Angeles'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./push-dedup', () => ({ notifyUsersOnce: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { notifyUsersOnce } = await import('./push-dedup')
const { mockDb, byTable } = await import('./qualifications-mock-db.test-helpers')
const { withSlotTables } = await import('./cron-daily-slot.test-helpers')
const { gateDailySlot, slotFor } = await import('./cron-daily-slot')
const { runQualificationDigest, digestAnchorsByOrg, digestDaysByOrg } = await import('./qualification-digest')

const HOUR = 3600_000
const ORG = 'org-span'
const ORG_DUB = 'org-dub'
const person = (id, full_name) => ({ id, full_name, role: 'staff', active: true, deleted_at: null })
const link = (profile_id, location_id, role) => ({ profile_id, location_id, role, profiles: person(profile_id, `Test ${profile_id}`) })

function world({ spanAnchor }) {
  // spanAnchor 'ny': the New York studio has the lower id, so it anchors the
  // spanning organisation; 'dub': the Dublin one does.
  const NY = { id: spanAnchor === 'ny' ? 'loc-a-ny' : 'loc-z-ny', name: 'Test NY', organization_id: ORG, timezone: 'America/New_York' }
  const DUB = { id: spanAnchor === 'ny' ? 'loc-z-dub' : 'loc-a-dub', name: 'Test Dublin', organization_id: ORG, timezone: 'Europe/Dublin' }
  const SOLO = { id: 'loc-m-solo', name: 'Test Solo', organization_id: ORG_DUB, timezone: 'Europe/Dublin' }
  const locations = [NY, DUB, SOLO]
  const links = [
    link('ny-owner', NY.id, 'owner'), link('ny-coach', NY.id, 'staff'),
    link('dub-owner', DUB.id, 'owner'), link('dub-coach', DUB.id, 'staff'),
    link('solo-owner', SOLO.id, 'owner'), link('solo-coach', SOLO.id, 'staff'),
  ]
  const types = [{ id: 'fa', organization_id: ORG, name: 'First aid', active: true }, { id: 'sfa', organization_id: ORG_DUB, name: 'First aid', active: true }]
  const records = [
    { id: 'r1', organization_id: ORG, profile_id: 'ny-coach', qualification_type_id: 'fa', expires_on: '2026-06-01' },
    { id: 'r2', organization_id: ORG, profile_id: 'dub-coach', qualification_type_id: 'fa', expires_on: '2026-06-01' },
    { id: 'r3', organization_id: ORG_DUB, profile_id: 'solo-coach', qualification_type_id: 'sfa', expires_on: '2026-06-01' },
  ]
  const claims = new Map()
  const db = withSlotTables(mockDb(byTable({
    locations: { data: locations, error: null },
    organizations: { data: [{ id: ORG, name: 'Span Co' }, { id: ORG_DUB, name: 'Solo Co' }], error: null },
    profile_locations: (q) => ({ data: links.filter((l) => q.filters.find((f) => f[1] === 'location_id')[2].includes(l.location_id)), error: null }),
    staff_qualification_types: (q) => ({ data: types.filter((t) => q.filters.find((f) => f[1] === 'organization_id')[2].includes(t.organization_id)), error: null }),
    staff_qualifications: (q) => ({ data: records.filter((r) => q.filters.find((f) => f[1] === 'organization_id')[2].includes(r.organization_id)), error: null }),
    'push_event_sends.select': { data: [], error: null },
    'push_event_sends.upsert': { data: null, error: null },
  })), { locations: locations.map(({ id, timezone }) => ({ id, timezone })), claims })
  return { db, NY, DUB, SOLO }
}

/** contract-reminders' arm, tick by tick: gate, then the digest for the claimed studios. */
async function runHours(db, fromIso, hours) {
  const runs = []
  for (let ms = Date.parse(fromIso); ms < Date.parse(fromIso) + hours * HOUR; ms += HOUR) {
    const gate = await gateDailySlot(db, 'qualification-digest', { nowMs: ms })
    if (gate.slots.size === 0) continue
    notifyUsersOnce.mockClear()
    const out = await runQualificationDigest(db, { nowMs: ms, isDue: (id) => !!slotFor(gate.slots, id) })
    if (out.organizations > 0) {
      runs.push({ at: new Date(ms).toISOString(), organizations: out.organizations, quiet_hours: out.quiet_hours, to: notifyUsersOnce.mock.calls.map((c) => c[2][0]).sort() })
    }
  }
  return runs
}

beforeEach(() => {
  notifyUsersOnce.mockReset().mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0, emailed: 0, email_failed: 0, deduped: 0 })
})

describe('digestAnchorsByOrg', () => {
  it('the anchor is the lowest-id studio, the one whose zone is the organisation day', () => {
    const { NY, DUB, SOLO } = world({ spanAnchor: 'ny' })
    const anchors = digestAnchorsByOrg([DUB, SOLO, NY])
    expect(anchors.get(ORG)).toBe(NY)
    expect(anchors.get(ORG_DUB)).toBe(SOLO)
    const ms = Date.parse('2026-07-01T03:00:00Z') // 23:00 on 30 Jun in New York
    expect(digestDaysByOrg([DUB, SOLO, NY], ms).get(ORG)).toBe('2026-06-30')
  })
})

describe('an organisation whose studios span two zones gets ONE digest run a day, at its anchor studio 08:00', () => {
  it('anchor in New York: 08:00 EDT/EST across the 1 Nov fall-back; Dublin-only org still at 08:00 UTC', async () => {
    const { db } = world({ spanAnchor: 'ny' })
    const runs = await runHours(db, '2026-10-31T00:00:00Z', 72)
    const span = runs.filter((r) => !r.to.includes('solo-owner'))
    expect(span.map((r) => r.at)).toEqual(['2026-10-31T12:00:00.000Z', '2026-11-01T13:00:00.000Z', '2026-11-02T13:00:00.000Z'])
    // 08:00 in New York is 12:00/13:00 in Dublin: both studios are inside the band, both owners hear.
    for (const r of span) expect(r.to).toEqual(['dub-owner', 'ny-owner'])
    const solo = runs.filter((r) => r.to.includes('solo-owner'))
    expect(solo.map((r) => r.at)).toEqual(['2026-10-31T08:00:00.000Z', '2026-11-01T08:00:00.000Z', '2026-11-02T08:00:00.000Z'])
    expect(runs).toHaveLength(6) // three days, two organisations, one run each a day
  })

  it('anchor in Dublin: the spanning organisation runs at 08:00 UTC only, once a day (the New York studio slot is not a second run)', async () => {
    const { db } = world({ spanAnchor: 'dub' })
    const runs = await runHours(db, '2026-07-01T00:00:00Z', 48)
    expect(runs.map((r) => [r.at, r.organizations])).toEqual([
      ['2026-07-01T08:00:00.000Z', 2], // Span Co (anchor Dublin) + Solo Co
      ['2026-07-02T08:00:00.000Z', 2],
    ])
    // 08:00 UTC is 04:00 in New York: that owner is held by quiet hours (as on
    // the old 08:00 UTC tick); the notice is held, nothing is claimed for it.
    for (const r of runs) expect(r.to).toEqual(['dub-owner', 'solo-owner'])
  })

  it('a duplicate invocation of the slot hour runs nobody a second time', async () => {
    const { db } = world({ spanAnchor: 'ny' })
    const first = await runHours(db, '2026-07-01T12:00:00Z', 1)
    expect(first).toHaveLength(1)
    expect(await runHours(db, '2026-07-01T12:00:00Z', 1)).toEqual([])
  })
})
