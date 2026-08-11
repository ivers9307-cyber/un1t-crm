// GAPS-P5 — repeat-bounce escalation. These tests pin the DECISION, which is
// the whole point of the module: a soft or transient bounce is temporary and
// suppressing on one is the bug this feature exists to avoid. Escalation is
// only ever about REPEATED failure across DISTINCT campaigns, and only the
// case where nothing has ever reached the address is acted on automatically.
//
// Measured at Stillorgan 2026-08-09: 32 contacts soft/transient-bounced across
// 3+ distinct campaigns and never hard-bounced; 15 of those have zero
// successful deliveries ever. The 15 are `suppress`, the other 17 are
// `review`. Mailchimp suppresses at 7 soft bounces with no delivery condition
// at all; this is deliberately narrower.
import { describe, it, expect } from 'vitest'
import {
  BOUNCE_ESCALATION_MIN_CAMPAIGNS,
  SUCCESSFUL_RECIPIENT_STATUSES,
  decideBounceEscalation,
  groupBouncesByContact,
} from './bounce-escalation.js'

const at = (iso) => iso
const bounce = (campaign_id, bounce_type = 'soft', bounced_at = '2026-06-01T00:00:00.000Z') =>
  ({ campaign_id, bounce_type, bounced_at })

const NOW = new Date('2026-08-09T12:00:00.000Z')
const decide = (history) => decideBounceEscalation(history, { now: NOW })

describe('thresholds', () => {
  it('escalates only at 3+ distinct campaigns (more conservative than Mailchimp)', () => {
    expect(BOUNCE_ESCALATION_MIN_CAMPAIGNS).toBe(3)
  })

  it('counts sent/delivered/opened/clicked as a successful delivery', () => {
    // The recipient status column PROGRESSES (sent -> delivered -> opened ->
    // clicked), so a contact who opened has status 'opened', not 'delivered'.
    // Reading only ['sent','delivered'] would call an engaged contact
    // never-delivered and suppress them.
    expect(SUCCESSFUL_RECIPIENT_STATUSES).toEqual(['sent', 'delivered', 'opened', 'clicked'])
  })
})

describe('decideBounceEscalation — suppress', () => {
  it('suppresses on 3 distinct campaigns with zero successful deliveries ever', () => {
    const d = decide({
      bounces: [bounce('camp-1'), bounce('camp-2'), bounce('camp-3')],
      successfulDeliveries: 0,
    })
    expect(d.outcome).toBe('suppress')
    expect(d.reason).toBe('repeat_bounce_never_delivered')
    expect(d.distinctCampaignCount).toBe(3)
  })

  it('suppresses on more than the threshold too', () => {
    const d = decide({
      bounces: [bounce('c1'), bounce('c2'), bounce('c3'), bounce('c4', 'transient')],
      successfulDeliveries: 0,
    })
    expect(d.outcome).toBe('suppress')
    expect(d.distinctCampaignCount).toBe(4)
  })

  it('mixed soft and transient bounces escalate the same way', () => {
    const d = decide({
      bounces: [bounce('c1', 'soft'), bounce('c2', 'transient'), bounce('c3', 'soft')],
      successfulDeliveries: 0,
    })
    expect(d.outcome).toBe('suppress')
  })

  it('an unrecognised bounce type (rejected) still counts as a failure', () => {
    // 'rejected' exists in campaign_recipients history (42 events at
    // Stillorgan) but the Postmark processor only ever writes hard/soft/
    // transient. An unknown type is a failed delivery attempt, not a
    // reason to ignore the row.
    const d = decide({
      bounces: [bounce('c1', 'rejected'), bounce('c2', 'rejected'), bounce('c3', 'rejected')],
      successfulDeliveries: 0,
    })
    expect(d.outcome).toBe('suppress')
    expect(d.bounceTypes).toEqual(['rejected'])
  })
})

