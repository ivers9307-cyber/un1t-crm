// INBOXASSIGN.1 — who may own a thread, and the write's two checks.
import { describe, it, expect } from 'vitest'
import {
  canUseChannelHere, loadAssignableStaff, assignThread, assignPickerFor,
  attachAssigneeNames, AssignBodySchema,
} from './inbox-assignment'
import {
  memoryDb, staffWorld, LOC_A, LOC_B, MAILBOX_A,
  ME, ALEX, BLAIR, PAT, CASEY, DREW, EVAN, MORGAN, OWNER,
} from './inbox-assignment.test-helpers'

const ids = (staff) => staff.map(s => s.id).sort()

describe('canUseChannelHere', () => {
  const profile = { id: ALEX, role: 'head_coach', employment_type: null }
  it('takes the web OR the mobile whatsapp key for WhatsApp and Instagram', () => {
    expect(canUseChannelHere({ channel: 'whatsapp', link: { role: 'staff', permissions: {} }, profile: { ...profile, role: 'staff' } })).toBe(false)
    expect(canUseChannelHere({ channel: 'whatsapp', link: { role: 'staff', permissions: { mobile: { whatsapp: true } } }, profile: { ...profile, role: 'staff' } })).toBe(true)
    expect(canUseChannelHere({ channel: 'instagram', link: { role: 'head_coach', permissions: {} }, profile })).toBe(true)
  })
  it('honours the studio switch and the role template', () => {
    expect(canUseChannelHere({ channel: 'whatsapp', link: { role: 'head_coach', permissions: {} }, profile, features: { whatsapp: false } })).toBe(false)
    const templates = [{ role: 'head_coach', employment_type: 'all', permissions: { whatsapp: false, mobile: { whatsapp: false } } }]
    expect(canUseChannelHere({ channel: 'whatsapp', link: { role: 'head_coach', permissions: {} }, profile, templates })).toBe(false)
  })
  it('mail needs email_inbox AND sight of the mailbox (grant, owner or master)', () => {
    const link = { role: 'head_coach', permissions: { email_inbox: true } }
    expect(canUseChannelHere({ channel: 'mail', link, profile, mailboxId: MAILBOX_A, grantedProfileIds: [] })).toBe(false)
    expect(canUseChannelHere({ channel: 'mail', link, profile, mailboxId: MAILBOX_A, grantedProfileIds: [ALEX] })).toBe(true)
    expect(canUseChannelHere({ channel: 'mail', link: { role: 'owner', permissions: {} }, profile: { ...profile, role: 'owner' }, mailboxId: MAILBOX_A })).toBe(true)
    // A NULL-mailbox conversation is elevated-only, as it is to read.
    expect(canUseChannelHere({ channel: 'mail', link, profile, mailboxId: null, grantedProfileIds: [ALEX] })).toBe(false)
  })
  it('fails closed on an unknown channel', () => {
    expect(canUseChannelHere({ channel: 'sms', link: { role: 'owner', permissions: {} }, profile })).toBe(false)
  })
})

describe('loadAssignableStaff', () => {
  it('lists active, non-deleted members of the studio who hold WhatsApp there — names only', async () => {
    const db = memoryDb(staffWorld())
    const out = await loadAssignableStaff(db, { channel: 'whatsapp', locationId: LOC_A })
    expect(out.ok).toBe(true)
    expect(ids(out.staff)).toEqual([ME, ALEX, PAT, MORGAN, OWNER].sort())
    expect(ids(out.staff)).not.toContain(BLAIR) // switched off for them
    expect(ids(out.staff)).not.toContain(CASEY) // another studio
    expect(ids(out.staff)).not.toContain(DREW)  // tombstone
    expect(ids(out.staff)).not.toContain(EVAN)  // deactivated
    for (const s of out.staff) expect(Object.keys(s).sort()).toEqual(['full_name', 'id'])
    // The profiles read is tombstone-filtered and active-only.
    const profRead = db.calls.find(c => c.table === 'profiles')
    expect(profRead.filters).toContainEqual(['is', 'deleted_at', null])
    expect(profRead.filters).toContainEqual(['eq', 'active', true])
  })

  it('mail lists only those who can see the mailbox', async () => {
    const db = memoryDb(staffWorld())
    const out = await loadAssignableStaff(db, { channel: 'mail', locationId: LOC_A, mailboxId: MAILBOX_A })
    expect(ids(out.staff)).toEqual([MORGAN, OWNER].sort())
  })

  it('a failed read is ok:false, never an empty list', async () => {
    for (const table of ['profile_locations', 'location_role_permissions', 'locations', 'profiles']) {
      const db = memoryDb(staffWorld(), { fail: { [`${table}:select`]: { message: 'boom' } } })
      expect(await loadAssignableStaff(db, { channel: 'whatsapp', locationId: LOC_A })).toEqual({ ok: false })
    }
    const db = memoryDb(staffWorld(), { fail: { 'email_mailbox_access:select': { message: 'boom' } } })
    expect(await loadAssignableStaff(db, { channel: 'mail', locationId: LOC_A, mailboxId: MAILBOX_A })).toEqual({ ok: false })
  })
})

