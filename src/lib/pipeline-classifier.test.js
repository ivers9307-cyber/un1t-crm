// FUNNEL.1 — acquisition-funnel classifier tests. Fixtures are named
// people so failures read like a story (repo convention from PIPELINE5).
import { describe, it, expect } from 'vitest'
import {
  classifyContact,
  countAttendedBookings,
  nextBookedClass,
  returnEpisode,
  splitStagesByFunnel,
  PIPELINE_THRESHOLDS,
  FUNNEL_STAGE_SLUGS,
  OFF_FUNNEL_STAGE_SLUGS,
} from './pipeline-classifier.js'

const NOW = new Date('2026-07-02T12:00:00Z').getTime()
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()
const unixDaysFromNow = (n) => Math.floor((NOW + n * 24 * 60 * 60 * 1000) / 1000)

// recent_bookings entries mirror the Glofox sync shape (GLOFOX2.1.18).
const attendedBooking = (nDaysAgo) => ({
  status: 'BOOKED', attended: true, time_start: unixDaysFromNow(-nDaysAgo),
})
const futureBooking = (nDaysAhead) => ({
  status: 'BOOKED', attended: false, time_start: unixDaysFromNow(nDaysAhead),
})

describe('countAttendedBookings', () => {
  it('counts only attended=true entries', () => {
    expect(countAttendedBookings([attendedBooking(3), futureBooking(2), attendedBooking(10)])).toBe(2)
  })
  it('is 0 for null / non-array', () => {
    expect(countAttendedBookings(null)).toBe(0)
    expect(countAttendedBookings('nope')).toBe(0)
  })
})

describe('nextBookedClass', () => {
  it('returns the SOONEST future BOOKED class as ISO', () => {
    const iso = nextBookedClass([futureBooking(5), futureBooking(2), attendedBooking(1)], NOW)
    expect(iso).toBe(new Date(unixDaysFromNow(2) * 1000).toISOString())
  })
  it('ignores past bookings and cancelled statuses', () => {
    expect(nextBookedClass([attendedBooking(1), { status: 'CANCELLED', time_start: unixDaysFromNow(3) }], NOW)).toBeNull()
  })
  it('is null for empty/missing', () => {
    expect(nextBookedClass(null, NOW)).toBeNull()
  })
})

describe('classifyContact — funnel columns', () => {
  it('Nora: joined last week, no classes → new_lead', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(7), recent_bookings: [],
    }, NOW)).toBe('new_lead')
  })
  it('Nora with a class BOOKED but not attended stays new_lead (badge carries the signal)', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(7),
      recent_bookings: [futureBooking(2)],
    }, NOW)).toBe('new_lead')
  })
  it('Fiona: 1 class attended recently → first_class', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(20),
      last_attended_at: daysAgo(5), recent_bookings: [attendedBooking(5)],
    }, NOW)).toBe('first_class')
  })
  it('Sean: 2 attended → second_class', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(20),
      last_attended_at: daysAgo(3), recent_bookings: [attendedBooking(3), attendedBooking(9)],
    }, NOW)).toBe('second_class')
  })
  it('Aoife: 3 attended, no membership → trial_done (decision point)', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(30),
      last_attended_at: daysAgo(2),
      recent_bookings: [attendedBooking(2), attendedBooking(6), attendedBooking(12)],
    }, NOW)).toBe('trial_done')
  })
  it('4+ attended without converting folds into trial_done', () => {
    expect(classifyContact({
      glofox_membership_status: 'no_sale_trial', joined_at: daysAgo(40),
      last_attended_at: daysAgo(4),
      recent_bookings: [attendedBooking(4), attendedBooking(8), attendedBooking(15), attendedBooking(22)],
    }, NOW)).toBe('trial_done')
  })
})