describe('decideBounceEscalation — review (never auto-acted on)', () => {
  it('reviews when 3+ campaigns bounced but the address HAS been delivered to', () => {
    const d = decide({
      bounces: [bounce('c1'), bounce('c2'), bounce('c3')],
      successfulDeliveries: 1,
    })
    expect(d.outcome).toBe('review')
    expect(d.reason).toBe('repeat_bounce_previously_delivered')
  })

  it('a single successful delivery is enough to downgrade suppress to review', () => {
    const many = Array.from({ length: 9 }, (_, i) => bounce(`c${i}`))
    expect(decide({ bounces: many, successfulDeliveries: 0 }).outcome).toBe('suppress')
    expect(decide({ bounces: many, successfulDeliveries: 1 }).outcome).toBe('review')
  })
})

describe('decideBounceEscalation — keep', () => {
  it('keeps a contact with no bounce history at all', () => {
    const d = decide({ bounces: [], successfulDeliveries: 4 })
    expect(d.outcome).toBe('keep')
    expect(d.reason).toBe('no_bounces')
    expect(d.distinctCampaignCount).toBe(0)
  })

  it('keeps a single soft bounce — the bug this feature exists to avoid', () => {
    const d = decide({ bounces: [bounce('c1', 'soft')], successfulDeliveries: 0 })
    expect(d.outcome).toBe('keep')
    expect(d.reason).toBe('below_campaign_threshold')
  })

  it('keeps a single transient bounce', () => {
    expect(decide({ bounces: [bounce('c1', 'transient')], successfulDeliveries: 0 }).outcome).toBe('keep')
  })

  it('keeps at exactly one below the threshold', () => {
    const d = decide({ bounces: [bounce('c1'), bounce('c2')], successfulDeliveries: 0 })
    expect(d.outcome).toBe('keep')
    expect(d.distinctCampaignCount).toBe(2)
  })

  it('counts DISTINCT campaigns, not events — retries inside one campaign are one failure', () => {
    const d = decide({
      bounces: [bounce('c1'), bounce('c1'), bounce('c1'), bounce('c1'), bounce('c1')],
      successfulDeliveries: 0,
    })
    expect(d.outcome).toBe('keep')
    expect(d.distinctCampaignCount).toBe(1)
    expect(d.bounceEvents).toBe(5)
  })

  it('two campaigns with many retries each is still below the threshold', () => {
    const d = decide({
      bounces: [bounce('c1'), bounce('c1'), bounce('c1'), bounce('c2'), bounce('c2'), bounce('c2')],
      successfulDeliveries: 0,
    })
    expect(d.outcome).toBe('keep')
    expect(d.distinctCampaignCount).toBe(2)
  })
})

describe('decideBounceEscalation — hard bounces stay where they are', () => {
  it('never escalates a contact with a hard bounce (the webhook already handles it)', () => {
    const d = decide({
      bounces: [bounce('c1', 'hard'), bounce('c2'), bounce('c3'), bounce('c4')],
      successfulDeliveries: 0,
    })
    expect(d.outcome).toBe('keep')
    expect(d.reason).toBe('hard_bounce_handled_elsewhere')
    expect(d.hasHardBounce).toBe(true)
  })

  it('does not crash on a hard-bounce-only history', () => {
    const d = decide({ bounces: [bounce('c1', 'hard')], successfulDeliveries: 0 })
    expect(d.outcome).toBe('keep')
    expect(d.hasHardBounce).toBe(true)
  })

  it('bounce type matching is case and whitespace insensitive', () => {
    const d = decide({
      bounces: [bounce('c1', '  HARD '), bounce('c2'), bounce('c3')],
      successfulDeliveries: 0,
    })
    expect(d.hasHardBounce).toBe(true)
    expect(d.outcome).toBe('keep')
  })
})

