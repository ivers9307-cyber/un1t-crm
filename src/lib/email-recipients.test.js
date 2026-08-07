// EMAIL-CC.1 — the recipient model.
//
// THE FILE THIS TESTS IS THE ONE PLACE A BCC CAN LEAK INTO A LATER SEND, so
// the Bcc block below is written as a MUTATION CHECK, not a happy-path
// assertion: every test in it fails if the guard it names is deleted. The
// guard here is negative space — `threadParticipants()` not reading
// `bcc_emails` — and negative space is exactly what a test suite normally
// fails to notice disappearing, so the fixtures put a Bcc address on every
// message the function is handed and assert on the ABSENCE of it.

import { describe, it, expect } from 'vitest'
import {
  MAX_RECIPIENTS,
  MAX_STORED_RECIPIENTS,
  normalizeAddress,
  normalizeAddressList,
  inboundAddresses,
  threadParticipants,
  latestCorrespondence,
  replyMode,
  resolveRecipients,
  toPostmarkFields,
  newRecipients,
  recipientCount,
} from './email-recipients'

const OURS = ['studio@un1tdublin.com', 'UN1T <hello@un1t.ie>']

describe('normalizeAddress', () => {
  it('trims and lowercases', () => {
    expect(normalizeAddress('  Ada@Example.COM ')).toBe('ada@example.com')
  })

  it('unwraps the "Display Name <addr>" form operators paste out of a mail client', () => {
    expect(normalizeAddress('Ada Member <Ada@Example.com>')).toBe('ada@example.com')
  })

  it('rejects anything that is not an address', () => {
    for (const bad of ['', '   ', 'ada', 'ada@', '@example.com', 'ada example.com', null, 42, {}]) {
      expect(normalizeAddress(bad)).toBeNull()
    }
  })

  // The LIKE metacharacters are legal email characters and this validator must
  // NOT reject them — an underscore in a local part is ordinary. The wildcard
  // hazard lives in DB lookups (escapeLikePattern), not here.
  it('accepts underscores, which are legal and not this file’s problem', () => {
    expect(normalizeAddress('a_b@example.com')).toBe('a_b@example.com')
  })

  it('rejects a percent local part, which no valid address has', () => {
    expect(normalizeAddress('%@example.com')).toBeNull()
  })

  it('rejects an address over 320 characters', () => {
    expect(normalizeAddress(`${'a'.repeat(320)}@example.com`)).toBeNull()
  })
})

describe('normalizeAddressList', () => {
  it('splits usable addresses from unusable ones and dedupes case-insensitively', () => {
    const { valid, invalid } = normalizeAddressList([
      'Ada@Example.com', 'ada@example.com', 'nope', '', null, 'bob@example.com',
    ])
    expect(valid).toEqual(['ada@example.com', 'bob@example.com'])
    expect(invalid).toEqual(['nope'])
  })

  it('never throws on a non-array', () => {
    expect(normalizeAddressList(null)).toEqual({ valid: [], invalid: [] })
  })
})

describe('inboundAddresses', () => {
  it('reads Postmark’s typed *Full array', () => {
    expect(inboundAddresses(
      [{ Email: 'Ada@Example.com', Name: 'Ada' }, { Email: 'bob@example.com' }],
      null,
    )).toEqual(['ada@example.com', 'bob@example.com'])
  })

  // Both sources are read because neither is reliable alone — a Cc we fail to
  // record is a person the operator never learns was on the thread.
  it('falls back to the display-string header when *Full is missing', () => {
    expect(inboundAddresses(undefined, 'Ada <ada@example.com>, bob@example.com'))
      .toEqual(['ada@example.com', 'bob@example.com'])
  })

  it('merges the two without duplicating', () => {
    expect(inboundAddresses([{ Email: 'ada@example.com' }], 'Ada <ADA@example.com>, bob@example.com'))
      .toEqual(['ada@example.com', 'bob@example.com'])
  })

  // A stranger can put 500 addresses in a Cc header; an unbounded text[] would
  // then ride along on every read of that ticket forever.
  it('caps a hostile header at MAX_STORED_RECIPIENTS', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ Email: `a${i}@example.com` }))
    expect(inboundAddresses(many, null)).toHaveLength(MAX_STORED_RECIPIENTS)
  })
})