describe('classifyContact — funnel exits', () => {
  it('lead joined 70d ago with no classes ages out → dormant (60d window on joined_at, NOT lead_created_at)', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(70), recent_bookings: [],
    }, NOW)).toBe('dormant')
  })
  it('mid-funnel lead does NOT vanish at day 60 — window keys on activity, not joined_at', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(65),
      last_attended_at: daysAgo(10), recent_bookings: [attendedBooking(10), attendedBooking(20)],
    }, NOW)).toBe('second_class')
  })
  it('funnel lead gone quiet 61+d since last class → dormant', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(100),
      last_attended_at: daysAgo(61), recent_bookings: [attendedBooking(61)],
    }, NOW)).toBe('dormant')
  })
  it('last_attended_at set but recent_bookings pruned still counts as attended once', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(20),
      last_attended_at: daysAgo(5), recent_bookings: [],
    }, NOW)).toBe('first_class')
  })
  it('FUTURE last_attended_at (check-in flagged before class start) counts as active, not dormant', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(20),
      last_attended_at: new Date(NOW + 60 * 60 * 1000).toISOString(), // 1h ahead
      recent_bookings: [attendedBooking(0)],
    }, NOW)).toBe('first_class')
  })
  it('lead joined at EXACTLY the new-lead window boundary is still new_lead (pins <= semantics)', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead',
      joined_at: daysAgo(PIPELINE_THRESHOLDS.NEW_LEAD_WINDOW_DAYS),
      recent_bookings: [],
    }, NOW)).toBe('new_lead')
  })
})

describe('classifyContact — converted & members', () => {
  it('converted 10d ago → converted, regardless of class count (early converter after 1 class)', () => {
    expect(classifyContact({
      glofox_membership_status: 'member', converted_at: daysAgo(10),
      joined_at: daysAgo(15), recent_bookings: [attendedBooking(12)],
    }, NOW)).toBe('converted')
  })
  it('converted 61d ago rolls off the board → member', () => {
    expect(classifyContact({
      glofox_membership_status: 'member', converted_at: daysAgo(61), joined_at: daysAgo(200),
    }, NOW)).toBe('member')
  })
  it('pre-existing member with no converted_at → member', () => {
    expect(classifyContact({
      glofox_membership_status: 'credit_member', joined_at: daysAgo(400),
    }, NOW)).toBe('member')
  })
})

describe('classifyContact — exclusions', () => {
  it('ClassPass PAYG is NEVER in the funnel → classpass', () => {
    expect(classifyContact({
      glofox_membership_status: 'classpass_payg', joined_at: daysAgo(5),
      last_attended_at: daysAgo(2), recent_bookings: [attendedBooking(2)],
    }, NOW)).toBe('classpass')
  })
  // GYMPASS.2 — Gympass/Wellhub users are pulled OUT of the sellable funnel.
  it('an ATTENDING Gympass lead is off the funnel → gympass (not trial_done)', () => {
    // Tommy Faherty's shape: a Gympass lead training regularly. Without the
    // gympass check this classifies to trial_done — a hot prospect you can't sell.
    expect(classifyContact({
      glofox_membership_status: 'lead', gympass_member_id: '3601127012482',
      joined_at: daysAgo(20), last_attended_at: daysAgo(1),
      recent_bookings: [attendedBooking(1), attendedBooking(3), attendedBooking(5)],
    }, NOW)).toBe('gympass')
  })
  it('a Gympass user who becomes a MEMBER graduates to the member category', () => {
    // Richard 2026-07-20: the Glofox profile is shared, so a real membership
    // OUTRANKS Gympass — converted ≤60d → converted, else member.
    expect(classifyContact({
      glofox_membership_status: 'member', gympass_member_id: '3602390808954',
      converted_at: daysAgo(10), joined_at: daysAgo(15),
    }, NOW)).toBe('converted')
    expect(classifyContact({
      glofox_membership_status: 'member', gympass_member_id: '3602390808954',
      converted_at: daysAgo(90), joined_at: daysAgo(200),
    }, NOW)).toBe('member')
  })
  it('gympass is an off-funnel stage, never a funnel column', () => {
    expect(OFF_FUNNEL_STAGE_SLUGS).toContain('gympass')
    expect(FUNNEL_STAGE_SLUGS).not.toContain('gympass')
  })
  it('ex_member → dormant (winback, not a funnel lead)', () => {
    expect(classifyContact({
      glofox_membership_status: 'ex_member', joined_at: daysAgo(300),
    }, NOW)).toBe('dormant')
  })
  it('null/garbage input → dormant', () => {
    expect(classifyContact(null, NOW)).toBe('dormant')
  })
})

