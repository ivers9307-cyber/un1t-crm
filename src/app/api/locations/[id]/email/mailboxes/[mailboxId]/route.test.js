// EMAIL-MAILBOX-ADMIN.1 — editing one email account.
//
// Two properties this file pins:
//   1. A MANAGER CANNOT EDIT ONE — and nothing is written when they try.
//   2. DEACTIVATING IS NOT DELETING. email_tickets.mailbox_id is ON DELETE SET
//      NULL, so a delete would strip every historic ticket of the address it
//      arrived at. The row survives and its tickets still resolve through it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { PATCH } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, insertsInto, writesTo } from '@/app/api/email/tickets/_test-db'
import { visibleMailboxes } from '@/lib/email-mailboxes'
import {
  LOC_A, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION,
  OWNER_A, OWNER_B, MANAGER_A, adminState,
} from '../_test-fixtures'
import { T_STUDIO } from '@/app/api/email/tickets/_test-fixtures'

const propsFor = (mailboxId) => ({ params: { id: LOC_A, mailboxId } })

const patchReq = (body) => new Request(`http://x/api/locations/${LOC_A}/email/mailboxes/m`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

async function patch(mailboxId, body) {
  const res = await PATCH(patchReq(body), propsFor(mailboxId))
  return { res, body: await res.json() }
}

const rowFor = (id) => db._state.mailboxes.find(m => m.id === id)
const atLocA = () => db._state.mailboxes.filter(m => m.location_id === LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER_A)
  setupDb(adminState({ tickets: [{ ...T_STUDIO }] }))
})

describe('PATCH — the gate', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await patch(MB_STUDIO.id, { label: 'Renamed' })).res.status).toBe(401)
    expect(writesTo(db)).toEqual([])
  })

  it('REFUSES a manager, and the label is unchanged afterwards', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const { res } = await patch(MB_STUDIO.id, { label: 'Renamed' })
    expect(res.status).toBe(403)
    expect(writesTo(db)).toEqual([])
    expect(rowFor(MB_STUDIO.id).label).toBe(MB_STUDIO.label)
  })

  it('refuses an owner of a different studio', async () => {
    getCurrentUser.mockResolvedValue(OWNER_B)
    expect((await patch(MB_STUDIO.id, { active: false })).res.status).toBe(403)
    expect(writesTo(db)).toEqual([])
  })

  it('404s — not 403 — for a mailbox belonging to another studio', async () => {
    // Otherwise a 403/404 split makes another studio's mailbox ids probeable.
    const { res } = await patch(MB_OTHER_LOCATION.id, { label: 'Nope' })
    expect(res.status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  it('404s for an id that does not exist at all — same answer', async () => {
    expect((await patch('99999999-9999-4999-8999-999999999999', { label: 'Nope' })).res.status).toBe(404)
  })
})

describe('PATCH — label', () => {
  it('renames and trims', async () => {
    const { res } = await patch(MB_ACCOUNTS.id, { label: '  Billing  ' })
    expect(res.status).toBe(200)
    expect(rowFor(MB_ACCOUNTS.id).label).toBe('Billing')
  })

  it('refuses a blank label the way the btrim CHECK does', async () => {
    const { res, body } = await patch(MB_ACCOUNTS.id, { label: '   ' })
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/short label/i)
    expect(rowFor(MB_ACCOUNTS.id).label).toBe(MB_ACCOUNTS.label)
  })

  it('refuses a label over 40 characters', async () => {
    const { res, body } = await patch(MB_ACCOUNTS.id, { label: 'x'.repeat(41) })
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/40 characters/)
  })

  it('400s on an empty patch rather than pretending something happened', async () => {
    expect((await patch(MB_ACCOUNTS.id, {})).res.status).toBe(400)
  })

  it('offers no way to change the address — editing it would reattribute history', async () => {
    await patch(MB_ACCOUNTS.id, { address: 'somethingelse@un1t.ie', label: 'Billing' })
    expect(rowFor(MB_ACCOUNTS.id).address).toBe(MB_ACCOUNTS.address)
  })
})

