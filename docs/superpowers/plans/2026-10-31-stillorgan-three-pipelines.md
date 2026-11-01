# Stillorgan Three Pipelines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give UN1T Stillorgan two more rule-placed pipeline boards, €39 Trial and Programmes, with one router deciding every person's board, on web and phone.

**Architecture:** Two new board modules in `shared/pipelines/` (pure rules) and one pure router that picks a board from a contact plus its *claims* (a paid trial row, a recorded programme claim). One IO module loads and records claims. The nightly orchestrator and the webhook placement path both call the router; a deal moves between boards by updating its `pipeline_id` and `stage_id` together. A migration seeds the two boards disabled, the claims table, the settings and the backfills; a second migration enables them after Richard reads a dry run.

**Tech Stack:** Next.js 16 App Router, Supabase (service role in `/api`, RLS-bound browser client on the phone), Zod, Vitest (+ PGlite for migration tests), Expo/React Native under `mobile/`.

**Spec:** `docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md`

## Global Constraints

- Stillorgan location id `a0000000-0000-0000-0000-000000000001`. Acquisition stays `is_primary`; nothing here moves `is_primary`.
- Board keys `paid_trial` and `programmes`; module names identical to the keys. Tab names "€39 Trial" and "Programmes" are row data.
- Slugs are unique per location: board 2 uses `paid_trial_new_lead`, `paid_trial_first_class`, `paid_trial_day_7`, `paid_trial_done`, `paid_trial_converted` (display_order 601–605); board 3 uses `programme_lead`, `programme_first_class`, `programme_converted` (701–703). Every new stage is `is_dormant = false`.
- Time rules: Day 7 = `start + 7 × 86_400_000 ms` (≥), Trial Done = `start + duration_days × 86_400_000 ms` (≥), where `start = granted_at ?? paid_at`. Quiet exit = 60 days (`QUIET_DAYS = 60`) measured from `max(claim end or claim start, last_attended_at, last_payment_at)`. Converted window = 60 days from `converted_at`. Instants only, never wall-clock date parsing (TZ invariant).
- Settings path `locations.settings.pipelines.programmes = { lead_sources: string[], glofox_plan_patterns: string[] }`, seeded `['meta_50plus']` and `['elites trial']`. Matching is case-insensitive; a plan pattern is a substring match. Never hard-code `meta_50plus` outside the seed and the tests.
- Every supabase write destructures `{ error }` and judges it (`check:guardrails`). Builders are thenables: `try { await … } catch {}`, never `.catch`. `.single()` only on a pk filter; otherwise `.maybeSingle()`.
- A failed claims read in the nightly run **skips placement for that run** (`ok: false`, audit row `failed`), the un1t-inputs shape. It never routes everyone to the acquisition board.
- New table: `REVOKE ALL ON public.pipeline_board_claims FROM anon, authenticated;` in the migration that creates it (`tests/table-default-acl-guard.test.js` rule 5). Service role only, RLS on, no policy.
- No new `console.log`. Logs through `logWarn`/`logError` from `@/lib/log`, ids only.
- `shared/**` and `mobile/app/**` are OTA publish paths: this PR publishes an update to staff phones on merge (the phone board picker is a real change; the shared modules are a no-op for members).
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Branch: `stillorgan-three-pipelines` off fresh `origin/main` (`git fetch origin main && git checkout -b stillorgan-three-pipelines origin/main`). `npm ci` first if `node_modules` is empty.

## Review Focus

1. **Claims unreadable on the nightly run.** `trial_purchases` or `pipeline_board_claims` fails to read → the run must stop (`ok: false`) rather than move every €39 buyer back to Acquisition. Pinned in Task 6.
2. **A €39 buyer already stamped as a pack customer** (`pack_customer_at` set, 10 credits) must land on the €39 board, not `pack_member`, and the sync must not re-stamp them while the claim is live. Pinned in Tasks 1, 7 and the migration (Task 4).
3. **Both claims live at once** (a 50+ lead who buys the €39 trial): paid wins; a Gympass or Cold reading beats both. Pinned in Task 3.
4. **Boundaries at the instant**: exactly 7 × 24 h in is Day 7; exactly `duration_days` × 24 h in is Trial Done; a member status with `converted_at` null is Converted and the claim stays live 60 days from its last activity. Pinned in Task 1.
5. **Cross-board deal move**: a contact whose open deal sits on Acquisition and who routes to the €39 board gets ONE update setting both `pipeline_id` and `stage_id`; afterwards exactly one open deal exists for them at Stillorgan. Pinned in Tasks 6 and 7.

---

### Task 1: €39 Trial board module

**Files:**
- Create: `shared/pipelines/paid-trial.js`
- Create: `shared/pipelines/paid-trial.test.js`

**Interfaces:**
- Consumes: `classifyContact`, `countAttendedBookings` from `shared/pipeline-classifier.js` (existing).
- Produces:
  - `export const QUIET_DAYS = 60`, `export const CONVERTED_WINDOW_DAYS = 60`, `export const DAY_MS = 86_400_000`.
  - `export const MEMBER_STATUSES = Object.freeze(['member', 'credit_member'])`.
  - `export const stages` — the five rows `{ slug, name, display_order, color, is_dormant: false }` in the Global Constraints order, colours `#3B82F6, #10B981, #8B5CF6, #F59E0B, #059669`.
  - `export const requiredFields` — `['id','name','email','glofox_membership_status','last_attended_at','last_payment_at','recent_bookings','converted_at','pack_customer_at','pipeline_dismissed_at','last_lead_source_at','gympass_member_id','trial_credits_remaining','joined_at','created_at','glofox_membership_state','glofox_membership_expiry','total_attended_7d','total_attended_30d']` (the acquisition set, so the router can also run `classifyContact` on the same row).
  - `export function paidTrialClaim(purchases, now)` → `{ start: number, end: number, paidAt: number, grantedAt: number|null, durationDays: number } | null`. `purchases` is this contact's `trial_purchases` rows (`{ status, payment_status, paid_at, granted_at, duration_days }`). A row counts when `status === 'granted'`, or `payment_status === 'paid'` and `status ∈ {queued, processing, needs_review}`. The newest `start` wins. `start = Date.parse(granted_at ?? paid_at)`; `end = start + (duration_days ?? 14) × DAY_MS`.
  - `export function attendedSince(contact, sinceMs)` → number of attended classes at or after `sinceMs`: `recent_bookings` entries with `attended === true` and `time_start × 1000 ≥ sinceMs`, floored at 1 when `Date.parse(last_attended_at) ≥ sinceMs`.
  - `export function convertedSince(contact, sinceMs)` → `true` when `MEMBER_STATUSES` includes `glofox_membership_status`, or `pack_customer_at` parses to `≥ sinceMs`.
  - `export function lastActivityMs(contact)` → `max(Date.parse(last_attended_at), Date.parse(last_payment_at))` or `null`.
  - `export function claimLive(claim, contact, now)` → boolean: `false` when `claim` is null; when `convertedSince(contact, claim.start)`: `now − (Date.parse(converted_at) ?? max(claim.start, lastActivityMs ?? claim.start)) < CONVERTED_WINDOW_DAYS × DAY_MS`; otherwise `now − max(claim.end, lastActivityMs(contact) ?? 0) < QUIET_DAYS × DAY_MS`.
  - `export function classify(contact, now, claim)` → slug: `paid_trial_converted` if `convertedSince(contact, claim.start)`; else `paid_trial_done` if `now ≥ claim.end`; else `paid_trial_day_7` if `now ≥ claim.start + 7 × DAY_MS`; else `paid_trial_first_class` if `attendedSince(contact, claim.start) ≥ 1`; else `paid_trial_new_lead`. Throws `TypeError` when `claim` is null (the router never calls it without one).

- [ ] **Step 1: Write the failing tests**