describe('classifyContact — pack customers (FUNNEL.3)', () => {
  // Operator decision (Richard, 2026-07-03): buying a class pack IS the
  // conversion — pack customers are reported in their own off-funnel
  // 'pack_member' stage and NEVER cycle back into the acquisition funnel.
  // Sticky via contacts.pack_customer_at; live 4+ credits also qualify
  // (covers the sync tick before the stamp lands).
  it('Wendy: cold status + 16-credit active pack → pack_member (reported as a pack customer)', () => {
    expect(classifyContact({
      glofox_membership_status: 'cold', joined_at: daysAgo(220),
      last_attended_at: daysAgo(1), trial_credits_remaining: 16,
      recent_bookings: [attendedBooking(1), attendedBooking(2), attendedBooking(4), attendedBooking(7)],
    }, NOW)).toBe('pack_member')
  })
  it('pack used up (2 credits left) but stamped → STAYS pack_member, never re-clogs the funnel', () => {
    expect(classifyContact({
      glofox_membership_status: 'cold', joined_at: daysAgo(220),
      last_attended_at: daysAgo(1), trial_credits_remaining: 2,
      pack_customer_at: daysAgo(90),
      recent_bookings: [attendedBooking(1), attendedBooking(2), attendedBooking(4)],
    }, NOW)).toBe('pack_member')
  })
  it('lapsed pack holder (no attendance for 120d) is still reported as a pack customer', () => {
    expect(classifyContact({
      glofox_membership_status: 'cold', joined_at: daysAgo(300),
      last_attended_at: daysAgo(120), trial_credits_remaining: 10,
      recent_bookings: [attendedBooking(120)],
    }, NOW)).toBe('pack_member')
  })
  it('big-pack buyer who has never attended is already a pack customer, not a lead', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(10),
      trial_credits_remaining: 92, recent_bookings: [],
    }, NOW)).toBe('pack_member')
  })
  it('membership OUTRANKS the pack stamp — a pack customer who joins shows as converted/member', () => {
    expect(classifyContact({
      glofox_membership_status: 'member', converted_at: daysAgo(5),
      pack_customer_at: daysAgo(100), joined_at: daysAgo(300),
    }, NOW)).toBe('converted')
  })
  it('a genuine 3-credit trial is NOT a pack customer (also the mig-001 schema default)', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(5),
      last_attended_at: daysAgo(2), trial_credits_remaining: 3,
      recent_bookings: [attendedBooking(2)],
    }, NOW)).toBe('first_class')
  })
  it('null credits → normal funnel rules', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(5),
      trial_credits_remaining: null, recent_bookings: [],
    }, NOW)).toBe('new_lead')
  })
  it('classpass_payg with credits stays classpass (distinct motion wins)', () => {
    expect(classifyContact({
      glofox_membership_status: 'classpass_payg', trial_credits_remaining: 20,
    }, NOW)).toBe('classpass')
  })
})

describe('classifyContact — cold / operator-dismissed (FUNNEL.4)', () => {
  // A staffer marked the lead "not worth selling to / not interested" via the
  // Cold button (contacts.pipeline_dismissed_at). Removes them from the funnel,
  // auto-revoked the moment they come back and TRAIN (attend after the dismissal).
  it('a dismissed lead → cold_lead, off the funnel', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(5),
      pipeline_dismissed_at: daysAgo(1), recent_bookings: [],
    }, NOW)).toBe('cold_lead')
  })
  it('a dismissed lead who had attended BEFORE the dismissal stays cold_lead', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(30),
      last_attended_at: daysAgo(10), pipeline_dismissed_at: daysAgo(2),
      recent_bookings: [attendedBooking(10)],
    }, NOW)).toBe('cold_lead')
  })
  it('comes back and TRAINS after being dismissed → rejoins the funnel', () => {
    // dismissed 10d ago, then attended 2d ago (after the dismissal) → first_class
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(40),
      last_attended_at: daysAgo(2), pipeline_dismissed_at: daysAgo(10),
      recent_bookings: [attendedBooking(2)],
    }, NOW)).toBe('first_class')
  })
  it('two classes after the dismissal → second_class (normal funnel rules resume)', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(40),
      last_attended_at: daysAgo(1), pipeline_dismissed_at: daysAgo(10),
      recent_bookings: [attendedBooking(1), attendedBooking(4)],
    }, NOW)).toBe('second_class')
  })
  it('membership OUTRANKS a dismissal — a cold lead who joins shows as converted', () => {
    expect(classifyContact({
      glofox_membership_status: 'member', converted_at: daysAgo(3),
      pipeline_dismissed_at: daysAgo(20), joined_at: daysAgo(20),
    }, NOW)).toBe('converted')
  })
  it('a pack purchase OUTRANKS a dismissal — cold lead who buys a pack → pack_member', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(20),
      pipeline_dismissed_at: daysAgo(10), trial_credits_remaining: 10,
    }, NOW)).toBe('pack_member')
  })
  it('null pipeline_dismissed_at → normal funnel rules', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(5),
      pipeline_dismissed_at: null, recent_bookings: [],
    }, NOW)).toBe('new_lead')
  })
})

