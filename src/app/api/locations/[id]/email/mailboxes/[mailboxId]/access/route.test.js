// EMAIL-MAILBOX-ADMIN.1 — granting and revoking one account.
//
// THE HOLE THIS FEATURE COULD HAVE OPENED
// A manager holds `email_inbox`, sees the inbox, and is NOT elevated. If this
// route were gated on the surface permission — the obvious-looking choice —
// a manager could grant THEMSELVES `accounts@` and read the studio's billing
// correspondence. Every refusal test asserts no row was written, because a
// 403 returned after the insert is still a breach.
//
// The grant/revoke tests assert through visibleMailboxes — the SAME function
// the ticket queue calls — rather than by inspecting the row. A test that only
// checks "the row is gone" passes even if the read path stops consulting
// grants entirely.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { PUT } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, insertsInto, deletesFrom, writesTo } from '@/app/api/email/tickets/_test-db'
import { visibleMailboxes } from '@/lib/email-mailboxes'
import {
  LOC_A, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION,
  OWNER_A, OWNER_B, MANAGER_A, MASTER, COACH_A, adminState,
} from '../../_test-fixtures'

const propsFor = (mailboxId) => ({ params: { id: LOC_A, mailboxId } })

const putReq = (body) => new Request(`http://x/api/locations/${LOC_A}/email/mailboxes/m/access`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

async function setAccess(mailboxId, profileId, granted) {
  const res = await PUT(putReq({ profile_id: profileId, granted }), propsFor(mailboxId))
  return { res, body: await res.json() }
}

/** What the coach's inbox would actually show, via the real read path. */
function coachSees() {
  const mine = db._state.grants.filter(g => g.profile_id === COACH_A.id).map(g => g.mailbox_id)
  const atLocA = db._state.mailboxes.filter(m => m.location_id === LOC_A)
  return visibleMailboxes(atLocA, { isElevated: false, grantedMailboxIds: mine }).map(m => m.id)
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER_A)
  setupDb(adminState())
})

describe('PUT access — the gate', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await setAccess(MB_STUDIO.id, COACH_A.id, true)).res.status).toBe(401)
    expect(writesTo(db)).toEqual([])
  })

  it('REFUSES A MANAGER GRANTING THEMSELVES accounts@ — the exact hole', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const { res, body } = await setAccess(MB_ACCOUNTS.id, MANAGER_A.id, true)
    expect(res.status).toBe(403)
    expect(body.error).toMatch(/owner of this studio/i)

    // No row, anywhere.
    expect(writesTo(db)).toEqual([])
    expect(db._state.grants).toEqual([])

    // …and the read path agrees they still cannot see it.
    const theirs = visibleMailboxes(
      db._state.mailboxes.filter(m => m.location_id === LOC_A),
      { isElevated: false, grantedMailboxIds: db._state.grants.filter(g => g.profile_id === MANAGER_A.id).map(g => g.mailbox_id) }
    )
    expect(theirs).toEqual([])
  })

  it('refuses a manager granting a third party too', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await setAccess(MB_STUDIO.id, COACH_A.id, true)).res.status).toBe(403)
    expect(writesTo(db)).toEqual([])
  })

  it('refuses a manager REVOKING an existing grant', async () => {
    setupDb(adminState({ grants: [{ mailbox_id: MB_STUDIO.id, profile_id: COACH_A.id, granted_by: OWNER_A.id }] }))
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await setAccess(MB_STUDIO.id, COACH_A.id, false)).res.status).toBe(403)
    expect(deletesFrom(db, 'email_mailbox_access')).toEqual([])
    expect(coachSees()).toEqual([MB_STUDIO.id])
  })

  it('refuses an owner of a DIFFERENT studio', async () => {
    getCurrentUser.mockResolvedValue(OWNER_B)
    const { res } = await setAccess(MB_STUDIO.id, COACH_A.id, true)
    expect(res.status).toBe(403)
    expect(writesTo(db)).toEqual([])
  })

  it('404s for another studio’s mailbox, so ids stay unprobeable', async () => {
    const { res } = await setAccess(MB_OTHER_LOCATION.id, COACH_A.id, true)
    expect(res.status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  it('ALLOWS the owner at this location, and master', async () => {
    expect((await setAccess(MB_STUDIO.id, COACH_A.id, true)).res.status).toBe(200)
    setupDb(adminState())
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await setAccess(MB_STUDIO.id, COACH_A.id, true)).res.status).toBe(200)
  })
})