```js
// shared/pipelines/paid-trial.test.js
import { describe, it, expect } from 'vitest'
import { stages, requiredFields, paidTrialClaim, claimLive, classify, attendedSince, convertedSince, DAY_MS } from './paid-trial.js'

const T0 = Date.parse('2026-10-24T08:19:21Z')
const iso = (ms) => new Date(ms).toISOString()
const granted = (over = {}) => ({ status: 'granted', payment_status: 'paid', paid_at: iso(T0 - 3_600_000), granted_at: iso(T0), duration_days: 14, ...over })
const booking = (ms) => ({ status: 'BOOKED', attended: true, time_start: Math.floor(ms / 1000) })

describe('stages', () => {
  it('five on-funnel columns in order', () => {
    expect(stages.map((s) => s.slug)).toEqual(['paid_trial_new_lead', 'paid_trial_first_class', 'paid_trial_day_7', 'paid_trial_done', 'paid_trial_converted'])
    expect(stages.every((s) => s.is_dormant === false)).toBe(true)
    expect(stages.map((s) => s.display_order)).toEqual([601, 602, 603, 604, 605])
  })
  it('declares the acquisition classifier inputs', () => {
    for (const f of ['glofox_membership_status', 'recent_bookings', 'converted_at', 'pack_customer_at', 'last_payment_at', 'last_attended_at']) expect(requiredFields).toContain(f)
  })
})

describe('paidTrialClaim', () => {
  it('a granted row: start is granted_at, end is +duration', () => {
    expect(paidTrialClaim([granted()], T0)).toMatchObject({ start: T0, end: T0 + 14 * DAY_MS, durationDays: 14 })
  })
  it('paid but not granted yet (needs_review): start is paid_at', () => {
    const c = paidTrialClaim([granted({ status: 'needs_review', granted_at: null })], T0)
    expect(c.start).toBe(T0 - 3_600_000)
  })
  it('awaiting_payment, payment_failed and failed rows are not claims', () => {
    expect(paidTrialClaim([granted({ status: 'awaiting_payment', payment_status: null, paid_at: null, granted_at: null })], T0)).toBeNull()
    expect(paidTrialClaim([granted({ status: 'payment_failed', payment_status: 'failed' })], T0)).toBeNull()
    expect(paidTrialClaim([], T0)).toBeNull()
  })
  it('the newest start wins when there are several', () => {
    const c = paidTrialClaim([granted(), granted({ granted_at: iso(T0 + 40 * DAY_MS) })], T0 + 41 * DAY_MS)
    expect(c.start).toBe(T0 + 40 * DAY_MS)
  })
})

describe('classify', () => {
  const claim = paidTrialClaim([granted()], T0)
  it('day 0, nothing attended: new lead', () => {
    expect(classify({ glofox_membership_status: 'trial' }, T0 + DAY_MS, claim)).toBe('paid_trial_new_lead')
  })
  it('one class since the grant: 1st Class', () => {
    expect(classify({ glofox_membership_status: 'trial', recent_bookings: [booking(T0 + DAY_MS)], last_attended_at: iso(T0 + DAY_MS) }, T0 + 2 * DAY_MS, claim)).toBe('paid_trial_first_class')
  })
  it('a class BEFORE the grant does not count', () => {
    expect(classify({ glofox_membership_status: 'trial', recent_bookings: [booking(T0 - 5 * DAY_MS)], last_attended_at: iso(T0 - 5 * DAY_MS) }, T0 + DAY_MS, claim)).toBe('paid_trial_new_lead')
  })
  it('exactly 7 × 24h in is Day 7, trained or not', () => {
    expect(classify({ glofox_membership_status: 'trial' }, T0 + 7 * DAY_MS, claim)).toBe('paid_trial_day_7')
    expect(classify({ glofox_membership_status: 'trial', last_attended_at: iso(T0 + DAY_MS) }, T0 + 9 * DAY_MS, claim)).toBe('paid_trial_day_7')
    expect(classify({ glofox_membership_status: 'trial' }, T0 + 7 * DAY_MS - 1, claim)).toBe('paid_trial_new_lead')
  })
  it('exactly duration × 24h in is Trial Done', () => {
    expect(classify({ glofox_membership_status: 'trial' }, T0 + 14 * DAY_MS, claim)).toBe('paid_trial_done')
    expect(classify({ glofox_membership_status: 'trial' }, T0 + 14 * DAY_MS - 1, claim)).toBe('paid_trial_day_7')
  })
  it('a member status is Converted at any point, converted_at or not', () => {
    expect(classify({ glofox_membership_status: 'member', converted_at: iso(T0 + 3 * DAY_MS) }, T0 + 4 * DAY_MS, claim)).toBe('paid_trial_converted')
    expect(classify({ glofox_membership_status: 'credit_member', converted_at: null }, T0 + 20 * DAY_MS, claim)).toBe('paid_trial_converted')
  })
  it('a Class Pack bought after the grant is Converted; the 10 trial credits are not', () => {
    expect(classify({ glofox_membership_status: 'trial', pack_customer_at: iso(T0 + 16 * DAY_MS) }, T0 + 17 * DAY_MS, claim)).toBe('paid_trial_converted')
    expect(classify({ glofox_membership_status: 'trial', trial_credits_remaining: 10, pack_customer_at: iso(T0 - DAY_MS) }, T0 + DAY_MS, claim)).toBe('paid_trial_new_lead')
  })
  it('throws without a claim', () => {
    expect(() => classify({}, T0, null)).toThrow(TypeError)
  })
})

describe('claimLive', () => {
  const claim = paidTrialClaim([granted()], T0)
  it('live through the trial and for 60 quiet days after it ends', () => {
    expect(claimLive(claim, { glofox_membership_status: 'trial' }, T0 + 14 * DAY_MS + 59 * DAY_MS)).toBe(true)
    expect(claimLive(claim, { glofox_membership_status: 'trial' }, T0 + 14 * DAY_MS + 60 * DAY_MS)).toBe(false)
  })
  it('a class or payment after the end restarts the quiet clock', () => {
    const c = { glofox_membership_status: 'trial', last_attended_at: iso(T0 + 30 * DAY_MS) }
    expect(claimLive(claim, c, T0 + 30 * DAY_MS + 59 * DAY_MS)).toBe(true)
    expect(claimLive(claim, c, T0 + 30 * DAY_MS + 60 * DAY_MS)).toBe(false)
  })
  it('converted: live for 60 days from converted_at, then not', () => {
    const c = { glofox_membership_status: 'member', converted_at: iso(T0 + 5 * DAY_MS) }
    expect(claimLive(claim, c, T0 + 5 * DAY_MS + 59 * DAY_MS)).toBe(true)
    expect(claimLive(claim, c, T0 + 5 * DAY_MS + 60 * DAY_MS)).toBe(false)
  })
  it('converted with no converted_at: 60 days from the last activity', () => {
    const c = { glofox_membership_status: 'member', converted_at: null, last_payment_at: iso(T0 + 10 * DAY_MS) }
    expect(claimLive(claim, c, T0 + 10 * DAY_MS + 59 * DAY_MS)).toBe(true)
    expect(claimLive(claim, c, T0 + 10 * DAY_MS + 60 * DAY_MS)).toBe(false)
  })
  it('null claim is never live', () => { expect(claimLive(null, {}, T0)).toBe(false) })
})

describe('helpers', () => {
  it('attendedSince counts bookings at/after the instant and floors on last_attended_at', () => {
    expect(attendedSince({ recent_bookings: [booking(T0 + 1), booking(T0 - 1)] }, T0)).toBe(1)
    expect(attendedSince({ recent_bookings: [], last_attended_at: iso(T0 + 1) }, T0)).toBe(1)
    expect(attendedSince({}, T0)).toBe(0)
  })
  it('convertedSince: member status, or a pack stamp at/after the instant', () => {
    expect(convertedSince({ glofox_membership_status: 'member' }, T0)).toBe(true)
    expect(convertedSince({ pack_customer_at: iso(T0) }, T0)).toBe(true)
    expect(convertedSince({ pack_customer_at: iso(T0 - 1) }, T0)).toBe(false)
    expect(convertedSince({ glofox_membership_status: 'trial' }, T0)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/pipelines/paid-trial.test.js`
Expected: FAIL, cannot resolve `./paid-trial.js`.

