import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the glofox module BEFORE importing glofox-push so the
// orchestrator picks up our stubs. Mocks return controllable
// shapes; tests override .mockResolvedValueOnce per case.
vi.mock('./glofox.js', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  searchGlofoxByEmail: vi.fn(),
  searchGlofoxMember: vi.fn(),
  registerGlofoxMember: vi.fn(),
  purchaseGlofoxMembership: vi.fn(),
  generateGlofoxPasscode: vi.fn(() => 'TEST-1234'),
  glofoxFetch: vi.fn(),
}))

vi.mock('./glofox-sync.js', () => ({
  applyMemberSync: vi.fn(async () => ({ ok: true })),
}))

// GLOFOX4.1 — writeContactTag is the centralised "add a tag +
// trigger sequences" path. Mock it so the orchestrator tests stay
// pure (no DB writes, no transitive sequences/triggers imports).
vi.mock('./contact-tags.js', () => ({
  writeContactTag: vi.fn(async () => ({ written: true, tag: 'mocked', alreadyPresent: false })),
}))

import { findOrCreateGlofoxMember } from './glofox-push.js'
import {
  glofoxCredentialsForLocation,
  searchGlofoxByEmail,
  searchGlofoxMember,
  registerGlofoxMember,
  purchaseGlofoxMembership,
  glofoxFetch,
} from './glofox.js'

// Tiny fluent fake — supports .from().select/insert/update/eq/maybeSingle/single.
// All branches return user-supplied stubs; missing stubs throw so test
// failures are loud rather than silently null.
function makeFakeDb({
  contactsUpdate = { error: null },
  pushEventsInsert = { data: { id: 'evt-1' }, error: null },
  contactTagsInsert = { error: null },
  locationSelect = { data: { settings: {} }, error: null },
} = {}) {
  return {
    from(table) {
      if (table === 'contacts') {
        return {
          update: () => ({ eq: () => Promise.resolve(contactsUpdate) }),
        }
      }
      if (table === 'glofox_push_events') {
        return {
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve(pushEventsInsert),
            }),
          }),
        }
      }
      if (table === 'contact_tags') {
        return {
          insert: () => Promise.resolve(contactTagsInsert),
        }
      }
      if (table === 'locations') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve(locationSelect) }),
          }),
        }
      }
      throw new Error(`fake db: unhandled table ${table}`)
    },
  }
}

const VALID_CREDS = { branchId: 'br1', apiKey: 'k', apiToken: 't' }

beforeEach(() => {
  vi.clearAllMocks()
  glofoxCredentialsForLocation.mockResolvedValue(VALID_CREDS)
  // Default applyMemberSync re-fetch path returns a benign body so
  // the post-link sync doesn't blow up.
  glofoxFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { _id: 'gx-1' } }),
  })
})

describe('findOrCreateGlofoxMember — guard clauses', () => {
  it('returns failed when args are missing', async () => {
    const out = await findOrCreateGlofoxMember({ db: null, locationId: null, contact: null, source: 'dup_check' })
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/missing args/)
  })

  it('skips when contact is already linked', async () => {
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'dup_check',
      contact: { id: 'c1', email: 'a@b.com', glofox_member_id: 'already-here' },
    })
    expect(out.status).toBe('skipped')
    expect(out.glofox_member_id).toBe('already-here')
    expect(searchGlofoxByEmail).not.toHaveBeenCalled()
  })

  it('fails fast when credentials are missing', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null })
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'dup_check',
      contact: { id: 'c1', email: 'a@b.com' },
    })
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/credentials/)
  })

  it('REGISTRYREAD.1a: an unreadable settings row is "could not be read — retry", not "not configured"', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
    const out = await findOrCreateGlofoxMember({
      db: makeFakeDb(), locationId: 'loc1', source: 'dup_check',
      contact: { id: 'c1', email: 'a@b.com' },
    })
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/could not be read/)
    expect(out.error).not.toMatch(/not configured/)
    expect(searchGlofoxByEmail).not.toHaveBeenCalled()
  })
})

