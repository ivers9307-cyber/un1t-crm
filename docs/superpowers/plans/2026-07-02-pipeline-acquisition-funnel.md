# Pipeline Acquisition Funnel (FUNNEL.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 9-stage engagement pipeline with a 5-column acquisition funnel (New Leads → 1st Class → 2nd Class → Trial Done → Converted), stamped-on-webhook conversion detection, a "next class booked" badge, ClassPass excluded, and all comms/automations filter surfaces updated.

**Architecture:** Keep the existing `deals` + `pipeline_stages` + nightly-cron + webhook-reclassify machinery; swap the taxonomy and rewrite the pure classifier. Board becomes read-only (columns are fully derived — drag-drop would be overwritten nightly). New `contacts.converted_at` column is stamped write-once inside `applyMemberSync` (the shared webhook + nightly sync path), so conversion moves are near-instant via the existing `MEMBER_UPDATED` → `ensureDealForContact` flow.

**Tech Stack:** Next.js 16 App Router, Supabase (migrations via MCP, project `iyvtbjjxdggiadzwwvdj`), Vitest.

**Operator-approved design (Richard, 2026-07-02):**

| Column | Stage slug | Who | Badge |
|---|---|---|---|
| 1. New Leads | `new_lead` (reused) | joined ≤60d, 0 classes attended, non-member, non-ClassPass | next class booked / none |
| 2. 1st Class | `first_class` | 1 attended, last attended ≤60d | same |
| 3. 2nd Class | `second_class` | 2 attended, last attended ≤60d | same |
| 4. Trial Done | `trial_done` | 3+ attended, not yet member — decision point | same + credits left |
| 5. Converted | `converted` | `converted_at` ≤60d | — |
| off-board | `member` | members converted >60d ago / pre-existing | shown in "Off funnel" tab |
| off-board | `classpass` | all `classpass_payg` | same |
| off-board | `dormant` (reused) | aged-out leads, ex_members, ghosts | same |

Stages being retired (archived in mig 351, **after** reclassify): `active_trial`, `hot_conversion`, `active_member`, `at_risk_member`, `classpass_active`, `lapsed`, `dormant_classpass`.

**Key data facts (verified against live DB 2026-07-02):**
- `contacts.lead_created_at` is import-poisoned (5,531 contacts stamped week of 2026-05-11). **`joined_at` is the real Glofox date — use it.**
- No conversion timestamp exists anywhere. `converted_at` is new; seeded from `joined_at` for members joined ≤60d (proxy, ~15 contacts), accurate from webhook stamping onward.
- Booking history lives ONLY in `contacts.recent_bookings` (jsonb, last 10, includes future bookings: `{time_start (unix s), attended (bool), status ('BOOKED'), event_name, ...}`). The `class_bookings` table is empty — do not use it.
- ClassPass = `glofox_membership_status='classpass_payg'` (also `lead_source='classpass'`).
- Zero saved broadcast audiences reference old slugs; ONE draft sequence ("New member welcome") has `trigger_type='pipeline_stage_change'`, `trigger_config={"to_status":"member"}` → retarget to `converted` in mig 350.
- CCF Autos / SourceIt have zero deals — no manual kanban usage exists outside the gym; removing drag-drop is safe.

**Deploy sequencing (critical — order matters):**
1. Mig 343 (converted_at + seed + new stage rows + sequence-config data fixes) — harmless under old code because old classifier never targets the new slugs.
2. Merge the code PR (Vercel auto-deploys).
3. Run admin reclassify: dry-run → review movement matrix → commit. All ~8.3k deals move to new slugs.
4. Mig 344 archives the 7 old stages (guarded: raises if any open deal still sits on them).

**Worktree:** per repo convention, branch in `~/code/un1t-crm-ct`: `git fetch origin main && git checkout -b funnel-pipeline-redesign origin/main`.

---

### Task 1: Migration 343 — converted_at, seed, new stages, sequence-config fixes

