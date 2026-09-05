// RADAR-AGENT Phase 1 — unit tests for account-tool pure helpers.
import { describe, it, expect, vi } from 'vitest'

// PERSON-ACCT.8 — request_pause/request_cancellation now reach this dynamic
// import on the success path (they never did before, since every prior test
// either errors out first or is the pure-helper suite). Mocked so a test
// asserting the insert shape isn't also exercising the real push-dedup
// stack against a stub db that doesn't implement it.
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))
import {
  identityMatches,
  surnameInName,
  emailPathVerifies,
  formatMembership,
  formatNextClass,
  formatRecentAttendance,
  normEmail,
  ACCOUNT_TOOL_NAMES,
  buildPauseDetails,
  buildCancellationDetails,
} from './account-tools'

describe('identityMatches', () => {
  const contact = { email: 'Jo@Example.com', last_name: 'Murphy' }
  it('passes on matching email (case-insensitive)', () => {
    expect(identityMatches(contact, { email: 'jo@example.com' })).toBe(true)
    expect(identityMatches(contact, { email: '  JO@EXAMPLE.COM ' })).toBe(true)
  })
  it('ignores DOB entirely — the studio does not gather it (2026-06-12)', () => {
    expect(identityMatches(contact, { date_of_birth: '1990-05-14', last_name: 'Murphy' })).toBe(false)
  })
  it('fails on DOB alone or last name alone', () => {
    expect(identityMatches(contact, { date_of_birth: '1990-05-14' })).toBe(false)
    expect(identityMatches(contact, { last_name: 'Murphy' })).toBe(false)
  })
  it('fails on wrong email / wrong dob', () => {
    expect(identityMatches(contact, { email: 'someone@else.com' })).toBe(false)
    expect(identityMatches(contact, { date_of_birth: '1991-01-01', last_name: 'Murphy' })).toBe(false)
  })
  it('fails on empty inputs / null contact', () => {
    expect(identityMatches(contact, {})).toBe(false)
    expect(identityMatches(null, { email: 'jo@example.com' })).toBe(false)
  })
})

describe('surnameInName', () => {
  it('matches a surname as a whole token, case-insensitively', () => {
    expect(surnameInName('Jane Murphy', 'murphy')).toBe(true)
    expect(surnameInName('jane MURPHY', 'Murphy')).toBe(true)
    expect(surnameInName('Murphy', 'murphy')).toBe(true)
  })
  it('tolerates apostrophes / hyphens in either side', () => {
    expect(surnameInName("Sean O'Brien", "O'Brien")).toBe(true)
    expect(surnameInName('Mary Smith-Jones', 'smithjones')).toBe(true)
  })
  it('does NOT match a substring of a token', () => {
    expect(surnameInName('Ashlee Doyle', 'Lee')).toBe(false)
    expect(surnameInName('Bradley', 'Brad')).toBe(false)
  })
  it('rejects too-short surnames and empty/missing names', () => {
    expect(surnameInName('Jane Ng', 'N')).toBe(false)
    expect(surnameInName('', 'Murphy')).toBe(false)
    expect(surnameInName(null, 'Murphy')).toBe(false)
    expect(surnameInName('Jane Murphy', '')).toBe(false)
  })
})

describe('emailPathVerifies', () => {
  const contact = { email: 'Jo@Example.com', last_name: 'Murphy' }
  it('requires BOTH a matching email AND the surname (email alone fails)', () => {
    expect(emailPathVerifies(contact, { email: 'jo@example.com' })).toBe(false)
    expect(emailPathVerifies(contact, { email: 'jo@example.com', last_name: 'Murphy' })).toBe(true)
  })
  it('accepts the surname from the channel display name (nameHint)', () => {
    expect(emailPathVerifies(contact, { email: 'jo@example.com' }, { nameHint: 'Jo Murphy' })).toBe(true)
    expect(emailPathVerifies(contact, { email: 'jo@example.com' }, { nameHint: 'jomurphy123' })).toBe(false)
  })
  it('fails on a wrong email even with the right surname', () => {
    expect(emailPathVerifies(contact, { email: 'someone@else.com', last_name: 'Murphy' })).toBe(false)
  })
  it('fails when the contact has no surname on file (cannot satisfy the 2nd factor)', () => {
    expect(emailPathVerifies({ email: 'jo@example.com', last_name: null }, { email: 'jo@example.com', last_name: 'Murphy' })).toBe(false)
  })
  it('handles null inputs', () => {
    expect(emailPathVerifies(null, { email: 'jo@example.com' })).toBe(false)
    expect(emailPathVerifies(contact, null)).toBe(false)
  })
})