describe('PATCH — the default account', () => {
  it('moving the default leaves exactly one, and does not delete the incumbent', async () => {
    const { res } = await patch(MB_ACCOUNTS.id, { is_default: true })
    expect(res.status).toBe(200)
    expect(atLocA().filter(m => m.is_default).map(m => m.id)).toEqual([MB_ACCOUNTS.id])
    expect(rowFor(MB_STUDIO.id)).toBeTruthy()
    expect(rowFor(MB_STUDIO.id).is_default).toBe(false)
  })

  it('does not disturb another studio’s default', async () => {
    await patch(MB_ACCOUNTS.id, { is_default: true })
    expect(rowFor(MB_OTHER_LOCATION.id).is_default).toBe(true)
  })

  it('setting the SAME mailbox default twice still leaves one default', async () => {
    await patch(MB_ACCOUNTS.id, { is_default: true })
    await patch(MB_ACCOUNTS.id, { is_default: true })
    expect(atLocA().filter(m => m.is_default)).toHaveLength(1)
  })

  it('can clear the default outright, leaving the studio with none', async () => {
    const { res } = await patch(MB_STUDIO.id, { is_default: false })
    expect(res.status).toBe(200)
    expect(atLocA().filter(m => m.is_default)).toHaveLength(0)
  })

  it('refuses to make a deactivated account the default', async () => {
    setupDb(adminState({ mailboxes: [{ ...MB_STUDIO }, { ...MB_ACCOUNTS, active: false }] }))
    const { res, body } = await patch(MB_ACCOUNTS.id, { is_default: true })
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/reactivate it first/i)
    expect(rowFor(MB_ACCOUNTS.id).is_default).toBe(false)
  })
})

describe('PATCH — deactivation is not deletion', () => {
  it('keeps the row, and its historic tickets still resolve through it', async () => {
    const { res } = await patch(MB_STUDIO.id, { active: false })
    expect(res.status).toBe(200)

    // The row survives…
    const row = rowFor(MB_STUDIO.id)
    expect(row).toBeTruthy()
    expect(row.active).toBe(false)
    expect(writesTo(db).some(w => w.op === 'delete')).toBe(false)

    // …so the ticket that arrived at it still points at a real mailbox, and
    // the address it came in on is still recoverable.
    const ticket = db._state.tickets.find(t => t.id === T_STUDIO.id)
    expect(ticket.mailbox_id).toBe(MB_STUDIO.id)
    expect(rowFor(ticket.mailbox_id).address).toBe(MB_STUDIO.address)
  })

  it('hides it from every inbox including an owner’s', async () => {
    await patch(MB_STUDIO.id, { active: false })
    const ids = visibleMailboxes(atLocA(), { isElevated: true }).map(m => m.id)
    expect(ids).not.toContain(MB_STUDIO.id)
    expect(ids).toContain(MB_ACCOUNTS.id)
  })

  it('clears is_default so the studio never defaults to a dead address', async () => {
    expect(rowFor(MB_STUDIO.id).is_default).toBe(true)
    await patch(MB_STUDIO.id, { active: false })
    expect(rowFor(MB_STUDIO.id).is_default).toBe(false)
    expect(atLocA().filter(m => m.is_default)).toHaveLength(0)
  })

  it('reactivates without silently restoring the default flag', async () => {
    await patch(MB_STUDIO.id, { active: false })
    await patch(MB_STUDIO.id, { active: true })
    expect(rowFor(MB_STUDIO.id).active).toBe(true)
    expect(rowFor(MB_STUDIO.id).is_default).toBe(false)
  })

  it('refuses active:false + is_default:true in one request', async () => {
    const { res } = await patch(MB_ACCOUNTS.id, { active: false, is_default: true })
    expect(res.status).toBe(400)
    expect(rowFor(MB_ACCOUNTS.id).active).toBe(true)
  })
})

describe('PATCH — audit', () => {
  it('records a deactivation under its own action', async () => {
    await patch(MB_STUDIO.id, { active: false })
    const audits = insertsInto(db, 'audit_events')
    expect(audits).toHaveLength(1)
    expect(audits[0].payload.action).toBe('email_mailbox.deactivated')
    expect(audits[0].payload.actor_id).toBe(OWNER_A.id)
    expect(audits[0].payload.details.before.active).toBe(true)
    expect(audits[0].payload.details.after.active).toBe(false)
  })

  it('records a rename as an update', async () => {
    await patch(MB_ACCOUNTS.id, { label: 'Billing' })
    const audits = insertsInto(db, 'audit_events')
    expect(audits[0].payload.action).toBe('email_mailbox.updated')
    expect(audits[0].payload.details.before.label).toBe('Accounts')
    expect(audits[0].payload.details.after.label).toBe('Billing')
  })

  it('does not audit a refused edit', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    await patch(MB_ACCOUNTS.id, { label: 'Billing' })
    expect(insertsInto(db, 'audit_events')).toEqual([])
  })
})