describe('findOrCreateGlofoxMember — search-and-link (createIfMissing=false)', () => {
  it('links when search finds a single match', async () => {
    searchGlofoxByEmail.mockResolvedValueOnce({
      found: true,
      member: { _id: 'gx-1', email: 'a@b.com' },
    })
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'dup_check',
      contact: { id: 'c1', email: 'a@b.com' },
      createIfMissing: false,
    })
    expect(out.status).toBe('linked')
    expect(out.glofox_member_id).toBe('gx-1')
    expect(registerGlofoxMember).not.toHaveBeenCalled()
  })

  it('flags needs_review when search reports multiple matches', async () => {
    searchGlofoxByEmail.mockResolvedValueOnce({
      found: true,
      member: { _id: 'gx-1', email: 'a@b.com' },
      error: 'multiple_glofox_matches',
      allMatches: [{ _id: 'gx-1' }, { _id: 'gx-2' }],
    })
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'dup_check',
      contact: { id: 'c1', email: 'a@b.com' },
    })
    expect(out.status).toBe('needs_review')
    expect(out.glofox_member_id).toBe('gx-1') // best-effort link to first
    expect(out.error).toBe('multiple_glofox_matches')
  })

  it('skips when search finds nothing and createIfMissing=false', async () => {
    searchGlofoxByEmail.mockResolvedValueOnce({ found: false })
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'dup_check',
      contact: { id: 'c1', email: 'a@b.com' },
      createIfMissing: false,
    })
    expect(out.status).toBe('skipped')
    expect(registerGlofoxMember).not.toHaveBeenCalled()
  })

  it('fails when search itself errors out', async () => {
    searchGlofoxByEmail.mockResolvedValueOnce({ found: false, error: 'network blew up' })
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'dup_check',
      contact: { id: 'c1', email: 'a@b.com' },
      createIfMissing: true, // even with create-if-missing, search-error halts
    })
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/network blew up/)
    expect(registerGlofoxMember).not.toHaveBeenCalled()
  })
})