describe('resolveRecipients — dedupe', () => {
  // The ordinary version of the bug the brief names: the member's own address
  // in To AND Cc.
  it('removes an address from Cc when it is already in To', () => {
    const r = resolveRecipients({ to: ['ada@example.com'], cc: ['ada@example.com'] })
    expect(r).toMatchObject({ ok: true, to: ['ada@example.com'], cc: [] })
  })

  // The interesting version: it differs only in case.
  it('dedupes case-insensitively across all three lists', () => {
    const r = resolveRecipients({
      to: ['Ada@Example.com'],
      cc: ['ADA@EXAMPLE.COM', 'bob@example.com'],
      bcc: ['ada@example.com', 'BOB@example.com', 'carol@example.com'],
    })
    expect(r).toMatchObject({
      ok: true,
      to: ['ada@example.com'],
      cc: ['bob@example.com'],
      bcc: ['carol@example.com'],
    })
  })

  // The strongest visibility wins. Demoting someone from To to Bcc would
  // change who the other recipients think the mail was addressed to.
  it('keeps the STRONGEST placement — To beats Cc beats Bcc', () => {
    const r = resolveRecipients({ to: [], cc: ['ada@example.com'], bcc: ['ada@example.com'] })
    expect(r.ok).toBe(false)
    const r2 = resolveRecipients({ to: ['x@example.com'], cc: ['ada@example.com'], bcc: ['ada@example.com'] })
    expect(r2).toMatchObject({ cc: ['ada@example.com'], bcc: [] })
  })

  it('dedupes within a single list too', () => {
    const r = resolveRecipients({ to: ['ada@example.com', 'Ada@example.com'] })
    expect(r.to).toEqual(['ada@example.com'])
  })
})

describe('resolveRecipients — our own addresses', () => {
  // Mailing ourselves is not harmless: Postmark delivers the copy to our own
  // inbound webhook, which files OUR OWN REPLY on the SAME ticket as an
  // inbound message — the ticket reopens and the needs-reply badge lights up
  // for mail nobody sent us.
  it('strips our addresses from every list, including a hand-typed one', () => {
    const r = resolveRecipients({
      to: ['ada@example.com', 'studio@un1tdublin.com'],
      cc: ['STUDIO@un1tdublin.com'],
      bcc: ['hello@un1t.ie'],
      exclude: OURS,
    })
    expect(r).toMatchObject({ ok: true, to: ['ada@example.com'], cc: [], bcc: [] })
  })

  it('unwraps a "Name <addr>" exclusion, because POSTMARK_FROM_EMAIL is written that way', () => {
    const r = resolveRecipients({ to: ['hello@un1t.ie'], exclude: ['UN1T <hello@un1t.ie>'] })
    expect(r).toMatchObject({ ok: false, code: 'no_recipients' })
  })

  it('refuses rather than sending to nobody when exclusions empty the To list', () => {
    const r = resolveRecipients({ to: ['studio@un1tdublin.com'], cc: ['ada@example.com'], exclude: OURS })
    expect(r).toMatchObject({ ok: false, code: 'no_recipients' })
  })
})

describe('resolveRecipients — validation and the cap', () => {
  it('REFUSES an invalid address rather than dropping it', () => {
    const r = resolveRecipients({ to: ['ada@example.com'], cc: ['not-an-address'] })
    expect(r).toMatchObject({ ok: false, code: 'invalid_address', invalid: ['not-an-address'] })
  })

  it('names the offending value so the operator can fix it', () => {
    const r = resolveRecipients({ to: ['bogus'] })
    expect(r.error).toContain('bogus')
  })

  it(`accepts exactly ${MAX_RECIPIENTS} addresses across all three lists`, () => {
    const to = Array.from({ length: 10 }, (_, i) => `t${i}@example.com`)
    const cc = Array.from({ length: 10 }, (_, i) => `c${i}@example.com`)
    const bcc = Array.from({ length: 5 }, (_, i) => `b${i}@example.com`)
    const r = resolveRecipients({ to, cc, bcc })
    expect(r).toMatchObject({ ok: true, count: MAX_RECIPIENTS })
  })

  // The cap is COMBINED, not per list — three lists of 24 would be a bulk
  // sender wearing a ticket's clothes.
  it('refuses one address over the cap, counting To + Cc + Bcc together', () => {
    const to = Array.from({ length: 9 }, (_, i) => `t${i}@example.com`)
    const cc = Array.from({ length: 9 }, (_, i) => `c${i}@example.com`)
    const bcc = Array.from({ length: 8 }, (_, i) => `b${i}@example.com`)
    const r = resolveRecipients({ to, cc, bcc })
    expect(r).toMatchObject({ ok: false, code: 'too_many_recipients' })
    expect(r.error).toContain(String(MAX_RECIPIENTS))
  })

  // Duplicates and exclusions come off BEFORE the count, or a paste of the
  // same address 30 times would be refused as 30 recipients.
  it('counts after dedupe and exclusion, not before', () => {
    const to = ['ada@example.com', ...Array.from({ length: 40 }, () => 'ada@example.com')]
    expect(resolveRecipients({ to })).toMatchObject({ ok: true, count: 1 })
  })

  it('recipientCount adds the three lists', () => {
    expect(recipientCount({ to: ['a@x.com'], cc: ['b@x.com', 'c@x.com'], bcc: [] })).toBe(3)
  })
})