describe('PUT access — grant then revoke, proved through the read path', () => {
  it('a grant makes exactly that one mailbox visible', async () => {
    expect(coachSees()).toEqual([])

    const { res } = await setAccess(MB_STUDIO.id, COACH_A.id, true)
    expect(res.status).toBe(200)
    expect(coachSees()).toEqual([MB_STUDIO.id])
    // studio@ does NOT bring accounts@ with it.
    expect(coachSees()).not.toContain(MB_ACCOUNTS.id)
  })

  it('a revoke takes it away again', async () => {
    await setAccess(MB_STUDIO.id, COACH_A.id, true)
    expect(coachSees()).toEqual([MB_STUDIO.id])

    const { res, body } = await setAccess(MB_STUDIO.id, COACH_A.id, false)
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ granted: false, changed: true })
    expect(coachSees()).toEqual([])
    expect(db._state.grants).toEqual([])
  })

  it('revoking one account leaves the other in place', async () => {
    await setAccess(MB_STUDIO.id, COACH_A.id, true)
    await setAccess(MB_ACCOUNTS.id, COACH_A.id, true)
    expect(coachSees().sort()).toEqual([MB_ACCOUNTS.id, MB_STUDIO.id].sort())

    await setAccess(MB_ACCOUNTS.id, COACH_A.id, false)
    expect(coachSees()).toEqual([MB_STUDIO.id])
  })

  it('stamps granted_by with the acting user', async () => {
    await setAccess(MB_STUDIO.id, COACH_A.id, true)
    const payload = insertsInto(db, 'email_mailbox_access')[0].payload
    expect(payload).toMatchObject({
      mailbox_id: MB_STUDIO.id,
      profile_id: COACH_A.id,
      granted_by: OWNER_A.id,
    })
  })

  it('is idempotent in both directions — no duplicate row, no phantom delete', async () => {
    await setAccess(MB_STUDIO.id, COACH_A.id, true)
    const second = await setAccess(MB_STUDIO.id, COACH_A.id, true)
    expect(second.res.status).toBe(200)
    expect(second.body.data).toEqual({ granted: true, changed: false })
    expect(insertsInto(db, 'email_mailbox_access')).toHaveLength(1)
    expect(db._state.grants).toHaveLength(1)

    await setAccess(MB_STUDIO.id, COACH_A.id, false)
    const again = await setAccess(MB_STUDIO.id, COACH_A.id, false)
    expect(again.body.data.changed).toBe(false)
    expect(deletesFrom(db, 'email_mailbox_access')).toHaveLength(1)
  })
})

describe('PUT access — who can be a grantee', () => {
  it('refuses someone who does not work at this studio', async () => {
    // OWNER_B is a real profile — just not here. Same answer as an id that
    // does not exist, so nothing is enumerable.
    const { res, body } = await setAccess(MB_STUDIO.id, OWNER_B.id, true)
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/not an active staff member at this studio/i)
    expect(writesTo(db)).toEqual([])

    const unknown = await setAccess(MB_STUDIO.id, '99999999-9999-4999-8999-999999999999', true)
    expect(unknown.res.status).toBe(400)
    expect(unknown.body.error).toBe(body.error)
  })

  it('EXPLAINS rather than silently no-opping when asked to grant an owner', async () => {
    // Elevation lives in code, not rows. A silent no-op would have the
    // operator toggling an owner and watching nothing happen.
    const { res, body } = await setAccess(MB_ACCOUNTS.id, OWNER_A.id, true)
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/already read every account/i)
    expect(writesTo(db)).toEqual([])
  })

  it('refuses to REVOKE an owner for the same reason', async () => {
    const { res, body } = await setAccess(MB_ACCOUNTS.id, OWNER_A.id, false)
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/cannot be granted or revoked/i)
    expect(writesTo(db)).toEqual([])
  })

  it('refuses to grant a master, who is elevated everywhere', async () => {
    const state = adminState()
    state.profileLocations.push({ profile_id: MASTER.id, location_id: LOC_A, role: 'staff' })
    setupDb(state)
    const { res, body } = await setAccess(MB_ACCOUNTS.id, MASTER.id, true)
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/master admins/i)
  })
})

describe('PUT access — audit', () => {
  it('records the grant with the actor, the grantee and the account', async () => {
    await setAccess(MB_ACCOUNTS.id, COACH_A.id, true)
    const audits = insertsInto(db, 'audit_events')
    expect(audits).toHaveLength(1)
    expect(audits[0].payload.action).toBe('email_mailbox_access.granted')
    expect(audits[0].payload.actor_id).toBe(OWNER_A.id)
    // The target IS a profile here, so target_profile_id is legitimate.
    expect(audits[0].payload.target_profile_id).toBe(COACH_A.id)
    expect(audits[0].payload.target_resource).toBe(`email_mailbox/${MB_ACCOUNTS.id}`)
    expect(audits[0].payload.details.mailbox_address).toBe(MB_ACCOUNTS.address)
    expect(audits[0].payload.location_id).toBe(LOC_A)
  })

  it('records the REVOKE — otherwise nothing anywhere remembers it happened', async () => {
    setupDb(adminState({ grants: [{ mailbox_id: MB_ACCOUNTS.id, profile_id: COACH_A.id, granted_by: OWNER_A.id }] }))
    await setAccess(MB_ACCOUNTS.id, COACH_A.id, false)

    // The row is gone, so audit_events is the only surviving record.
    expect(db._state.grants).toEqual([])
    const audits = insertsInto(db, 'audit_events')
    expect(audits).toHaveLength(1)
    expect(audits[0].payload.action).toBe('email_mailbox_access.revoked')
    expect(audits[0].payload.target_profile_id).toBe(COACH_A.id)
    expect(audits[0].payload.details.granted).toBe(false)
  })

  it('does not audit a no-op or a refusal', async () => {
    await setAccess(MB_STUDIO.id, COACH_A.id, false) // already ungranted
    expect(insertsInto(db, 'audit_events')).toEqual([])

    getCurrentUser.mockResolvedValue(MANAGER_A)
    await setAccess(MB_STUDIO.id, COACH_A.id, true)
    expect(insertsInto(db, 'audit_events')).toEqual([])
  })
})