describe('formatMembership', () => {
  it('maps state to a friendly label + exposes account_active', () => {
    expect(formatMembership({ glofox_membership_state: 'active', glofox_account_active: true }))
      .toEqual({ found: true, status: 'active', raw_state: 'active', account_active: true })
    expect(formatMembership({ glofox_membership_state: 'paused', glofox_account_active: true }).status).toBe('paused')
    expect(formatMembership({ glofox_membership_state: 'future', glofox_account_active: false }).status).toMatch(/starting soon/)
  })
  it('falls back to account_active when state is absent', () => {
    expect(formatMembership({ glofox_membership_state: null, glofox_account_active: true }).status).toBe('active')
    expect(formatMembership({ glofox_membership_state: null, glofox_account_active: false }).status).toBe('not currently active')
  })
  it('includes plan only when present', () => {
    expect(formatMembership({ glofox_membership_state: 'active', glofox_account_active: true }).plan).toBeUndefined()
    expect(formatMembership({ glofox_membership_state: 'active', glofox_account_active: true, glofox_membership_plan: 'Pay as you go' }).plan).toBe('Pay as you go')
  })
  it('returns not-found for empty / null record', () => {
    expect(formatMembership(null)).toEqual({ found: false })
    expect(formatMembership({ glofox_membership_state: null, glofox_account_active: null })).toEqual({ found: false })
  })
})

describe('formatNextClass (recent_bookings jsonb shape)', () => {
  const now = new Date('2026-06-01T12:00:00Z')
  const sec = (iso) => Math.floor(new Date(iso).getTime() / 1000)
  it('returns the soonest upcoming non-cancelled class', () => {
    const rows = [
      { event_name: 'Later', time_start: sec('2026-06-03T10:00:00Z'), status: 'BOOKED' },
      { event_name: 'Soonest', time_start: sec('2026-06-01T18:00:00Z'), status: 'BOOKED' },
      { event_name: 'Past', time_start: sec('2026-05-30T10:00:00Z'), status: 'BOOKED' },
    ]
    const r = formatNextClass(rows, now)
    expect(r.found).toBe(true)
    expect(r.class_name).toBe('Soonest')
    // MIA-REVIEW.3 — a DUBLIN wall-clock label, never the raw UTC ISO the
    // model used to be handed (18:00Z in June = 19:00 Dublin; the UTC form
    // is what told a customer their 7am class was at "6am", 2026-06-12).
    expect(r.class_time).toBe('Mon 1 Jun, 19:00')
  })
  it('falls back to model_name when event_name absent', () => {
    const rows = [{ model_name: 'RALLY - CONDITIONING', time_start: sec('2026-06-02T18:00:00Z'), status: 'BOOKED' }]
    expect(formatNextClass(rows, now).class_name).toBe('RALLY - CONDITIONING')
  })
  it('skips cancelled classes', () => {
    const rows = [
      { event_name: 'Cancelled', time_start: sec('2026-06-01T18:00:00Z'), status: 'CANCELLED' },
      { event_name: 'Good', time_start: sec('2026-06-02T18:00:00Z'), status: 'BOOKED' },
    ]
    expect(formatNextClass(rows, now).class_name).toBe('Good')
  })
  it('returns not-found when nothing upcoming', () => {
    expect(formatNextClass([], now)).toEqual({ found: false })
    expect(formatNextClass([{ event_name: 'Past', time_start: sec('2026-05-01T10:00:00Z'), status: 'BOOKED' }], now)).toEqual({ found: false })
    expect(formatNextClass(null, now)).toEqual({ found: false })
  })
})