// ── THE BCC GUARANTEE ────────────────────────────────────────────────
//
// Deleting the guard must turn one of these red. The guard is that
// threadParticipants() does not read `bcc_emails`; each fixture below carries
// a Bcc address, and each assertion is that it is NOT in the result. A change
// that adds `...message.bcc_emails` to that function fails every one of them.
describe('threadParticipants — bcc NEVER becomes a recipient', () => {
  const OUTBOUND_WITH_BCC = {
    direction: 'outbound',
    from_email: 'hello@un1t.ie',
    to_emails: ['ada@example.com'],
    cc_emails: ['bob@example.com'],
    bcc_emails: ['secret@example.com', 'auditor@example.com'],
    is_internal_note: false,
    created_at: '2026-08-07T10:00:00Z',
  }

  it('omits every bcc address from the participant set', () => {
    const out = threadParticipants(OUTBOUND_WITH_BCC, { exclude: OURS })
    expect(out).toEqual(['ada@example.com', 'bob@example.com'])
    expect(out).not.toContain('secret@example.com')
    expect(out).not.toContain('auditor@example.com')
  })

  it('omits a bcc address even when it is ALSO the only other plausible recipient', () => {
    const bccOnly = { ...OUTBOUND_WITH_BCC, to_emails: [], to_email: null, cc_emails: [] }
    expect(threadParticipants(bccOnly, { exclude: OURS })).toEqual([])
  })

  // The one that catches a "helpfully" merged implementation: a bcc address
  // that also appears in Cc is on the thread because of the Cc, and removing
  // the Cc must remove it.
  it('a bcc address is not resurrected by appearing in an earlier list', () => {
    const overlap = { ...OUTBOUND_WITH_BCC, cc_emails: [], bcc_emails: ['bob@example.com'] }
    expect(threadParticipants(overlap, { exclude: OURS })).toEqual(['ada@example.com'])
  })

  it('is unaffected by bcc when deciding reply vs reply-all', () => {
    const soloWithBcc = {
      ...OUTBOUND_WITH_BCC,
      cc_emails: [],
      bcc_emails: ['a@example.com', 'b@example.com', 'c@example.com'],
    }
    const out = threadParticipants(soloWithBcc, { exclude: OURS })
    expect(out).toEqual(['ada@example.com'])
    // Three blind copies must NOT make this a four-person reply-all.
    expect(replyMode(out)).toBe('reply')
  })
})