**Files:**
- Create: `supabase/migrations/350_pipeline_acquisition_funnel.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- FUNNEL.1 — acquisition-funnel pipeline redesign (operator-approved 2026-07-02).
-- Design doc: docs/superpowers/plans/2026-07-02-pipeline-acquisition-funnel.md
--
-- Adds contacts.converted_at + the new funnel stage rows + retargets the
-- one draft sequence that referenced the old taxonomy. The 7 retired
-- PIPELINE5 stages are archived LATER (mig 351), after the new classifier
-- has moved every deal — deploy order: this migration → code → reclassify
-- commit → mig 351.

-- 1. Conversion moment. Write-once, stamped by applyMemberSync when
--    glofox_membership_status transitions into member/credit_member
--    (webhook path = near-instant; nightly sync = catch-all).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS converted_at timestamptz;
COMMENT ON COLUMN contacts.converted_at IS
  'FUNNEL.1 — first observed transition into member/credit_member. Drives the pipeline Converted column (60d window). Seeded from joined_at for members who joined within 60d of mig 350; accurate from webhook stamping onward.';

-- 2. Launch-cohort seed. joined_at is a proxy for the conversion moment
--    (~15 contacts at Stillorgan on 2026-07-02). NOT accurate for members
--    who existed as leads long before joining — accepted by operator.
UPDATE contacts
   SET converted_at = joined_at
 WHERE converted_at IS NULL
   AND glofox_membership_status IN ('member', 'credit_member')
   AND joined_at > now() - interval '60 days';

-- 3. Revive Stillorgan's ARCHIVED legacy 'member' stage row (mig 239
--    archived it) as the new off-funnel Member bucket, so the slug isn't
--    duplicated. Other locations get a fresh row from the INSERT below.
UPDATE pipeline_stages
   SET archived = false, is_dormant = true, name = 'Member',
       display_order = 306, color = '#64748B'
 WHERE slug = 'member';

-- 4. New funnel stages for every location (mig 147 CROSS JOIN pattern).
--    display_order 301+ sorts after the PIPELINE5 200-block until mig 351
--    archives that block. is_dormant=true = "Off funnel" tab (hidden from
--    the default board view; the existing view switcher mechanism).
INSERT INTO pipeline_stages (location_id, name, slug, display_order, color, archived, is_dormant)
SELECT l.id, s.name, s.slug, s.display_order, s.color, false, s.is_dormant
FROM locations l
CROSS JOIN (VALUES
  ('1st Class',  'first_class',  302, '#10B981', false),
  ('2nd Class',  'second_class', 303, '#14B8A6', false),
  ('Trial Done', 'trial_done',   304, '#F59E0B', false),
  ('Converted',  'converted',    305, '#059669', false),
  ('Member',     'member',       306, '#64748B', true),
  ('ClassPass',  'classpass',    307, '#A855F7', true)
) AS s(name, slug, display_order, color, is_dormant)
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages ps
  WHERE ps.location_id = l.id AND ps.slug = s.slug
);

-- 5. Re-slot the two REUSED stages into the funnel ordering.
--    new_lead: column 1 (semantics tighten to "joined ≤60d, 0 attended"
--    in the new classifier). dormant: off-funnel catch-all, unchanged.
UPDATE pipeline_stages SET name = 'New Leads', display_order = 301
 WHERE slug = 'new_lead' AND archived = false;
UPDATE pipeline_stages SET display_order = 308
 WHERE slug = 'dormant' AND archived = false;

-- 6. Retarget stored sequence configs that reference retired stage
--    semantics. Verified 2026-07-02: exactly one draft sequence has
--    trigger_config to_status='member' ("New member welcome") — its
--    intent maps to the new 'converted' stage (fires the moment the
--    conversion move happens, not 60d later when converted → member).
UPDATE email_sequences
   SET trigger_config = jsonb_set(trigger_config, '{to_status}', '"converted"')
 WHERE trigger_type = 'pipeline_stage_change'
   AND trigger_config->>'to_status' = 'member';
UPDATE email_sequences
   SET goal_config = jsonb_set(goal_config, '{value}', '"converted"')
 WHERE goal_config->>'type' = 'pipeline_stage'
   AND goal_config->>'value' IN ('active_member', 'member');
UPDATE email_sequences
   SET goal_config = jsonb_set(goal_config, '{value}', '"first_class"')
 WHERE goal_config->>'type' = 'pipeline_stage'
   AND goal_config->>'value' = 'active_trial';
```

- [ ] **Step 2: Apply via Supabase MCP**

Use `apply_migration` (name `350_pipeline_acquisition_funnel`) against project `iyvtbjjxdggiadzwwvdj` (NOT the sentinel project). Migrations are forward-only.

- [ ] **Step 3: Verify**

Run via `execute_sql`:
```sql
SELECT slug, count(*) FROM pipeline_stages WHERE archived = false
  AND slug IN ('new_lead','first_class','second_class','trial_done','converted','member','classpass','dormant')
GROUP BY slug ORDER BY slug;
-- Expect: each slug × 5 locations = 5 (member may be 5 after revive+insert)
SELECT count(*) FROM contacts WHERE converted_at IS NOT NULL;
-- Expect: ~15
SELECT trigger_config FROM email_sequences WHERE trigger_type = 'pipeline_stage_change';
-- Expect: {"to_status": "converted"}
```
Also confirm no slug is duplicated per location:
```sql
SELECT location_id, slug, count(*) FROM pipeline_stages WHERE archived = false
GROUP BY 1, 2 HAVING count(*) > 1;  -- Expect: 0 rows
```

- [ ] **Step 4: Run advisors**

`get_advisors` (type=security) — required after any DDL. The 2 known SECURITY DEFINER WARNs are intentional; anything new needs fixing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/350_pipeline_acquisition_funnel.sql
git commit -m "FUNNEL.1 — mig 350: converted_at + acquisition-funnel stages

Adds contacts.converted_at (write-once conversion moment, seeded from
joined_at ≤60d proxy), inserts the funnel stage rows for all locations,
revives Stillorgan's archived legacy 'member' row as the off-funnel
Member bucket, and retargets the one draft sequence referencing the old
taxonomy. Old PIPELINE5 stages stay live until mig 351 (post-reclassify)."
```

---

### Task 2: Rewrite the classifier (TDD)

**Files:**
- Modify: `src/lib/pipeline-classifier.js` (full rewrite of rules; keep file location + export names)
- Modify: `src/lib/pipeline-classifier.test.js` (full rewrite)

The classifier stays a pure function and keeps the `classifyContact(contact, now)` signature so `ensureDealForContact` (glofox-sync.js:474) and `pipeline-reclassify.js` keep working. Two new pure helpers are exported: `countAttendedBookings` and `nextBookedClass` (the badge derivation — lives here so board UI and classifier share one definition of "attended" / "future booking").

- [ ] **Step 1: Write the new test file (replace the old one entirely)**

```javascript
// FUNNEL.1 — acquisition-funnel classifier tests. Fixtures are named
// people so failures read like a story (repo convention from PIPELINE5).
import { describe, it, expect } from 'vitest'
import {
  classifyContact,
  countAttendedBookings,
  nextBookedClass,
  PIPELINE_THRESHOLDS,
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
  it('ex_member → dormant (winback, not a funnel lead)', () => {
    expect(classifyContact({
      glofox_membership_status: 'ex_member', joined_at: daysAgo(300),
    }, NOW)).toBe('dormant')
  })
  it('null/garbage input → dormant', () => {
    expect(classifyContact(null, NOW)).toBe('dormant')
  })
})

