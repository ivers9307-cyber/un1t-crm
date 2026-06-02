// Pipeline classifier tests. The classifier replaces the simpler
// Glofox-status → stage map that left 8k pipeline ghosts after the
// bulk import (see PIPELINE5 diagnosis). Every branch deserves a
// concrete fixture so the operator's mental model and the code
// stay aligned — a future refactor that drops a clause here would
// silently mis-stage contacts.

import { describe, it, expect } from 'vitest'
import { classifyContact, PIPELINE_THRESHOLDS } from './pipeline-classifier.js'

// Fixed "now" so day-math is deterministic. 2026-05-12 12:00 UTC.
const NOW = new Date('2026-05-12T12:00:00Z').getTime()
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString()

// ── Defensive ──────────────────────────────────────────────────

describe('classifyContact — defensive', () => {
  it('returns dormant for null / non-object input', () => {
    expect(classifyContact(null)).toBe('dormant')
    expect(classifyContact('string')).toBe('dormant')
    expect(classifyContact(undefined)).toBe('dormant')
  })

  it('returns dormant for an empty contact (no signals at all)', () => {
    expect(classifyContact({}, NOW)).toBe('dormant')
  })
})

// ── ClassPass — dedicated columns ──────────────────────────────

describe('classifyContact — ClassPass paths', () => {
  it('classifies classpass_payg with recent attendance as classpass_active', () => {
    const c = {
      glofox_membership_status: 'classpass_payg',
      last_attended_at: daysAgo(3),
      total_attended_30d: 5,
    }
    expect(classifyContact(c, NOW)).toBe('classpass_active')
  })

  it('classifies classpass_payg with NO recent attendance as dormant_classpass', () => {
    const c = {
      glofox_membership_status: 'classpass_payg',
      last_attended_at: daysAgo(45),
      total_attended_30d: 0,
    }
    expect(classifyContact(c, NOW)).toBe('dormant_classpass')
  })

  it('classifies classpass_payg with NO attendance ever as dormant_classpass', () => {
    const c = {
      glofox_membership_status: 'classpass_payg',
      last_attended_at: null,
    }
    expect(classifyContact(c, NOW)).toBe('dormant_classpass')
  })
})

// ── Upcoming (membership_state='future') — GLOFOX-CLASSIFY.2 ───

describe('classifyContact — future membership state', () => {
  it('recent future-state signup → active_trial (kept visible in funnel)', () => {
    const c = {
      glofox_membership_status: 'trial',
      glofox_membership_state: 'future',
      joined_at: daysAgo(10),
      last_attended_at: null,
    }
    expect(classifyContact(c, NOW)).toBe('active_trial')
  })

  it('recent future-state PAID membership → active_trial (upcoming, not dormant)', () => {
    const c = {
      glofox_membership_status: 'member',
      glofox_membership_state: 'future',
      glofox_membership_type: 'time',
      joined_at: daysAgo(5),
      last_attended_at: null,
    }
    expect(classifyContact(c, NOW)).toBe('active_trial')
  })

  it('OLD future-state signup (never started) → dormant via recency fallthrough', () => {
    // The real 741: opened an account >1yr ago, never booked a class.
    const c = {
      glofox_membership_status: 'trial',
      glofox_membership_state: 'future',
      joined_at: daysAgo(2 * 365),
      last_attended_at: null,
      trial_credits_remaining: 3,
    }
    expect(classifyContact(c, NOW)).toBe('dormant')
  })

  it('future-state with no joined_at → dormant (no freshness signal)', () => {
    const c = {
      glofox_membership_status: 'trial',
      glofox_membership_state: 'future',
      joined_at: null,
      last_attended_at: null,
    }
    expect(classifyContact(c, NOW)).toBe('dormant')
  })
})

// ── Hot Conversion — signal-driven ────────────────────────────

