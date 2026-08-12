// EMAIL-CC.1 — the recipient model.
//
// THE FILE THIS TESTS IS THE ONE PLACE A BCC CAN LEAK INTO A LATER SEND, so
// the Bcc block below is written as a MUTATION CHECK, not a happy-path
// assertion: every test in it fails if the guard it names is deleted. The
// guard here is negative space — `ticketParticipants()` not reading
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
  replyMode,
  resolveRecipients,
  toPostmarkFields,
  newRecipients,
  recipientCount,
  ticketParticipants,
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

// ── THE BCC GUARANTEE ────────────────────────────────────────────────
//
// ticketParticipants() is THE function that derives recipients from stored
// correspondence, so it is the one place a Bcc can leak into a later send.
// Deleting the guard must turn one of these red. The guard is NEGATIVE SPACE —
// the function not naming `bcc_emails` — and negative space is exactly what a
// suite normally fails to notice disappearing, so every fixture below carries
// a Bcc address and every assertion is that it is NOT in the result. A change
// that adds `...m.bcc_emails` to the loop fails all four.
//
// STRICTLY MORE EXPOSED THAN THE PER-MESSAGE DERIVATION IT REPLACED. This
// function unions the WHOLE thread, so a Bcc typed once, months ago, on a
// message nobody is replying to is still in the window it walks. The
// cross-message case below is that hazard, and it has no counterpart in a
// latest-message-only derivation.
describe('ticketParticipants — bcc NEVER becomes a recipient', () => {
  const bccMsg = (over = {}) => ({
    from_email: 'hello@un1t.ie',
    to_emails: ['ada@example.com'],
    cc_emails: ['bob@example.com'],
    bcc_emails: ['secret@example.com', 'auditor@example.com'],
    is_internal_note: false, forwarded_message_id: null,
    created_at: '2026-08-07T10:00:00Z', ...over,
  })

  it('omits every bcc address from the participant set', () => {
    const out = ticketParticipants([bccMsg()], { exclude: OURS })
    expect(out).toEqual(['ada@example.com', 'bob@example.com'])
    expect(out).not.toContain('secret@example.com')
    expect(out).not.toContain('auditor@example.com')
  })

  it('omits a bcc address even when it is ALSO the only other plausible recipient', () => {
    const bccOnly = bccMsg({ to_emails: [], to_email: null, cc_emails: [] })
    expect(ticketParticipants([bccOnly], { exclude: OURS })).toEqual([])
  })

  // THE UNION-SPECIFIC ONE. A bcc on an OLD message is inside the window this
  // function walks, so "we only look at the latest message" is no longer any
  // part of why it stays out — the only reason is that the column is never
  // read. Nothing else in this file would catch a bcc leaking in through a
  // message that is not the newest.
  it('does not resurrect a bcc address from an EARLIER message in the thread', () => {
    const out = ticketParticipants([
      bccMsg({ bcc_emails: ['ghost@example.com'], created_at: '2026-03-01T00:00:00Z' }),
      bccMsg({ from_email: 'ada@example.com', to_emails: ['hello@un1t.ie'], cc_emails: [],
               bcc_emails: [], created_at: '2026-08-07T10:00:00Z' }),
    ], { exclude: OURS })
    expect(out).not.toContain('ghost@example.com')
  })

  // The one that catches a "helpfully" merged implementation: an address that
  // is on the thread BECAUSE of a Cc is there on the Cc's account, and taking
  // the Cc away must take the person away.
  it('a bcc address is not resurrected by appearing in an earlier list', () => {
    const overlap = bccMsg({ cc_emails: [], bcc_emails: ['bob@example.com'] })
    expect(ticketParticipants([overlap], { exclude: OURS })).toEqual(['ada@example.com'])
  })

  it('is unaffected by bcc when deciding reply vs reply-all', () => {
    const soloWithBcc = bccMsg({
      cc_emails: [],
      bcc_emails: ['a@example.com', 'b@example.com', 'c@example.com'],
    })
    const out = ticketParticipants([soloWithBcc], { exclude: OURS })
    expect(out).toEqual(['ada@example.com'])
    // Three blind copies must NOT make this a four-person reply-all.
    expect(replyMode(out)).toBe('reply')
  })
})