describe('decideBounceEscalation — malformed input', () => {
  it('tolerates being called with nothing', () => {
    expect(decideBounceEscalation().outcome).toBe('keep')
  })

  it('ignores null/undefined rows in the bounce list', () => {
    const d = decide({
      bounces: [null, bounce('c1'), undefined, bounce('c2'), bounce('c3')],
      successfulDeliveries: 0,
    })
    expect(d.outcome).toBe('suppress')
    expect(d.distinctCampaignCount).toBe(3)
  })

  it('ignores bounce rows with no campaign id — they cannot prove a distinct failure', () => {
    const d = decide({
      bounces: [bounce(null), bounce(''), bounce('c1'), bounce('c2'), bounce('c3')],
      successfulDeliveries: 0,
    })
    expect(d.distinctCampaignCount).toBe(3)
    expect(d.outcome).toBe('suppress')
  })

  it('does not suppress when every bounce row is campaign-less', () => {
    const d = decide({ bounces: [bounce(null), bounce(null), bounce(null)], successfulDeliveries: 0 })
    expect(d.outcome).toBe('keep')
  })

  it('treats a missing/negative/NaN delivery count as zero', () => {
    const bounces = [bounce('c1'), bounce('c2'), bounce('c3')]
    expect(decide({ bounces }).outcome).toBe('suppress')
    expect(decide({ bounces, successfulDeliveries: -3 }).outcome).toBe('suppress')
    expect(decide({ bounces, successfulDeliveries: Number.NaN }).outcome).toBe('suppress')
    expect(decide({ bounces, successfulDeliveries: '2' }).outcome).toBe('review')
  })

  it('tolerates a null bounce_type', () => {
    const d = decide({
      bounces: [bounce('c1', null), bounce('c2', null), bounce('c3', null)],
      successfulDeliveries: 0,
    })
    expect(d.outcome).toBe('suppress')
    expect(d.hasHardBounce).toBe(false)
    expect(d.bounceTypes).toEqual(['unknown'])
  })
})

describe('decideBounceEscalation — reported facts (this is the audit trail)', () => {
  it('reports the distinct campaign ids, sorted and deduplicated', () => {
    const d = decide({
      bounces: [bounce('c3'), bounce('c1'), bounce('c2'), bounce('c1')],
      successfulDeliveries: 0,
    })
    expect(d.campaignIds).toEqual(['c1', 'c2', 'c3'])
  })

  it('reports first and last bounce timestamps', () => {
    const d = decide({
      bounces: [
        bounce('c2', 'soft', at('2026-07-01T00:00:00.000Z')),
        bounce('c1', 'soft', at('2026-05-01T00:00:00.000Z')),
        bounce('c3', 'soft', at('2026-06-01T00:00:00.000Z')),
      ],
      successfulDeliveries: 0,
    })
    expect(d.firstBounceAt).toBe('2026-05-01T00:00:00.000Z')
    expect(d.lastBounceAt).toBe('2026-07-01T00:00:00.000Z')
  })

  it('leaves the timestamps null when no row carries a usable date', () => {
    const d = decide({
      bounces: [
        bounce('c1', 'soft', null),
        bounce('c2', 'soft', 'not-a-date'),
        { campaign_id: 'c3', bounce_type: 'soft' },   // no bounced_at key at all
      ],
      successfulDeliveries: 0,
    })
    expect(d.firstBounceAt).toBeNull()
    expect(d.lastBounceAt).toBeNull()
  })

  it('reports distinct bounce types, sorted', () => {
    const d = decide({
      bounces: [bounce('c1', 'transient'), bounce('c2', 'soft'), bounce('c3', 'soft')],
      successfulDeliveries: 0,
    })
    expect(d.bounceTypes).toEqual(['soft', 'transient'])
  })

  it('echoes the delivery count back for the audit row', () => {
    const d = decide({
      bounces: [bounce('c1'), bounce('c2'), bounce('c3')],
      successfulDeliveries: 7,
    })
    expect(d.successfulDeliveries).toBe(7)
  })
})