describe('classifyContact — Hot Conversion (engagement-driven)', () => {
  it('fires on a trial with ≥2 attended in last 7d', () => {
    const c = {
      glofox_membership_status: 'trial',
      total_attended_7d: 2,
      total_attended_30d: 3,
      joined_at: daysAgo(20),
      last_attended_at: daysAgo(1),
    }
    expect(classifyContact(c, NOW)).toBe('hot_conversion')
  })

  it('fires on a trial with exactly 1 credit remaining', () => {
    const c = {
      glofox_membership_status: 'trial',
      trial_credits_remaining: 1,
      joined_at: daysAgo(10),
      total_attended_7d: 0,
      total_attended_30d: 1,
    }
    expect(classifyContact(c, NOW)).toBe('hot_conversion')
  })

  it('fires on a trial with 0 credits remaining (last class used)', () => {
    const c = {
      glofox_membership_status: 'trial',
      trial_credits_remaining: 0,
      joined_at: daysAgo(10),
    }
    expect(classifyContact(c, NOW)).toBe('hot_conversion')
  })

  it('fires on a no_sale_trial that came back ≥2 times last week', () => {
    // Someone who let their trial lapse but is now booking
    // classes again — strong reactivation signal.
    const c = {
      glofox_membership_status: 'no_sale_trial',
      total_attended_7d: 3,
      last_attended_at: daysAgo(2),
    }
    expect(classifyContact(c, NOW)).toBe('hot_conversion')
  })

  it('fires on a tour-booker who attended ≥2 times in last 7d', () => {
    const c = {
      glofox_membership_status: 'tour',
      total_attended_7d: 2,
      joined_at: daysAgo(5),
    }
    expect(classifyContact(c, NOW)).toBe('hot_conversion')
  })

  it('does NOT fire when credits > 1 AND attended < 2 in 7d', () => {
    const c = {
      glofox_membership_status: 'trial',
      trial_credits_remaining: 2,
      total_attended_7d: 1,
      joined_at: daysAgo(3),
    }
    // Not hot — drops to active_trial (recently joined, on trial).
    expect(classifyContact(c, NOW)).toBe('active_trial')
  })
})

// ── Active Trial ──────────────────────────────────────────────

describe('classifyContact — Active Trial', () => {
  it('classifies a trial with recent attendance + plenty of credits as active_trial', () => {
    const c = {
      glofox_membership_status: 'trial',
      last_attended_at: daysAgo(5),
      total_attended_7d: 1,
      total_attended_30d: 2,
      trial_credits_remaining: 3,
      joined_at: daysAgo(20),
    }
    expect(classifyContact(c, NOW)).toBe('active_trial')
  })

  it('classifies a brand-new trial joiner as active_trial even with no attendance yet', () => {
    // Grace period for someone who joined this week — they
    // haven't booked their first class but they ARE in the active
    // funnel.
    const c = {
      glofox_membership_status: 'trial',
      joined_at: daysAgo(3),
      last_attended_at: null,
      trial_credits_remaining: 3,
    }
    expect(classifyContact(c, NOW)).toBe('active_trial')
  })

  it('does NOT classify a stale trial (joined 4 years ago, no recent activity)', () => {
    // The exact case the operator hit post-import: 2,854 of 3,608
    // trial_active deals had joined > 2 years ago. They should
    // fall through to dormant, not stay in the active funnel.
    const c = {
      glofox_membership_status: 'trial',
      joined_at: daysAgo(4 * 365),
      last_attended_at: null,
      trial_credits_remaining: 3,
    }
    expect(classifyContact(c, NOW)).toBe('dormant')
  })
})

// ── Active Member + At Risk ───────────────────────────────────