describe('formatRecentAttendance (rollup columns)', () => {
  it('reads the synced rollups off the contact row', () => {
    const r = formatRecentAttendance({ total_attended_30d: 10, total_attended_7d: 2, last_attended_at: '2026-05-23T07:00:00Z' })
    expect(r).toEqual({ found: true, attended_last_30d: 10, attended_last_7d: 2, last_attended: '2026-05-23T07:00:00Z' })
  })
  it('coerces missing counts to 0', () => {
    const r = formatRecentAttendance({ total_attended_30d: null, total_attended_7d: null, last_attended_at: '2026-05-23T07:00:00Z' })
    expect(r).toEqual({ found: true, attended_last_30d: 0, attended_last_7d: 0, last_attended: '2026-05-23T07:00:00Z' })
  })
  it('returns found:false when there is no attendance at all', () => {
    expect(formatRecentAttendance({ total_attended_30d: 0, total_attended_7d: 0, last_attended_at: null })).toEqual({ found: false })
    expect(formatRecentAttendance(null)).toEqual({ found: false })
  })
})

describe('tool registry', () => {
  it('exposes all seven tools (4 read + 3 request)', () => {
    expect([...ACCOUNT_TOOL_NAMES].sort()).toEqual(
      [
        'get_my_membership', 'get_my_next_class', 'get_my_recent_attendance',
        'request_cancellation', 'request_membership_purchase', 'request_pause', 'verify_identity',
      ].sort()
    )
  })
  it('normEmail lowercases + trims', () => {
    expect(normEmail('  Foo@Bar.COM ')).toBe('foo@bar.com')
  })
})


// RADAR-AGENT Phase 2 — pause / cancellation request builders.
describe('buildPauseDetails', () => {
  it('captures + normalises dates and reason', () => {
    expect(buildPauseDetails({ start_date: '2026-07-01', end_date: '2026-08-01T00:00:00Z', reason: '  travelling  ' }))
      .toEqual({ start_date: '2026-07-01', end_date: '2026-08-01', reason: 'travelling' })
  })
  it('nulls missing / blank fields', () => {
    expect(buildPauseDetails({})).toEqual({ start_date: null, end_date: null, reason: null })
    expect(buildPauseDetails({ reason: '   ' }).reason).toBeNull()
  })
  it('ignores a non-date string', () => {
    expect(buildPauseDetails({ start_date: 'next week' }).start_date).toBeNull()
  })
})

describe('buildCancellationDetails', () => {
  it('captures reason + desired date', () => {
    expect(buildCancellationDetails({ reason: 'too expensive', desired_date: '2026-09-01' }))
      .toEqual({ reason: 'too expensive', desired_date: '2026-09-01' })
  })
  it('nulls missing fields', () => {
    expect(buildCancellationDetails({})).toEqual({ reason: null, desired_date: null })
  })
})

describe('Phase 2 tool registry', () => {
  it('exposes request_pause + request_cancellation', () => {
    expect(ACCOUNT_TOOL_NAMES.has('request_pause')).toBe(true)
    expect(ACCOUNT_TOOL_NAMES.has('request_cancellation')).toBe(true)
  })
})

// request_membership_purchase — the "yes to the offer" capture path.
import { buildMembershipPurchaseDetails } from './account-tools'

describe('buildMembershipPurchaseDetails', () => {
  it('keeps the offer and note, trimmed', () => {
    expect(buildMembershipPurchaseDetails({ offer: '  Kickstarter — first month €99 ', note: 'wants to start Monday' }))
      .toEqual({ offer: 'Kickstarter — first month €99', note: 'wants to start Monday' })
  })
  it('nulls empties and caps length', () => {
    const d = buildMembershipPurchaseDetails({ offer: 'x'.repeat(500), note: '' })
    expect(d.offer.length).toBe(300)
    expect(d.note).toBeNull()
    expect(buildMembershipPurchaseDetails({})).toEqual({ offer: null, note: null })
  })
})

// ── DUPE-VERIFY — a linked thread must verify against ANY contact on the
// sender's number, not just the thread's bound contact_id. A WhatsApp number
// with several contact rows (duplicates) that gets pinned to one whose email
// differs from the member's would otherwise make the email quiz unwinnable:
// the customer can only ever type their own real email, never the dupe's.
import { pickVerifiedContact, executeAccountTool, verifyFailureHint, escapeLikePattern } from './account-tools'