describe('idempotency', () => {
  it('same input twice → same output', () => {
    const c = { glofox_membership_status: 'trial', joined_at: daysAgo(10), last_attended_at: daysAgo(3), recent_bookings: [attendedBooking(3)] }
    expect(classifyContact(c, NOW)).toBe(classifyContact(c, NOW))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- pipeline-classifier`
Expected: FAIL — `countAttendedBookings` / `nextBookedClass` not exported; stage-slug assertions mismatch.

- [ ] **Step 3: Rewrite `src/lib/pipeline-classifier.js`**

Replace the stage-definition comment block, `PIPELINE_THRESHOLDS`, and `classifyContact` with (keep the existing `daysSince` helper and `DAY_MS` unchanged):

```javascript
// FUNNEL.1 — acquisition-funnel classifier (operator-approved 2026-07-02).
//
// The pipeline is now a pure lead→member funnel. Member lifecycle
// (at-risk / lapsed) is the Churn Radar's job — it keys on Glofox
// status and never read pipeline slugs, so nothing breaks.
//
// Stage definitions:
//   new_lead     — non-member, 0 classes attended, joined ≤60d ago
//                  (joined_at ONLY — lead_created_at is import-poisoned)
//   first_class  — 1 class attended, last attended ≤60d
//   second_class — 2 classes attended, last attended ≤60d
//   trial_done   — 3+ attended, not yet a member. THE decision point.
//   converted    — became member/credit_member ≤60d ago (converted_at,
//                  stamped by applyMemberSync on the status transition)
//   member       — converted >60d ago, or pre-existing member (off funnel)
//   classpass    — classpass_payg, always (off funnel — distinct motion)
//   dormant      — aged-out leads, ex_members, ghosts (off funnel)
//
// Attended counts come from contacts.recent_bookings (last 10 from the
// Glofox sync). For funnel-age leads that IS their complete history;
// last_attended_at backstops the count if the list was ever pruned.
//
// Pure function — same input, same output. Callers: applyMemberSync
// (per-webhook, near-instant) and the nightly pipeline-classify cron.

export const PIPELINE_THRESHOLDS = {
  // Column 1 entry window, keyed on joined_at (Glofox tenure date).
  NEW_LEAD_WINDOW_DAYS:    60,
  // Columns 2–4 stay on the board while the lead is still active —
  // keyed on last attendance so a mid-trial lead doesn't vanish when
  // their joined_at crosses 60d.
  FUNNEL_ACTIVITY_DAYS:    60,
  // Column 5 window, keyed on converted_at; then off-board to member.
  CONVERTED_WINDOW_DAYS:   60,
  // 3 classes ≈ a completed trial pack → decision point.
  TRIAL_DONE_MIN_ATTENDED: 3,
}

/** Count attended classes in a recent_bookings jsonb array. */
export function countAttendedBookings(recentBookings) {
  if (!Array.isArray(recentBookings)) return 0
  return recentBookings.filter((b) => b && b.attended === true).length
}

/**
 * Soonest FUTURE booked class in a recent_bookings array, as an ISO
 * string, or null. Drives the board's "next class booked" badge.
 * time_start is unix SECONDS (Glofox payload convention).
 */
export function nextBookedClass(recentBookings, now = Date.now()) {
  if (!Array.isArray(recentBookings)) return null
  let soonest = null
  for (const b of recentBookings) {
    if (!b || String(b.status || '').toUpperCase() !== 'BOOKED') continue
    const ms = Number(b.time_start) * 1000
    if (!Number.isFinite(ms) || ms <= now) continue
    if (soonest === null || ms < soonest) soonest = ms
  }
  return soonest === null ? null : new Date(soonest).toISOString()
}

export function classifyContact(contact, now = Date.now()) {
  if (!contact || typeof contact !== 'object') return 'dormant'
  const status = contact.glofox_membership_status || null

  // ── Members: recently converted → the funnel's win column ──────
  if (status === 'member' || status === 'credit_member') {
    const sinceConverted = daysSince(contact.converted_at, now)
    if (sinceConverted !== null && sinceConverted <= PIPELINE_THRESHOLDS.CONVERTED_WINDOW_DAYS) {
      return 'converted'
    }
    return 'member'
  }

  // ── ClassPass: excluded from the funnel entirely ───────────────
  if (status === 'classpass_payg') return 'classpass'

  // ── Ex-members are winback targets, not funnel leads ───────────
  if (status === 'ex_member') return 'dormant'

  // ── Funnel candidates: lead/cold/tour/no_sale_*/trial/null ─────
  // last_attended_at backstops the count: it's advance-only on the
  // persisted row, so a non-empty value means ≥1 attendance even if
  // recent_bookings was pruned.
  const attended = Math.max(
    countAttendedBookings(contact.recent_bookings),
    contact.last_attended_at ? 1 : 0,
  )
  const sinceAttended = daysSince(contact.last_attended_at, now)
  const sinceJoined   = daysSince(contact.joined_at, now)

  if (attended >= 1) {
    const stillActive = sinceAttended !== null
      && sinceAttended <= PIPELINE_THRESHOLDS.FUNNEL_ACTIVITY_DAYS
    if (!stillActive) return 'dormant'
    if (attended >= PIPELINE_THRESHOLDS.TRIAL_DONE_MIN_ATTENDED) return 'trial_done'
    return attended === 2 ? 'second_class' : 'first_class'
  }

  const recentlyJoined = sinceJoined !== null
    && sinceJoined <= PIPELINE_THRESHOLDS.NEW_LEAD_WINDOW_DAYS
  return recentlyJoined ? 'new_lead' : 'dormant'
}
```

Delete the old thresholds/rules that are no longer referenced (HOT_*, ACTIVE_*, AT_RISK_*, LAPSED_*, TRIAL_GRACE_DAYS). Grep the repo for any external reader of the deleted threshold keys before removing: `grep -rn "PIPELINE_THRESHOLDS\." src/ | grep -v pipeline-classifier` — update or remove any hits.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- pipeline-classifier`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline-classifier.js src/lib/pipeline-classifier.test.js
git commit -m "FUNNEL.1 — rewrite classifier as acquisition funnel

new_lead → first_class → second_class → trial_done → converted, with
member/classpass/dormant off-board. Attendance counted from
recent_bookings (last_attended_at backstop); 60d windows key on
joined_at (col 1), last attendance (cols 2-4), converted_at (col 5).
Exports countAttendedBookings + nextBookedClass for the board badge."
```

---

### Task 3: Stamp converted_at on the webhook path (TDD)

**Files:**
- Modify: `src/lib/glofox-sync.js` (pure decision fn + wiring in `applyMemberSync` ~line 1730; snapshot ~line 1853; `previewMemberSync` existing-row select)
- Modify: `src/lib/glofox-sync.test.js` (add tests)

`applyMemberSync` already captures `previousStatus`/`newStatus` (lines 1725–1730) and runs `ensureDealForContact` per webhook — we stamp between the contact write and the reclassify block so the classifier snapshot sees the fresh `converted_at`.

- [ ] **Step 1: Write failing tests for the pure decision function**

Append to `src/lib/glofox-sync.test.js` (mirror the existing `detectTrialTransitionTags` test style in that file):

```javascript
describe('shouldStampConversion (FUNNEL.1)', () => {
  const NOW = new Date('2026-07-02T12:00:00Z').getTime()
  const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()

  it('stamps on lead→member transition', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: 'lead', newStatus: 'member',
      existingConvertedAt: null, joinedAt: daysAgo(30), now: NOW,
    })).toBe(true)
  })
  it('stamps on trial→credit_member transition', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: 'trial', newStatus: 'credit_member',
      existingConvertedAt: null, joinedAt: daysAgo(10), now: NOW,
    })).toBe(true)
  })
  it('write-once: never restamps when converted_at already set', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: 'trial', newStatus: 'member',
      existingConvertedAt: daysAgo(5), joinedAt: daysAgo(10), now: NOW,
    })).toBe(false)
  })
  it('no stamp on member→member re-sync (no transition)', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: 'member', newStatus: 'member',
      existingConvertedAt: null, joinedAt: daysAgo(300), now: NOW,
    })).toBe(false)
  })
  it('no stamp on member→credit_member (already a member)', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: 'member', newStatus: 'credit_member',
      existingConvertedAt: null, joinedAt: daysAgo(300), now: NOW,
    })).toBe(false)
  })
  it('create path: stamps a direct join (created as member, joined ≤60d)', () => {
    expect(shouldStampConversion({
      action: 'create', previousStatus: null, newStatus: 'member',
      existingConvertedAt: null, joinedAt: daysAgo(2), now: NOW,
    })).toBe(true)
  })
  it('create path: does NOT stamp a long-standing member appearing for the first time', () => {
    expect(shouldStampConversion({
      action: 'create', previousStatus: null, newStatus: 'member',
      existingConvertedAt: null, joinedAt: daysAgo(200), now: NOW,
    })).toBe(false)
  })
  it('no stamp when newStatus is not a member status', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: 'lead', newStatus: 'trial',
      existingConvertedAt: null, joinedAt: daysAgo(5), now: NOW,
    })).toBe(false)
  })
})
```

Add `shouldStampConversion` to the file's import list from `./glofox-sync.js`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- glofox-sync`
Expected: FAIL — `shouldStampConversion` is not exported.