// INBOX-SURFACE.C — the A/B switch.
//
// THREE PROPERTIES, and the first is the security one.
//
// 1. IT IS BEHIND guardMailboxAdmin LIKE EVERY OTHER MAILBOX WRITE. A manager
//    holds `email_inbox` and works the queue every day, so a manager is exactly
//    who would reach for this — and a manager is NOT elevated. If this were
//    ever gated on the surface permission instead, a manager could move the
//    studio's billing correspondence onto a surface of their choosing, and the
//    test below fails rather than that shipping.
// 2. IT IS AUDITED UNDER ITS OWN ACTION. "Where did our mail go" needs one
//    greppable line in /admin/audit-log, not an `email_mailbox.updated` that
//    looks like a rename.
// 3. IT MOVES NOTHING. No ticket, message, grant or attachment is touched —
//    only the column that decides which queue LISTS the account.
describe('PATCH — surface (the ticketing / mail A/B switch)', () => {
  it('REFUSES a manager, and the surface is unchanged afterwards', async () => {
    // The manager holds email_inbox. That is not this gate.
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const { res, body } = await patch(MB_ACCOUNTS.id, { surface: 'inbox' })
    expect(res.status).toBe(403)
    expect(body.success).toBe(false)
    expect(writesTo(db)).toEqual([])
    expect(rowFor(MB_ACCOUNTS.id).surface).toBeUndefined()
  })

  it('refuses an owner of a different studio', async () => {
    getCurrentUser.mockResolvedValue(OWNER_B)
    expect((await patch(MB_ACCOUNTS.id, { surface: 'inbox' })).res.status).toBe(403)
    expect(writesTo(db)).toEqual([])
  })

  it('moves an account to the mail surface for an owner here', async () => {
    const { res, body } = await patch(MB_ACCOUNTS.id, { surface: 'inbox' })
    expect(res.status).toBe(200)
    expect(rowFor(MB_ACCOUNTS.id).surface).toBe('inbox')
    // …and the row that comes back carries it, so the card can re-render
    // without guessing what it just wrote.
    expect(body.data.mailbox.surface).toBe('inbox')
  })

  it('moves it back', async () => {
    await patch(MB_ACCOUNTS.id, { surface: 'inbox' })
    await patch(MB_ACCOUNTS.id, { surface: 'tickets' })
    expect(rowFor(MB_ACCOUNTS.id).surface).toBe('tickets')
  })

  it('rejects a value that is neither surface, writing nothing', async () => {
    // A third value would be an account on NO screen — mail that exists and is
    // listed nowhere. The z.enum is what stops it reaching the CHECK.
    const { res } = await patch(MB_ACCOUNTS.id, { surface: 'archive' })
    expect(res.status).toBe(400)
    expect(writesTo(db)).toEqual([])
  })

  it('touches NOTHING but email_mailboxes — no ticket is moved or rewritten', async () => {
    await patch(MB_STUDIO.id, { surface: 'inbox' })
    const tables = [...new Set(writesTo(db).map(w => w.table))]
    expect(tables.sort()).toEqual(['audit_events', 'email_mailboxes'])
    // The ticket that arrived at it is untouched: its mailbox_id still points
    // at the same account, which is what makes the move reversible.
    expect(db._state.tickets[0].mailbox_id).toBe(MB_STUDIO.id)
  })

  it('leaves label, default and active alone', async () => {
    await patch(MB_STUDIO.id, { surface: 'inbox' })
    const row = rowFor(MB_STUDIO.id)
    expect(row.label).toBe(MB_STUDIO.label)
    expect(row.is_default).toBe(true)
    expect(row.active).toBe(true)
  })

  it('is allowed on a DEACTIVATED account', async () => {
    // Refusing would strand a deactivated account on whichever surface it
    // happened to be on when it was switched off.
    setupDb(adminState({
      mailboxes: [{ ...MB_STUDIO }, { ...MB_ACCOUNTS, active: false }, { ...MB_OTHER_LOCATION }],
      tickets: [{ ...T_STUDIO }],
    }))
    expect((await patch(MB_ACCOUNTS.id, { surface: 'inbox' })).res.status).toBe(200)
    expect(rowFor(MB_ACCOUNTS.id).surface).toBe('inbox')
  })

  it('writes an audit row under its OWN action, with before and after', async () => {
    await patch(MB_ACCOUNTS.id, { surface: 'inbox' })
    const audits = insertsInto(db, 'audit_events')
    expect(audits).toHaveLength(1)
    expect(audits[0].payload.action).toBe('email_mailbox.surface_changed')
    expect(audits[0].payload.actor_id).toBe(OWNER_A.id)
    expect(audits[0].payload.location_id).toBe(LOC_A)
    // 'tickets' rather than undefined — the column's own DEFAULT, so the row
    // never records a move away from nothing.
    expect(audits[0].payload.details.before.surface).toBe('tickets')
    expect(audits[0].payload.details.after.surface).toBe('inbox')
  })

  it('does not claim a surface change when the value did not change', async () => {
    // A no-op PATCH is still a legal write (the label branch may have done
    // work), but calling it a surface change would put a lie in the audit log
    // that an operator would then go looking for.
    await patch(MB_ACCOUNTS.id, { surface: 'tickets' })
    expect(insertsInto(db, 'audit_events')[0].payload.action).toBe('email_mailbox.updated')
  })

  it('does not audit a refused move', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    await patch(MB_ACCOUNTS.id, { surface: 'inbox' })
    expect(insertsInto(db, 'audit_events')).toEqual([])
  })
})