- [ ] **Step 3: Implement `shared/pipelines/paid-trial.js`** with the exports in Interfaces. Pure, no IO; a header comment naming the spec and that the module only ever runs for a contact the router sent it. Note in the header that `trial_credits_remaining` and `pack_customer_at` **before** `claim.start` are ignored on purpose (the 10-credit trial is not a Class Pack).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/pipelines/paid-trial.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/pipelines/paid-trial.js shared/pipelines/paid-trial.test.js
git commit -m "PIPE3.1 — the €39 Trial board module (pure rules)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Programmes board module

**Files:**
- Create: `shared/pipelines/programmes.js`
- Create: `shared/pipelines/programmes.test.js`

**Interfaces:**
- Consumes: `attendedSince`, `convertedSince`, `lastActivityMs`, `QUIET_DAYS`, `CONVERTED_WINDOW_DAYS`, `DAY_MS` from `./paid-trial.js`.
- Produces:
  - `export const stages` — `programme_lead` "Lead" 701 `#3B82F6`, `programme_first_class` "1st Class Done" 702 `#10B981`, `programme_converted` "Converted" 703 `#059669`; all `is_dormant: false`.
  - `export const requiredFields` — the paid-trial list plus `'lead_source'`, `'last_lead_source'`, `'glofox_membership_plan'`.
  - `export function programmeClaimLive(claim, contact, now)` — `claim` is `{ claimedAt: number }` or null. `false` for null. Converted (`convertedSince(contact, claim.claimedAt)`): live while `now − (Date.parse(converted_at) ?? max(claim.claimedAt, lastActivityMs ?? claim.claimedAt)) < CONVERTED_WINDOW_DAYS × DAY_MS`. Otherwise live while `now − max(claim.claimedAt, lastActivityMs(contact) ?? 0) < QUIET_DAYS × DAY_MS`.
  - `export function classify(contact, now, claim)` → `programme_converted` if `convertedSince(contact, claim.claimedAt)`; else `programme_first_class` if `attendedSince(contact, claim.claimedAt) ≥ 1`; else `programme_lead`. Throws `TypeError` on a null claim.
  - `export function matchProgrammeSignal(contact, rules, now)` → `{ claimedAt: number, source: 'lead_source' | 'glofox_plan' } | null`. `rules = { lead_sources: string[], glofox_plan_patterns: string[] }`. Lead-source match: `last_lead_source` (or, when that is null, `lead_source`) equals a rule entry case-insensitively → `claimedAt = Date.parse(last_lead_source_at) ?? now`, source `lead_source`. Else plan match: `glofox_membership_plan` contains a pattern case-insensitively → `claimedAt = now`, source `glofox_plan`. Else null. Empty rules → null.

- [ ] **Step 1: Write the failing tests**

```js
// shared/pipelines/programmes.test.js
import { describe, it, expect } from 'vitest'
import { stages, requiredFields, classify, programmeClaimLive, matchProgrammeSignal } from './programmes.js'
import { DAY_MS } from './paid-trial.js'

const T0 = Date.parse('2026-10-31T22:28:37Z')
const iso = (ms) => new Date(ms).toISOString()
const RULES = { lead_sources: ['meta_50plus'], glofox_plan_patterns: ['elites trial'] }
const claim = { claimedAt: T0 }

describe('stages', () => {
  it('three on-funnel columns', () => {
    expect(stages.map((s) => [s.slug, s.name, s.display_order])).toEqual([
      ['programme_lead', 'Lead', 701], ['programme_first_class', '1st Class Done', 702], ['programme_converted', 'Converted', 703],
    ])
    expect(stages.every((s) => s.is_dormant === false)).toBe(true)
  })
  it('declares the matching inputs', () => {
    for (const f of ['lead_source', 'last_lead_source', 'glofox_membership_plan', 'last_lead_source_at']) expect(requiredFields).toContain(f)
  })
})

describe('matchProgrammeSignal', () => {
  it('the /50plus lead source, dated at last_lead_source_at', () => {
    expect(matchProgrammeSignal({ last_lead_source: 'meta_50plus', last_lead_source_at: iso(T0) }, RULES, T0 + 1000)).toEqual({ claimedAt: T0, source: 'lead_source' })
  })
  it('case-insensitive; falls back to lead_source when last_lead_source is null', () => {
    expect(matchProgrammeSignal({ last_lead_source: null, lead_source: 'META_50PLUS' }, RULES, T0)).toEqual({ claimedAt: T0, source: 'lead_source' })
  })
  it('the Elites Trial plan, dated now; "Elite Membership" does not match', () => {
    expect(matchProgrammeSignal({ glofox_membership_plan: 'The Elites Trial' }, RULES, T0)).toEqual({ claimedAt: T0, source: 'glofox_plan' })
    expect(matchProgrammeSignal({ glofox_membership_plan: 'Elite Membership' }, RULES, T0)).toBeNull()
    expect(matchProgrammeSignal({ glofox_membership_plan: '3 Month Elites Membership (Plan 1)' }, RULES, T0)).toBeNull()
  })
  it('a lead-source match outranks a plan match', () => {
    expect(matchProgrammeSignal({ last_lead_source: 'meta_50plus', last_lead_source_at: iso(T0 - DAY_MS), glofox_membership_plan: 'The Elites Trial' }, RULES, T0).source).toBe('lead_source')
  })
  it('empty rules match nobody', () => {
    expect(matchProgrammeSignal({ last_lead_source: 'meta_50plus' }, { lead_sources: [], glofox_plan_patterns: [] }, T0)).toBeNull()
  })
})

describe('classify', () => {
  it('lead → 1st class done → converted, counted from the claim', () => {
    expect(classify({ glofox_membership_status: 'trial' }, T0 + DAY_MS, claim)).toBe('programme_lead')
    expect(classify({ glofox_membership_status: 'trial', last_attended_at: iso(T0 + DAY_MS) }, T0 + 2 * DAY_MS, claim)).toBe('programme_first_class')
    expect(classify({ glofox_membership_status: 'trial', last_attended_at: iso(T0 - 300 * DAY_MS) }, T0 + DAY_MS, claim)).toBe('programme_lead')
    expect(classify({ glofox_membership_status: 'member', converted_at: iso(T0 + 3 * DAY_MS) }, T0 + 4 * DAY_MS, claim)).toBe('programme_converted')
  })
  it('a second class does not move them', () => {
    const b = (ms) => ({ status: 'BOOKED', attended: true, time_start: Math.floor(ms / 1000) })
    expect(classify({ recent_bookings: [b(T0 + DAY_MS), b(T0 + 3 * DAY_MS)], last_attended_at: iso(T0 + 3 * DAY_MS) }, T0 + 4 * DAY_MS, claim)).toBe('programme_first_class')
  })
  it('throws without a claim', () => { expect(() => classify({}, T0, null)).toThrow(TypeError) })
})

describe('programmeClaimLive', () => {
  it('a lead who never books falls off 60 days after the claim', () => {
    expect(programmeClaimLive(claim, {}, T0 + 59 * DAY_MS)).toBe(true)
    expect(programmeClaimLive(claim, {}, T0 + 60 * DAY_MS)).toBe(false)
  })
  it('a class restarts the clock; a 2025 claim is dead on arrival', () => {
    expect(programmeClaimLive(claim, { last_attended_at: iso(T0 + 20 * DAY_MS) }, T0 + 79 * DAY_MS)).toBe(true)
    expect(programmeClaimLive({ claimedAt: Date.parse('2025-09-05T22:09:11Z') }, {}, T0)).toBe(false)
  })
  it('converted: 60 days from converted_at', () => {
    const c = { glofox_membership_status: 'member', converted_at: iso(T0 + 5 * DAY_MS) }
    expect(programmeClaimLive(claim, c, T0 + 64 * DAY_MS)).toBe(true)
    expect(programmeClaimLive(claim, c, T0 + 65 * DAY_MS)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/pipelines/programmes.test.js`
Expected: FAIL, cannot resolve `./programmes.js`.

- [ ] **Step 3: Implement `shared/pipelines/programmes.js`** per Interfaces, importing the helpers from `./paid-trial.js`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/pipelines/programmes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/pipelines/programmes.js shared/pipelines/programmes.test.js
git commit -m "PIPE3.2 — the Programmes board module (pure rules)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The router, and registering the modules