- [ ] **Step 3: Implement the pure function**

Add to `src/lib/glofox-sync.js`, directly after `detectTrialTransitionTags` (ends line 922):

```javascript
const MEMBER_STATUSES = new Set(['member', 'credit_member'])
const CONVERSION_CREATE_WINDOW_DAYS = 60

/**
 * FUNNEL.1 — should this sync stamp contacts.converted_at?
 *
 * Write-once: never when already set. Update path: only on a real
 * transition INTO member/credit_member from a non-member status
 * (incl. classpass_payg and ex_member — any status flip into paying
 * counts; the classifier decides what the board shows). Create path:
 * a contact appearing for the first time already AS a member is a
 * direct join only if they joined recently — the nightly full sync
 * also creates unseen contacts, and stamping a 2022 member as a fresh
 * conversion would pollute the Converted column.
 *
 * Pure function — caller writes the timestamp.
 */
export function shouldStampConversion({ action, previousStatus, newStatus, existingConvertedAt, joinedAt, now = Date.now() }) {
  if (existingConvertedAt) return false
  if (!MEMBER_STATUSES.has(newStatus)) return false
  if (action === 'update') return !MEMBER_STATUSES.has(previousStatus)
  if (action === 'create') {
    if (!joinedAt) return false
    const ms = now - new Date(joinedAt).getTime()
    return Number.isFinite(ms) && ms >= 0 && ms <= CONVERSION_CREATE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  }
  return false
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- glofox-sync`
Expected: PASS.

- [ ] **Step 5: Wire the stamp into `applyMemberSync`**