describe('idempotency', () => {
  it('same input twice → same output, and the input is never mutated', () => {
    const c = Object.freeze({
      glofox_membership_status: 'trial', joined_at: daysAgo(10),
      last_attended_at: daysAgo(3),
      recent_bookings: Object.freeze([Object.freeze(attendedBooking(3))]),
    })
    // Frozen fixture: any mutation attempt throws in strict mode (ESM),
    // so passing = pure function that leaves its input alone.
    expect(classifyContact(c, NOW)).toBe(classifyContact(c, NOW))
  })
})

// ── FUNNEL.5 — a booked class in the diary is not dormant ──────────
//
// Every rule in the funnel branch keys on ATTENDANCE, and booking does not
// move last_attended_at, so a re-engaging contact was filed as a ghost until
// they physically turned up. Measured the evening the 3-Class Trial sequence
// went out: 12 booked through /start, 10 sat in `dormant`, 8 had an upcoming
// class at the moment of classification.

describe('FUNNEL.5 — an upcoming booked class overrides dormant', () => {
  const NOW = Date.parse('2026-08-21T09:00:00Z')
  const ago = (days) => new Date(NOW - days * 86400000).toISOString()
  const upcoming = (hours) => ([{ status: 'BOOKED', time_start: Math.floor((NOW + hours * 3600_000) / 1000) }])
  const past = (hours) => ([{ status: 'BOOKED', time_start: Math.floor((NOW - hours * 3600_000) / 1000) }])

  it('an aged-out signup who has never attended but has booked → new_lead, not dormant', () => {
    // The 11-of-12 case: a Glofox join date, no attendance, long past the
    // new-lead window, and a class in the diary.
    const base = { glofox_membership_status: 'trial', joined_at: ago(200), last_attended_at: null }
    expect(classifyContact({ ...base, recent_bookings: [] }, NOW)).toBe('dormant')
    expect(classifyContact({ ...base, recent_bookings: upcoming(48) }, NOW)).toBe('new_lead')
  })

  it('an ex-trainer who aged out and has booked again → the RETURNING board (RETURNPIPE.1 supersedes)', () => {
    // Yesterday this asserted 'new_lead'. RETURNPIPE.1 gave people who have
    // trained before their own pipeline, and this contact is its entry column
    // — booked, not yet back in the room. The person has not changed; where
    // they belong has. The never-trained case above still lands in new_lead,
    // which is the distinction the two changes exist to draw.
    const base = {
      glofox_membership_status: 'trial',
      joined_at: ago(300),
      last_attended_at: ago(180),
    }
    expect(classifyContact({ ...base, recent_bookings: [] }, NOW)).toBe('dormant')
    expect(classifyContact({ ...base, recent_bookings: upcoming(72) }, NOW)).toBe('returning_booked')
  })

  it('a booking they already MISSED is not re-engagement — still dormant', () => {
    const base = { glofox_membership_status: 'trial', joined_at: ago(200), last_attended_at: null }
    expect(classifyContact({ ...base, recent_bookings: past(24) }, NOW)).toBe('dormant')
  })

  it('a CANCELLED upcoming booking does not count', () => {
    const base = { glofox_membership_status: 'trial', joined_at: ago(200), last_attended_at: null }
    const cancelled = [{ status: 'CANCELLED', time_start: Math.floor((NOW + 48 * 3600_000) / 1000) }]
    expect(classifyContact({ ...base, recent_bookings: cancelled }, NOW)).toBe('dormant')
  })

  it('does NOT override the off-funnel piles that outrank the funnel', () => {
    // A paying member with a class booked is a member using their membership,
    // not a re-acquisition. Same for the platform piles.
    const bookings = upcoming(24)
    expect(classifyContact({ glofox_membership_status: 'member', converted_at: ago(400), recent_bookings: bookings }, NOW)).toBe('member')
    expect(classifyContact({ glofox_membership_status: 'classpass_payg', recent_bookings: bookings }, NOW)).toBe('classpass')
  })

  it('an actively-training contact is unaffected — attendance rules still win', () => {
    const recent = {
      glofox_membership_status: 'trial',
      joined_at: ago(20),
      last_attended_at: ago(2),
      recent_bookings: [
        { status: 'ATTENDED', time_start: Math.floor((NOW - 2 * 86400000) / 1000) },
        ...upcoming(48),
      ],
    }
    expect(classifyContact(recent, NOW)).toBe('first_class')
  })
})