describe('findOrCreateGlofoxMember — create-and-trial (createIfMissing=true)', () => {
  beforeEach(() => {
    searchGlofoxByEmail.mockResolvedValue({ found: false })
  })

  it('refuses to register when first/last name missing', async () => {
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form',
      contact: { id: 'c1', email: 'a@b.com' }, // no first_name / last_name
      createIfMissing: true,
    })
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/first_name or last_name/)
    expect(registerGlofoxMember).not.toHaveBeenCalled()
  })

  it('creates a Glofox member when search empty and names supplied', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form',
      contact: { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' },
      createIfMissing: true,
      attachTrial: false,
    })
    expect(out.status).toBe('created')
    expect(out.glofox_member_id).toBe('gx-new')
    expect(out.passcode).toBe('TEST-1234')
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('attaches trial when attachTrial=true and location has trial config', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: true })
    const db = makeFakeDb({
      locationSelect: {
        data: { settings: { glofox: { trial_membership_id: 'mem-trial', trial_plan_code: 999 } } },
        error: null,
      },
    })
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form',
      contact: { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' },
      createIfMissing: true,
      attachTrial: true,
    })
    expect(out.status).toBe('created')
    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(VALID_CREDS, 'gx-new', 'mem-trial', 999)
    expect(out.error).toBeNull()
    expect(out.trial_failed).toBe(false)
  })

  it('marks needs_review when trial config missing', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    const db = makeFakeDb({
      locationSelect: { data: { settings: { glofox: {} } }, error: null },
    })
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form',
      contact: { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' },
      createIfMissing: true,
      attachTrial: true,
    })
    expect(out.status).toBe('needs_review')
    expect(out.error).toMatch(/Trial membership not configured/)
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(out.trial_failed).toBe(true)
  })

  it('marks needs_review when trial purchase fails', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: false, error: 'Glofox 422' })
    const db = makeFakeDb({
      locationSelect: {
        data: { settings: { glofox: { trial_membership_id: 'mem-trial', trial_plan_code: 999 } } },
        error: null,
      },
    })
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form',
      contact: { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' },
      createIfMissing: true,
      attachTrial: true,
    })
    expect(out.status).toBe('needs_review')
    expect(out.error).toMatch(/Glofox 422/)
    // TRIALGRANT.1 — the processor files needs_credit_grant on this, not
    // account_needs_review.
    expect(out.trial_failed).toBe(true)
    // A refusal Glofox answered is a known outcome: the card may buy again.
    expect(out.trial_outcome_unknown).toBeUndefined()
  })

  it('a trial purchase with no clear answer (a 5xx) says it may have gone through (GLOFOXPOSTRETRY.1)', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: false, error: 'Glofox HTTP 503', http_status: 503, outcome_unknown: true })
    const db = makeFakeDb({
      locationSelect: {
        data: { settings: { glofox: { trial_membership_id: 'mem-trial', trial_plan_code: 999 } } },
        error: null,
      },
    })
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form',
      contact: { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' },
      createIfMissing: true,
      attachTrial: true,
    })
    expect(out.status).toBe('needs_review')
    expect(out.trial_failed).toBe(true)
    expect(out.error).toMatch(/may have gone through/)
    expect(out.error).toMatch(/€0 trial invoice/)
    expect(purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
    // Review: the doubt must reach the card the processor files, or its
    // first approval could buy a second trial.
    expect(out.trial_outcome_unknown).toBe(true)
  })

  it('reports register failure as failed', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: false, error: 'Glofox 400 — duplicate email' })
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form',
      contact: { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' },
      createIfMissing: true,
    })
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/duplicate email/)
  })

  it('prefers a per-funnel trialOverride over the location default trial config', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: true })
    // Location default trial config is present too — the override must
    // win, not the location's mem-trial/999 pair.
    const db = makeFakeDb({
      locationSelect: {
        data: { settings: { glofox: { trial_membership_id: 'mem-trial', trial_plan_code: 999 } } },
        error: null,
      },
    })
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form',
      contact: { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' },
      createIfMissing: true,
      attachTrial: true,
      trialOverride: { membershipId: 'block-trial', planCode: 'block-plan' },
    })
    expect(out.status).toBe('created')
    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(VALID_CREDS, 'gx-new', 'block-trial', 'block-plan')
    expect(out.error).toBeNull()
  })

  it('falls back to the location default trial config when trialOverride is absent or incomplete', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    purchaseGlofoxMembership.mockResolvedValueOnce({ ok: true })
    const db = makeFakeDb({
      locationSelect: {
        data: { settings: { glofox: { trial_membership_id: 'mem-trial', trial_plan_code: 999 } } },
        error: null,
      },
    })
    // Half an override (planCode missing) must NOT be treated as a
    // usable override — falls through to the location default.
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form',
      contact: { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' },
      createIfMissing: true,
      attachTrial: true,
      trialOverride: { membershipId: 'block-trial' },
    })
    expect(out.status).toBe('created')
    expect(purchaseGlofoxMembership).toHaveBeenCalledWith(VALID_CREDS, 'gx-new', 'mem-trial', 999)
  })

  it('REGISTRYREAD.1a: a failed trial-settings read says so (not "Trial membership not configured")', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    const db = makeFakeDb({ locationSelect: { data: null, error: { message: 'boom' } } })
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form',
      contact: { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' },
      createIfMissing: true,
      attachTrial: true,
    })
    expect(out.status).toBe('needs_review')
    expect(out.error).toMatch(/Could not read the trial membership settings/)
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })
})

