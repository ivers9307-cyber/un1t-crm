// GLOFOXWRITEJUDGE.1 (a) — Glofox refused a new account because the email
// already has one (21 Aug 2026, a /start booking), after our email search had
// found nothing a second earlier. The push was filed "Register failed: unknown"
// and the person stayed unlinked. Now: search once more; one account → link it
// (no new account, no trial, no password); anything else → staff review with
// the reason. Every other refusal keeps Glofox's words.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./glofox.js', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'br1', apiKey: 'k', apiToken: 't' })),
  searchGlofoxByEmail: vi.fn(),
  searchGlofoxMember: vi.fn(),
  registerGlofoxMember: vi.fn(),
  purchaseGlofoxMembership: vi.fn(),
  generateGlofoxPasscode: vi.fn(() => 'TEST-1234'),
  glofoxFetch: vi.fn(async () => ({ ok: true, json: async () => ({ data: { _id: 'gx-old' } }) })),
}))
vi.mock('./glofox-sync.js', () => ({ applyMemberSync: vi.fn(async () => ({ ok: true })) }))
vi.mock('./contact-tags.js', () => ({ writeContactTag: vi.fn(async () => ({ written: true })) }))
// A trial IS configured: a wrong implementation that fell through to the
// create path would buy one, and the purchase assertion would catch it.
vi.mock('./connection-registry.js', () => ({
  readGlofoxConfig: vi.fn(async () => ({ cfg: { trial_membership_id: 'mem-trial', trial_plan_code: 999 }, error: null })),
}))

import { findOrCreateGlofoxMember } from './glofox-push.js'
import { searchGlofoxByEmail, registerGlofoxMember, purchaseGlofoxMembership } from './glofox.js'
import { writeContactTag } from './contact-tags.js'