// ── RETURNPIPE.1 — the returning board ─────────────────────────────
//
// A returning customer follows a different flow from a new one, so they get
// their own pipeline rather than a badge. The counting is what makes it work:
// scoped to THIS return, never lifetime.

describe('RETURNPIPE.1 — returning customers get their own board', () => {
  const NOW = Date.parse('2026-08-21T09:00:00Z')
  const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString()
  const att = (d) => ({ status: 'BOOKED', attended: true, time_start: Math.floor((NOW - d * 86400000) / 1000) })
  const soon = (h) => ({ status: 'BOOKED', time_start: Math.floor((NOW + h * 3600000) / 1000) })
  const lapsedTrial = { glofox_membership_status: 'trial', joined_at: daysAgo(400) }

  it('booked back in, not yet returned', () => {
    expect(classifyContact(
      { ...lapsedTrial, last_attended_at: daysAgo(300), recent_bookings: [soon(48)] }, NOW,
    )).toBe('returning_booked')
  })

  it('walks the board as they come back', () => {
    const old = [att(300), att(299)]
    expect(classifyContact({ ...lapsedTrial, last_attended_at: daysAgo(1), recent_bookings: [...old, att(1)] }, NOW))
      .toBe('returning_first_class')
    expect(classifyContact({ ...lapsedTrial, last_attended_at: daysAgo(1), recent_bookings: [...old, att(4), att(1)] }, NOW))
      .toBe('returning_second_class')
    expect(classifyContact({ ...lapsedTrial, last_attended_at: daysAgo(1), recent_bookings: [...old, att(7), att(4), att(1)] }, NOW))
      .toBe('returning_final_class')
  })

  it('🔴 counts THIS return only — a long-ago regular starts at 1st class back', () => {
    // The whole reason the episode boundary exists. Nine classes two years
    // ago plus one today is a first class back, not a finished trial.
    const nineLongAgo = [400, 398, 396, 394, 392, 390, 388, 386, 384].map(att)
    const c = { ...lapsedTrial, last_attended_at: daysAgo(1), recent_bookings: [...nineLongAgo, att(1)] }
    expect(classifyContact(c, NOW)).toBe('returning_first_class')
    expect(returnEpisode(c, NOW).attended).toBe(1)
  })

  it('someone training continuously is NOT returning — no gap, no episode', () => {
    const steady = { ...lapsedTrial, last_attended_at: daysAgo(2), recent_bookings: [att(9), att(6), att(2)] }
    expect(returnEpisode(steady, NOW)).toBeNull()
    expect(classifyContact(steady, NOW)).toBe('trial_done')
  })

  it('a returner who re-joins counts as the RETURNING board win, not the acquisition funnel', () => {
    const rejoined = {
      glofox_membership_status: 'member', converted_at: daysAgo(3),
      last_attended_at: daysAgo(1), recent_bookings: [att(300), att(2), att(1)],
    }
    expect(classifyContact(rejoined, NOW)).toBe('returning_converted')
    // A first-time member is untouched — no prior training, no episode.
    expect(classifyContact({ glofox_membership_status: 'member', converted_at: daysAgo(3), recent_bookings: [att(2)] }, NOW))
      .toBe('converted')
  })

  it('never-trained people never reach the returning board', () => {
    expect(returnEpisode({ ...lapsedTrial, last_attended_at: null, recent_bookings: [soon(24)] }, NOW)).toBeNull()
    expect(classifyContact({ ...lapsedTrial, last_attended_at: null, recent_bookings: [soon(24)] }, NOW)).toBe('new_lead')
  })

  it('the off-funnel piles still outrank it — a member using their membership is not re-acquiring', () => {
    const bookings = [att(300), att(1)]
    expect(classifyContact({ glofox_membership_status: 'classpass_payg', last_attended_at: daysAgo(1), recent_bookings: bookings }, NOW)).toBe('classpass')
    expect(classifyContact({ glofox_membership_status: 'trial', gympass_member_id: 'g1', last_attended_at: daysAgo(1), recent_bookings: bookings }, NOW)).toBe('gympass')
    // A dismissal is a human judgement; only attending overturns it (unchanged).
    expect(classifyContact({ ...lapsedTrial, pipeline_dismissed_at: daysAgo(10), last_attended_at: daysAgo(300), recent_bookings: [soon(24)] }, NOW)).toBe('cold_lead')
  })
})