First make `previewMemberSync` load `converted_at` on the existing row: find the existing-contact select (`grep -n "glofox_membership_state" src/lib/glofox-sync.js | head -5` — the `.select(` list used to build `preview.existing`) and add `converted_at` to that column list. (`recent_bookings` is already selected — it's diffed in `preview.changes`.)

Then in `applyMemberSync`, insert after the contact insert/update completes (after line 1804, before the roster upsert) — `previousStatus`/`newStatus` are already in scope from lines 1725–1730:

```javascript
  // FUNNEL.1 — stamp the conversion moment. Runs on the webhook path
  // (MEMBER_UPDATED → applyMemberSync), so the Converted column moves
  // near-instantly; the nightly sync is the catch-all. Write-once —
  // .is('converted_at', null) makes a concurrent double-fire harmless.
  // Best-effort: a stamp failure must not roll back the contact write.
  let convertedAt = preview.existing?.converted_at ?? null
  if (shouldStampConversion({
    action: preview.action,
    previousStatus,
    newStatus,
    existingConvertedAt: convertedAt,
    joinedAt: preview.mapped?.joined_at ?? preview.existing?.joined_at ?? null,
  })) {
    try {
      const { error: stampErr } = await db.from('contacts')
        .update({ converted_at: now })
        .eq('id', contactId)
        .is('converted_at', null)
      if (!stampErr) convertedAt = now
    } catch (e) {
      logWarn('glofox-sync', 'converted_at stamp threw', { err: e?.message })
    }
  }
```

- [ ] **Step 6: Feed the new fields to the classifier snapshot**

In the `contactSnapshot` object (lines 1853–1872), add two fields after `trial_credits_remaining`:

```javascript
        // FUNNEL.1 — the funnel classifier counts attended classes from
        // recent_bookings and gates the Converted column on converted_at.
        recent_bookings: m.recent_bookings ?? ex.recent_bookings ?? null,
        converted_at:    convertedAt,
```

Also update the `contactSnapshot` shape list in the `ensureDealForContact` JSDoc (lines 461–464) to include `recent_bookings` and `converted_at`.

- [ ] **Step 7: Run the full glofox-sync suite**

Run: `npm test -- glofox-sync`
Expected: PASS. If existing `applyMemberSync` tests assert exact snapshot shapes, update those fixtures to include the two new keys.

- [ ] **Step 8: Commit**

```bash
git add src/lib/glofox-sync.js src/lib/glofox-sync.test.js
git commit -m "FUNNEL.1 — stamp contacts.converted_at on status transition

shouldStampConversion (pure, tested): update-path stamps on any
non-member → member/credit_member flip; create-path only for direct
joins (joined_at ≤60d) so nightly-sync creations of long-standing
members don't pollute the Converted column. Stamped inside
applyMemberSync before ensureDealForContact so the webhook path moves
the deal to Converted in the same request. Snapshot now carries
recent_bookings + converted_at for the funnel classifier."
```

---

### Task 4: Reclassify orchestrator reads the new signals

**Files:**
- Modify: `src/lib/pipeline-reclassify.js` (contact select list, ~lines 107–151)
- Modify: `src/lib/pipeline-reclassify.test.js` (fixture slugs)

- [ ] **Step 1: Add the new columns to the contacts select**

Find the paginated contacts `.select('...')` in `reclassifyAllContacts` (the list containing `glofox_membership_status`, `last_attended_at`, `trial_credits_remaining`, …) and add `recent_bookings` and `converted_at` to it. Without this, the nightly cron classifies with `attended=0`/`converted_at=null` and drags webhook-placed deals back — the exact PIPELINE-FLAP failure mode documented at glofox-sync.js:1829.

- [ ] **Step 2: Update `pipeline-reclassify.test.js` fixtures**

Update stage-slug fixtures/assertions from old slugs to new ones (`active_trial`→`first_class`, `active_member`→`member`, etc.), and give classified-contact fixtures `recent_bookings` arrays consistent with their intended column (same `attendedBooking` helper shape as Task 2's tests).

- [ ] **Step 3: Run**

Run: `npm test -- pipeline-reclassify`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/pipeline-reclassify.js src/lib/pipeline-reclassify.test.js
git commit -m "FUNNEL.1 — reclassify cron reads recent_bookings + converted_at

Keeps the nightly classifier and the webhook classifier reading the
same signals (PIPELINE-FLAP guard)."
```

---

### Task 5: Board UI — read-only funnel with next-class badge

**Files:**
- Modify: `src/app/pipeline/page.js`
- Modify: `src/components/KanbanBoard.jsx`
- Modify: `src/components/DealCard.jsx`
- Modify: `src/components/PipelineViewSwitcher.jsx`
- Modify: `src/components/PipelineReclassifyTab.jsx` (slug references — `grep -n "hot_conversion\|active_trial" src/components/PipelineReclassifyTab.jsx` and update to new slugs)

- [ ] **Step 1: page.js — fetch recent_bookings on the funnel view, derive the badge server-side**

In the deals select (lines 83–90), add `recent_bookings` to the contacts embed **only for the funnel view** (the off-funnel view has thousands of deals and no badge — don't ship the jsonb):

```javascript
      const contactFields = view === 'dormant'
        ? 'id, name, lead_source, pipeline_stage_slug, trial_credits_remaining'
        : 'id, name, lead_source, pipeline_stage_slug, trial_credits_remaining, recent_bookings'
      const { data: page, error } = await db
        .from('deals')
        .select(`
          id, title, stage_id, created_at,
          contacts ( ${contactFields} )
        `)
```

After the pagination loop, derive `next_class_at` and strip the raw jsonb before it reaches the client (import `nextBookedClass` from `@/lib/pipeline-classifier`):

```javascript
  // FUNNEL.1 — derive the badge server-side and strip recent_bookings
  // so the client payload stays card-sized (PERF.2 discipline).
  const boardDeals = deals.map((d) => {
    const { recent_bookings, ...contact } = d.contacts || {}
    return {
      ...d,
      contacts: { ...contact, next_class_at: nextBookedClass(recent_bookings) },
    }
  })
```

Pass `boardDeals` (not `deals`) to `<KanbanBoard initialDeals={boardDeals} …>`. Update the header count copy `'dormant' : 'active'` → `'off-funnel' : 'funnel'`.

- [ ] **Step 2: KanbanBoard.jsx — remove drag-drop, new colors, badge-first sort**

The columns are now fully derived — a drag would be overwritten by the next webhook/nightly run, so the affordance is a lie. Remove: `draggedDeal`/`dragOverStage` state, `handleDrop`, the `createBrowserClient` import, and the `draggable`/`onDragStart`/`onDragEnd`/`onDragOver`/`onDragLeave`/`onDrop` props (keep the `expandedColumns` cap logic and `isOver` styling removal). Replace `stageColors` with:

```javascript
// FUNNEL.1 — funnel taxonomy. Hexes match mig 350 stage rows.
const stageColors = {
  new_lead:     '#3B82F6',
  first_class:  '#10B981',
  second_class: '#14B8A6',
  trial_done:   '#F59E0B',
  converted:    '#059669',
  member:       '#64748B',
  classpass:    '#A855F7',
  dormant:      '#6B7280',
}
```

Sort each column so "no next class booked" (the follow-up list) floats to the top, replacing the plain filter on line 78:

```javascript
        const stageDeals = deals
          .filter(d => d.stage_id === stage.id)
          .sort((a, b) =>
            (a.contacts?.next_class_at ? 1 : 0) - (b.contacts?.next_class_at ? 1 : 0))
```

- [ ] **Step 3: DealCard.jsx — badge + new slug colors**

Replace `statusColors` with the new slugs (same border-l idiom):

```javascript
const statusColors = {
  new_lead:     'border-l-blue-500',
  first_class:  'border-l-green-500',
  second_class: 'border-l-teal-500',
  trial_done:   'border-l-amber-500',
  converted:    'border-l-emerald-500',
  member:       'border-l-slate-500',
  classpass:    'border-l-purple-500',
  dormant:      'border-l-gray-500',
}

// Funnel columns 1–4 show the next-class badge; Converted and the
// off-funnel stages don't (it'd be noise there).
const BADGE_SLUGS = new Set(['new_lead', 'first_class', 'second_class', 'trial_done'])
```

Update the credits pill condition (line 68) from `=== 'active_trial'` to `BADGE_SLUGS.has(contact.pipeline_stage_slug)` and add the badge after it:

```jsx
        {BADGE_SLUGS.has(contact.pipeline_stage_slug) && (
          contact.next_class_at ? (
            <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 bg-emerald-500/10 rounded text-emerald-700">
              Next: {new Date(contact.next_class_at).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })}
            </span>
          ) : (
            <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/10 rounded text-red-700">
              No class booked
            </span>
          )
        )}