// AGENT-AUTH.3 — the retry hint used to demand a surname on EVERY failed path,
// including the linked shared-number one where the prompt mandates asking for
// the email ONLY (and where the surname is ignored by the matcher anyway).
describe('verifyFailureHint', () => {
  it('LINKED: asks only for the email, never a surname', () => {
    const hint = verifyFailureHint(true)
    expect(hint).toMatch(/email/i)
    expect(hint).toMatch(/do not ask for a surname/i)
    expect(hint).not.toMatch(/together with the surname/i)
  })
  it('UNLINKED: still asks for email + surname (the second factor is real there)', () => {
    expect(verifyFailureHint(false)).toMatch(/email on the account together with the surname/i)
  })
  it('never reveals which detail matched, on either path', () => {
    for (const linked of [true, false]) {
      expect(verifyFailureHint(linked)).toMatch(/never reveal which detail/i)
    }
  })
})

describe('pickVerifiedContact', () => {
  const member = { id: 'm1', email: 'taylor@example.test', last_name: 'Fixture' }
  const dupe = { id: 'd1', email: 'test@example.test', last_name: 'Fixture' }

  it('LINKED: verifies against a sibling when the thread is bound to a different duplicate', () => {
    // Pool = the bound dupe (test@, no membership) + the real member (richard@).
    // Customer gives their real membership email → must resolve to the member.
    expect(pickVerifiedContact([dupe, member], { email: 'taylor@example.test' }, { linked: true })).toEqual(member)
  })

  it('LINKED: matches email case-insensitively across the pool', () => {
    expect(pickVerifiedContact([dupe, member], { email: '  TAYLOR@EXAMPLE.TEST ' }, { linked: true })).toEqual(member)
  })

  it('LINKED: no match when the email is on none of the sender\'s contacts', () => {
    expect(pickVerifiedContact([dupe, member], { email: 'someone@else.com' }, { linked: true })).toBeNull()
  })

  it('LINKED: a single-contact pool behaves exactly like the old bound-only check', () => {
    expect(pickVerifiedContact([member], { email: 'taylor@example.test' }, { linked: true })).toEqual(member)
    expect(pickVerifiedContact([member], { email: 'someone@else.com' }, { linked: true })).toBeNull()
  })

  it('UNLINKED (email path): still requires email + surname, not email alone', () => {
    expect(pickVerifiedContact([member], { email: 'taylor@example.test' }, { linked: false })).toBeNull()
    expect(pickVerifiedContact([member], { email: 'taylor@example.test', last_name: 'Fixture' }, { linked: false })).toEqual(member)
  })

  it('UNLINKED: surname may come from the channel display name (nameHint)', () => {
    expect(pickVerifiedContact([member], { email: 'taylor@example.test' }, { linked: false, nameHint: 'Taylor Fixture' })).toEqual(member)
  })

  it('returns null on empty / non-array pool', () => {
    expect(pickVerifiedContact([], { email: 'x@y.com' }, { linked: true })).toBeNull()
    expect(pickVerifiedContact(null, { email: 'x@y.com' }, { linked: true })).toBeNull()
  })
})

// Minimal thenable-builder mock mirroring the two contacts reads + one
// conversations update that verify_identity performs. supabase-js builders are
// thenables, so the mock resolves on await via `then`.
function makeVerifyMockDb({ bound, siblings, byEmail = [], onUpdate, onIlike }) {
  return {
    from(table) {
      const b = {
        _table: table, _update: false, _or: false, _ilike: false, _payload: null,
        select() { return b },
        update(payload) { b._update = true; b._payload = payload; return b },
        eq() { return b },
        or() { b._or = true; return b },
        ilike(col, pattern) { b._ilike = true; onIlike && onIlike(col, pattern); return b },
        limit() { return b },
        async maybeSingle() { return { data: bound, error: null } },
        then(resolve, reject) {
          try {
            if (b._update) { onUpdate && onUpdate(b._payload); resolve({ data: null, error: null }) }
            else if (b._ilike) { resolve({ data: byEmail, error: null }) }
            else if (b._or) { resolve({ data: siblings, error: null }) }
            else { resolve({ data: null, error: null }) }
          } catch (e) { reject(e) }
        },
      }
      return b
    },
  }
}

