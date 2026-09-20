// RUNWAY.1 — WHO gets the runway alert, exactly once, and under what subject.
//
// roster-runway-notify.test.js mocks the dedup sender, so it cannot see any of
// this. Here the arm runs against the REAL push-dedup (the push_event_sends
// claim ledger), the REAL resolveRoleRecipientIds (per-location role, active
// only, masters linked here), the REAL notifyUsers (the email fallback) and
// the REAL notifications registry. Only the edges are faked: the database,
// Expo (sendPush), Postmark (sendEmail) and the runway read.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { locations: [], links: [], claims: new Set(), tokens: [], profiles: [] }

function thenable(result) {
  return { then: (res, rej) => Promise.resolve(result).then(res, rej) }
}

const fakeDb = {
  from(table) {
    if (table === 'locations') {
      return { select: () => thenable({ data: state.locations, error: null }) }
    }
    if (table === 'profile_locations') {
      return {
        select: () => ({
          eq: (col, locationId) => {
            if (col !== 'location_id') throw new Error(`unexpected filter ${col}`)
            return thenable({ data: state.links.filter((l) => l.location_id === locationId), error: null })
          },
        }),
      }
    }
    if (table === 'push_event_sends') {
      return {
        upsert: (rows) => ({
          select: () => {
            const fresh = rows.filter((r) => !state.claims.has(`${r.event_key}|${r.recipient_id}`))
            fresh.forEach((r) => state.claims.add(`${r.event_key}|${r.recipient_id}`))
            return Promise.resolve({ data: fresh, error: null })
          },
        }),
        delete: () => ({
          eq: (_c, eventKey) => ({
            in: (_c2, ids) => {
              ids.forEach((id) => state.claims.delete(`${eventKey}|${id}`))
              return Promise.resolve({ error: null })
            },
          }),
        }),
      }
    }
    if (table === 'device_tokens') {
      return { select: () => ({ not: () => ({ in: (_c, ids) => thenable({ data: state.tokens.filter((t) => ids.includes(t.user_id)), error: null }) }) }) }
    }
    if (table === 'profiles') {
      return { select: () => ({ in: (_c, ids) => thenable({ data: state.profiles.filter((p) => ids.includes(p.id)), error: null }) }) }
    }
    throw new Error(`unexpected table ${table}`)
  },
}