describe('assignThread', () => {
  const thread = (over = {}) => ({ id: 't1', location_id: LOC_A, assigned_to: null, ...over })
  const world = (over) => staffWorld({ whatsapp_conversations: [thread(over)] })
  const user = { id: ME }

  it("'me' takes the thread, pinned to its id and studio", async () => {
    const db = memoryDb(world())
    const out = await assignThread(db, { channel: 'whatsapp', user, thread: thread(), assignee: 'me' })
    expect(out).toEqual({ status: 200, body: { success: true, data: { assigned_to: ME, assignee_name: 'Test Manager' } } })
    expect(db.state.whatsapp_conversations[0].assigned_to).toBe(ME)
    const write = db.calls.find(c => c.op === 'update')
    expect(write.payload).toEqual({ assigned_to: ME })
    expect(write.filters).toEqual([['eq', 'id', 't1'], ['eq', 'location_id', LOC_A]])
  })

  it('names an eligible colleague', async () => {
    const db = memoryDb(world())
    const out = await assignThread(db, { channel: 'whatsapp', user, thread: thread(), assignee: ALEX })
    expect(out.status).toBe(200)
    expect(out.body.data).toEqual({ assigned_to: ALEX, assignee_name: 'Alex Example' })
  })

  it.each([
    ['without the channel', BLAIR],
    ['at another studio', CASEY],
    ['deleted', DREW],
    ['deactivated', EVAN],
    ['unknown', '10000000-0000-4000-8000-0000000000ff'],
  ])('refuses a colleague %s, and writes nothing', async (_label, who) => {
    const db = memoryDb(world())
    const out = await assignThread(db, { channel: 'whatsapp', user, thread: thread(), assignee: who })
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('assignee_not_eligible')
    expect(db.calls.some(c => c.op === 'update')).toBe(false)
  })

  it('null unassigns', async () => {
    const db = memoryDb(world({ assigned_to: ALEX }))
    const out = await assignThread(db, { channel: 'whatsapp', user, thread: thread({ assigned_to: ALEX }), assignee: null })
    expect(out.body).toEqual({ success: true, data: { assigned_to: null, assignee_name: null } })
    expect(db.state.whatsapp_conversations[0].assigned_to).toBe(null)
  })

  it('a failed write is a 500, not a success', async () => {
    const db = memoryDb(world(), { fail: { 'whatsapp_conversations:update': { message: 'boom' } } })
    const out = await assignThread(db, { channel: 'whatsapp', user, thread: thread(), assignee: 'me' })
    expect(out.status).toBe(500)
    expect(out.body.success).toBe(false)
  })

  it('a write that matched no row is a 409, not a success', async () => {
    const db = memoryDb(world(), { zeroRowUpdate: ['whatsapp_conversations'] })
    const out = await assignThread(db, { channel: 'whatsapp', user, thread: thread(), assignee: 'me' })
    expect(out.status).toBe(409)
    expect(out.body.success).toBe(false)
  })

  it('a thread moved to another studio matches no row (the studio pin)', async () => {
    const db = memoryDb(staffWorld({ whatsapp_conversations: [thread({ location_id: LOC_B })] }))
    const out = await assignThread(db, { channel: 'whatsapp', user, thread: thread(), assignee: 'me' })
    expect(out.status).toBe(409)
  })

  it('a failed eligibility read is a 500 and writes nothing', async () => {
    const db = memoryDb(world(), { fail: { 'profile_locations:select': { message: 'boom' } } })
    const out = await assignThread(db, { channel: 'whatsapp', user, thread: thread(), assignee: ALEX })
    expect(out.status).toBe(500)
    expect(db.calls.some(c => c.op === 'update')).toBe(false)
  })

  it('re-assigning the current owner writes nothing', async () => {
    const db = memoryDb(world({ assigned_to: ME }))
    const out = await assignThread(db, { channel: 'whatsapp', user, thread: thread({ assigned_to: ME }), assignee: 'me' })
    expect(out.status).toBe(200)
    expect(db.calls.some(c => c.op === 'update')).toBe(false)
  })
})

describe('assignPickerFor / attachAssigneeNames', () => {
  it('returns the owner, the viewer and names-only staff', async () => {
    const db = memoryDb(staffWorld())
    const out = await assignPickerFor(db, { channel: 'whatsapp', user: { id: ME }, thread: { id: 't1', location_id: LOC_A, assigned_to: ALEX } })
    expect(out.status).toBe(200)
    expect(out.body.data.assigned_to).toBe(ALEX)
    expect(out.body.data.assignee_name).toBe('Alex Example')
    expect(out.body.data.viewer_id).toBe(ME)
    expect(JSON.stringify(out.body)).not.toContain('annual_salary')
    expect(JSON.stringify(out.body)).not.toContain('99999')
  })
  it('a failed lookup is a 500', async () => {
    const db = memoryDb(staffWorld(), { fail: { 'profiles:select': { message: 'boom' } } })
    const out = await assignPickerFor(db, { channel: 'whatsapp', user: { id: ME }, thread: { id: 't1', location_id: LOC_A } })
    expect(out.status).toBe(500)
  })
  it('stamps names on list rows, and survives a failed read', async () => {
    const rows = [{ id: 'a', assigned_to: ALEX }, { id: 'b', assigned_to: null }]
    await attachAssigneeNames(memoryDb(staffWorld()), rows)
    expect(rows.map(r => r.assignee_name)).toEqual(['Alex Example', null])
    const rows2 = [{ id: 'a', assigned_to: ALEX }]
    await attachAssigneeNames(memoryDb(staffWorld(), { fail: { 'profiles:select': { message: 'x' } } }), rows2)
    expect(rows2[0].assignee_name).toBe(null)
  })
})

describe('AssignBodySchema', () => {
  it("accepts 'me', null and a uuid-shaped id (including a version-0 one)", () => {
    expect(AssignBodySchema.safeParse({ assignee: 'me' }).success).toBe(true)
    expect(AssignBodySchema.safeParse({ assignee: null }).success).toBe(true)
    expect(AssignBodySchema.safeParse({ assignee: 'a0000000-0000-0000-0000-000000000001' }).success).toBe(true)
    expect(AssignBodySchema.safeParse({ assignee: 'nobody' }).success).toBe(false)
    expect(AssignBodySchema.safeParse({}).success).toBe(false)
  })
})