describe('executeAccountTool · verify_identity across duplicate contacts', () => {
  const bound = { id: 'd1', email: 'test@example.test', last_name: 'Fixture', wa_phone: '353870000000', phone: '0870000000' }
  const siblings = [
    { id: 'd1', email: 'test@example.test', last_name: 'Fixture' },
    { id: 'm1', email: 'taylor@example.test', last_name: 'Fixture' },
  ]

  it('verifies the member and stamps the MEMBER contact, though the thread is bound to a membership-less dupe', async () => {
    let stamped = null
    const db = makeVerifyMockDb({ bound, siblings, onUpdate: (p) => { stamped = p } })
    const res = await executeAccountTool(
      'verify_identity',
      { email: 'taylor@example.test', last_name: 'Fixture' },
      { db, conversationId: 'c1', conversationsTable: 'whatsapp_conversations', contactId: 'd1', locationId: 'loc1', channel: 'whatsapp' },
    )
    expect(res).toEqual({ verified: true })
    expect(stamped.agent_verified_contact_id).toBe('m1')
  })

  it('still refuses an email that is on none of the sender\'s contacts', async () => {
    let stamped = null
    const db = makeVerifyMockDb({ bound, siblings, onUpdate: (p) => { stamped = p } })
    const res = await executeAccountTool(
      'verify_identity',
      { email: 'attacker@evil.com', last_name: 'Fixture' },
      { db, conversationId: 'c1', conversationsTable: 'whatsapp_conversations', contactId: 'd1', locationId: 'loc1', channel: 'whatsapp' },
    )
    expect(res.verified).toBe(false)
    expect(stamped).toBeNull()
  })
})

// MIA-REVIEW.3 (3.5) — the email-only "linked" relaxation is justified by the
// WhatsApp NUMBER being a second factor, not by the conversation carrying a
// contact_id. instagram_conversations has a contact_id column too, so keying on
// !!contactId would silently downgrade any future IG contact link from
// email+surname to email-only. Emails are not secret.
describe('executeAccountTool · verify_identity keys "linked" on the phone factor', () => {
  const bound = { id: 'ig1', email: 'jane@example.com', last_name: 'Murphy', wa_phone: null, phone: null }

  const ctxFor = (channel) => ({
    db: null, conversationId: 'c1', conversationsTable: `${channel}_conversations`,
    contactId: 'ig1', locationId: 'loc1', channel,
  })

  it('WhatsApp + a bound contact: email alone verifies (the number is the 2nd factor)', async () => {
    let stamped = null
    const db = makeVerifyMockDb({ bound, siblings: [bound], onUpdate: (p) => { stamped = p } })
    const res = await executeAccountTool('verify_identity', { email: 'jane@example.com' },
      { ...ctxFor('whatsapp'), db })
    expect(res).toEqual({ verified: true })
    expect(stamped.agent_verified_contact_id).toBe('ig1')
  })

  it('Instagram + a bound contact: email alone is NOT enough — surname still required', async () => {
    let stamped = null
    const db = makeVerifyMockDb({ bound, siblings: [bound], byEmail: [bound], onUpdate: (p) => { stamped = p } })
    const res = await executeAccountTool('verify_identity', { email: 'jane@example.com' },
      { ...ctxFor('instagram'), db })
    expect(res.verified).toBe(false)
    expect(res.hint).toMatch(/surname/i)
    expect(stamped).toBeNull()
  })

  it('Instagram: email + surname still verifies', async () => {
    let stamped = null
    const db = makeVerifyMockDb({ bound, siblings: [bound], byEmail: [bound], onUpdate: (p) => { stamped = p } })
    const res = await executeAccountTool('verify_identity', { email: 'jane@example.com', last_name: 'Murphy' },
      { ...ctxFor('instagram'), db })
    expect(res).toEqual({ verified: true })
    expect(stamped.agent_verified_contact_id).toBe('ig1')
  })
})