// SINGLEERR.1 — the audit insert discarded its error.
//
// `const { data } = await db.from('glofox_push_events').insert(row).select('id')
// .single()` covered only ONE of the two failure channels: the try/catch caught a
// throw, but a PostgREST/Postgres error comes back in the RESULT object, so a
// rejected insert returned `data = null` and said nothing. Every audit row in
// this file is fire-and-forget, which the repo defines as best-effort-but-LOGGED
// (see reportRpc in postmark-webhook-processor) — "never fail the caller" is not
// "never tell anyone". The push itself must still succeed either way.
// GLOFOX-SPEC-2026-09 — the namespace search can now match on PHONE. A
// returner who types a NEW email is invisible to the email search, so before
// the mint we ask Glofox whether any account already holds this mobile. A hit
// is evidence a person exists, which blocks the mint — but it is NEVER a link:
// couples share numbers (PERSON-ACCT.9), so a phone-only match books person
// B's class on person A's account if trusted. Staff decide.
describe('findOrCreateGlofoxMember — phone dup-check before a mint', () => {
  const returner = { id: 'c1', email: 'new-address@b.com', phone: '087 123 4567', first_name: 'Alice', last_name: 'Smith' }

  beforeEach(() => {
    searchGlofoxByEmail.mockResolvedValue({ found: false })
  })

  it('refuses to mint when a Glofox account already holds the mobile, and routes to review WITHOUT linking', async () => {
    searchGlofoxMember.mockResolvedValueOnce({ found: true, member: { _id: 'gx-phone', email: 'old-address@b.com' }, error: null })
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form', contact: returner,
      createIfMissing: true, attachTrial: true,
    })
    expect(searchGlofoxMember).toHaveBeenCalledWith(VALID_CREDS, { phone: '087 123 4567' })
    expect(out.status).toBe('needs_review')
    expect(out.error).toBe('phone_match_no_link')
    expect(out.glofox_member_id).toBeUndefined()
    expect(registerGlofoxMember).not.toHaveBeenCalled()
    expect(purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('mints as before when no Glofox account holds the mobile', async () => {
    searchGlofoxMember.mockResolvedValueOnce({ found: false, member: null, error: null })
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form', contact: returner,
      createIfMissing: true, attachTrial: false,
    })
    expect(out.status).toBe('created')
    expect(out.glofox_member_id).toBe('gx-new')
  })

  it('skips the phone search when the contact has no phone', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form',
      contact: { ...returner, phone: null },
      createIfMissing: true, attachTrial: false,
    })
    expect(searchGlofoxMember).not.toHaveBeenCalled()
    expect(out.status).toBe('created')
  })

  it('halts on a phone-search error exactly like an email-search error (no create-on-failure)', async () => {
    searchGlofoxMember.mockResolvedValueOnce({ found: false, member: null, error: 'Glofox HTTP 503' })
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form', contact: returner,
      createIfMissing: true, attachTrial: false,
    })
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/Glofox HTTP 503/)
    expect(registerGlofoxMember).not.toHaveBeenCalled()
  })

  it('does not phone-search in dup-check-only mode (createIfMissing=false is unchanged)', async () => {
    const db = makeFakeDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'dup_check', contact: returner,
      createIfMissing: false,
    })
    expect(searchGlofoxMember).not.toHaveBeenCalled()
    expect(out.status).toBe('skipped')
  })
})

describe('findOrCreateGlofoxMember — a failed audit insert is logged, never silent', () => {
  it('logs the insert error and still returns the push result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null })
    const db = makeFakeDb({
      pushEventsInsert: { data: null, error: { message: 'null value in column "status"' } },
    })

    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'dup_check',
      contact: { id: 'c1', email: 'a@b.com' },
    })

    // best-effort: the caller's own outcome is unchanged
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/credentials/)
    expect(out.push_event_id).toBeFalsy()
    // …but the failure was reported
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).toMatch(/null value in column/)
    warn.mockRestore()
  })

  it('stays quiet when the audit insert succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null })
    const db = makeFakeDb()

    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'dup_check',
      contact: { id: 'c1', email: 'a@b.com' },
    })

    expect(out.push_event_id).toBe('evt-1')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