describe('classifyContact — Active Member / At Risk', () => {
  it('classifies a member with recent attendance as active_member', () => {
    const c = {
      glofox_membership_status: 'member',
      last_attended_at: daysAgo(5),
      total_attended_30d: 8,
    }
    expect(classifyContact(c, NOW)).toBe('active_member')
  })

  it('classifies a member who attends rarely but paid recently as active_member', () => {
    // Subscription-style member — pays monthly, only attends
    // occasionally. Recent payment keeps them in the active
    // column.
    const c = {
      glofox_membership_status: 'member',
      last_attended_at: daysAgo(50),
      last_payment_at: daysAgo(10),
    }
    expect(classifyContact(c, NOW)).toBe('active_member')
  })

  it('classifies a member with 30-90d silence + no recent payment as at_risk_member', () => {
    const c = {
      glofox_membership_status: 'member',
      last_attended_at: daysAgo(60),
      last_payment_at: daysAgo(90),
    }
    expect(classifyContact(c, NOW)).toBe('at_risk_member')
  })

  it('credit_member is treated identically to member for the active/at_risk distinction', () => {
    // PIPELINE5 collapses the old separate credit_member stage —
    // they're real paying customers and belong in active_member.
    expect(classifyContact({
      glofox_membership_status: 'credit_member',
      last_attended_at: daysAgo(2),
    }, NOW)).toBe('active_member')

    expect(classifyContact({
      glofox_membership_status: 'credit_member',
      last_attended_at: daysAgo(60),
    }, NOW)).toBe('at_risk_member')
  })

  it('drops a member with 90-180d silence into lapsed', () => {
    const c = {
      glofox_membership_status: 'member',
      last_attended_at: daysAgo(120),
      last_payment_at: daysAgo(120),
    }
    expect(classifyContact(c, NOW)).toBe('lapsed')
  })

  it('drops a member with no attendance signal at all into dormant', () => {
    // The 815 "members" with last_attended_at=null in the audit
    // diagnostic. Glofox still says MEMBER but they have no
    // engagement history we can see.
    const c = {
      glofox_membership_status: 'member',
      last_attended_at: null,
      last_payment_at: null,
    }
    expect(classifyContact(c, NOW)).toBe('dormant')
  })

  // GLOFOX-CLASSIFY.1 — live membership_state override
  it('overdue member (state=locked) → at_risk_member even if they attended yesterday', () => {
    expect(classifyContact({
      glofox_membership_status: 'member',
      glofox_membership_state: 'locked',
      last_attended_at: daysAgo(1),
    }, NOW)).toBe('at_risk_member')
  })

  it('overdue credit_member (state=locked) → at_risk_member despite credits + recent class', () => {
    expect(classifyContact({
      glofox_membership_status: 'credit_member',
      glofox_membership_state: 'locked',
      last_attended_at: daysAgo(1),
      trial_credits_remaining: 5,
    }, NOW)).toBe('at_risk_member')
  })

  it('state=active is NOT an override — member still classifies on engagement', () => {
    expect(classifyContact({
      glofox_membership_status: 'member',
      glofox_membership_state: 'active',
      last_attended_at: daysAgo(5),
    }, NOW)).toBe('active_member')
  })

  it('null-safe: member with no membership_state falls through to recency logic', () => {
    expect(classifyContact({
      glofox_membership_status: 'member',
      last_attended_at: daysAgo(5),
    }, NOW)).toBe('active_member')
  })
})

// ── Live-membership floor (GLOFOX-CLASSIFY.3) ─────────────────
// A future membership expiry = paid-up subscription. A paid-up
// member is never silently dropped to lapsed/dormant — only the
// active vs at_risk split applies. Fixes paid members buried in the
// hidden dormant bucket because last_payment_at is barely synced.

const daysFromNow = (d) => new Date(NOW + d * 86_400_000).toISOString()