// MIA-REVIEW.3 (3.15) — customer-supplied email goes into .ilike; % and _ are
// LIKE wildcards there. Never a bypass (emailPathVerifies re-checks strict
// equality), but an unescaped '_' matches any character and could fetch the
// wrong row, failing a legitimate member's verification.
describe('escapeLikePattern', () => {
  it('escapes the LIKE wildcards and the escape character itself', () => {
    expect(escapeLikePattern('jo_smith@example.com')).toBe('jo\\_smith@example.com')
    expect(escapeLikePattern('%')).toBe('\\%')
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
    expect(escapeLikePattern('plain@example.com')).toBe('plain@example.com')
    expect(escapeLikePattern(null)).toBe('')
  })

  it('the unlinked email lookup queries the ESCAPED pattern', async () => {
    const seen = []
    const db = makeVerifyMockDb({
      bound: null, siblings: [], byEmail: [],
      onIlike: (col, pattern) => seen.push([col, pattern]),
    })
    await executeAccountTool('verify_identity', { email: 'jo_smith@example.com', last_name: 'Smith' },
      { db, conversationId: 'c1', conversationsTable: 'instagram_conversations', contactId: null, locationId: 'loc1', channel: 'instagram' })
    expect(seen).toEqual([['email', 'jo\\_smith@example.com']])
  })
})

// MIA-REVIEW.3 (3.13) — tool results are written FOR the model: a raw
// PostgREST/Postgres string would put constraint/column/RLS detail into the
// model's context (card-tools convention). Clean message out, real error logged.
describe('executeAccountTool · request queue failures never leak the raw DB error', () => {
  function insertFailDb(message) {
    return {
      from() {
        let inserting = false
        const b = {
          select() { return b }, eq() { return b }, limit() { return b },
          async maybeSingle() { return { data: null, error: null } },
          // insert().select('id').single() shape (APPROVALS-STUDIO.1 captures
          // the new row id for the approval push).
          insert() { inserting = true; return b },
          async single() { return inserting ? { data: null, error: { message } } : { data: null, error: null } },
          then(resolve) { resolve({ data: null, error: null }) },
        }
        return b
      },
    }
  }
  const RAW = 'duplicate key value violates unique constraint "agent_membership_requests_pkey"'

  it('request_membership_purchase returns a clean message and logs the real error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await executeAccountTool('request_membership_purchase', { offer: 'Kickstarter' },
      { db: insertFailDb(RAW), conversationId: 'c1', conversationsTable: 'whatsapp_conversations', contactId: 'c-1', locationId: 'loc1', channel: 'whatsapp' })
    expect(res.error).toBe('queue_failed')
    expect(res.message).not.toContain('constraint')
    expect(res.message).toMatch(/hand off/i)
    expect(spy.mock.calls.flat().join(' ')).toContain(RAW)
    spy.mockRestore()
  })

  it('request_pause does the same on the verified path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await executeAccountTool('request_pause', { reason: 'travelling' },
      { db: insertFailDb(RAW), conversationId: 'c1', conversationsTable: 'whatsapp_conversations', contactId: 'c-1', verifiedContactId: 'c-1', locationId: 'loc1', channel: 'whatsapp' })
    expect(res.error).toBe('queue_failed')
    expect(res.message).not.toContain('constraint')
    spy.mockRestore()
  })
})