**Files:**
- Create: `shared/pipelines/router.js`
- Create: `shared/pipelines/router.test.js`
- Modify: `shared/pipelines/index.js` (register `paid_trial`, `programmes`)
- Modify: `shared/pipelines/index.test.js` (two registration assertions)
- Modify: `src/lib/pipeline-other-studio-members.js:48` (`OWN_STUDIO_MEMBER_SLUGS`)
- Test: `src/lib/pipeline-other-studio-members.test.js` (one assertion)

**Interfaces:**
- Consumes: `classifyContact` (`shared/pipeline-classifier.js`); `paidTrialClaim`, `claimLive`, `classify as classifyPaid` (`./paid-trial.js`); `programmeClaimLive`, `classify as classifyProgramme` (`./programmes.js`).
- Produces:
  - `export const BOARD_KEYS = Object.freeze({ ACQUISITION: 'acquisition', PAID_TRIAL: 'paid_trial', PROGRAMMES: 'programmes' })`.
  - `export const CLAIM_BOARD_MODULES = Object.freeze(['paid_trial', 'programmes'])` — the modules that need claims.
  - `export function routeContact(contact, claims, now, boards)` → `{ boardKey, slug }`. `claims = { paid: <paidTrialClaim result>|null, programme: { claimedAt }|null }`. `boards` is the set of board keys enabled at the location (`Set<string>`); a claim for a board not in the set is ignored. Order: `acq = classifyContact(contact, now)`; if `acq === 'cold_lead' || acq === 'gympass'` → `{ acquisition, acq }`; if `boards.has('paid_trial') && claimLive(claims.paid, contact, now)` → `{ paid_trial, classifyPaid(contact, now, claims.paid) }`; if `boards.has('programmes') && programmeClaimLive(claims.programme, contact, now)` → `{ programmes, classifyProgramme(contact, now, claims.programme) }`; else `{ acquisition, acq }`.
- `index.js`: `BOARD_MODULES` gains `paid_trial: paidTrial`, `programmes`. The existing contract test (`stages`, `requiredFields`, `classify` non-empty) must keep passing: both modules export those names.
- `OWN_STUDIO_MEMBER_SLUGS` becomes `['converted', 'member', 'pack_member', 'paid_trial_converted', 'programme_converted']`.

- [ ] **Step 1: Write the failing tests**

```js
// shared/pipelines/router.test.js
import { describe, it, expect } from 'vitest'
import { routeContact, BOARD_KEYS } from './router.js'
import { paidTrialClaim, DAY_MS } from './paid-trial.js'

const T0 = Date.parse('2026-10-30T19:44:05Z')
const iso = (ms) => new Date(ms).toISOString()
const ALL = new Set(['acquisition', 'paid_trial', 'programmes'])
const paid = paidTrialClaim([{ status: 'granted', payment_status: 'paid', paid_at: iso(T0), granted_at: iso(T0), duration_days: 14 }], T0)
const programme = { claimedAt: T0 }
const trialer = { glofox_membership_status: 'trial', joined_at: iso(T0), trial_credits_remaining: 10, pack_customer_at: iso(T0 + 1000) }

describe('routeContact', () => {
  it('no claims: the acquisition board, classifyContact\'s slug', () => {
    expect(routeContact({ glofox_membership_status: 'lead', joined_at: iso(T0) }, { paid: null, programme: null }, T0 + DAY_MS, ALL)).toEqual({ boardKey: 'acquisition', slug: 'new_lead' })
  })
  it('a live paid claim wins over the acquisition pack reading (the 10-credit buyer)', () => {
    expect(routeContact(trialer, { paid, programme: null }, T0 + DAY_MS, ALL)).toEqual({ boardKey: 'paid_trial', slug: 'paid_trial_new_lead' })
  })
  it('paid outranks programme when both are live', () => {
    expect(routeContact(trialer, { paid, programme }, T0 + DAY_MS, ALL).boardKey).toBe('paid_trial')
  })
  it('a live programme claim alone goes to Programmes', () => {
    expect(routeContact({ glofox_membership_status: 'trial', joined_at: iso(T0) }, { paid: null, programme }, T0 + DAY_MS, ALL)).toEqual({ boardKey: 'programmes', slug: 'programme_lead' })
  })
  it('Cold beats every claim', () => {
    const cold = { ...trialer, pack_customer_at: null, trial_credits_remaining: 0, pipeline_dismissed_at: iso(T0 + 2 * DAY_MS) }
    expect(routeContact(cold, { paid, programme }, T0 + 3 * DAY_MS, ALL)).toEqual({ boardKey: 'acquisition', slug: 'cold_lead' })
  })
  it('a public re-entry after the dismissal revokes Cold and the claim applies again', () => {
    const back = { ...trialer, pack_customer_at: null, pipeline_dismissed_at: iso(T0 + 2 * DAY_MS), last_lead_source_at: iso(T0 + 3 * DAY_MS) }
    expect(routeContact(back, { paid, programme: null }, T0 + 4 * DAY_MS, ALL).boardKey).toBe('paid_trial')
  })
  it('Gympass beats every claim', () => {
    expect(routeContact({ glofox_membership_status: 'trial', gympass_member_id: 'g1' }, { paid, programme }, T0 + DAY_MS, ALL)).toEqual({ boardKey: 'acquisition', slug: 'gympass' })
  })
  it('an expired claim falls back to acquisition (dormant after the quiet spell)', () => {
    expect(routeContact({ glofox_membership_status: 'trial', joined_at: iso(T0) }, { paid, programme: null }, T0 + 80 * DAY_MS, ALL).boardKey).toBe('acquisition')
  })
  it('a claim for a board the location does not run is ignored', () => {
    expect(routeContact(trialer, { paid, programme }, T0 + DAY_MS, new Set(['acquisition'])).boardKey).toBe('acquisition')
    expect(routeContact(trialer, { paid, programme }, T0 + DAY_MS, new Set(['acquisition', 'programmes'])).boardKey).toBe('programmes')
  })
  it('exports the three keys', () => { expect(Object.values(BOARD_KEYS).sort()).toEqual(['acquisition', 'paid_trial', 'programmes']) })
})
```

Add to `shared/pipelines/index.test.js`:

```js
it('registers paid_trial and programmes as contacts-input modules', () => {
  expect(getBoardModule('paid_trial')?.inputSource).toBeUndefined()
  expect(getBoardModule('programmes')?.stages.map((s) => s.slug)).toEqual(['programme_lead', 'programme_first_class', 'programme_converted'])
})
```

Add to `src/lib/pipeline-other-studio-members.test.js`:

```js
it('a person converted on the €39 or Programmes board is kept here', () => {
  expect(leavesBoard('paid_trial_converted', true)).toBe(false)
  expect(leavesBoard('programme_converted', true)).toBe(false)
  expect(leavesBoard('paid_trial_day_7', true)).toBe(true)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/pipelines src/lib/pipeline-other-studio-members.test.js`
Expected: FAIL (router missing, modules unregistered, slugs not kept).

- [ ] **Step 3: Implement `shared/pipelines/router.js`**, register both modules in `index.js`, extend `OWN_STUDIO_MEMBER_SLUGS`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/pipelines src/lib/pipeline-other-studio-members.test.js tests/shared-pair-sync.test.js`
Expected: PASS (the pair-sync test has no `src/lib` twin for the new files, so it stays green).

- [ ] **Step 5: Commit**

```bash
git add shared/pipelines/router.js shared/pipelines/router.test.js shared/pipelines/index.js shared/pipelines/index.test.js src/lib/pipeline-other-studio-members.js src/lib/pipeline-other-studio-members.test.js
git commit -m "PIPE3.3 — one router decides a Stillorgan contact's board" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Migrations 797 (seed, disabled) and 798 (enable)

**Files:**
- Create: `supabase/migrations/797_stillorgan_three_pipelines.sql`
- Create: `supabase/migrations/798_stillorgan_three_pipelines_enable.sql`
- Create: `tests/migration-797-stillorgan-three-pipelines.test.js`