```

(Light-theme -700 text ramp per CLAUDE.md convention.)

- [ ] **Step 4: PipelineViewSwitcher.jsx — rename tabs**

Read the file; change the visible tab label strings: `Active` → `Funnel`, `Dormant` → `Off funnel`. Keep the `?view=dormant` query param value as-is (bookmarks, and the page.js branch keys on it).

- [ ] **Step 5: Verify in dev**

Run: `npm run dev`, open `http://localhost:3000/pipeline`.
Expected: 5 funnel columns; badges on cols 1–4; no-badge cards sorted to the top; drag does nothing (no handlers); "Off funnel" tab shows member/classpass/dormant. NOTE: columns will only populate correctly after Task 10's reclassify run — until then most deals sit on old (still-unarchived) stages, which no longer render as columns; the funnel columns may be sparse in dev. Sanity-check rendering, not counts.

- [ ] **Step 6: Commit**

```bash
git add src/app/pipeline/page.js src/components/KanbanBoard.jsx src/components/DealCard.jsx src/components/PipelineViewSwitcher.jsx src/components/PipelineReclassifyTab.jsx
git commit -m "FUNNEL.1 — read-only funnel board with next-class badge

Drag-drop removed (columns are fully derived; a manual move would be
overwritten by the next classify pass). next_class_at derived
server-side from recent_bookings and stripped before the client
payload. No-next-class cards sort first — that's the follow-up list."
```

---

### Task 6: Comms & automations surfaces — new slugs everywhere

**Files:**
- Modify: `src/components/AudienceBuilder.jsx:14-17`
- Modify: `src/components/sequences/SequenceSettings.jsx:14-16`
- Modify: `src/lib/sequence-templates.js` (goal/trigger stage values + descriptions: lines 341, 400–403, 471, 498, 528–530)
- Modify: `src/lib/sequences/agent/prompt.js:52`
- Modify: `src/lib/agent/followups.js:49,524`

The server-side whitelist (`src/lib/audience-filter.js` `AUDIENCE_FIELDS.pipeline_stage_slug`) validates field+ops only, not values — no change needed there. The `pipeline_stage_change` sequence trigger (`src/lib/sequences/triggers.js:225-260`) matches on raw slug strings and is fired by both `ensureDealForContact` callers and the reclassify orchestrator — it works with new slugs as-is; only the UI slug lists need updating.