// PERSON-ACCT.8 — request_pause/request_cancellation elect ONE of a
// person's linked accounts (electWriteAccount, person-accounts.js) rather
// than always filing against the contact the conversation happens to be
// bound to — same discipline book_class already applies (PERSON-ACCT.7).
//
// stubDb mirrors booking-tools-elect.test.js's double: person_group_members
// resolves the group, contacts answers eq('id', x) / in('id', [...]), and
// agent_membership_requests captures whatever the insert actually wrote so
// assertions read the real row shape, not a reimplementation of it.
describe('executeAccountTool · request_pause / request_cancellation elect the write account', () => {
  function stubDb(trace, { contacts = [], groupId = 'g-1' } = {}) {
    return {
      from(table) {
        const st = { cols: '', filters: {} }
        const settle = (single) => {
          if (table === 'person_group_members') {
            if (st.cols.includes('group_id')) return { data: { group_id: groupId }, error: null }
            return { data: contacts.map((c) => ({ contact_id: c.id })), error: null }
          }
          if (table === 'contacts') {
            const want = st.filters.id
            const list = Array.isArray(want)
              ? contacts.filter((c) => want.includes(c.id))
              : contacts.filter((c) => c.id === want)
            return { data: list, error: null }
          }
          if (table === 'agent_membership_requests') {
            if (st.op === 'insert') return { data: { id: 'req-1' }, error: null }
            return single ? { data: null, error: null } : { data: [], error: null }
          }
          return single ? { data: null, error: null } : { data: [], error: null }
        }
        const b = {
          select(cols) { st.cols = cols || ''; return b },
          eq(col, val) { st.filters[col] = val; return b },
          in(col, vals) { st.filters[col] = vals; return b },
          limit() { return b },
          insert(row) {
            st.op = 'insert'
            trace.push({
              contactId: row.contact_id, kind: row.kind, details: row.details,
              customerNote: row.customer_note, retentionFlagged: row.retention_flagged,
            })
            return b
          },
          async maybeSingle() { return settle(true) },
          async single() { return settle(true) },
          then(resolve, reject) { return Promise.resolve(settle(false)).then(resolve, reject) },
        }
        return b
      },
    }
  }

  const PHONE = '+353871234567'
  const acct = (id, memberId, extra = {}) => ({
    id,
    name: `Vanessa ${id}`,
    glofox_member_id: memberId,
    glofox_membership_status: 'lead',
    glofox_membership_state: null,
    trial_credits_remaining: null,
    last_attended_at: null,
    updated_at: '2026-08-01T00:00:00Z',
    phone: PHONE,
    wa_phone: null,
    email: null,
    location_id: null,
    ...extra,
  })

  const ctx = (db) => ({
    db, conversationId: 'conv-1', conversationsTable: 'whatsapp_conversations',
    contactId: 'c-1', verifiedContactId: 'c-1', locationId: 'loc-1', channel: 'whatsapp',
    nameHint: 'Vanessa',
  })

  it('pause files against the ELECTED sibling, stamped with elected_glofox_member_id', async () => {
    const group = [
      acct('c-1', 'gf-1'), // the anchor — bare lead, conversation is bound here
      acct('c-2', 'gf-2', { glofox_membership_status: 'member', glofox_membership_state: 'active' }),
    ]
    const trace = []
    const db = stubDb(trace, { contacts: group })
    const res = await executeAccountTool('request_pause', { reason: 'going travelling for a month' }, ctx(db))
    expect(res).toEqual({ requested: true, kind: 'pause' })
    expect(trace).toHaveLength(1)
    expect(trace[0].contactId).toBe('c-2')
    expect(trace[0].details.elected_glofox_member_id).toBe('gf-2')
    expect(trace[0].details.candidates).toBeUndefined()
    // Customer's own words survive verbatim, in both details.reason and
    // the top-level customer_note the card reads.
    expect(trace[0].details.reason).toBe('going travelling for a month')
    expect(trace[0].customerNote).toBe('going travelling for a month')
  })

  it('cancellation does the same', async () => {
    const group = [
      acct('c-1', 'gf-1'),
      acct('c-2', 'gf-2', { glofox_membership_status: 'member', glofox_membership_state: 'active' }),
    ]
    const trace = []
    const db = stubDb(trace, { contacts: group })
    const res = await executeAccountTool('request_cancellation', { reason: "can't afford it right now" }, ctx(db))
    expect(res).toEqual({ requested: true, kind: 'cancellation' })
    expect(trace[0].contactId).toBe('c-2')
    expect(trace[0].details.elected_glofox_member_id).toBe('gf-2')
    expect(trace[0].details.reason).toBe("can't afford it right now")
    expect(trace[0].customerNote).toBe("can't afford it right now")
    expect(trace[0].retentionFlagged).toBe(true)
  })

  it('conflict: files against the top candidate with details.candidates, and the customer\'s words are untouched', async () => {
    const older = acct('c-1', 'gf-1', {
      glofox_membership_status: 'member', glofox_membership_state: 'active',
      last_attended_at: '2026-08-01T00:00:00Z', trial_credits_remaining: 4,
    })
    const newer = acct('c-2', 'gf-2', {
      glofox_membership_status: 'member', glofox_membership_state: 'active',
      last_attended_at: '2026-08-10T00:00:00Z', trial_credits_remaining: 0,
    })
    const trace = []
    const db = stubDb(trace, { contacts: [older, newer] })
    const said = 'moving to another city next month, please cancel'
    const res = await executeAccountTool('request_cancellation', { reason: said }, ctx(db))
    expect(res).toEqual({ requested: true, kind: 'cancellation' })
    // Ranked: 'newer' (more recent activity) is the top candidate.
    expect(trace[0].contactId).toBe('c-2')
    expect(trace[0].details.elected_glofox_member_id).toBeUndefined()
    expect(trace[0].details.candidates).toEqual([
      { contact_id: 'c-2', glofox_member_id: 'gf-2', membership_status: 'member', credits: 0, name: 'Vanessa c-2' },
      { contact_id: 'c-1', glofox_member_id: 'gf-1', membership_status: 'member', credits: 4, name: 'Vanessa c-1' },
    ])
    // The whole point of this test: a machine-shaped candidates array sits
    // ALONGSIDE details.reason, never inside or instead of it — the reason
    // is the exact customer string, still renderable as a quote.
    expect(trace[0].details.reason).toBe(said)
    expect(trace[0].customerNote).toBe(said)
  })

  it('customer_note is preserved exactly as the tool captured it, regardless of election outcome', async () => {
    // A single bare contact — election outcome 'none' (no linked group to
    // elect from — see the readFailed-equivalent test below for the other
    // 'stay put' path).
    const trace = []
    const db = stubDb(trace, { contacts: [] })
    const res = await executeAccountTool('request_pause', { reason: '  injury, need a break  ', start_date: '2026-09-01' }, ctx(db))
    expect(res).toEqual({ requested: true, kind: 'pause' })
    expect(trace[0].contactId).toBe('c-1')
    expect(trace[0].customerNote).toBe('injury, need a break')
    expect(trace[0].details.reason).toBe('injury, need a break')
  })

  it('readFailed (unreadable group) → unchanged single-contact filing, no election fields added', async () => {
    const failingDb = {
      from(table) {
        if (table === 'person_group_members') {
          return {
            select() { return this },
            eq() { return this },
            async maybeSingle() { return { data: null, error: { message: 'boom' } } },
          }
        }
        // Never reached for contacts once the group lookup errors, but keep
        // it harmless in case the code path changes.
        if (table === 'contacts') {
          return { select() { return this }, eq() { return this }, in() { return this }, then(resolve) { resolve({ data: [], error: null }) } }
        }
        if (table === 'agent_membership_requests') {
          const b = {
            select() { return b },
            insert(row) { trace.push({ contactId: row.contact_id, details: row.details }); return b },
            async single() { return { data: { id: 'req-1' }, error: null } },
          }
          return b
        }
        return { select() { return this }, eq() { return this }, then(resolve) { resolve({ data: [], error: null }) } }
      },
    }
    const trace = []
    const res = await executeAccountTool('request_cancellation', { reason: 'no longer needed' }, ctx(failingDb))
    expect(res).toEqual({ requested: true, kind: 'cancellation' })
    expect(trace[0].contactId).toBe('c-1') // the anchor — verifiedContactId, unchanged
    expect(trace[0].details.elected_glofox_member_id).toBeUndefined()
    expect(trace[0].details.candidates).toBeUndefined()
  })

  it('locationId guard wiring: a foreign-location sibling is excluded, so the anchor is elected instead of escalating to conflict', async () => {
    const home = acct('c-1', 'gf-1', {
      glofox_membership_status: 'member', glofox_membership_state: 'active', location_id: 'loc-1',
    })
    const foreign = acct('c-2', 'gf-2', {
      glofox_membership_status: 'member', glofox_membership_state: 'active', location_id: 'loc-2',
    })
    const trace = []
    const db = stubDb(trace, { contacts: [home, foreign] })
    // ctx() sets locationId: 'loc-1' — foreign's loc-2 must be excluded.
    const res = await executeAccountTool('request_pause', { reason: 'need a break' }, ctx(db))
    expect(res).toEqual({ requested: true, kind: 'pause' })
    expect(trace[0].contactId).toBe('c-1')
    expect(trace[0].details.elected_glofox_member_id).toBe('gf-1')
    expect(trace[0].details.candidates).toBeUndefined()
  })
})