**Interfaces:**
- Produces table `public.pipeline_board_claims (contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE, board_key text NOT NULL, claimed_at timestamptz NOT NULL, source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (contact_id, location_id, board_key))`, index on `(location_id, board_key)`, `ENABLE ROW LEVEL SECURITY`, `REVOKE ALL … FROM anon, authenticated`, a `COMMENT ON TABLE` naming the spec. (Task 5 reads and upserts it.)
- Produces two `pipelines` rows at Stillorgan: `('paid_trial', '€39 Trial', 'paid_trial', 'derived', false, 1, false)` and `('programmes', 'Programmes', 'programmes', 'derived', false, 2, false)` — columns `(key, name, module, mode, is_primary, display_order, enabled)`; `ON CONFLICT (location_id, key) DO UPDATE SET module = EXCLUDED.module, mode = 'derived'` (never touches `enabled` or `is_primary` on a re-run). Stage rows per module from Tasks 1–2 (`location_id, pipeline_id, name, slug, display_order, color, is_dormant, archived`), `ON CONFLICT (location_id, slug) DO NOTHING`, then `COUNT` = 5 and 3 or raise.
- Settings seed: `UPDATE locations SET settings = jsonb_set(coalesce(settings,'{}'), '{pipelines}', coalesce(settings->'pipelines','{}') || jsonb_build_object('programmes', jsonb_build_object('lead_sources', jsonb_build_array('meta_50plus'), 'glofox_plan_patterns', jsonb_build_array('elites trial')))) WHERE id = <Stillorgan> AND (settings->'pipelines'->'programmes') IS NULL` (seed only when absent).
- Backfill claims (`board_key = 'programmes'`) for Stillorgan-home contacts: `last_lead_source = 'meta_50plus'` → `claimed_at = last_lead_source_at`, source `lead_source`; else `glofox_membership_plan ILIKE '%elites trial%'` → `claimed_at = coalesce(joined_at, created_at)`, source `glofox_plan`. `ON CONFLICT DO NOTHING`.
- Pack stamp clear: `UPDATE contacts c SET pack_customer_at = NULL FROM trial_purchases tp WHERE tp.contact_id = c.id AND tp.location_id = <Stillorgan> AND tp.status = 'granted' AND c.pack_customer_at IS NOT NULL AND c.pack_customer_at >= tp.paid_at`.
- Self-check (`DO $$`): Stillorgan has exactly one enabled primary and it is `acquisition`; both new rows exist disabled; stage counts 5 and 3; no `pipelines` row outside Stillorgan changed (hash before/after as mig 741); no `deals` row changed. First line comment: `-- grant: pipeline_board_claims is service role only (REVOKE below)`.
- 798: `UPDATE pipelines SET enabled = true WHERE location_id = <Stillorgan> AND key IN ('paid_trial','programmes')`; self-check: three enabled boards at Stillorgan, acquisition still the one primary, nothing else changed. Header comment: **apply only after the dry run (spec, Rollout step 3)**.