- [ ] **Step 1: AudienceBuilder.jsx — new stage options**

Replace the options array at lines 14–17:

```javascript
  { value: 'pipeline_stage_slug',   label: 'Stage',                 type: 'select',
    options: ['new_lead', 'first_class', 'second_class', 'trial_done',
              'converted', 'member', 'classpass', 'dormant'] },
```

- [ ] **Step 2: SequenceSettings.jsx — new PIPELINE_SLUGS**

```javascript
const PIPELINE_SLUGS = [
  'new_lead', 'first_class', 'second_class', 'trial_done',
  'converted', 'member', 'classpass', 'dormant',
]
```

- [ ] **Step 3: sequence-templates.js — retarget stage goals/triggers**

- Line 341: `goal_config: { type: 'pipeline_stage', value: 'dormant' }` — unchanged (`dormant` survives).
- Lines 400–403 and 471: `value: 'active_trial'` → `value: 'first_class'`; fix the line-400 description text `becomes an active_trial` → `attends their first class`.
- Line 498: `value: 'active_member'` → `value: 'converted'`.
- Lines 528–530: description `flips to active_member` → `flips to converted`; `trigger_config: { to_status: 'active_member' }` → `{ to_status: 'converted' }`.

- [ ] **Step 4: sequences/agent/prompt.js line 52 — the "Build with AI" tool vocabulary**

```
- move_pipeline_stage: { stage_slug } — one of new_lead, first_class, second_class, trial_done, converted, member, classpass, dormant.
```

- [ ] **Step 5: followups.js — Mia's check-in cohort**

Line 49 and the matching `.in()` at line 524 — the check-in feature targets top-of-funnel contacts; that's now the four lead columns:

```javascript
const CHECKIN_STAGES = new Set(['new_lead', 'first_class', 'second_class', 'trial_done'])
```
```javascript
      .in('pipeline_stage_slug', ['new_lead', 'first_class', 'second_class', 'trial_done'])
```

- [ ] **Step 6: Sweep for stragglers**

Run: `grep -rn "active_trial\|hot_conversion\|at_risk_member\|classpass_active\|dormant_classpass\|'lapsed'\|\"lapsed\"\|active_member" src/ shared/ mobile/ --include='*.js' --include='*.jsx' | grep -v test | grep -v pipeline-classifier.js`
Expected remaining hits after this task: only Task 7's display maps (ContactsTable, PersonHeader, StudioDashboard) and historical comments. Fix anything else found.

- [ ] **Step 7: Run sequence/trigger tests**

Run: `npm test -- sequences && npm test -- audience-filter`
Expected: PASS (audience-filter tests use slug values only as opaque strings; update any fixture that asserts a specific old slug for realism if it fails).

- [ ] **Step 8: Commit**

```bash
git add src/components/AudienceBuilder.jsx src/components/sequences/SequenceSettings.jsx src/lib/sequence-templates.js src/lib/sequences/agent/prompt.js src/lib/agent/followups.js
git commit -m "FUNNEL.1 — funnel slugs in audience filters, sequence triggers, templates, Mia followups"
```

---

### Task 7: Display maps — contacts table, person header, mobile dashboard

**Files:**
- Modify: `src/components/ContactsTable.jsx:30-40` (statusBadge map)
- Modify: `src/components/PersonHeader.jsx:17-27` (STAGE_PILL map)
- Modify: `mobile/components/dashboard/StudioDashboard.jsx:20-30` (STATUS_LABEL map)

All three fall back gracefully on unmapped slugs, but ship the real maps.

- [ ] **Step 1: ContactsTable.jsx**

```javascript
const statusBadge = {
  new_lead:     'bg-blue-500/20 text-blue-400',
  first_class:  'bg-green-500/20 text-green-400',
  second_class: 'bg-teal-500/20 text-teal-400',
  trial_done:   'bg-amber-500/20 text-amber-400',
  converted:    'bg-emerald-500/20 text-emerald-400',
  member:       'bg-slate-500/20 text-slate-400',
  classpass:    'bg-purple-500/20 text-purple-400',
  dormant:      'bg-gray-500/20 text-gray-400',
}
```

- [ ] **Step 2: PersonHeader.jsx**

```javascript
const STAGE_PILL = {
  new_lead:     'bg-blue-500/10 text-blue-700',
  first_class:  'bg-emerald-500/10 text-emerald-700',
  second_class: 'bg-teal-500/10 text-teal-700',
  trial_done:   'bg-amber-500/10 text-amber-700',
  converted:    'bg-emerald-500/10 text-emerald-700',
  member:       'bg-slate-500/10 text-slate-700',
  classpass:    'bg-purple-500/10 text-purple-700',
  dormant:      'bg-slate-500/10 text-slate-700',
}
```

- [ ] **Step 3: mobile StudioDashboard.jsx**

```javascript
const STATUS_LABEL = {
  new_lead:     'New leads',
  first_class:  '1st class',
  second_class: '2nd class',
  trial_done:   'Trial done',
  converted:    'Converted',
  member:       'Members',
  classpass:    'ClassPass',
  dormant:      'Dormant',
  unknown:      'Other',
}
```

(JS-only mobile change — OTA auto-publish on merge handles it; no `runtimeVersion` bump.)

- [ ] **Step 4: Commit**

```bash
git add src/components/ContactsTable.jsx src/components/PersonHeader.jsx mobile/components/dashboard/StudioDashboard.jsx
git commit -m "FUNNEL.1 — funnel-slug display maps (web badges/pills + mobile labels)"
```

---

### Task 8: Docs