// PASSCODEREAD.1 — the generated password registers the member and is handed
// back ONCE (the manual Create-in-Glofox button shows it to the staff member
// who pressed it). It is never written anywhere: it used to land on
// contacts.glofox_passcode and glofox_push_events.passcode_sent, where every
// staff member at the location could read it from their own session, for a
// welcome email that was never switched on. Mig 651 now refuses both columns.
describe('findOrCreateGlofoxMember — the initial password is never stored (PASSCODEREAD.1)', () => {
  function recordingDb() {
    const contactUpdates = []
    const pushEvents = []
    const db = {
      from(table) {
        if (table === 'contacts') {
          return {
            update: (patch) => {
              contactUpdates.push(patch)
              return { eq: () => Promise.resolve({ error: null }) }
            },
          }
        }
        if (table === 'glofox_push_events') {
          return {
            insert: (row) => {
              pushEvents.push(row)
              return { select: () => ({ single: () => Promise.resolve({ data: { id: 'evt-1' }, error: null }) }) }
            },
          }
        }
        if (table === 'contact_tags') return { insert: () => Promise.resolve({ error: null }) }
        if (table === 'locations') {
          return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { settings: {} }, error: null }) }) }) }
        }
        throw new Error(`fake db: unhandled table ${table}`)
      },
    }
    return { db, contactUpdates, pushEvents }
  }

  beforeEach(() => {
    searchGlofoxByEmail.mockResolvedValue({ found: false })
  })

  it('registers with the generated password, returns it once, and writes it nowhere', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    const { db, contactUpdates, pushEvents } = recordingDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'booking_form',
      contact: { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' },
      createIfMissing: true,
      attachTrial: false,
    })

    expect(out.status).toBe('created')
    expect(registerGlofoxMember).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ password: 'TEST-1234' }))
    expect(out.passcode).toBe('TEST-1234')

    expect(contactUpdates).toEqual([{ glofox_member_id: 'gx-new', glofox_synced_at: expect.any(String) }])
    expect(pushEvents).toHaveLength(1)
    expect(pushEvents[0]).not.toHaveProperty('passcode_sent')
    expect(JSON.stringify({ contactUpdates, pushEvents })).not.toContain('TEST-1234')
  })

  it('stores nothing on the needs_review path either (trial not configured)', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    const { db, contactUpdates, pushEvents } = recordingDb()
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'manual_button',
      contact: { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' },
      createIfMissing: true,
      attachTrial: true,
      trialOverride: { membershipId: null, planCode: null },
    })

    expect(out.status).toBe('needs_review')
    // The create path was reached: a needs_review from an earlier step (an
    // ambiguous search, a phone match) would pass the "stores nothing" check
    // without ever minting a password.
    expect(registerGlofoxMember).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ password: 'TEST-1234' }))
    expect(out.glofox_member_id).toBe('gx-new')
    // The desk button shows it on needs_review too, so it is still returned once.
    expect(out.passcode).toBe('TEST-1234')
    expect(contactUpdates).toEqual([{ glofox_member_id: 'gx-new', glofox_synced_at: expect.any(String) }])
    expect(JSON.stringify({ contactUpdates, pushEvents })).not.toContain('TEST-1234')
  })

  it('a failed CRM link write after the create still returns the password once (it exists nowhere else)', async () => {
    registerGlofoxMember.mockResolvedValueOnce({ ok: true, member: { _id: 'gx-new' } })
    const { db, pushEvents } = recordingDb()
    const realFrom = db.from
    db.from = (table) => table === 'contacts'
      ? { update: () => ({ eq: () => Promise.resolve({ error: { message: 'link failed' } }) }) }
      : realFrom(table)
    const out = await findOrCreateGlofoxMember({
      db, locationId: 'loc1', source: 'manual_button',
      contact: { id: 'c1', email: 'a@b.com', first_name: 'Alice', last_name: 'Smith' },
      createIfMissing: true,
      attachTrial: false,
    })

    expect(out.status).toBe('needs_review')
    expect(out.glofox_member_id).toBe('gx-new')
    expect(out.passcode).toBe('TEST-1234')
    expect(JSON.stringify(pushEvents)).not.toContain('TEST-1234')
  })
})