describe('decideBounceEscalation — purity', () => {
  it('stamps evaluatedAt from the injected now, never the wall clock', () => {
    const d = decideBounceEscalation(
      { bounces: [bounce('c1')], successfulDeliveries: 0 },
      { now: new Date('2020-01-02T03:04:05.000Z') },
    )
    expect(d.evaluatedAt).toBe('2020-01-02T03:04:05.000Z')
  })

  it('is deterministic — same input, same output', () => {
    const history = { bounces: [bounce('c1'), bounce('c2'), bounce('c3')], successfulDeliveries: 0 }
    expect(decide(history)).toEqual(decide(history))
  })

  it('does not mutate its input', () => {
    const bounces = [bounce('c2'), bounce('c1')]
    const snapshot = JSON.parse(JSON.stringify(bounces))
    decide({ bounces, successfulDeliveries: 0 })
    expect(bounces).toEqual(snapshot)
  })

  it('never reads the clock when now is supplied (no I/O, no Date.now)', () => {
    // A decision that shifts with the wall clock cannot be replayed from the
    // audit row, which is the point of recording the reasoning.
    const history = { bounces: [bounce('c1'), bounce('c2'), bounce('c3')], successfulDeliveries: 0 }
    const a = decideBounceEscalation(history, { now: new Date('2026-01-01T00:00:00.000Z') })
    const b = decideBounceEscalation(history, { now: new Date('2027-01-01T00:00:00.000Z') })
    expect({ ...a, evaluatedAt: null }).toEqual({ ...b, evaluatedAt: null })
  })
})

describe('groupBouncesByContact', () => {
  it('groups recipient rows by contact id', () => {
    const grouped = groupBouncesByContact([
      { contact_id: 'a', campaign_id: 'c1', bounce_type: 'soft', bounced_at: '2026-01-01T00:00:00.000Z' },
      { contact_id: 'b', campaign_id: 'c1', bounce_type: 'hard', bounced_at: '2026-01-01T00:00:00.000Z' },
      { contact_id: 'a', campaign_id: 'c2', bounce_type: 'soft', bounced_at: '2026-02-01T00:00:00.000Z' },
    ])
    expect(grouped.get('a')).toHaveLength(2)
    expect(grouped.get('b')).toHaveLength(1)
  })

  it('drops rows with no contact id', () => {
    const grouped = groupBouncesByContact([
      { contact_id: null, campaign_id: 'c1' },
      { campaign_id: 'c2' },
      { contact_id: 'a', campaign_id: 'c3' },
    ])
    expect([...grouped.keys()]).toEqual(['a'])
  })

  it('tolerates an empty or missing list', () => {
    expect(groupBouncesByContact().size).toBe(0)
    expect(groupBouncesByContact([]).size).toBe(0)
  })
})

// ── BOUNCEEV.1 — delivery evidence is not only campaign_recipients ──────────
//
// A contact who reliably receives TRANSACTIONAL mail (email_sends) but bounces
// on broadcasts could still be suppressed, because "never delivered to" was
// read off campaign_recipients alone. That fails in the UNSAFE direction: it
// makes the suppressed set larger than the evidence supports.
//
// Measured live 2026-08-11 (project iyvtbjjxdggiadzwwvdj): of the 21 contacts
// the sweep currently suppresses, contact 091d56fd… has six email_sends rows
// (source_type transactional + inbox_reply), every one of them delivered, and
// four of the six opened or clicked. Nothing in campaign_recipients says so.
import {
  SUCCESSFUL_EMAIL_SEND_STATUSES,
  isDeliveryEvidence,
} from './bounce-escalation.js'