**Files:**
- Modify: `docs/CHANGELOG.md` (new numbered entry)
- Modify: `docs/architecture/REFERENCE.md` (update any PIPELINE5 stage-list mentions — `grep -n "hot_conversion\|active_trial" docs/architecture/REFERENCE.md docs/LESSONS.md`)
- Create: `supabase/migrations/351_archive_pipeline5_stages.sql` (committed now, applied in Task 10)

- [ ] **Step 1: Write migration 344 (apply LATER — Task 10)**

```sql
-- FUNNEL.2 — archive the retired PIPELINE5 stages. Apply ONLY after the
-- post-deploy reclassify commit run (docs/superpowers/plans/
-- 2026-07-02-pipeline-acquisition-funnel.md, Task 10) — the guard below
-- refuses to run while any open deal still sits on a retired stage.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM deals d JOIN pipeline_stages ps ON ps.id = d.stage_id
   WHERE d.status = 'open'
     AND ps.slug IN ('active_trial','hot_conversion','active_member',
                     'at_risk_member','classpass_active','lapsed','dormant_classpass');
  IF n > 0 THEN
    RAISE EXCEPTION 'FUNNEL.2: % open deals still on PIPELINE5 stages — run the pipeline reclassify commit first', n;
  END IF;
END $$;

UPDATE pipeline_stages SET archived = true
 WHERE slug IN ('active_trial','hot_conversion','active_member',
                'at_risk_member','classpass_active','lapsed','dormant_classpass');
```

- [ ] **Step 2: CHANGELOG entry**

Append the next numbered entry to `docs/CHANGELOG.md` following the file's existing format, titled `FUNNEL.1 — acquisition-funnel pipeline redesign`, covering: new taxonomy + read-only board + badge, converted_at webhook stamping, migs 343/344, filter-surface updates, and the joined_at-not-lead_created_at gotcha.

- [ ] **Step 3: Update REFERENCE.md stage mentions found by the grep**

- [ ] **Step 4: Commit**

```bash
git add docs/CHANGELOG.md docs/architecture/REFERENCE.md supabase/migrations/351_archive_pipeline5_stages.sql
git commit -m "FUNNEL.1 — docs + guarded mig 351 (archive PIPELINE5 stages post-reclassify)"
```

---

### Task 9: CI mirror, build, PR

- [ ] **Step 1: Full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`
Expected: all green.

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: success. (Vitest+eslint green does NOT prove imports resolve — this catches the `nextBookedClass` import into page.js.)

- [ ] **Step 3: Push + PR**

```bash
git push -u origin HEAD
gh pr create --base main --fill
```
Report the PR URL. Pushing is not shipping — the PR is the deliverable of this task.

---

### Task 10: Post-deploy cutover (after PR merges + Vercel deploys)

- [ ] **Step 1: Confirm no active `pipeline_stage_change` sequences before the mass move**

```sql
SELECT id, name, status, trigger_config FROM email_sequences
 WHERE trigger_type = 'pipeline_stage_change' AND status = 'active';
```
Expected: 0 rows (verified 2026-07-02: the only one is a draft). The reclassify orchestrator fires this trigger per moved deal — an active sequence here would mass-enrol during the ~8.3k-deal move. If any are active, pause them for the run.

- [ ] **Step 2: Dry-run reclassify**

Admin UI: `/pipeline` → Reclassify tab → Preview (or `POST /api/admin/pipeline-reclassify` with `dryRun: true`, master role). Review the movement matrix. Expected shape at Stillorgan (from the 2026-07-02 audit; numbers will have drifted slightly): ~28 new_lead, ~24 first_class, ~15 second_class, ~12 trial_done, ~15 converted, ~1.2k member-ish → `member`, ~1.6k classpass → `classpass`, ~6.3k → `dormant`. Anything wildly off → stop and investigate before committing.

- [ ] **Step 3: Commit run**

Same surface with Commit. Verify `pipeline_classification_runs` shows `status='success'`, errors=0.

- [ ] **Step 4: Verify board + slug denormalisation**

- `/pipeline` shows the 5 funnel columns with sane counts and badges.
- `SELECT pipeline_stage_slug, count(*) FROM contacts WHERE location_id='a0000000-0000-0000-0000-000000000001' GROUP BY 1;` — only new slugs remain (trigger-synced).

- [ ] **Step 5: Apply migration 344 via MCP + advisors**

`apply_migration` name `351_archive_pipeline5_stages` (content from Task 8). The guard raises if Step 3 didn't complete. Then `get_advisors` (type=security).

- [ ] **Step 6: Live conversion smoke test**

Next real conversion (or a Glofox sandbox status flip): confirm the contact gets `converted_at` stamped and the deal moves to Converted within seconds of the `MEMBER_UPDATED` webhook (check `glofox_webhook_events` + the deal row), not at the 03:30 cron.

---

## Self-review notes

- **Spec coverage:** 5 columns ✔ (Task 1 stages + Task 2 classifier); attended-not-booked ✔ (Task 2); next-class badge on cols 1–4 ✔ (Task 5); ClassPass excluded ✔ (classifier + off-funnel stage); webhook-instant conversion ✔ (Task 3); comms/automations filters ✔ (Task 6); cleanup of old platform ✔ (drag-drop removal Task 5, slug sweeps Tasks 6–7, mig 351 Task 10).
- **Deliberately out of scope (YAGNI, agreed):** no `deals.status='won'` usage; no backfill of historical conversions beyond the 60d joined_at seed; churn radar untouched (keys on Glofox status, verified); `lead-radar.js` untouched (uses `glofox_membership_status`, not slugs).
- **Known approximation:** launch-cohort Converted column uses joined_at proxy; accurate from webhook stamping onward.