describe('classifyContact — live-membership floor', () => {
  it('paid-up member, quiet (200d since attended, no payment) → at_risk_member, NOT dormant', () => {
    expect(classifyContact({
      glofox_membership_status: 'member',
      glofox_membership_expiry: daysFromNow(20),
      last_attended_at: daysAgo(200),
    }, NOW)).toBe('at_risk_member')
  })

  it('paid-up member with NO attendance signal at all → at_risk_member, NOT dormant', () => {
    expect(classifyContact({
      glofox_membership_status: 'member',
      glofox_membership_expiry: daysFromNow(5),
      last_attended_at: null,
      last_payment_at: null,
    }, NOW)).toBe('at_risk_member')
  })

  it('paid-up member, recently attended → active_member', () => {
    expect(classifyContact({
      glofox_membership_status: 'member',
      glofox_membership_expiry: daysFromNow(20),
      last_attended_at: daysAgo(3),
    }, NOW)).toBe('active_member')
  })

  it('paused-but-paid member who is still attending stays active_member (NOT demoted)', () => {
    // The trap the floor avoids: a dedicated paused→at_risk branch
    // would wrongly demote paused members who are still showing up.
    expect(classifyContact({
      glofox_membership_status: 'member',
      glofox_membership_state: 'paused',
      glofox_membership_expiry: daysFromNow(40),
      last_attended_at: daysAgo(4),
    }, NOW)).toBe('active_member')
  })

  it('paused-but-paid member who is quiet → at_risk_member (surfaced, not hidden)', () => {
    expect(classifyContact({
      glofox_membership_status: 'member',
      glofox_membership_state: 'paused',
      glofox_membership_expiry: daysFromNow(40),
      last_attended_at: daysAgo(120),
    }, NOW)).toBe('at_risk_member')
  })

  it('locked override beats the floor: paid-up but frozen → at_risk_member', () => {
    expect(classifyContact({
      glofox_membership_status: 'member',
      glofox_membership_state: 'locked',
      glofox_membership_expiry: daysFromNow(20),
      last_attended_at: daysAgo(2),
    }, NOW)).toBe('at_risk_member')
  })

  it('PAST expiry does NOT trigger the floor — falls to recency (lapsed)', () => {
    expect(classifyContact({
      glofox_membership_status: 'member',
      glofox_membership_expiry: daysAgo(30),
      last_attended_at: daysAgo(120),
      last_payment_at: daysAgo(120),
    }, NOW)).toBe('lapsed')
  })

  it('credit_member with a future expiry but quiet → at_risk_member', () => {
    expect(classifyContact({
      glofox_membership_status: 'credit_member',
      glofox_membership_expiry: daysFromNow(15),
      last_attended_at: daysAgo(200),
    }, NOW)).toBe('at_risk_member')
  })
})

// ── New Lead ──────────────────────────────────────────────────

describe('classifyContact — New Lead', () => {
  it('classifies a recently-created lead with no attendance as new_lead', () => {
    const c = {
      glofox_membership_status: 'lead',
      created_at: daysAgo(10),
      joined_at: daysAgo(10),
      last_attended_at: null,
    }
    expect(classifyContact(c, NOW)).toBe('new_lead')
  })

  it('classifies a cold prospect joined recently as new_lead', () => {
    const c = {
      glofox_membership_status: 'cold',
      joined_at: daysAgo(30),
      last_attended_at: null,
    }
    expect(classifyContact(c, NOW)).toBe('new_lead')
  })

  it('classifies a recent tour-booker who has NOT attended as new_lead', () => {
    const c = {
      glofox_membership_status: 'tour',
      joined_at: daysAgo(7),
      last_attended_at: null,
    }
    expect(classifyContact(c, NOW)).toBe('new_lead')
  })

  it('does NOT classify a 4-year-old "lead" as new_lead — drops to dormant', () => {
    // 1,404 of 1,706 new_lead deals in the audit were >2 years
    // old. Those are not actionable leads — they're archive.
    const c = {
      glofox_membership_status: 'lead',
      joined_at: daysAgo(4 * 365),
      last_attended_at: null,
    }
    expect(classifyContact(c, NOW)).toBe('dormant')
  })

  // GLOFOX-CLASSIFY.1 — created_at is the import date, not real freshness
  it('lead with only a recent created_at (no joined_at) → dormant', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead',
      created_at: daysAgo(10),
      last_attended_at: null,
    }, NOW)).toBe('dormant')
  })

  it('recent created_at does NOT rescue an old joined_at lead', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead',
      joined_at: daysAgo(200),
      created_at: daysAgo(5),
      last_attended_at: null,
    }, NOW)).toBe('dormant')
  })
})

// ── Lapsed ────────────────────────────────────────────────────

describe('classifyContact — Lapsed', () => {
  it('classifies anyone with 60-180d-old attendance who didnt fit other buckets', () => {
    // ex_member status — Glofox flipped them but they're still in
    // the recovery window.
    const c = {
      glofox_membership_status: 'ex_member',
      last_attended_at: daysAgo(90),
    }
    expect(classifyContact(c, NOW)).toBe('lapsed')
  })

  it('respects the 180-day ceiling — older than that goes to dormant', () => {
    const c = {
      glofox_membership_status: 'ex_member',
      last_attended_at: daysAgo(200),
    }
    expect(classifyContact(c, NOW)).toBe('dormant')
  })
})

// ── Threshold sanity check ────────────────────────────────────