const IN_USE = {
  ok: false, member: null, code: 'EMAIL_ALREADY_IN_USE', error: 'LOGIN_ALREADY_IN_USE,EMAIL_ALREADY_IN_USE',
  glofox_response: { success: false, message: 'LOGIN_ALREADY_IN_USE,EMAIL_ALREADY_IN_USE', message_code: null, message_data: [], errors: ['LOGIN_ALREADY_IN_USE,EMAIL_ALREADY_IN_USE'] },
}
const CONTACT = { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' }

function recordingDb() {
  const contactUpdates = []
  const pushEvents = []
  const db = {
    from(table) {
      if (table === 'contacts') {
        return { update: (patch) => { contactUpdates.push(patch); return { eq: () => Promise.resolve({ error: null }) } } }
      }
      if (table === 'glofox_push_events') {
        return { insert: (row) => { pushEvents.push(row); return { select: () => ({ single: () => Promise.resolve({ data: { id: 'evt-1' }, error: null }) }) } } }
      }
      if (table === 'contact_tags') return { insert: () => Promise.resolve({ error: null }) }
      throw new Error(`fake db: unhandled table ${table}`)
    },
  }
  return { db, contactUpdates, pushEvents }
}

const run = (db) => findOrCreateGlofoxMember({
  db, locationId: 'loc1', source: 'booking_form', contact: CONTACT, createIfMissing: true, attachTrial: true,
})

// mockReset, not only clearAllMocks: an unconsumed mockResolvedValueOnce must
// never leak into the next test's answers.
beforeEach(() => { vi.clearAllMocks(); searchGlofoxByEmail.mockReset(); registerGlofoxMember.mockReset() })

describe('findOrCreateGlofoxMember — Glofox says the email already has an account', () => {
  it('the second search finds ONE account: linked to it; no new account, no trial, no password', async () => {
    searchGlofoxByEmail
      .mockResolvedValueOnce({ found: false, member: null, error: null })
      .mockResolvedValueOnce({ found: true, member: { _id: 'gx-old', email: 'a@b.com' }, error: null })
    registerGlofoxMember.mockResolvedValueOnce(IN_USE)
    const { db, contactUpdates, pushEvents } = recordingDb()
    const out = await run(db)
    expect(out).toMatchObject({ status: 'linked', glofox_member_id: 'gx-old', error: null })
    expect(out.passcode).toBeUndefined()
    expect(contactUpdates).toEqual([expect.objectContaining({ glofox_member_id: 'gx-old' })])
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(writeContactTag).not.toHaveBeenCalled() // no 'glofox_account_created' welcome trigger
    expect(pushEvents).toHaveLength(1)
    expect(pushEvents[0]).toMatchObject({ status: 'linked', glofox_member_id: 'gx-old', glofox_response: IN_USE.glofox_response })
    expect(pushEvents[0].error_message).toMatch(/already has an account/)
    expect(pushEvents[0].error_message).not.toMatch(/unknown/)
  })

  it('the second search finds nothing: staff review with the reason; nothing linked', async () => {
    searchGlofoxByEmail.mockResolvedValue({ found: false, member: null, error: null })
    registerGlofoxMember.mockResolvedValueOnce(IN_USE)
    const { db, contactUpdates, pushEvents } = recordingDb()
    const out = await run(db)
    expect(out).toMatchObject({ status: 'needs_review', reason: 'email_in_use_not_linked' })
    expect(out.glofox_member_id).toBeUndefined()
    expect(contactUpdates).toEqual([])
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(pushEvents[0]).toMatchObject({ status: 'needs_review' })
    expect(pushEvents[0].error_message).toMatch(/already has an account, but the search cannot see it/)
  })

  it('the second search FAILS: staff review, never a guess', async () => {
    searchGlofoxByEmail
      .mockResolvedValueOnce({ found: false, member: null, error: null })
      .mockResolvedValueOnce({ found: false, member: null, error: 'Glofox HTTP 500' })
    registerGlofoxMember.mockResolvedValueOnce(IN_USE)
    const { db, contactUpdates, pushEvents } = recordingDb()
    const out = await run(db)
    expect(out.status).toBe('needs_review')
    expect(contactUpdates).toEqual([])
    expect(pushEvents[0].error_message).toMatch(/search to find it failed/)
  })

  it('the second search finds SEVERAL accounts: staff review, nothing linked', async () => {
    searchGlofoxByEmail
      .mockResolvedValueOnce({ found: false, member: null, error: null })
      .mockResolvedValueOnce({ found: true, member: { _id: 'gx-a' }, allMatches: [{ _id: 'gx-a' }, { _id: 'gx-b' }], error: 'multiple_glofox_matches' })
    registerGlofoxMember.mockResolvedValueOnce(IN_USE)
    const { db, contactUpdates, pushEvents } = recordingDb()
    const out = await run(db)
    expect(out.status).toBe('needs_review')
    expect(contactUpdates).toEqual([])
    expect(pushEvents[0].error_message).toMatch(/2 accounts/)
  })
})

describe('findOrCreateGlofoxMember — email in use, one account found, but the CRM link write fails', () => {
  it('staff review with the reason, never reported as linked', async () => {
    searchGlofoxByEmail
      .mockResolvedValueOnce({ found: false, member: null, error: null })
      .mockResolvedValueOnce({ found: true, member: { _id: 'gx-old' }, error: null })
    registerGlofoxMember.mockResolvedValueOnce(IN_USE)
    const { db, pushEvents } = recordingDb()
    const realFrom = db.from
    db.from = (table) => (table === 'contacts'
      ? { update: () => ({ eq: () => Promise.resolve({ error: { message: 'db down' } }) }) }
      : realFrom(table))
    const out = await run(db)
    expect(out).toMatchObject({ status: 'needs_review', reason: 'email_in_use_link_failed', glofox_member_id: 'gx-old' })
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(writeContactTag).not.toHaveBeenCalled()
    expect(pushEvents).toHaveLength(1)
    expect(pushEvents[0]).toMatchObject({ status: 'needs_review', glofox_member_id: 'gx-old' })
    expect(pushEvents[0].error_message).toMatch(/could not save the link/)
  })
})

describe('findOrCreateGlofoxMember — any other refusal keeps Glofox\'s words', () => {
  it('June shape: failed, "Register failed: The first name field is required. …", one search only', async () => {
    searchGlofoxByEmail.mockResolvedValue({ found: false, member: null, error: null })
    registerGlofoxMember.mockResolvedValueOnce({
      ok: false, member: null, code: 'REGISTER_REFUSED',
      error: 'The first name field is required., The last name field is required.',
      glofox_response: { success: false },
    })
    const { db, pushEvents } = recordingDb()
    const out = await run(db)
    expect(out).toMatchObject({ status: 'failed', code: 'REGISTER_REFUSED' })
    expect(out.error).toMatch(/first name field is required/)
    expect(searchGlofoxByEmail).toHaveBeenCalledTimes(1)
    expect(pushEvents[0].error_message).toBe('Register failed: The first name field is required., The last name field is required.')
  })
})