describe('RETURNPIPE.1 — splitStagesByFunnel keeps three boards apart', () => {
  const stages = [
    { slug: 'new_lead', is_dormant: false, display_order: 301 },
    { slug: 'dormant',  is_dormant: true,  display_order: 309 },
    { slug: 'returning_booked',      is_dormant: false, display_order: 401, board: 'returning' },
    { slug: 'returning_first_class', is_dormant: false, display_order: 402, board: 'returning' },
  ]

  it('returning stages never leak into the acquisition tabs', () => {
    const { funnel, offFunnel, returning } = splitStagesByFunnel(stages)
    expect(funnel.map((s) => s.slug)).toEqual(['new_lead'])
    expect(offFunnel.map((s) => s.slug)).toEqual(['dormant'])
    expect(returning.map((s) => s.slug)).toEqual(['returning_booked', 'returning_first_class'])
  })

  it('a stage with no board column reads as acquisition — every pre-mig-558 row', () => {
    const { funnel, returning } = splitStagesByFunnel([{ slug: 'new_lead', is_dormant: false }])
    expect(funnel).toHaveLength(1)
    expect(returning).toHaveLength(0)
  })
})

// ── RETURNPIPE.3 — the /start form revokes a Cold dismissal ────────
//
// Richard, 2026-08-21: "a cold lead that comes in on the /start form who
// hasn't trained with us before gets reclassified as a lead and starts on the
// new lead pipeline; if they have trained before then they come in on the new
// returning pipeline."
//
// 92 of the 112 dismissed contacts are in the live trial sequence, so this is
// the path that decides whether that campaign's wins are visible.

describe('RETURNPIPE.3 — re-entering a funnel form un-dismisses a cold lead', () => {
  const NOW = Date.parse('2026-08-21T09:00:00Z')
  const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString()
  const att = (d) => ({ status: 'BOOKED', attended: true, time_start: Math.floor((NOW - d * 86400000) / 1000) })
  const soon = (h) => ({ status: 'BOOKED', time_start: Math.floor((NOW + h * 3600000) / 1000) })
  const dismissed = { glofox_membership_status: 'trial', joined_at: daysAgo(300), pipeline_dismissed_at: daysAgo(20) }

  it('never trained + came in on the form → new_lead on the ACQUISITION board', () => {
    expect(classifyContact({
      ...dismissed, last_attended_at: null,
      last_lead_source_at: daysAgo(1), recent_bookings: [soon(48)],
    }, NOW)).toBe('new_lead')
  })

  it('trained before + came in on the form → the RETURNING board', () => {
    expect(classifyContact({
      ...dismissed, last_attended_at: daysAgo(250),
      last_lead_source_at: daysAgo(1), recent_bookings: [soon(48)],
    }, NOW)).toBe('returning_booked')
  })

  it('still cold when the last form entry PREDATES the dismissal', () => {
    // The dismissal was the more recent judgement — it stands.
    expect(classifyContact({
      ...dismissed, last_attended_at: null,
      last_lead_source_at: daysAgo(60), recent_bookings: [soon(48)],
    }, NOW)).toBe('cold_lead')
  })

  it('still cold with no form entry at all — the existing behaviour is unchanged', () => {
    expect(classifyContact({ ...dismissed, last_attended_at: null, last_lead_source_at: null }, NOW)).toBe('cold_lead')
    expect(classifyContact({ ...dismissed, last_attended_at: daysAgo(250) }, NOW)).toBe('cold_lead')
  })

  it('attending after the dismissal still revokes it, as it always did', () => {
    expect(classifyContact({
      ...dismissed, last_attended_at: daysAgo(1),
      recent_bookings: [att(300), att(1)],
    }, NOW)).toBe('returning_first_class')
  })

  it('the revocation is permanent — it does not lapse when the booking passes', () => {
    // last_lead_source_at persists, so they cannot silently snap back to cold
    // once recent_bookings rolls over. Only a NEW dismissal makes them cold
    // again, and that stamps a newer pipeline_dismissed_at.
    const later = NOW + 200 * 86400000
    expect(classifyContact({
      ...dismissed, last_attended_at: null,
      last_lead_source_at: daysAgo(1), recent_bookings: [],
    }, later)).not.toBe('cold_lead')
  })
})