describe('threadParticipants — everybody on the thread', () => {
  const INBOUND = {
    direction: 'inbound',
    from_email: 'ada@example.com',
    to_emails: ['studio@un1tdublin.com'],
    cc_emails: ['bob@example.com', 'carol@example.com'],
    is_internal_note: false,
    created_at: '2026-08-07T09:00:00Z',
  }

  it('is From + To + Cc of the message, minus our own addresses', () => {
    expect(threadParticipants(INBOUND, { exclude: OURS }))
      .toEqual(['ada@example.com', 'bob@example.com', 'carol@example.com'])
  })

  // One rule has to cover both directions, or "reply-all on a ticket nobody
  // has answered yet" becomes a special case nobody tested.
  it('works the same on an OUTBOUND message, where the From is ours', () => {
    const outbound = {
      direction: 'outbound',
      from_email: 'hello@un1t.ie',
      to_emails: ['ada@example.com', 'bob@example.com'],
      cc_emails: [],
      bcc_emails: [],
      is_internal_note: false,
    }
    expect(threadParticipants(outbound, { exclude: OURS }))
      .toEqual(['ada@example.com', 'bob@example.com'])
  })

  it('falls back to the scalar to_email on a row written before mig 499', () => {
    const legacy = {
      direction: 'outbound', from_email: 'hello@un1t.ie',
      to_email: 'ada@example.com', cc_emails: [], is_internal_note: false,
    }
    expect(threadParticipants(legacy, { exclude: OURS })).toEqual(['ada@example.com'])
  })

  it('drops malformed stored addresses rather than putting them on the wire', () => {
    const junk = { from_email: 'ada@example.com', to_emails: ['', null, 'not-an-address'], cc_emails: [] }
    expect(threadParticipants(junk)).toEqual(['ada@example.com'])
  })

  it('returns [] for no message at all', () => {
    expect(threadParticipants(null)).toEqual([])
  })
})

describe('latestCorrespondence', () => {
  const older = { id: 'a', created_at: '2026-08-07T09:00:00Z', is_internal_note: false }
  const newer = { id: 'b', created_at: '2026-08-07T11:00:00Z', is_internal_note: false }
  const note = { id: 'c', created_at: '2026-08-07T12:00:00Z', is_internal_note: true }

  it('picks the newest message whatever order they arrive in', () => {
    expect(latestCorrespondence([older, newer]).id).toBe('b')
    expect(latestCorrespondence([newer, older]).id).toBe('b')
  })

  // A note was sent to nobody, so it names no participants — a thread that
  // ends in one must still reply-all to the people on the mail before it.
  it('skips internal notes, even when a note is the newest thing on the ticket', () => {
    expect(latestCorrespondence([older, newer, note]).id).toBe('b')
  })

  it('is null when there is nothing but notes', () => {
    expect(latestCorrespondence([note])).toBeNull()
    expect(latestCorrespondence([])).toBeNull()
  })
})

describe('replyMode', () => {
  it('is a plain reply for one recipient', () => {
    expect(replyMode(['ada@example.com'])).toBe('reply')
  })

  it('is reply-all for two or more', () => {
    expect(replyMode(['ada@example.com', 'bob@example.com'])).toBe('reply_all')
  })

  it('is a plain reply for an empty set, not a crash', () => {
    expect(replyMode([])).toBe('reply')
    expect(replyMode(undefined)).toBe('reply')
  })
})

describe('toPostmarkFields', () => {
  it('joins each list with a comma, as Postmark’s API expects', () => {
    expect(toPostmarkFields({ to: ['a@x.com', 'b@x.com'], cc: ['c@x.com'], bcc: ['d@x.com'] }))
      .toEqual({ to: 'a@x.com, b@x.com', cc: 'c@x.com', bcc: 'd@x.com' })
  })

  // undefined, not '' — so the serialised request body is byte-identical to a
  // pre-EMAIL-CC.1 send for every caller that passes no cc/bcc.
  it('omits an empty Cc/Bcc entirely', () => {
    expect(toPostmarkFields({ to: ['a@x.com'] })).toEqual({ to: 'a@x.com', cc: undefined, bcc: undefined })
  })

  // The single-site rule: bcc goes in `bcc` and touches nothing else.
  it('never puts a bcc address in the To or Cc value', () => {
    const wire = toPostmarkFields({ to: ['a@x.com'], cc: ['c@x.com'], bcc: ['secret@x.com'] })
    expect(wire.to).not.toContain('secret@x.com')
    expect(wire.cc).not.toContain('secret@x.com')
    expect(wire.bcc).toBe('secret@x.com')
  })
})

describe('newRecipients', () => {
  it('names only the addresses that were not already on the thread', () => {
    const resolved = { to: ['ada@example.com'], cc: ['stranger@example.com'], bcc: ['boss@example.com'] }
    expect(newRecipients(resolved, ['ADA@example.com']))
      .toEqual(['stranger@example.com', 'boss@example.com'])
  })

  it('is the whole set when nothing was known — a composed email', () => {
    expect(newRecipients({ to: ['ada@example.com'] }, [])).toEqual(['ada@example.com'])
  })
})