describe('email_sends as delivery evidence', () => {
  it('reads email_sends.status with the same progressing-column rule as campaign_recipients', () => {
    // email_sends.status is ONE column the Postmark processor overwrites in
    // place (verified live: status='opened' rows carry no 'delivered'), exactly
    // like campaign_recipients.status and whatsapp_broadcast_recipients.status.
    // So evidence means "reached AT LEAST sent", never status = 'delivered'.
    expect(SUCCESSFUL_EMAIL_SEND_STATUSES).toEqual(['sent', 'delivered', 'opened', 'clicked'])
  })

  it('a transactional delivery keeps a repeat-bouncer out of the suppressed set', () => {
    const bounces = [bounce('c1'), bounce('c2'), bounce('c3')]
    expect(decide({ bounces, successfulDeliveries: 0, transactionalDeliveries: 1 }).outcome).toBe('review')
  })

  it('still suppresses when no source has ever delivered', () => {
    const bounces = [bounce('c1'), bounce('c2'), bounce('c3')]
    expect(decide({ bounces, successfulDeliveries: 0, transactionalDeliveries: 0 }).outcome).toBe('suppress')
  })

  it('reports the two evidence sources separately and as one total', () => {
    const bounces = [bounce('c1'), bounce('c2'), bounce('c3')]
    const d = decide({ bounces, successfulDeliveries: 2, transactionalDeliveries: 3 })
    expect(d.successfulDeliveries).toBe(2)
    expect(d.transactionalDeliveries).toBe(3)
    expect(d.totalDeliveries).toBe(5)
  })

  it('treats a missing transactional count as no evidence, never as a reason to suppress harder', () => {
    const bounces = [bounce('c1'), bounce('c2'), bounce('c3')]
    // Absent field — the old call shape. Same verdict as before this change.
    expect(decide({ bounces, successfulDeliveries: 1 }).outcome).toBe('review')
    expect(decide({ bounces, successfulDeliveries: 0 }).outcome).toBe('suppress')
    expect(decide({ bounces, successfulDeliveries: 0, transactionalDeliveries: 'nonsense' }).outcome).toBe('suppress')
  })
})

describe('isDeliveryEvidence — a row that proves the address accepted mail', () => {
  it('accepts any status that has reached at least sent', () => {
    for (const status of ['sent', 'delivered', 'opened', 'clicked']) {
      expect(isDeliveryEvidence({ status })).toBe(true)
    }
  })

  it('rejects a row that never got out the door', () => {
    expect(isDeliveryEvidence({ status: 'queued' })).toBe(false)
    expect(isDeliveryEvidence({ status: 'sending' })).toBe(false)
    expect(isDeliveryEvidence({ status: 'cancelled' })).toBe(false)
    expect(isDeliveryEvidence({ status: 'bounced' })).toBe(false)
    expect(isDeliveryEvidence({})).toBe(false)
    expect(isDeliveryEvidence(null)).toBe(false)
  })

  it('accepts a LATER-bounced row that still carries proof it was delivered, opened or clicked', () => {
    // The status column is terminal-overwritten, so a deferred bounce erases
    // 'clicked' and leaves 'bounced' — but the timestamps survive. Live case
    // 2026-08-11: contact 6ad8921c… has four sends delivered, opened AND
    // clicked minutes before a transient bounce arrived, on both
    // campaign_recipients and email_sends. Reading status alone calls that
    // person never-delivered and suppresses a demonstrably engaged reader.
    expect(isDeliveryEvidence({ status: 'bounced', delivered_at: '2026-06-08T19:29:14Z' })).toBe(true)
    expect(isDeliveryEvidence({ status: 'bounced', opened_at: '2026-06-08T19:52:22Z' })).toBe(true)
    expect(isDeliveryEvidence({ status: 'bounced', clicked_at: '2026-06-08T19:52:24Z' })).toBe(true)
    expect(isDeliveryEvidence({ status: 'complained', delivered_at: '2026-06-08T19:29:14Z' })).toBe(true)
  })

  it('ignores a bounced_at on its own — a bounce is not a delivery', () => {
    expect(isDeliveryEvidence({ status: 'bounced', bounced_at: '2026-06-08T19:53:12Z' })).toBe(false)
  })
})