- [ ] **Step 1: Write the failing PGlite test** `tests/migration-797-stillorgan-three-pipelines.test.js`, copying the harness of `tests/migration-741-hatch-pipeline-tab-order.test.js` (schema fixture: `locations` with a `settings jsonb` column, `pipelines` with mig 594's constraints, `pipeline_stages` with `(location_id, slug)` and `(pipeline_id, name)` unique constraints plus `color`, `is_dormant`, `archived`; `contacts` with `location_id, last_lead_source, last_lead_source_at, glofox_membership_plan, joined_at, created_at, pack_customer_at`; `trial_purchases` with `contact_id, location_id, status, paid_at`; `deals`). Fixture rows: Stillorgan acquisition (primary, enabled) and returning (disabled); Hatch waitlist (primary) + acquisition; one contact with `last_lead_source 'meta_50plus'`; one with plan `'The Elites Trial'` joined 2025-09-05; one with plan `'Elite Membership'`; one €39 buyer with `pack_customer_at` after `paid_at` and a granted purchase; one pack customer with no purchase. Tests:

```js
describe('mig 797 — static', () => {
  it('creates pipeline_board_claims closed to clients (REVOKE … FROM anon, authenticated; RLS on)', …)
  it('never assigns is_primary and inserts the two boards disabled', …)
})
describe('mig 797 — behaviour (PGlite)', () => {
  it('adds €39 Trial (display_order 1) and Programmes (2) at Stillorgan, disabled, derived, not primary', …)
  it('seeds 5 + 3 stage rows with the module slugs and display orders 601–605 / 701–703', …)
  it('seeds settings.pipelines.programmes once and keeps it on a re-run', …)   // run twice; a hand-edited list survives
  it('backfills a programmes claim for the meta_50plus lead (at last_lead_source_at) and the Elites Trial holder (at joined_at), not the Elite Membership member', …)
  it('clears pack_customer_at on the granted €39 buyer only', …)
  it('touches no Hatch row and no deals row', …)
  it('is idempotent', …)
  it('raises and rolls back when Stillorgan has no enabled primary acquisition board', …)
})
describe('mig 798', () => {
  it('enables exactly the two boards; acquisition stays the one primary; raises when a board is missing', …)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/migration-797-stillorgan-three-pipelines.test.js`
Expected: FAIL (files missing).

- [ ] **Step 3: Write both migrations** per Interfaces, in the mig 597/741 house style (one `DO $$` transaction, counted inserts, hash self-checks, idempotent).

- [ ] **Step 4: Run the test and the schema guards**

Run: `npx vitest run tests/migration-797-stillorgan-three-pipelines.test.js tests/table-default-acl-guard.test.js tests/function-execute-guard.test.js tests/scheduling-client-grants-guard.test.js && npm run check:select-columns && npm run check:rls-restrictive`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/797_stillorgan_three_pipelines.sql supabase/migrations/798_stillorgan_three_pipelines_enable.sql tests/migration-797-stillorgan-three-pipelines.test.js
git commit -m "PIPE3.4 — migs 797/798: the two Stillorgan boards, claims table, seeds and backfills" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Claims IO

**Files:**
- Create: `src/lib/pipeline-claims.js`
- Create: `src/lib/pipeline-claims.test.js`

**Interfaces:**
- Consumes: `paidTrialClaim` (`shared/pipelines/paid-trial.js`), `matchProgrammeSignal` (`shared/pipelines/programmes.js`), `logWarn` (`@/lib/log`), `selectAllByKeys` (`./select-all.js`, existing: chunked `.in()` reads).
- Produces:
  - `export const PROGRAMME_RULES_PATH = ['pipelines', 'programmes']`.
  - `export function programmeRulesFromSettings(settings)` → `{ lead_sources: string[], glofox_plan_patterns: string[] }`, lower-cased, trimmed, empties dropped; `{ lead_sources: [], glofox_plan_patterns: [] }` when absent or malformed.
  - `export async function loadBoardsForLocation(db, locationId)` → `{ ok: true, boards: Array<{ id, key, module, mode, enabled, is_primary }> } | { ok: false, reason: 'boards_unreadable', err }` — enabled rows only.
  - `export async function loadClaimsForLocation(db, { locationId, contactIds, now, rules })` → `{ ok: true, paidByContact: Map<string, claim>, programmeByContact: Map<string, { claimedAt, source }> } | { ok: false, reason: 'purchases_unreadable' | 'claims_unreadable', err }`. Reads `trial_purchases` (`contact_id, status, payment_status, paid_at, granted_at, duration_days`) `.eq('location_id', locationId)` paged with `.range()` + `.order('id')`, keeps rows whose `contact_id ∈ contactIds`; reads `pipeline_board_claims` (`contact_id, claimed_at, source`) `.eq('location_id', …).eq('board_key','programmes')` the same way.
  - `export function pendingProgrammeClaims(contacts, programmeByContact, rules, now)` → `Array<{ contact_id, location_id?, claimed_at: iso, source }>` — for each contact with no claim, or whose `matchProgrammeSignal` gives a `lead_source` claim with `claimedAt` newer than the stored one, the row to upsert. Pure.
  - `export async function upsertProgrammeClaims(db, locationId, rows)` → `{ ok, written, error? }`; `.upsert([...], { onConflict: 'contact_id,location_id,board_key' })` in chunks of 500, each row `{ contact_id, location_id, board_key: 'programmes', claimed_at, source, updated_at: now }`.
  - `export async function loadClaimsForContact(db, { locationId, contactId, contact, now, rules, write = true })` → `{ ok: true, claims: { paid, programme } } | { ok: false, reason }`. Reads this contact's purchases and claim row (`.eq('contact_id', …)`), computes `paidTrialClaim`, applies `pendingProgrammeClaims([contact], …)`; when `write` and a pending row exists, upserts it and returns the new claim.
  - `export async function loadProgrammeRules(db, locationId)` → `{ ok: true, rules } | { ok: false, reason: 'settings_unreadable' }` from `locations.settings`.

- [ ] **Step 1: Write the failing tests** (`src/lib/pipeline-claims.test.js`, a fluent fake db in the style of `pipeline-reclassify.test.js`'s `fakeDb`): `programmeRulesFromSettings` on absent / malformed / mixed-case input; `loadClaimsForLocation` keeps only purchases for the given contact ids and answers `{ ok: false, reason: 'purchases_unreadable' }` on a read error (and `claims_unreadable` for the second read); `pendingProgrammeClaims` yields a row for a new `meta_50plus` match, renews a stored claim when `last_lead_source_at` is newer, yields nothing for a plan match that already has a claim, and nothing for `Elite Membership`; `upsertProgrammeClaims` upserts on `contact_id,location_id,board_key` and returns `{ ok: false }` with the error; `loadClaimsForContact` writes the pending claim when `write` is true and never when false.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/pipeline-claims.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/pipeline-claims.js`** per Interfaces. Every write destructures `error`. Log through `logWarn('pipeline-claims', …, { locationId, reason })`, ids only.

- [ ] **Step 4: Run the tests and the guardrails**

Run: `npx vitest run src/lib/pipeline-claims.test.js && npm run check:guardrails && npm run check:select-columns`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline-claims.js src/lib/pipeline-claims.test.js
git commit -m "PIPE3.5 — claims IO: paid-trial rows and recorded programme claims" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The nightly orchestrator routes across boards

**Files:**
- Modify: `src/lib/pipeline-reclassify.js` (steps 1b, 3, 5, 6; `EXCLUDING_MODULES` at line 952; `DRY_RUN_DISABLED_MODULE` use)
- Modify: `src/app/api/admin/pipeline-reclassify/route.js:40` (`include_disabled` enum)
- Test: `src/lib/pipeline-reclassify.test.js`
- Test: `src/app/api/admin/pipeline-reclassify/route.test.js` (if present; else skip the route test and rely on the schema line)

**Interfaces:**
- Consumes: `routeContact`, `CLAIM_BOARD_MODULES` (`shared/pipelines/router.js`); `loadClaimsForLocation`, `loadProgrammeRules`, `pendingProgrammeClaims`, `upsertProgrammeClaims` (`./pipeline-claims.js`).
- Produces: behaviour of `reclassifyAllContacts` on the contacts path:
  - `selectColsFor` unions every active module's `requiredFields` (unchanged); the three Stillorgan modules together add `lead_source, last_lead_source, glofox_membership_plan, last_payment_at`.
  - When any active module is in `CLAIM_BOARD_MODULES`: load rules (`loadProgrammeRules`) and claims (`loadClaimsForLocation`) after the contacts page read. A `{ ok: false }` from either → `markRun(failed, 'claims unavailable: <reason>')`, return `{ ok: false, error, run_id, pipelines_skipped }`, no deal write.
  - Real runs upsert `pendingProgrammeClaims` **before** routing and use the renewed claims; dry runs apply them in memory only and report `claims_pending: n`.
  - Per contact: `const { boardKey, slug } = routeContact(contact, claims, nowMs, activeBoardKeys)`; `targetStageId = stageIdBySlug.get(slug)`; a slug with no stage at the location counts as an error (unchanged).
  - A move whose target stage belongs to a different `pipeline_id` than the existing deal's writes `{ stage_id, pipeline_id }` in one update; the move record carries `from_board`/`to_board` keys, and `movement_matrix` keys stay slugs. Result gains `boards_moved: n` (deals that changed board).
  - Dry run result gains `board_histogram: { [boardKey]: n }`.
  - `EXCLUDING_MODULES` = `new Set(['acquisition', 'acquisition_un1t', 'paid_trial', 'programmes'])`.
  - `includeDisabled`: a disabled row whose own `module` is registered is dry-run as that module; only an unregistered/absent module falls back to `acquisition_un1t`. The admin route's `include_disabled` is `z.array(z.enum(['acquisition', 'paid_trial', 'programmes']))`.
  - The deals read (step 4) must select `pipeline_id` too (`'id, contact_id, stage_id, pipeline_id'`).

- [ ] **Step 1: Write the failing tests** in `src/lib/pipeline-reclassify.test.js`, a new `describe('PIPE3 — three boards at one location')` with a `fakeDb` extended to serve `trial_purchases`, `pipeline_board_claims` (reads and upserts into `writes.all`) and `locations` (`settings`). Fixture: the three Stillorgan pipelines rows, acquisition stages plus the eight new stage rows (`pipeline_id` 'p-paid' / 'p-prog'), and contacts:
  - a 10-credit trialer with a granted purchase 2 days ago, open deal at `pack_member` → one update with `{ stage_id: 'stage-pt-new', pipeline_id: 'p-paid' }`, `boards_moved: 1`;
  - a `meta_50plus` lead with no claim row → real run upserts a `programmes` claim then creates a deal at `programme_lead` with `pipeline_id: 'p-prog'`; dry run writes nothing and reports `claims_pending: 1`;
  - a plain lead → stays on acquisition `new_lead` (unchanged count);
  - `trial_purchases` read error → result `{ ok: false, error: /claims unavailable: purchases_unreadable/ }`, the audit row marked failed, zero deal writes;
  - a dry run returns `board_histogram` `{ acquisition: 1, paid_trial: 1, programmes: 1 }`;
  - `includeDisabled: ['paid_trial']` with the paid row disabled dry-runs it as `paid_trial` (the histogram shows `paid_trial`), while `['acquisition']` at a un1t fixture still maps to `acquisition_un1t` (the existing test keeps passing).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/pipeline-reclassify.test.js`
Expected: the new describe FAILS; the rest PASS.

- [ ] **Step 3: Implement** in `pipeline-reclassify.js`: the claims load, the router call in step 5 in place of the inline `classifyContact({...})` for the contacts path (keep the un1t path untouched), the two-column move, the generalised `includeDisabled`, `EXCLUDING_MODULES`. Update the admin route schema.

- [ ] **Step 4: Run the full file and guardrails**

Run: `npx vitest run src/lib/pipeline-reclassify.test.js src/lib/pipeline-other-studio-members.test.js && npm run check:guardrails && npm run check:select-columns`
Expected: PASS, every pre-existing test unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline-reclassify.js src/lib/pipeline-reclassify.test.js src/app/api/admin/pipeline-reclassify/route.js
git commit -m "PIPE3.6 — the nightly run routes each contact to one of three boards" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The webhook path, the Cold route and the pack stamp

**Files:**
- Modify: `src/lib/glofox-sync.js` — `shouldStampPackCustomer` (line 1094), `ensureDealForContact` (line 528), the webhook `SELECT_COLS` (line 1256), the snapshot built before `ensureDealForContact` (≈line 2330)
- Modify: `src/app/api/contacts/[id]/pipeline-status/route.js:46` (`SNAPSHOT_COLS`)
- Create: `src/lib/pipeline-place-now.js`
- Modify: `src/lib/trial-purchase-processor.js` (after the `granted` stamp, ≈line 213)
- Modify: `src/app/api/public/class-booking/route.js` (after `placeWaitlistEntry`, line 374)
- Test: `src/lib/glofox-sync.test.js`, `src/lib/pipeline-place-now.test.js`, `src/lib/trial-purchase-processor.test.js`

**Interfaces:**
- `shouldStampPackCustomer({ newStatus, credits, existingPackCustomerAt, liveTrialClaim = false })` → `false` when `liveTrialClaim` is true.
- `ensureDealForContact(db, locationId, contactId, contactSnapshot, contactName = null, opts = {})`, `opts` gains `claims` (`{ paid, programme }`, pre-loaded by the caller) and `now`. Behaviour: `loadBoardsForLocation`; if no enabled derived primary → `leave` (unchanged). If any enabled board's module is in `CLAIM_BOARD_MODULES`: claims = `opts.claims ?? (await loadClaimsForContact(db, { locationId, contactId, contact: contactSnapshot, now, rules, write: true })).claims` (rules via `loadProgrammeRules`; an `{ ok: false }` from either → `{ action: 'error', error: 'claims unavailable: <reason>' }`, nothing written); `{ boardKey, slug } = routeContact(...)`; target board = the enabled row with that key. Otherwise today's path exactly (`classifyContact`, primary board). `existing` = the contact's newest open deal at the location on ANY enabled board (`findOpenDealAtLocation(db, contactId, locationId)` — add to `src/lib/deal-lookup.js`: same shape as `findOpenDealForPipeline`, filtered on `location_id`, returning `{ id, stage_id, pipeline_id }`). A move to a stage on another board writes `{ stage_id, pipeline_id }`; the result carries `pipeline_id` of the TARGET board, plus `from_board`, `to_board`.
- `applyMemberSync` loads `loadClaimsForContact` once (when the location runs a claim board), passes `liveTrialClaim: claimLive(claims.paid, snapshot, now)` into `shouldStampPackCustomer` and `claims` into `ensureDealForContact`. The snapshot gains `last_lead_source`, `lead_source`, `glofox_membership_plan`, `location_id`; `SELECT_COLS` gains `last_lead_source, glofox_membership_plan`.
- `SNAPSHOT_COLS` in the Cold route becomes the acquisition `requiredFields` plus `location_id, lead_source, last_lead_source, glofox_membership_plan, last_payment_at` (read it from the module: `getBoardModule('programmes').requiredFields` + `location_id`).
- `src/lib/pipeline-place-now.js`: `export async function placeContactNow(db, { locationId, contactId, now = Date.now() })` → `{ ok: true, deal } | { ok: false, reason }`. Reads the contact with the Cold route's column list by id (`.maybeSingle()`), calls `ensureDealForContact`, never throws (logs `logWarn('pipeline-place-now', …)`). Called best-effort (own `try/catch`) by `processTrialPurchase` right after the `granted` stamp lands and by the class-booking route right after `placeWaitlistEntry`.

- [ ] **Step 1: Write the failing tests**
  - `glofox-sync.test.js`: `shouldStampPackCustomer({ newStatus: 'trial', credits: 10, existingPackCustomerAt: null, liveTrialClaim: true })` is `false`, and `true` with `liveTrialClaim: false`; a new `describe('ensureDealForContact — three boards (PIPE3)')` with a `boardDb` serving three enabled pipelines (`acquisition` primary + `paid_trial` + `programmes`), stage lookups for both slug sets, a `trial_purchases` granted row and an empty claims table: (a) a trialer with an open deal on `p-acq` moves with `update({ stage_id: 's-pt-new', pipeline_id: 'p-paid' })` and the result is `{ action: 'move', pipeline_id: 'p-paid', from_board: 'acquisition', to_board: 'paid_trial', … }`; (b) a contact with no deal and a `meta_50plus` lead source gets a claim upsert then a deal insert with `pipeline_id: 'p-prog'`; (c) `trial_purchases` unreadable → `{ action: 'error', error: 'claims unavailable: purchases_unreadable' }` and no deals write; (d) a location with only the acquisition board issues no `trial_purchases` read (today's path).
  - `pipeline-place-now.test.js`: reads the contact by id, calls `ensureDealForContact` (mocked) with `locationId`, returns `{ ok: false, reason: 'contact_unreadable' }` on a read error without throwing.
  - `trial-purchase-processor.test.js`: after a successful grant `placeContactNow` (mocked) is called once with `{ locationId: row.location_id, contactId: row.contact_id }`; a thrown placement does not change the `{ outcome: 'granted' }` result.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/glofox-sync.test.js src/lib/pipeline-place-now.test.js src/lib/trial-purchase-processor.test.js`
Expected: new tests FAIL.

- [ ] **Step 3: Implement** per Interfaces. In the class-booking route, call `placeContactNow` inside its own `try/catch` after line 374's placement (one `logWarn('classbook', 'board placement failed', { err })` on failure).

- [ ] **Step 4: Run the tests, the route guard and the guardrails**

Run: `npx vitest run src/lib/glofox-sync.test.js src/lib/pipeline-place-now.test.js src/lib/trial-purchase-processor.test.js src/app/api/contacts && npm run check:guardrails && npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/glofox-sync.js src/lib/glofox-sync.test.js src/lib/deal-lookup.js src/lib/pipeline-place-now.js src/lib/pipeline-place-now.test.js src/lib/trial-purchase-processor.js src/lib/trial-purchase-processor.test.js 'src/app/api/contacts/[id]/pipeline-status/route.js' src/app/api/public/class-booking/route.js
git commit -m "PIPE3.7 — webhook, Cold and grant paths place through the router; the trial's credits are never a pack" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The programme rules setting (route + card)

**Files:**
- Create: `src/app/api/locations/[id]/pipeline-programmes/route.js`
- Create: `src/app/api/locations/[id]/pipeline-programmes/route.test.js`
- Create: `src/components/settings/ProgrammeBoardRulesCard.jsx`
- Modify: `src/app/settings/locations/[id]/page.js` (render the card on Details after `PayrollLieuCard`)
- Modify: `src/lib/openapi.js` (register GET/PUT, next to the payroll block at ≈line 6965)

**Interfaces:**
- Route, the payroll route's shape: `GET` → `{ success: true, data: { has_board: boolean, lead_sources: string[], glofox_plan_patterns: string[], can_edit } }` (`has_board` = an enabled or disabled `pipelines` row with `key = 'programmes'` exists at the location); any member reads. `PUT` body `ProgrammeRulesSchema = z.object({ lead_sources: z.array(z.string().trim().min(1).max(80)).max(20), glofox_plan_patterns: z.array(z.string().trim().min(1).max(80)).max(20) })`; `assertLocationAccess` then `guardMasterOrOwner`; writes through `mergeLocationSettings(db, locationId, (current) => ({ ...current, pipelines: { ...(current.pipelines || {}), programmes: { lead_sources, glofox_plan_patterns } } }), { scope: 'pipeline-programmes' })`. Values stored lower-cased and trimmed via `programmeRulesFromSettings` on read.
- Card: `ProgrammeBoardRulesCard({ locationId })`, the `PayrollLieuCard` pattern; renders nothing when `has_board` is false; two tag-list inputs (comma or newline separated text areas are fine); copy: title "Programmes board", body "Leads from these landing-page sources, or whose Glofox profile carries one of these trial plans, are placed on the Programmes board instead of the Acquisition board. Add the /postnatal page's lead source here when it goes live."

- [ ] **Step 1: Write the failing route test** (the shape of `src/app/api/locations/[id]/payroll/route.test.js` if it exists, else the geofence route test): GET returns the seeded lists and `has_board`; PUT by a manager → 403; PUT by an owner lower-cases and stores both lists through `mergeLocationSettings` (mock) and echoes them; PUT with 21 entries → 400.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run 'src/app/api/locations/[id]/pipeline-programmes'`
Expected: FAIL (route missing).

- [ ] **Step 3: Implement the route, the card, the page mount and the openapi registration.**

- [ ] **Step 4: Run the tests and the gates**

Run: `npx vitest run 'src/app/api/locations/[id]/pipeline-programmes' tests/location-settings-writers.test.js && npm run check:route-guards && npm run check:location-scoping && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/locations/[id]/pipeline-programmes' src/components/settings/ProgrammeBoardRulesCard.jsx 'src/app/settings/locations/[id]/page.js' src/lib/openapi.js
git commit -m "PIPE3.8 — the Programmes board's lead sources and plan names are a studio setting" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Web labels, colours and the view toggle

**Files:**
- Modify: `src/components/KanbanBoard.jsx:12` (`stageColors`: the eight new slugs with the module colours)
- Modify: `src/components/AudienceBuilder.jsx:43` (`STAGE_LABELS`: `paid_trial_new_lead: '€39 trial: new lead'`, `paid_trial_first_class: '€39 trial: 1st class'`, `paid_trial_day_7: '€39 trial: day 7'`, `paid_trial_done: '€39 trial: done'`, `paid_trial_converted: '€39 trial: converted'`, `programme_lead: 'Programme: lead'`, `programme_first_class: 'Programme: 1st class done'`, `programme_converted: 'Programme: converted'`)
- Modify: `src/components/PipelineReclassifyTab.jsx:25` (same eight labels, board-style casing: '€39 Trial — New Leads' etc.)
- Modify: `src/components/ContactsTable.jsx:31` (`statusBadge` entries for the eight slugs: blue/green/violet/amber/emerald for paid, blue/green/emerald for programme, `-500/20` + `-700` pairs)
- Modify: `src/app/(sales)/pipeline/page.js` and `src/components/PipelineViewSwitcher.jsx`: the view row renders only when `dormantStages.length > 0` (a derived board with no off-funnel stages behaves like a manual one for the toggle; `?view=dormant` on such a board falls back to `active`)
- Test: `src/components/KanbanBoard.test.jsx`, `src/components/PipelineViewSwitcher.test.jsx` (or `src/app/(sales)/pipeline/page.test.js` if that is where the toggle is pinned)

- [ ] **Step 1: Write the failing tests**: every slug in `getBoardModule('paid_trial').stages` and `getBoardModule('programmes').stages` has an entry in `stageColors` (export it or test through the rendered dot colour), in `AudienceBuilder`'s `STAGE_LABELS` (export the map) and in `ContactsTable`'s `statusBadge` (export it); the view switcher draws no view row when given `dormantCount`/stages empty for a derived board.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/KanbanBoard.test.jsx src/components/PipelineViewSwitcher.test.jsx src/components/AudienceBuilder.test.jsx src/components/ContactsTable.test.jsx`
Expected: new tests FAIL.

- [ ] **Step 3: Implement** the four maps and the toggle rule.

- [ ] **Step 4: Run the tests and lint**

Run: `npx vitest run src/components && npm run lint && npm run check:guardrails`
Expected: PASS (`no-low-contrast-chip` accepts `-500/20 text-*-700`).

- [ ] **Step 5: Commit**

```bash
git add src/components/KanbanBoard.jsx src/components/AudienceBuilder.jsx src/components/PipelineReclassifyTab.jsx src/components/ContactsTable.jsx 'src/app/(sales)/pipeline/page.js' src/components/PipelineViewSwitcher.jsx src/components/*.test.jsx
git commit -m "PIPE3.9 — the new stages have names, colours and chips everywhere a slug is shown" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The phone shows the location's boards

**Files:**
- Modify: `mobile/lib/pipeline-api.js` — `listStagesForPipeline` selects `is_dormant` too
- Modify: `mobile/app/(staff)/(tabs)/pipeline.jsx` — board picker
- Test: `mobile/lib/pipeline-api.test.js`

**Interfaces:**
- `pipeline.jsx`: on load call `listPipelines(activeLocation.id)`; when it succeeds with ≥ 1 row, hold `boards` and `selectedBoardId` (first row, by `display_order`) and read stages with `listStagesForPipeline(selectedBoardId)`; when it fails or returns no rows, fall back to `listStages(activeLocation.id)` exactly as today (a disabled-only studio keeps its screen). Render a `Tabs` row of boards above the Funnel/Off-funnel row only when `boards.length > 1`; render the Funnel/Off-funnel row only when `offFunnel.length > 0`. Switching board resets `view` to `'funnel'` and `selectedId` to null.

- [ ] **Step 1: Write the failing test** in `mobile/lib/pipeline-api.test.js`: `listStagesForPipeline('p1')` selects a string containing `is_dormant` and filters `pipeline_id = 'p1'` and `archived = false` (mock `supabase.from` chain, the file's existing idiom).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run mobile/lib/pipeline-api.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** the select change and the board picker in `pipeline.jsx`.

- [ ] **Step 4: Run the mobile gates**

Run: `npx vitest run mobile/lib/pipeline-api.test.js && npm run check:mobile-lint && npm run check:mobile-imports && npm run check:mobile-parity && npm run check:ota-paths`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/pipeline-api.js mobile/lib/pipeline-api.test.js 'mobile/app/(staff)/(tabs)/pipeline.jsx'
git commit -m "PIPE3.10 — the phone's pipeline tab shows every board at the studio" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Docs, the CI mirror, the PR and the rollout

**Files:**
- Modify: `docs/architecture/REFERENCE.md` (the "Audience classification model" / pipeline section ≈line 174: a paragraph on the three Stillorgan boards, claims, and the router)
- Modify: `CLAUDE.md` (one invariant line under "Conventions that bite": every Stillorgan placement path calls `routeContact` through `ensureDealForContact` or the orchestrator, never `classifyContact()` for placement; the €39 trial's credits are never a Class Pack while the claim is live)
- Add: `docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md` and this plan (commit them)
- Create after `gh pr create`: `docs/changelog/entries/<PR>.md` — one row `| #<PR> | PIPE3.1 — Stillorgan: €39 Trial and Programmes boards | 2026-10-31. … |`

- [ ] **Step 1: Write the docs changes and commit the spec and plan**

```bash
git add docs/architecture/REFERENCE.md CLAUDE.md docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md docs/superpowers/plans/2026-10-31-stillorgan-three-pipelines.md
git commit -m "PIPE3.11 — docs: the three-board router and its invariant" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: Run the CI mirror once** (never beside a build on this machine):

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths
```
Expected: every command exits 0. Then `npm run build` on its own. Expected: exit 0.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "PIPE3 — Stillorgan: €39 Trial and Programmes pipeline boards" --body-file <a body naming the spec, migs 797/798 and the rollout order, ending with "🤖 Generated with [Claude Code](https://claude.com/claude-code)">
```
Then add `docs/changelog/entries/<PR>.md`, commit, push.

- [ ] **Step 4: Rollout (operator steps, in order; each confirmed before the next)**
  1. Apply mig 797 via Supabase MCP `apply_migration` on project `iyvtbjjxdggiadzwwvdj` (confirm with `list_projects`); run `get_advisors` type `security`; `SELECT key, enabled, is_primary, display_order FROM pipelines WHERE location_id = 'a0000000-0000-0000-0000-000000000001'` shows acquisition enabled primary 0, paid_trial disabled 1, programmes disabled 2.
  2. Merge the PR; wait for the Vercel deploy.
  3. Dry run: `POST /api/admin/pipeline-reclassify { location_id: <Stillorgan>, dry_run: true, include_disabled: ['paid_trial', 'programmes'] }` as master; hand Richard `board_histogram`, `stage_histogram`, `movement_matrix`, `claims_pending`.
  4. On Richard's go: apply mig 798; `POST /api/admin/pipeline-reclassify { location_id, source: 'manual' }` (or wait for 03:30); record `boards_moved` and `movement_matrix` in the PR thread.

---

## Self-review notes

- Spec coverage: boards and columns (T1–T4), routing and precedence (T3, T6, T7), claims recorded (T4, T5), shared piles (router falls back to acquisition; no dormant stages on new boards), setting (T8), stage-slug visibility and labels (T9), sequence pickers deliberately untouched (T9 leaves `PIPELINE_SLUGS` in `SequenceSettings.jsx` alone), PIPEEXCL on all boards (T3, T6), scope unchanged (T6 reads contacts by home studio; T5 filters purchases by the contact set), `placeWaitlistEntry` left as is with `placeContactNow` after it (T7), rollout (T11), phone (T10), docs (T11).
- Type consistency: `routeContact(contact, claims, now, boards:Set)` in T3 is what T6 and T7 call; `claims = { paid, programme }` everywhere; `programme` claim shape `{ claimedAt: number, source }`; `loadClaimsForContact` returns `{ ok, claims }` and T7 destructures that.
- Proportion: the plan is shorter than the code it describes; test bodies carry the spec's values, code bodies are left to the implementer except where the signature pins them.