vi.mock('./supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('./push', async (importOriginal) => {
  const real = await importOriginal()
  return {
    // REAL: who holds a publishing role AT this location is what is under test.
    resolveRoleRecipientIds: real.resolveRoleRecipientIds,
    sendPush: vi.fn(),
    // The per-category opt-out is push.js's own tested business; allow all.
    resolvePushAllowedIds: vi.fn(async (_db, ids) => new Set(ids)),
  }
})
vi.mock('./postmark', () => ({ sendEmail: vi.fn() }))
vi.mock('./roster-runway-data', () => ({ fetchRosterRunways: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const { sendPush } = await import('./push')
const { sendEmail } = await import('./postmark')
const { fetchRosterRunways } = await import('./roster-runway-data')
const { getNotificationCategory } = await import('./notifications-registry')
const { runRosterRunwayAlerts } = await import('./roster-runway-notify')

const NORTH = { id: 'loc-north', name: 'Studio North', timezone: 'Europe/Dublin' }
const SOUTH = { id: 'loc-south', name: 'Studio South', timezone: 'Europe/Dublin' } // another studio (and, here, another organisation)

const link = (profile_id, location_id, role, { profileRole = role, active = true } = {}) => ({
  profile_id, location_id, role, profiles: { id: profile_id, role: profileRole, active },
})

const AMBER = {
  weekStart: '2026-09-28', daysAway: 9, severity: 'amber',
  blocks: 34, staffed: 0, underMin: 0, published: 0, unstaffed: 34, unpublished: 34,
}
const RED = { ...AMBER, daysAway: 4, severity: 'red' }

const DAY_9 = Date.UTC(2026, 8, 19, 8, 0) // Sat 19 Sep, the 08:00 UTC tick
const DAY_4 = Date.UTC(2026, 8, 24, 8, 0) // Thu 24 Sep
const NIGHT_9 = Date.UTC(2026, 8, 19, 2, 20) // 03:20 in Dublin

const PUBLISHERS = ['owner-n', 'manager-n', 'headcoach-n', 'master-n']

const runwayIs = (runway) => fetchRosterRunways.mockResolvedValue({
  success: true,
  data: {
    byLocation: { [NORTH.id]: runway, [SOUTH.id]: null },
    weeksByLocation: { [NORTH.id]: runway ? [runway] : [], [SOUTH.id]: [] },
  },
})

beforeEach(() => {
  state.locations = [NORTH, SOUTH]
  state.links = [
    link('owner-n', NORTH.id, 'owner'),
    link('manager-n', NORTH.id, 'manager'),
    link('headcoach-n', NORTH.id, 'head_coach'),
    // A master's per-location row can say anything; mastership is profiles.role.
    link('master-n', NORTH.id, 'staff', { profileRole: 'master' }),
    link('coach-n', NORTH.id, 'staff'),
    link('reception-n', NORTH.id, 'reception'),
    link('exmanager-n', NORTH.id, 'manager', { active: false }),
    // Holds publishing roles, but only at the OTHER studio.
    link('manager-s', SOUTH.id, 'manager'),
    link('owner-s', SOUTH.id, 'owner'),
    link('master-s', SOUTH.id, 'owner', { profileRole: 'master' }),
    // Manager at South who is a plain coach at North.
    link('split-1', SOUTH.id, 'manager'),
    link('split-1', NORTH.id, 'staff'),
  ]
  state.claims = new Set()
  // manager-n has no device: the email fallback is their only channel.
  state.tokens = ['owner-n', 'headcoach-n', 'master-n'].map((user_id) => ({ user_id }))
  state.profiles = PUBLISHERS.map((id) => ({ id, full_name: `Person ${id}`, email: `${id}@example.test` }))
  sendPush.mockReset().mockImplementation(async (ids) => ({ sent: ids.length, skipped: 0, invalidated: 0, failed: 0 }))
  sendEmail.mockReset().mockResolvedValue({ ErrorCode: 0, MessageID: 'm-1' })
  fetchRosterRunways.mockReset()
  runwayIs(AMBER)
})

describe('roster runway push — recipients', () => {
  it('goes to exactly the people who can publish at THAT studio', async () => {
    await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 })
    expect(sendPush).toHaveBeenCalledTimes(1)
    const [ids, payload] = sendPush.mock.calls[0]
    expect([...ids].sort()).toEqual([...PUBLISHERS].sort())
    expect(payload.data).toEqual({ type: 'roster_runway', location_id: NORTH.id, week_start: '2026-09-28', severity: 'amber' })
  })

  it.each([
    ['a coach', 'coach-n'],
    ['reception', 'reception-n'],
    ['a deactivated manager', 'exmanager-n'],
    ['a manager of another studio', 'manager-s'],
    ['an owner of another studio', 'owner-s'],
    ['a master linked only to another studio', 'master-s'],
    ['a manager elsewhere who is a coach here', 'split-1'],
  ])('never %s', async (_who, id) => {
    await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 })
    expect(sendPush.mock.calls.flatMap(([ids]) => ids)).not.toContain(id)
    expect([...state.claims].some((c) => c.endsWith(`|${id}`))).toBe(false)
  })
})

// STAFFDELETE.1 (#1731) — a permanently deleted staff member is a TOMBSTONE:
// profiles.deleted_at is set, active is false, and their profile_locations
// rows are gone. Pinned through the real resolver both ways round: the state
// the delete really leaves (no link at all), and a stale link that somehow
// survived it (active=false is what keeps them out).
describe('roster runway push — tombstones', () => {
  it('a deleted owner never receives it, with or without a surviving link', async () => {
    const deletedAt = '2026-09-18T10:00:00Z'
    state.profiles.push(
      { id: 'owner-gone', full_name: 'Deleted staff member', email: 'owner-gone@example.test', deleted_at: deletedAt },
      { id: 'owner-stale', full_name: 'Deleted staff member', email: 'owner-stale@example.test', deleted_at: deletedAt },
    )
    // owner-gone: no profile_locations row, as the delete leaves it.
    state.links.push({
      profile_id: 'owner-stale', location_id: NORTH.id, role: 'owner',
      profiles: { id: 'owner-stale', role: 'owner', active: false, deleted_at: deletedAt },
    })

    await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 })

    const pushed = sendPush.mock.calls.flatMap(([ids]) => ids)
    expect([...pushed].sort()).toEqual([...PUBLISHERS].sort())
    for (const id of ['owner-gone', 'owner-stale']) {
      expect(pushed).not.toContain(id)
      expect([...state.claims].some((c) => c.endsWith(`|${id}`))).toBe(false)
      expect(sendEmail.mock.calls.map(([m]) => m.to)).not.toContain(`${id}@example.test`)
    }
  })
})

