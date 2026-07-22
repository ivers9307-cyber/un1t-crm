import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the glofox module BEFORE importing glofox-push so the
// orchestrator picks up our stubs. Mocks return controllable
// shapes; tests override .mockResolvedValueOnce per case.
vi.mock('./glofox.js', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  searchGlofoxByEmail: vi.fn(),
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
})