describe('PIPELINE_THRESHOLDS — exported for operator tuning', () => {
  it('matches the operator-confirmed numbers (2026-05-12 sign-off)', () => {
    // If any of these change without an operator conversation,
    // the test fails — forces the next developer to ask.
    expect(PIPELINE_THRESHOLDS.HOT_RECENT_DAYS).toBe(7)
    expect(PIPELINE_THRESHOLDS.HOT_MIN_ATTENDED).toBe(2)
    expect(PIPELINE_THRESHOLDS.HOT_CREDITS_REMAINING_MAX).toBe(1)
    expect(PIPELINE_THRESHOLDS.ACTIVE_RECENT_DAYS).toBe(30)
    expect(PIPELINE_THRESHOLDS.AT_RISK_MAX_DAYS).toBe(90)
    expect(PIPELINE_THRESHOLDS.LAPSED_MIN_DAYS).toBe(60)
    expect(PIPELINE_THRESHOLDS.LAPSED_MAX_DAYS).toBe(180)
    expect(PIPELINE_THRESHOLDS.NEW_LEAD_RECENT_DAYS).toBe(90)
    expect(PIPELINE_THRESHOLDS.TRIAL_GRACE_DAYS).toBe(14)
  })
})

// ── Real-world fixtures from the diagnostic ───────────────────

describe('classifyContact — real fixtures from the post-import audit', () => {
  it('Paula Glynn — fresh trial, no transitions yet', () => {
    // From the audit: trial, joined 3 days ago, 0 credits used
    // (no last_attended_at yet because no booking).
    const c = {
      glofox_membership_status: 'trial',
      joined_at: daysAgo(3),
      last_attended_at: null,
      trial_credits_remaining: null,
    }
    expect(classifyContact(c, NOW)).toBe('active_trial')
  })

  it('ClassPass user who hasnt booked in 2 years — dormant_classpass not pipeline', () => {
    // 1,533 contacts in the audit were classpass_payg with
    // last_attended_at IS NULL. They cluttered the conversion_ready
    // column. Now they correctly go to the dormant ClassPass
    // archive.
    const c = {
      glofox_membership_status: 'classpass_payg',
      joined_at: daysAgo(2 * 365 + 30),
      last_attended_at: null,
    }
    expect(classifyContact(c, NOW)).toBe('dormant_classpass')
  })

  it('Ancient "member" with no recent signal — dormant not active_member', () => {
    // The 657 "members" who joined >2y ago and have no recent
    // booking. Glofox marks them MEMBER (subscription possibly
    // cancelled but record not updated). They should NOT be in
    // the active member column.
    const c = {
      glofox_membership_status: 'member',
      joined_at: daysAgo(3 * 365),
      last_attended_at: null,
      last_payment_at: null,
    }
    expect(classifyContact(c, NOW)).toBe('dormant')
  })
})

// PIPELINE-FLAP regression — root cause of the Simon Goldsmith
// "Active Member ⇄ Dormant" flapping (May 2026). A member's
// classification diverges depending on whether attendance data is
// present. The full sync supplies it (→ active_member); the detail-
// backfill skips the booking fetch, leaving attendance null (→ dormant).
// The fix is to NOT reclassify when there's no booking signal
// (applyMemberSync opts.skipReclassify / skipBookings); these tests
// pin the divergent classifier outputs that made the guard necessary.
describe('PIPELINE-FLAP: member classification depends on attendance presence', () => {
  const NOW = new Date('2026-05-31T03:30:00Z').getTime()
  const recentlyAttendedMember = {
    glofox_membership_status: 'member',
    last_attended_at: '2026-05-23T07:00:00Z', // 8 days before NOW
    total_attended_30d: 10,
    total_attended_7d: 0,
  }

  it('classifies a recently-attended member as active_member (full-sync data)', () => {
    expect(classifyContact(recentlyAttendedMember, NOW)).toBe('active_member')
  })

  it('drops the SAME member to dormant when attendance is blanked (backfill data)', () => {
    const noAttendanceSignal = {
      glofox_membership_status: 'member',
      last_attended_at: null,        // skipBookings → never set
      total_attended_30d: 0,
      total_attended_7d: 0,
    }
    expect(classifyContact(noAttendanceSignal, NOW)).toBe('dormant')
  })
})