describe('roster runway push — the email fallback subject', () => {
  it('the trap is real: the schedule category emails, under a subject that says the opposite', () => {
    const entry = getNotificationCategory('schedule')
    expect(entry.fallbackEmail).toBe(true)
    expect(entry.emailSubject).toBe('Your schedule has been published')
  })

  it('a manager with no device is emailed under the ALERT\'s subject, never "has been published"', async () => {
    const outcome = await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 })
    expect(outcome).toMatchObject({ alerts: 1, sent: 4, emailed: 1 })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const mail = sendEmail.mock.calls[0][0]
    expect(mail.to).toBe('manager-n@example.test')
    expect(mail.subject).toBe('Studio North: week of 28 Sep is not ready')
    expect(mail.subject).not.toBe(getNotificationCategory('schedule').emailSubject)
    expect(mail.htmlBody).toContain('34 of 34 shifts have no coach')
    expect(mail.htmlBody).not.toMatch(/has been published/i)
  })
})

describe('roster runway push — once per studio, week and severity', () => {
  it('amber on day 9, silence on the re-run, red on day 4, silence again, and never another amber', async () => {
    await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 })
    expect(sendPush).toHaveBeenCalledTimes(1)

    // The same tick again (a retry, a second deploy): every claim exists.
    const rerun = await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 + 60_000 })
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(rerun).toMatchObject({ alerts: 1, sent: 0, emailed: 0, deduped: 4 })

    // Day 4, still unready: the amber claims must NOT block the red.
    runwayIs(RED)
    const red = await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_4 })
    expect(sendPush).toHaveBeenCalledTimes(2)
    expect(sendPush.mock.calls[1][1].data.severity).toBe('red')
    expect([...sendPush.mock.calls[1][0]].sort()).toEqual([...PUBLISHERS].sort())
    expect(red).toMatchObject({ sent: 4, deduped: 0 })

    const redAgain = await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_4 + 24 * 3600_000 })
    expect(sendPush).toHaveBeenCalledTimes(2)
    expect(redAgain).toMatchObject({ sent: 0, deduped: 4 })

    // A week's severity cannot go back to amber (shared/roster-runway.test.js),
    // but even if something upstream said it had, the amber is spent.
    runwayIs(AMBER)
    await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_4 + 2 * 24 * 3600_000 })
    expect(sendPush).toHaveBeenCalledTimes(2)
    expect(sendEmail).toHaveBeenCalledTimes(2) // one per severity, for the one person without a device
  })

  it('a publisher added after the first send gets theirs once; nobody else is re-sent', async () => {
    await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 })
    state.links.push(link('manager-new', NORTH.id, 'manager'))
    state.tokens.push({ user_id: 'manager-new' })
    await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 + 24 * 3600_000 })
    expect(sendPush).toHaveBeenCalledTimes(2)
    expect(sendPush.mock.calls[1][0]).toEqual(['manager-new'])
  })

  it('quiet hours claim NOTHING, so the next run inside the band still sends to everyone', async () => {
    const night = await runRosterRunwayAlerts(fakeDb, { nowMs: NIGHT_9 })
    expect(night).toMatchObject({ alerts: 1, quiet_hours: 1, sent: 0 })
    expect(sendPush).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
    expect(state.claims.size).toBe(0)

    const morning = await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 })
    expect(morning).toMatchObject({ sent: 4, emailed: 1, deduped: 0 })
  })

  it('a send that fails outright releases its claims, so tomorrow retries', async () => {
    sendPush.mockResolvedValueOnce({ sent: 0, skipped: 0, invalidated: 0, failed: 3 })
    sendEmail.mockResolvedValueOnce({ ErrorCode: 500 })
    await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 })
    expect(state.claims.size).toBe(0)
    const retry = await runRosterRunwayAlerts(fakeDb, { nowMs: DAY_9 + 24 * 3600_000 })
    expect(retry).toMatchObject({ sent: 4, deduped: 0 })
  })
})