describe('ticketParticipants', () => {
  const msg = (over = {}) => ({
    from_email: 'a@x.com', to_emails: [], cc_emails: [],
    is_internal_note: false, forwarded_message_id: null,
    created_at: '2026-08-01T00:00:00Z', ...over,
  })

  it('unions across the whole thread, not just the newest message', () => {
    const out = ticketParticipants([
      msg({ from_email: 'us@ours.com', to_emails: ['rates@council.ie'], created_at: '2026-08-01T00:00:00Z' }),
      msg({ from_email: 'eleanor@council.ie', to_emails: ['us@ours.com'], created_at: '2026-08-02T00:00:00Z' }),
    ], { exclude: ['us@ours.com'] })
    expect(out).toEqual(['eleanor@council.ie', 'rates@council.ie'])
  })

  it('unions cc_emails across the thread too, not just to_emails', () => {
    // The cc'd address appears only on the FIRST (non-latest) message — this
    // proves the cc_emails line inside the loop is actually reached, not just
    // present in the source. Every fixture above this leaves cc_emails empty.
    const out = ticketParticipants([
      msg({ from_email: 'us@ours.com', to_emails: ['member@x.com'], cc_emails: ['watcher@council.ie'],
            created_at: '2026-08-01T00:00:00Z' }),
      msg({ from_email: 'member@x.com', to_emails: ['us@ours.com'], created_at: '2026-08-02T00:00:00Z' }),
    ], { exclude: ['us@ours.com'] })
    expect(out).toContain('watcher@council.ie')
  })

  it('puts the latest correspondent first', () => {
    const out = ticketParticipants([
      msg({ from_email: 'old@x.com', created_at: '2026-08-01T00:00:00Z' }),
      msg({ from_email: 'new@x.com', created_at: '2026-08-05T00:00:00Z' }),
    ])
    expect(out[0]).toBe('new@x.com')
  })

  // ── THE LEAD SURVIVES OUR OWN REPLY (EMAIL-PARTICIPANTS.12) ────────
  //
  // The lead used to be `newest.from_email` unconditionally. On an OUTBOUND
  // newest message that is one of OUR addresses, which `exclude` then drops —
  // so the lead silently evaporated and the order reverted to first
  // appearance the instant staff answered. `to[0]` is not decoration: web's
  // placeholder, mobile's footer and the header's "Opened by" divergence
  // marker all key on it, so the marker built to say the counterparty had
  // changed disappeared on the reply to the very ticket it existed for.
  //
  // The rule now reads the newest message BOTH WAYS: inbound → who wrote to
  // us, outbound → who we wrote to. Same question ("who am I answering"),
  // asked of a header whose direction decides which field holds the answer.
  it('leads with the person WE last wrote to when the newest message is outbound', () => {
    const out = ticketParticipants([
      msg({ from_email: 'us@ours.com', to_emails: ['rates@council.ie'], created_at: '2026-08-01T00:00:00Z' }),
      msg({ from_email: 'eleanor@council.ie', to_emails: ['us@ours.com'], created_at: '2026-08-02T00:00:00Z' }),
      // Our reply-all: Eleanor first, because she is who we were answering.
      msg({ from_email: 'us@ours.com', to_emails: ['eleanor@council.ie', 'rates@council.ie'],
            direction: 'outbound', created_at: '2026-08-03T00:00:00Z' }),
    ], { exclude: ['us@ours.com'] })
    expect(out).toEqual(['eleanor@council.ie', 'rates@council.ie'])
  })

  it('holds the lead STABLE across an inbound followed by our outbound reply', () => {
    const thread = [
      msg({ from_email: 'us@ours.com', to_emails: ['rates@council.ie'], created_at: '2026-08-01T00:00:00Z' }),
      msg({ from_email: 'eleanor@council.ie', to_emails: ['us@ours.com'], created_at: '2026-08-02T00:00:00Z' }),
    ]
    const beforeWeAnswer = ticketParticipants(thread, { exclude: ['us@ours.com'] })
    const afterWeAnswer = ticketParticipants([
      ...thread,
      msg({ from_email: 'us@ours.com', to_emails: beforeWeAnswer,
            direction: 'outbound', created_at: '2026-08-03T00:00:00Z' }),
    ], { exclude: ['us@ours.com'] })

    // Answering a ticket is not a change of counterparty, so it must not be a
    // change of audience ORDER either. Same set, same order, same to[0].
    expect(afterWeAnswer).toEqual(beforeWeAnswer)
  })

  // Direction is not always on the row: the participant query projects a
  // narrow column list, and pre-EMAIL-CC.1 rows predate parts of it. Our own
  // address in the From is the same fact stated another way, so the rule reads
  // both signals and needs only one of them.
  it('recognises an outbound newest message from the exclusions alone, with no direction column', () => {
    const out = ticketParticipants([
      msg({ from_email: 'member@x.com', to_emails: ['us@ours.com'], created_at: '2026-08-01T00:00:00Z' }),
      msg({ from_email: 'us@ours.com', to_email: 'later@x.com', to_emails: null,
            created_at: '2026-08-02T00:00:00Z' }),
    ], { exclude: ['us@ours.com'] })
    expect(out[0]).toBe('later@x.com')
  })

  it('falls back to first appearance when the newest outbound message named nobody usable', () => {
    const out = ticketParticipants([
      msg({ from_email: 'member@x.com', to_emails: ['us@ours.com'], created_at: '2026-08-01T00:00:00Z' }),
      msg({ from_email: 'us@ours.com', to_emails: [], to_email: null,
            direction: 'outbound', created_at: '2026-08-02T00:00:00Z' }),
    ], { exclude: ['us@ours.com'] })
    expect(out).toEqual(['member@x.com'])
  })

  // The lead is a To, never a Cc: "who we last wrote to" is the addressee.
  // A Cc'd watcher leading the list would put the wrong name in the
  // placeholder, the footer and the divergence check all at once.
  it('leads with the outbound To, not a Cc on the same message', () => {
    const out = ticketParticipants([
      msg({ from_email: 'member@x.com', to_emails: ['us@ours.com'], created_at: '2026-08-01T00:00:00Z' }),
      msg({ from_email: 'us@ours.com', to_emails: ['member@x.com'], cc_emails: ['watcher@x.com'],
            direction: 'outbound', created_at: '2026-08-02T00:00:00Z' }),
    ], { exclude: ['us@ours.com'] })
    expect(out[0]).toBe('member@x.com')
  })

  it('skips internal notes', () => {
    const out = ticketParticipants([
      msg({ from_email: 'member@x.com' }),
      msg({ from_email: 'staff@ours.com', to_emails: ['nobody@x.com'], is_internal_note: true }),
    ])
    expect(out).not.toContain('nobody@x.com')
  })

  it('skips forward rows — a forward shows the thread, it does not add someone', () => {
    const out = ticketParticipants([
      msg({ from_email: 'member@x.com' }),
      msg({ from_email: 'staff@ours.com', to_emails: ['accountant@third.com'], forwarded_message_id: 'm1' }),
    ])
    expect(out).not.toContain('accountant@third.com')
  })

  // (bcc has its own mutation-checked block above — see THE BCC GUARANTEE.)

  it('applies sticky exclusions case-insensitively', () => {
    const out = ticketParticipants(
      [msg({ from_email: 'member@x.com', to_emails: ['Rates@Council.IE'] })],
      { removed: ['rates@council.ie'] },
    )
    expect(out).toEqual(['member@x.com'])
  })

  it('reads the legacy scalar to_email on pre-EMAIL-CC.1 rows', () => {
    const out = ticketParticipants([
      { from_email: 'a@x.com', to_email: 'b@x.com', to_emails: null, cc_emails: null,
        is_internal_note: false, forwarded_message_id: null, created_at: '2026-08-01T00:00:00Z' },
    ])
    expect(out).toEqual(['a@x.com', 'b@x.com'])
  })

  // EMAIL-PARTICIPANTS.12 — a NON-EMPTY array of nothing is still nothing.
  // The other places that render a message's To (messageEnvelope in
  // src/lib/ticket-display.js, mobile's ticketMessageRecipients) filter the
  // array before asking whether it has anything in it, so `to_emails: [null]`
  // takes the scalar fallback there. This one asked `.length` of the raw
  // array, took the [null] branch, and dropped the address the others show.
  // No current writer produces the shape; readers disagreeing about the same
  // row is the defect.
  it('takes the scalar fallback for a to_emails array holding nothing usable', () => {
    const out = ticketParticipants([
      { from_email: 'a@x.com', to_email: 'b@x.com', to_emails: [null], cc_emails: null,
        is_internal_note: false, forwarded_message_id: null, created_at: '2026-08-01T00:00:00Z' },
    ])
    expect(out).toEqual(['a@x.com', 'b@x.com'])
  })

  it('dedupes case variants across messages', () => {
    const out = ticketParticipants([
      msg({ from_email: 'Member@X.com', created_at: '2026-08-01T00:00:00Z' }),
      msg({ from_email: 'member@x.com', created_at: '2026-08-02T00:00:00Z' }),
    ])
    expect(out).toEqual(['member@x.com'])
  })

  it('returns [] for no usable input', () => {
    expect(ticketParticipants(null)).toEqual([])
    expect(ticketParticipants([])).toEqual([])
  })

  // THE LIVE INCIDENT, 2026-08-12. Eleanor replied on a chain the rates office
  // forwarded to her; the reply that followed reached her alone and dropped
  // ratesoffice@ off their own thread.
  it('regression: keeps ratesoffice@ on the audience after Eleanor joins', () => {
    const out = ticketParticipants([
      msg({ from_email: 'accounts@hatchstreetfitness.com', to_emails: ['ratesoffice@dublincity.ie'],
            created_at: '2026-08-12T09:10:26Z' }),
      msg({ from_email: 'eleanor.brennan@dublincity.ie', to_emails: ['accounts@hatchstreetfitness.com'],
            created_at: '2026-08-12T10:06:43Z' }),
    ], { exclude: ['accounts@hatchstreetfitness.com'] })
    expect(out).toContain('ratesoffice@dublincity.ie')
    expect(out).toContain('eleanor.brennan@dublincity.ie')
  })
})
