## PR SHIFTREMIND.1 — shift reminders: 20:00 the evening before an early start, otherwise 2 hours before

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this section task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every coach gets exactly one reminder before each published shift, on push (email if they have no device), timed so an early start is never a 4am buzz.

**Why:** No shift reminder exists on any channel. `/api/cron/send-push-reminders` covers tasks and bookings only, and its ledger `push_reminder_sends` (mig 169) has `CHECK (entity_type IN ('task', 'booking'))`. 96 shifts in the last 8 weeks started before 07:00, so a fixed 60-minute lead (what tasks/bookings use) is useless for them: it would fire at 05:00.

**Ships:** migration 619 + web deploy + OTA. **DEPLOY ORDER:**
1. **Operator applies mig 619 FIRST**, through the Supabase MCP `apply_migration` against the **un1t-crm** project (ref `iyvtbjjxdggiadzwwvdj`, never the sentinel project), then runs `get_advisors` (type=security). The migration is safe alone: it only widens a CHECK, and nothing writes `entity_type='shift'` until the code deploys.
2. **Then merge.** Vercel deploys the cron arm (live on the next 5-minute tick) and, because `shared/**` and `mobile/lib/**` change, `eas-update.yml` **publishes an OTA at 100%** to every phone on the runtime lane.
3. If the code ever lands before the migration, nothing breaks and nothing spams: the ledger claim fails with `23514`, the reminder is **not sent**, and an error is logged every tick until the migration is applied (Task 6 pins this).
4. **Merge between 08:00 and 20:00 Dublin.** The first tick after deploy reminds every shift whose fire time has already passed and that is still 30+ minutes away. Merged at 03:00, that is a 03:00 push to every coach on an early shift.
5. A phone that has not taken the OTA yet still receives the push; tapping it does nothing (unknown `data.type` is logged by the app, never a crash).

**The rule (decided here, pinned by the Task 4 table):**
- Start **before 08:00** Dublin: ONE reminder at **20:00 Dublin the evening before**. Any other start: ONE reminder **2 hours before**.
- A reminder is **due from its fire time onwards, until 30 minutes before the start**. There is no 15-minute "late window" like the task/booking arms have. Consequences, all deliberate: missed cron ticks catch up by themselves; a shift published, assigned or swapped *after* its fire time still gets its one reminder on the next tick (as long as the start is 30+ minutes away); a shift created with under 30 minutes' notice gets **no** reminder (the `shift_adjusted` / `schedule_published` push that created it has just told the coach).
- **One reminder per (assignment, coach), ever.** If a manager moves the time after the reminder went, the coach gets the existing `shift_adjusted` push, not a second reminder. After a swap the assignment's `profile_id` changes, so the new owner still gets theirs.
- Published + live only: `fetchApiShiftRows(..., { publishedOnly: true })` (`src/lib/roster-read.js:191`) already applies `isLiveAssignment` (`src/lib/roster.js:440`) and `rosters.status = 'published'`; the pure function re-asserts both.
- **Correction to the brief:** "skip cancelled/swapped" is wrong for `swapped`. `isLiveAssignment` documents it (`src/lib/roster.js:434-442`): *"Only `cancelled` is dead; `swapped` is a real shift owned by the taker."* Migs 612/615 move `profile_id` to the taker and set `status='swapped'` on the same row. Skipping `swapped` would silence exactly the coach who just took the shift. Only `cancelled` is skipped.
- Approved leave is a fact about the **person**, not the studio: it is read by `profile_id`, not filtered by location.
- **Email fallback is ON** (`fallbackEmail: true`), unlike tasks/bookings. The evening-before reminder has ten hours of slack, and Android staff have no push tokens until FCM credentials exist, so email is the only channel they have.

**Finding that changes the migration:** mig 169 created two CHECKs, but **mig 170 already relaxed `lead_time_minutes` to `BETWEEN 5 AND 10080`** (`supabase/migrations/170_notification_config_on_locations.sql:42-47`). Every lead this PR stores (120, or 240-780 for an evening-before reminder) fits. Only the `entity_type` CHECK needs widening.

**Prerequisite:** run every command from your own fresh worktree off `origin/main` (`git fetch origin main && git worktree add ../un1t-crm-shiftremind -b shiftremind-1 origin/main`). A fresh worktree has no `node_modules`: run `npm ci` once. Tests: `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` locally (8GB machine); CI's **Test & lint** and **Next build** jobs are the full gates.

**Files:**

| File | Responsibility |
|---|---|
| `supabase/migrations/619_push_reminder_sends_shift.sql` (create) | widen `entity_type` CHECK to include `'shift'`, self-checking |
| `shared/permissions.js` (modify: line 716, and the six `notify_shift_adjusted: true,` lines 782 / 820 / 861 / 896 / 935 / 976) | `notify_shift_reminder` key + default ON for all six roles |
| `shared/permission-bundles.js` (modify: lines 335, 380, 396) | `EXEMPT_KEYS` literal list (drift-guarded against `NOTIFY_KEYS`) |
| `shared/push-channels.js` (modify: lines 85-86) | Android channel for the category |
| `src/lib/notifications-registry.js` (modify: after line 66) | registry entry (drives `/settings/notifications` and the email fallback) |
| `src/lib/shift-reminder-registration.test.js` (create) | pins all four registration sites in one place |
| `mobile/lib/notification-nav.js` (modify: lines 83-84) | `shift_reminder` tap opens that day on the Schedule tab |
| `mobile/lib/notification-nav.test.js` (modify) | test for it |
| `src/lib/push-channels.test.js` (modify: line 19) | add the type to `STAFF_TYPES` |
| `src/lib/shift-reminders.js` (create) | the pure rule, the message, and the cron arm |
| `src/lib/shift-reminders.test.js` (create) | timing table (DST included), message, arm |
| `src/app/api/cron/send-push-reminders/route.js` (modify: lines 33-40, 73-75, insert before 374) | call the arm |
| `src/app/api/cron/send-push-reminders/route.test.js` (create) | wiring test |
| `docs/CHANGELOG.md` (modify) | row keyed by the PR number, added after `gh pr create` |

**No settings UI edits are needed, and that is verified, not assumed.** The web per-user editor (`src/components/StaffForm.jsx:1083`), the web role editor (`src/components/RolePermissions.jsx:136-137`) and the mobile editor (`mobile/app/(staff)/staff/permissions/[id].jsx:26-29`) all render from `MOBILE_PERMISSIONS`, and `/settings/notifications` (`src/app/settings/notifications/page.js:63,99`) renders from `NOTIFICATION_REGISTRY`. The label and hint you add in Task 2 ARE the web and mobile settings labels. `mobile/lib/widget-push-reload.js` is deliberately untouched: a shift reminder feeds none of the three home-queue buckets, and unknown types already default to "no reload".

---

### Task 1: Migration 619 — the ledger accepts `entity_type = 'shift'`

**Files:**
- Create: `supabase/migrations/619_push_reminder_sends_shift.sql`

There is no vitest harness for SQL. The "test" is the migration's own self-check block plus the two repo scripts that replay every migration.

- [ ] **Step 1: Read what exists**

Open `supabase/migrations/169_push_reminder_sends.sql`. The table is created with two INLINE column CHECKs, so Postgres auto-named them `push_reminder_sends_entity_type_check` and `push_reminder_sends_lead_time_minutes_check`. Mig 170 dropped and re-added the second by exactly that auto-name and it is live, which is the evidence the naming convention holds here. The UNIQUE key is `(entity_type, entity_id, recipient_id, lead_time_minutes)`; RLS has one permissive `SELECT` for `authenticated` (own rows) and a restrictive `FOR ALL TO anon` deny. None of that changes: the cron writes with the service-role client, which bypasses RLS.

- [ ] **Step 2: Write the migration**

```sql
-- 619 — SHIFTREMIND.1: let the push-reminder ledger record shift reminders.
--
-- WHY
-- ───
-- /api/cron/send-push-reminders reminds staff about tasks and bookings, and
-- dedups through push_reminder_sends (mig 169). Nothing reminds a coach about
-- a SHIFT on any channel. SHIFTREMIND.1 adds a `shift` arm to that cron: one
-- reminder per published shift assignment (20:00 Dublin the evening before a
-- start before 08:00, otherwise 2 hours before). It reuses this ledger:
--
--   entity_type       = 'shift'
--   entity_id         = shift_assignments.id
--   recipient_id      = the coach (shift_assignments.profile_id)
--   lead_time_minutes = real minutes between the reminder's fire time and the
--                       shift start: 120, or 240..780 for an evening-before one
--
-- Mig 169 pinned entity_type to ('task', 'booking'). This widens it. Widening
-- only: no existing row can violate the new CHECK.
--
-- lead_time_minutes needs NO change: mig 170 already relaxed it to
-- BETWEEN 5 AND 10080.
--
-- DEPLOY ORDER: apply this BEFORE the SHIFTREMIND.1 code deploys. It is safe
-- alone (nothing writes 'shift' until the code exists). If the code lands
-- first, its ledger claim fails with 23514 and it sends nothing until this is
-- applied; it never spams.
--
-- REPLAYING THIS MIGRATION IS A NO-OP (drop-if-exists, then add).

ALTER TABLE public.push_reminder_sends
  DROP CONSTRAINT IF EXISTS push_reminder_sends_entity_type_check;

ALTER TABLE public.push_reminder_sends
  ADD CONSTRAINT push_reminder_sends_entity_type_check
  CHECK (entity_type IN ('task', 'booking', 'shift'));

-- Self-check (the mig 153b habit: verify the catalog, not the migration text).
-- The DROP above names the constraint by Postgres's auto-name for an inline
-- column CHECK. If prod's copy was ever named differently, the DROP was a
-- silent no-op and the OLD ('task','booking') CHECK is still there beside the
-- new one, still refusing 'shift'. Exactly one CHECK may mention entity_type.
-- A RAISE here aborts the migration's transaction, so nothing half-applies.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_constraint
   WHERE conrelid = 'public.push_reminder_sends'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%entity_type%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'mig 619: expected exactly 1 CHECK on push_reminder_sends.entity_type, found %', n;
  END IF;
END $$;

COMMENT ON TABLE public.push_reminder_sends IS
  'NOTIF.1 + SHIFTREMIND.1 — dedup ledger for cron push reminders: tasks, bookings and (mig 619) shifts. One row per (entity_type, entity_id, recipient_id, lead_time_minutes). For entity_type = shift, entity_id is shift_assignments.id and the row is a CLAIM inserted BEFORE the send, released (deleted) if the send fails outright. recipient_id is the profile that received the reminder.';
```

- [ ] **Step 3: Run the two checks that replay every migration**

Run: `npm run check:rls-restrictive && npm run check:select-columns`
Expected: both exit 0. (No policy and no column changed; this proves the new file parses in their replay and did not disturb the net policy state.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/619_push_reminder_sends_shift.sql
git commit -m "SHIFTREMIND.1 — mig 619: push_reminder_sends accepts entity_type 'shift'

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Do NOT apply it yourself. Applying to prod is the operator's step (see DEPLOY ORDER); say so in the PR body.

---

### Task 2: Register the `shift_reminder` category everywhere, default ON

**Files:**
- Create: `src/lib/shift-reminder-registration.test.js`
- Modify: `shared/permissions.js`, `shared/permission-bundles.js`, `shared/push-channels.js`, `src/lib/notifications-registry.js`

Why this is its own task: CLAUDE.md, *"An UNREGISTERED `sendPush` category fails CLOSED"*. `src/lib/push.js:213` gates on `` `notify_${category}` `` and `resolvePermission` (`shared/permissions.js:1258`) ends at `defaults?.[role]?.[key] === true`. Miss one role's default and that role silently gets nothing, while `master` (who bypasses the tiers) sees it work. **The category string is the BARE name, `shift_reminder`. Never pass `notify_shift_reminder` as a category: push.js adds the prefix itself.**

- [ ] **Step 1: Write the failing test**

```js
// SHIFTREMIND.1 — the `shift_reminder` push category is registered at EVERY
// site a category needs, default ON for every role.
//
// Why one file pins all of them: an unregistered sendPush category fails
// CLOSED (CLAUDE.md). resolvePermission's last tier is
// `defaults[role][key] === true`, so a key missing from one role's defaults
// silently sends that role nothing, and only `master` (who bypasses the
// tiers) would ever see the push while testing it.

import { describe, it, expect } from 'vitest'
import { MOBILE_PERMISSIONS, DEFAULT_MOBILE_PERMISSIONS_BY_ROLE, NOTIFY_KEYS } from '@shared/permissions'
import { EXEMPT_KEYS } from '@shared/permission-bundles'
import { androidChannelId } from '@shared/push-channels'
import { getNotificationCategory } from './notifications-registry'

const KEY = 'notify_shift_reminder'

describe('shift_reminder category registration', () => {
  it('is a personal, mobile-only notify toggle with a label the settings screens can render', () => {
    const entry = MOBILE_PERMISSIONS.find((p) => p.key === KEY)
    expect(entry).toMatchObject({ key: KEY, mobileOnly: true, isNotify: true })
    expect(entry.label).toMatch(/Shift reminders/)
    expect(entry.hint).toMatch(/8pm the evening before/)
    expect(NOTIFY_KEYS).toContain(KEY)
  })

  it('defaults ON for every role (a missing role default is a silent opt-out)', () => {
    const roles = Object.keys(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE)
    expect(roles.sort()).toEqual(['head_coach', 'manager', 'master', 'owner', 'reception', 'staff'])
    for (const role of roles) {
      expect(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[role][KEY], `${role}.${KEY}`).toBe(true)
    }
  })

  it('is exempt from the location feature gate, like every other notify_* key', () => {
    expect(EXEMPT_KEYS).toContain(KEY)
  })

  it('rides the Android "reminders" channel, by category and with its data.type', () => {
    expect(androidChannelId({ category: 'shift_reminder' })).toBe('reminders')
    expect(androidChannelId({ category: 'shift_reminder', type: 'shift_reminder' })).toBe('reminders')
  })

  it('is in the notifications registry as a cron category WITH the email fallback', () => {
    expect(getNotificationCategory('shift_reminder')).toMatchObject({
      category: 'shift_reminder',
      label: 'Shift reminders',
      trigger: { kind: 'cron' },
      recipients: { kind: 'assignee' },
      configurable: { leadTimes: false, roles: false },
      fallbackEmail: true,
    })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/shift-reminder-registration.test.js`
Expected: `5 failed`. The first is an `AssertionError` because `MOBILE_PERMISSIONS.find(…)` returned `undefined`: the key does not exist yet.

- [ ] **Step 3: Minimal implementation (four files)**

**(a) `shared/permissions.js`, the key.** Directly under the existing `notify_shift_adjusted` entry (line 716) add:

```js
  // SHIFTREMIND.1 — one reminder per published shift from the
  // send-push-reminders cron: 8pm the evening before for a start before
  // 08:00, otherwise 2 hours before. Default ON for every role.
  { key: 'notify_shift_reminder',   label: '… Shift reminders',    hint: 'Notify before each of your shifts: 8pm the evening before for a start before 8am, otherwise 2 hours before', mobileOnly: true, isNotify: true },
```

(The label's leading `… ` is what the neighbouring rows use; copy it from the line above rather than retyping it.)

**(b) `shared/permissions.js`, the six role defaults.** In `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE` the exact line `    notify_shift_adjusted: true,` appears **six** times, once per role block (`master` 782, `staff` 820, `reception` 861, `head_coach` 896, `manager` 935, `owner` 976). Under **each** of the six add:

```js
    notify_shift_reminder: true,
```

Check your work: `grep -c "notify_shift_reminder: true," shared/permissions.js` must print `6`.

**(c) `shared/permission-bundles.js`, the exempt list.** `EXEMPT_KEYS` is a deliberate LITERAL copy of `NOTIFY_KEYS` (a reverse import would be circular, see the comment at lines 358-368), and `shared/permission-bundles.test.js:99` fails the moment the two disagree. Under `'notify_shift_adjusted',` (line 396) add:

```js
  'notify_shift_reminder',
```

and change the two comments that count the toggles, `25 personal` to `26 personal` (lines 335 and 380).

**(d) `shared/push-channels.js`, the Android channel.** In `CATEGORY_CHANNELS`, under `bookings: 'reminders',` (line 86) add:

```js
  shift_reminder: 'reminders', // SHIFTREMIND.1 — cron lead-time reminder, same family
```

**(e) `src/lib/notifications-registry.js`, the registry entry.** Insert as the third array element, directly after the `bookings` entry closes (after line 66):

```js
  {
    category: 'shift_reminder',
    label: 'Shift reminders',
    description: 'One reminder before each published shift: 8pm the evening before for a shift starting before 8am, otherwise 2 hours before. Names the studio, the shift, its times and who you are on with.',
    trigger: { kind: 'cron', source: '/api/cron/send-push-reminders (every 5 min) -> src/lib/shift-reminders.js' },
    recipients: { kind: 'assignee', detail: 'The coach on the shift (shift_assignments.profile_id). Skipped while on approved leave.' },
    // Fixed rule, not a per-location lead-time list: 96 shifts in 8 weeks
    // started before 07:00, where any fixed lead is either useless or a 4am push.
    configurable: { leadTimes: false, roles: false },
    // Unlike tasks/bookings this DOES fall back to email. The evening-before
    // reminder has ten hours of slack, and Android staff have no push tokens
    // until FCM credentials exist, so email is the only channel they have.
    fallbackEmail: true,
    emailSubject: 'Shift reminder',
  },
```

- [ ] **Step 4: Run it, expect PASS, together with the three existing drift guards**

Run: `npx vitest run src/lib/shift-reminder-registration.test.js shared/permission-bundles.test.js src/lib/push-channels.test.js src/lib/shared-permissions.test.js`
Expected: all passed. If `permission-bundles.test.js` fails with *"every key appears in exactly one of KEY_BUNDLES / CORE_KEYS / EXEMPT_KEYS"* you skipped (c). If `shared-permissions.test.js` fails with *"registry category 'shift_reminder' has no notify_shift_reminder toggle"* you skipped (a).

Then: `npm run check:mobile-parity && npm run check:bundle-sql`
Expected: both exit 0. (`mobileOnly: true` satisfies parity. `check:bundle-sql` mirrors `KEY_BUNDLES`, not `EXEMPT_KEYS`, so no SQL reseed is needed; this run is the proof.)

- [ ] **Step 5: Commit**

```bash
git add shared/permissions.js shared/permission-bundles.js shared/push-channels.js src/lib/notifications-registry.js src/lib/shift-reminder-registration.test.js
git commit -m "SHIFTREMIND.1 — register the shift_reminder push category, default on for every role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Mobile tap routing for `data.type: 'shift_reminder'`

**Files:**
- Modify: `mobile/lib/notification-nav.js` (the `// ── Roster` group, lines 79-84)
- Modify: `mobile/lib/notification-nav.test.js`
- Modify: `src/lib/push-channels.test.js` (line 19)

`schedule_published` deep-links with `?date=`, which `mobile/app/(staff)/(tabs)/schedule.jsx:310-330` reads to preselect that week and day. Copy it.

- [ ] **Step 1: Write the failing test**

In `mobile/lib/notification-nav.test.js`, directly above `it('routes WhatsApp health/template alerts to the WhatsApp tab', …)` add:

```js
  // SHIFTREMIND.1
  it('opens the shift day for a shift reminder', () => {
    expect(routeForNotification({ type: 'shift_reminder', assignment_id: 'a1', block_date: '2026-09-22', lead_minutes: 600 }))
      .toBe('/(tabs)/schedule?date=2026-09-22')
    expect(routeForNotification({ type: 'shift_reminder' })).toBe('/(tabs)/schedule')
    expect(routeForNotification({ type: 'shift_reminder', block_date: 'tomorrow' })).toBe('/(tabs)/schedule')
  })
```

In `src/lib/push-channels.test.js` line 19, add the type to `STAFF_TYPES`:

```js
  'schedule_published', 'schedule_updated', 'shift_adjusted', 'shift_reminder',
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run mobile/lib/notification-nav.test.js`
Expected: `1 failed`, `expected undefined to be '/(tabs)/schedule?date=2026-09-22'` (unknown types return `undefined`).

- [ ] **Step 3: Minimal implementation**

In `mobile/lib/notification-nav.js`, directly after the `shift_adjusted` case (lines 83-84):

```js
    // SHIFTREMIND.1 — "you are on tomorrow / in 2 hours": open that day.
    case 'shift_reminder':
      return isIsoDay(data.block_date) ? `/(tabs)/schedule?date=${data.block_date}` : '/(tabs)/schedule'
```

and add `shift_reminder` to the list in the header comment's `schedule_published / schedule_updated / shift_adjusted / …` paragraph (lines 22-25) so the next reader finds it.

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run mobile/lib/notification-nav.test.js src/lib/push-channels.test.js`
Expected: all passed.

Then: `npm run check:mobile-lint`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/notification-nav.js mobile/lib/notification-nav.test.js src/lib/push-channels.test.js
git commit -m "SHIFTREMIND.1 — a shift reminder tap opens that day on the Schedule tab

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The pure rule — which reminders are due now

**Files:**
- Create: `src/lib/shift-reminders.js`
- Create: `src/lib/shift-reminders.test.js`

Signatures you build on (read them first):
- `localToUtc(dateStr, timeStr, tz)` → `Date | null`, DST-safe via `Intl` (`src/lib/push-reminders.js:25`). **Never** `new Date(\`${d}T${t}\`)`: `check:guardrails` bans the `Z` form and the local form breaks on a UTC server.
- `addDaysISO(dateStr, days)` → `'YYYY-MM-DD'`, pure calendar arithmetic (`src/lib/dublin-time.js:81`).
- `effectiveShiftStart(shift)` = `start_time_override || block_start_time || start_time || shift_templates.start_time` (`shared/roster-month.js:46-57`). This is `effectiveOverride`'s resolution order (assignment override → block → template) for the row shape `fetchApiShiftRows` returns. Reuse it; do not re-derive it.

The test header below already declares the mocks and names Tasks 5 and 6 need, so later tasks only append `describe` blocks. A name that does not exist yet destructures to `undefined`, which is harmless until a test calls it.

- [ ] **Step 1: Write the failing test**

Create `src/lib/shift-reminders.test.js`:

```js
// SHIFTREMIND.1 — when is a shift reminder due, what does it say, and does the
// cron arm send it exactly once?
//
// Every instant below is written in UTC with the Dublin wall-clock in the test
// name. Ireland is UTC+1 from the last Sunday of March to the last Sunday of
// October (2026: 29 Mar -> 25 Oct) and UTC+0 otherwise. Nothing here reads the
// host clock or the host timezone, so the file passes under any TZ.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./roster-read', () => ({ fetchApiShiftRows: vi.fn() }))
vi.mock('./notify', () => ({ notifyUsers: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const { fetchApiShiftRows } = await import('./roster-read')
const { notifyUsers } = await import('./notify')
const { logWarn, logError } = await import('./log')
const {
  reminderPlanFor, isReminderDue, dueShiftReminders, leaveKeysFor, leaveKey, reminderKey,
  coRosteredFirstNames, buildShiftReminderMessage, runShiftReminders,
} = await import('./shift-reminders')

const at = (iso) => Date.parse(iso)
const iso = (ms) => new Date(ms).toISOString()

// A fetchApiShiftRows() row. Fictional people only: the repo is public.
function shift(over = {}) {
  return {
    id: 'assign-1',
    profile_id: 'coach-1',
    location_id: 'loc-1',
    shift_template_id: 'tpl-early',
    shift_date: '2026-09-22',
    status: 'scheduled',
    published: true,
    start_time_override: null,
    end_time_override: null,
    block_start_time: null,
    block_end_time: null,
    shift_templates: { name: 'Early', start_time: '06:00:00', end_time: '14:00:00' },
    profiles: { id: 'coach-1', full_name: 'Alex Example' },
    ...over,
  }
}
const midShift = (over = {}) => shift({
  id: 'assign-2', shift_template_id: 'tpl-mid',
  shift_templates: { name: 'Mid', start_time: '10:00:00', end_time: '14:00:00' },
  ...over,
})

describe('reminderPlanFor — which rule, and the fire instant', () => {
  it('06:00 shift -> 20:00 Dublin the evening before (summer, UTC+1)', () => {
    const p = reminderPlanFor(shift())
    expect(p.kind).toBe('evening_before')
    expect(iso(p.fireAtMs)).toBe('2026-09-21T19:00:00.000Z') // 20:00 Dublin
    expect(iso(p.startMs)).toBe('2026-09-22T05:00:00.000Z')  // 06:00 Dublin
    expect(p.leadMinutes).toBe(600)
  })

  it('10:00 shift -> exactly 2 hours before', () => {
    const p = reminderPlanFor(midShift())
    expect(p.kind).toBe('two_hours')
    expect(iso(p.fireAtMs)).toBe('2026-09-22T07:00:00.000Z') // 08:00 Dublin
    expect(p.leadMinutes).toBe(120)
  })

  it('the 08:00 boundary: 07:59 is early, 08:00 is not', () => {
    const tpl = (start) => ({ name: 'T', start_time: start, end_time: '13:00:00' })
    expect(reminderPlanFor(shift({ shift_templates: tpl('07:59:00') })).kind).toBe('evening_before')
    expect(reminderPlanFor(shift({ shift_templates: tpl('08:00:00') })).kind).toBe('two_hours')
  })

  it('uses the EFFECTIVE start: assignment override, then block, then template', () => {
    // Template says 09:00 but this coach was moved to 07:30 -> evening before.
    expect(reminderPlanFor(shift({
      start_time_override: '07:30:00',
      shift_templates: { name: 'T', start_time: '09:00:00', end_time: '13:00:00' },
    })).kind).toBe('evening_before')
    // Template says 06:00 but the block was moved to 09:30 -> two hours.
    const p = reminderPlanFor(shift({ block_start_time: '09:30:00' }))
    expect(p.kind).toBe('two_hours')
    expect(iso(p.startMs)).toBe('2026-09-22T08:30:00.000Z')
  })

  it('spring forward (Sun 29 Mar 2026): 20:00 Sat is still winter time, the night is 1h short', () => {
    const p = reminderPlanFor(shift({ shift_date: '2026-03-29' }))
    expect(iso(p.fireAtMs)).toBe('2026-03-28T20:00:00.000Z') // 20:00 Dublin, UTC+0
    expect(iso(p.startMs)).toBe('2026-03-29T05:00:00.000Z')  // 06:00 Dublin, UTC+1
    expect(p.leadMinutes).toBe(540)
  })

  it('fall back (Sun 25 Oct 2026): 20:00 Sat is still summer time, the night is 1h long', () => {
    const p = reminderPlanFor(shift({ shift_date: '2026-10-25' }))
    expect(iso(p.fireAtMs)).toBe('2026-10-24T19:00:00.000Z') // 20:00 Dublin, UTC+1
    expect(iso(p.startMs)).toBe('2026-10-25T06:00:00.000Z')  // 06:00 Dublin, UTC+0
    expect(p.leadMinutes).toBe(660)
  })

  it('a 10:00 shift on both DST days still fires 2 real hours before', () => {
    expect(iso(reminderPlanFor(midShift({ shift_date: '2026-03-29' })).fireAtMs)).toBe('2026-03-29T07:00:00.000Z')
    expect(iso(reminderPlanFor(midShift({ shift_date: '2026-10-25' })).fireAtMs)).toBe('2026-10-25T08:00:00.000Z')
  })

  it('returns null rather than guessing when the row has no date or no start', () => {
    expect(reminderPlanFor(shift({ shift_date: null }))).toBeNull()
    expect(reminderPlanFor(shift({ shift_templates: {} }))).toBeNull()
    expect(reminderPlanFor(null)).toBeNull()
  })
})

describe('dueShiftReminders — the timing table', () => {
  // [name, shift, now (UTC), expected kinds]
  const TABLE = [
    ['06:00 shift at 19:59 the evening before -> not yet', shift(), '2026-09-21T18:59:00Z', []],
    ['06:00 shift at 20:00 the evening before -> due', shift(), '2026-09-21T19:00:00Z', ['evening_before']],
    ['06:00 shift at 20:14 (two missed ticks) -> still due', shift(), '2026-09-21T19:14:00Z', ['evening_before']],
    ['06:00 shift published at 23:30 -> due on the next tick', shift(), '2026-09-21T22:30:00Z', ['evening_before']],
    ['06:00 shift at 05:30 (exactly 30 min notice) -> due', shift(), '2026-09-22T04:30:00Z', ['evening_before']],
    ['06:00 shift at 05:31 (29 min notice) -> never fires late', shift(), '2026-09-22T04:31:00Z', []],
    ['06:00 shift after it has started -> nothing', shift(), '2026-09-22T05:10:00Z', []],
    ['10:00 shift at 07:59 -> not yet', midShift(), '2026-09-22T06:59:00Z', []],
    ['10:00 shift at 08:00 (T-2h) -> due', midShift(), '2026-09-22T07:00:00Z', ['two_hours']],
    ['10:00 shift created at 09:30 (30 min notice) -> due', midShift(), '2026-09-22T08:30:00Z', ['two_hours']],
    ['10:00 shift created at 09:31 (29 min notice) -> nothing', midShift(), '2026-09-22T08:31:00Z', []],
    ['spring-forward 06:00 shift at 19:59 Sat -> not yet', shift({ shift_date: '2026-03-29' }), '2026-03-28T19:59:00Z', []],
    ['spring-forward 06:00 shift at 20:00 Sat -> due', shift({ shift_date: '2026-03-29' }), '2026-03-28T20:00:00Z', ['evening_before']],
    ['fall-back 06:00 shift at 19:59 Sat -> not yet', shift({ shift_date: '2026-10-25' }), '2026-10-24T18:59:00Z', []],
    ['fall-back 06:00 shift at 20:00 Sat -> due', shift({ shift_date: '2026-10-25' }), '2026-10-24T19:00:00Z', ['evening_before']],
  ]
  it.each(TABLE)('%s', (_name, s, now, kinds) => {
    expect(dueShiftReminders([s], { nowMs: at(now) }).map((d) => d.kind)).toEqual(kinds)
  })

  const DUE_NOW = { nowMs: at('2026-09-21T19:00:00Z') }

  it('an UNPUBLISHED shift is never due, whatever the clock says', () => {
    expect(dueShiftReminders([shift({ published: false })], DUE_NOW)).toEqual([])
    expect(dueShiftReminders([shift({ published: undefined })], DUE_NOW)).toEqual([])
  })

  it('a cancelled assignment is skipped; a swapped one is a live shift for its new owner', () => {
    expect(dueShiftReminders([shift({ status: 'cancelled' })], DUE_NOW)).toEqual([])
    expect(dueShiftReminders([shift({ status: 'swapped', profile_id: 'coach-2' })], DUE_NOW)).toHaveLength(1)
  })

  it('a coach on approved leave that day is skipped; leave on another day is not', () => {
    const onLeave = new Set([leaveKey('coach-1', '2026-09-22')])
    expect(dueShiftReminders([shift()], { ...DUE_NOW, onLeave })).toEqual([])
    const otherDay = new Set([leaveKey('coach-1', '2026-09-23')])
    expect(dueShiftReminders([shift()], { ...DUE_NOW, onLeave: otherDay })).toHaveLength(1)
  })

  it('duplicate run inside the same window: a ledger hit removes it', () => {
    const first = dueShiftReminders([shift()], DUE_NOW)
    expect(first).toHaveLength(1)
    const sentKeys = new Set(first.map((d) => reminderKey(d.shift.id, d.shift.profile_id)))
    expect(dueShiftReminders([shift()], { nowMs: at('2026-09-21T19:05:00Z'), sentKeys })).toEqual([])
  })

  it('the ledger key is per RECIPIENT: after a swap the new owner is still reminded', () => {
    const sentKeys = new Set([reminderKey('assign-1', 'coach-1')])
    expect(dueShiftReminders([shift({ status: 'swapped', profile_id: 'coach-2' })], { ...DUE_NOW, sentKeys }))
      .toHaveLength(1)
  })

  it("reads each location's own timezone", () => {
    // 06:00 in New York on 22 Sep is 10:00 UTC; 20:00 the evening before is 00:00 UTC.
    const s = shift({ location_id: 'loc-ny' })
    const tzByLocation = { 'loc-ny': 'America/New_York' }
    expect(dueShiftReminders([s], { nowMs: at('2026-09-21T23:59:00Z'), tzByLocation })).toEqual([])
    expect(dueShiftReminders([s], { nowMs: at('2026-09-22T00:00:00Z'), tzByLocation })).toHaveLength(1)
  })

  it('isReminderDue(null) is false, not a throw', () => {
    expect(isReminderDue(null, 0)).toBe(false)
  })
})

describe('leaveKeysFor', () => {
  it('expands approved ranges over the asked-for dates only, and ignores other statuses', () => {
    const keys = leaveKeysFor([
      { profile_id: 'coach-1', status: 'approved', start_date: '2026-09-20', end_date: '2026-09-22' },
      { profile_id: 'coach-2', status: 'pending', start_date: '2026-09-22', end_date: '2026-09-22' },
      { profile_id: 'coach-3', status: 'approved', start_date: '2026-09-23', end_date: '2026-09-23' },
    ], ['2026-09-22', '2026-09-23'])
    expect([...keys].sort()).toEqual(['coach-1|2026-09-22', 'coach-3|2026-09-23'])
  })
  it('tolerates null input', () => {
    expect(leaveKeysFor(null, null).size).toBe(0)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/shift-reminders.test.js`
Expected: `Test Files 1 failed`, `no tests`, with `Error: Cannot find module '/src/lib/shift-reminders'`.

- [ ] **Step 3: Minimal implementation**

Create `src/lib/shift-reminders.js`:

```js
// SHIFTREMIND.1 — shift reminders for coaches.
//
// THE RULE (one reminder per shift assignment, ever):
//   - a shift that starts BEFORE 08:00 Dublin gets its reminder at 20:00 Dublin
//     the evening before (a 2-hour lead on a 06:00 shift is a 04:00 push);
//   - every other shift gets it 2 hours before the start.
//
// WHEN IT IS DUE: from its fire time onwards, until 30 minutes before the
// shift starts. There is deliberately NO upper "late window" like the task /
// booking arms have (15 min): a shift that is published, assigned or swapped
// AFTER its fire time has passed still gets its one reminder on the next
// 5-minute tick, and missed cron ticks catch up by themselves. Under 30
// minutes' notice it is noise (the coach is already travelling, and the
// shift_adjusted / schedule_published push that created the shift has just
// told them), so it never fires then. The push_reminder_sends ledger (migs
// 169 + 619) is what makes "from the fire time onwards" send exactly once.
//
// Everything above runShiftReminders is PURE (no clock, no database) so the
// timing table in shift-reminders.test.js can pin it, DST days included.

import { localToUtc } from './push-reminders'
import { addDaysISO } from './dublin-time'
import { effectiveShiftStart } from '@shared/roster-month'

export const EARLY_START_CUTOFF = '08:00'
export const EVENING_REMINDER_TIME = '20:00'
export const DAY_LEAD_MINUTES = 120
export const MIN_NOTICE_MINUTES = 30

const DEFAULT_TZ = 'Europe/Dublin'
const MINUTE_MS = 60 * 1000
const hhmm = (t) => String(t || '').slice(0, 5)

/**
 * When does this shift's one reminder fire?
 *
 * @param {object} shift  a fetchApiShiftRows() row (src/lib/roster-read.js):
 *   shift_date, start_time_override, block_start_time, shift_templates.start_time
 * @param {string} [tz]   the location's IANA timezone
 * @returns {{ kind: 'evening_before'|'two_hours', startMs: number, fireAtMs: number, leadMinutes: number } | null}
 *   null when the row has no readable date/start (never guess a time).
 */
export function reminderPlanFor(shift, tz = DEFAULT_TZ) {
  const start = effectiveShiftStart(shift)
  if (!shift?.shift_date || !start) return null
  const startUtc = localToUtc(shift.shift_date, start, tz)
  if (!startUtc) return null
  const startMs = startUtc.getTime()

  if (hhmm(start) < EARLY_START_CUTOFF) {
    const fireUtc = localToUtc(addDaysISO(shift.shift_date, -1), EVENING_REMINDER_TIME, tz)
    if (!fireUtc) return null
    const fireAtMs = fireUtc.getTime()
    // Wall-clock 20:00 -> wall-clock start, measured in REAL minutes: 600 for
    // a 06:00 shift on a normal day, 540 / 660 across the two DST changes.
    return { kind: 'evening_before', startMs, fireAtMs, leadMinutes: Math.round((startMs - fireAtMs) / MINUTE_MS) }
  }
  return { kind: 'two_hours', startMs, fireAtMs: startMs - DAY_LEAD_MINUTES * MINUTE_MS, leadMinutes: DAY_LEAD_MINUTES }
}

/** Due = the fire time has arrived AND the shift is still >= 30 minutes away. */
export function isReminderDue(plan, nowMs) {
  if (!plan) return false
  return nowMs >= plan.fireAtMs && plan.startMs - nowMs >= MIN_NOTICE_MINUTES * MINUTE_MS
}

export const reminderKey = (assignmentId, profileId) => `${assignmentId}|${profileId}`
export const leaveKey = (profileId, dateIso) => `${profileId}|${dateIso}`

/**
 * `${profile_id}|${date}` for every (coach, date) covered by APPROVED leave.
 * Leave is a fact about the person, not the studio, so it is not filtered by
 * location: a coach on holiday at one studio is on holiday at all of them.
 */
export function leaveKeysFor(requests, dates) {
  const keys = new Set()
  for (const r of requests || []) {
    if (r?.status !== 'approved' || !r.profile_id) continue
    for (const d of dates || []) {
      if (r.start_date <= d && d <= r.end_date) keys.add(leaveKey(r.profile_id, d))
    }
  }
  return keys
}

/**
 * Which reminders are due right now? PURE.
 *
 * Re-asserts `published` and the live status even though the reader already
 * filters on both: a coach must never learn about an unpublished shift, and
 * this function is the last thing between a row and a push.
 *
 * @param {Array<object>} shifts  fetchApiShiftRows() rows
 * @param {object} ctx
 * @param {number} ctx.nowMs
 * @param {Record<string,string>} [ctx.tzByLocation]  location_id -> IANA tz
 * @param {Set<string>} [ctx.onLeave]   leaveKey() values
 * @param {Set<string>} [ctx.sentKeys]  reminderKey() values already in the ledger
 * @returns {Array<{ shift: object, kind: string, startMs: number, fireAtMs: number, leadMinutes: number }>}
 */
export function dueShiftReminders(shifts, { nowMs, tzByLocation = {}, onLeave = new Set(), sentKeys = new Set() } = {}) {
  const due = []
  for (const s of shifts || []) {
    if (!s?.id || !s.profile_id) continue
    if (s.published !== true) continue
    if (s.status === 'cancelled') continue // `swapped` is a live shift owned by the taker
    if (onLeave.has(leaveKey(s.profile_id, s.shift_date))) continue
    if (sentKeys.has(reminderKey(s.id, s.profile_id))) continue
    const plan = reminderPlanFor(s, tzByLocation[s.location_id] || DEFAULT_TZ)
    if (!isReminderDue(plan, nowMs)) continue
    due.push({ shift: s, ...plan })
  }
  return due
}
```

- [ ] **Step 4: Run it, expect PASS, under two host timezones**

Run: `npx vitest run src/lib/shift-reminders.test.js && TZ=America/Los_Angeles npx vitest run src/lib/shift-reminders.test.js`
Expected: `32 passed` twice. (CLAUDE.md: test date code under Dublin *and* a US timezone.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/shift-reminders.js src/lib/shift-reminders.test.js
git commit -m "SHIFTREMIND.1 — the pure due-now rule: 20:00 the evening before an early start, else T-2h, DST-safe

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The message — studio, shift, times, and who you are on with

**Files:**
- Modify: `src/lib/shift-reminders.js`
- Modify: `src/lib/shift-reminders.test.js`

`fetchApiShiftRows` rows carry no block id. `shift_blocks` is `UNIQUE (location_id, template_id, block_date)` (mig 067), so `(location_id, shift_template_id, shift_date)` identifies the block. Fixtures use invented names only: the repo is public (`tests/fixture-pii.test.js`).

- [ ] **Step 1: Write the failing test**

Append to `src/lib/shift-reminders.test.js`:

```js
describe('coRosteredFirstNames + buildShiftReminderMessage', () => {
  const me = shift()
  const mate = (id, profileId, fullName, over = {}) =>
    shift({ id, profile_id: profileId, profiles: { id: profileId, full_name: fullName }, ...over })

  it('lists first names of other live, published coaches on the SAME block, A-Z', () => {
    const all = [
      me,
      mate('a2', 'coach-2', 'Sam Sample'),
      mate('a3', 'coach-3', 'Bo  Placeholder'),
      mate('a4', 'coach-4', 'Other Day', { shift_date: '2026-09-23' }),
      mate('a5', 'coach-5', 'Other Template', { shift_template_id: 'tpl-late' }),
      mate('a6', 'coach-6', 'Other Studio', { location_id: 'loc-2' }),
      mate('a7', 'coach-7', 'Dropped Out', { status: 'cancelled' }),
      mate('a8', 'coach-8', 'Draft Only', { published: false }),
    ]
    expect(coRosteredFirstNames(me, all)).toEqual(['Bo', 'Sam'])
  })

  it('leaves out a colleague who is on approved leave that day', () => {
    const all = [me, mate('a2', 'coach-2', 'Sam Sample')]
    expect(coRosteredFirstNames(me, all, new Set([leaveKey('coach-2', '2026-09-22')]))).toEqual([])
  })

  it('evening-before copy says "tomorrow" and names the studio, template, time range and colleagues', () => {
    expect(buildShiftReminderMessage({
      shift: me, locationName: 'Studio North', coNames: ['Bo', 'Sam'], nowMs: at('2026-09-21T19:00:00Z'),
    })).toEqual({
      title: 'Shift tomorrow at 6:00am',
      body: 'Studio North · Early · 6:00am-2:00pm · with Bo and Sam',
    })
  })

  it('a catch-up that fires on the day says "today", and no colleagues means no "with"', () => {
    expect(buildShiftReminderMessage({
      shift: me, locationName: 'Studio North', coNames: [], nowMs: at('2026-09-22T04:00:00Z'),
    })).toEqual({ title: 'Shift today at 6:00am', body: 'Studio North · Early · 6:00am-2:00pm' })
  })

  it('"tomorrow" is the DUBLIN tomorrow: 23:30 UTC on 21 Sep is already 22 Sep in Dublin', () => {
    expect(buildShiftReminderMessage({
      shift: me, locationName: 'Studio North', nowMs: at('2026-09-21T23:30:00Z'),
    }).title).toBe('Shift today at 6:00am')
  })

  it('three colleagues read "A, B and C"; the effective (overridden) times are the ones shown', () => {
    const moved = shift({ start_time_override: '07:00:00', end_time_override: '11:30:00' })
    expect(buildShiftReminderMessage({
      shift: moved, locationName: 'Studio North', coNames: ['Al', 'Bo', 'Cy'], nowMs: at('2026-09-21T19:00:00Z'),
    }).body).toBe('Studio North · Early · 7:00am-11:30am · with Al, Bo and Cy')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/shift-reminders.test.js`
Expected: `6 failed | 32 passed`, with `TypeError: coRosteredFirstNames is not a function` and `TypeError: buildShiftReminderMessage is not a function`.

- [ ] **Step 3: Minimal implementation**

In `src/lib/shift-reminders.js` replace the three import lines with:

```js
import { localToUtc, formatLocalTime } from './push-reminders'
import { addDaysISO, dublinDayStr } from './dublin-time'
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'
```

and append:

```js
const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || ''
// shift_blocks is UNIQUE (location_id, template_id, block_date), so these
// three fields identify the block (the API row carries no block id).
const sameBlock = (a, b) =>
  a.location_id === b.location_id && a.shift_template_id === b.shift_template_id && a.shift_date === b.shift_date

/** First names of the OTHER coaches on the same block, A-Z, de-duplicated. */
export function coRosteredFirstNames(shift, allShifts, onLeave = new Set()) {
  const names = []
  for (const o of allShifts || []) {
    if (o.id === shift.id || o.profile_id === shift.profile_id) continue
    if (!sameBlock(o, shift)) continue
    if (o.published !== true || o.status === 'cancelled') continue
    if (onLeave.has(leaveKey(o.profile_id, o.shift_date))) continue
    const n = firstName(o.profiles?.full_name)
    if (n && !names.includes(n)) names.push(n)
  }
  return names.sort((a, b) => a.localeCompare(b))
}

function joinNames(names) {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Title + body. "today"/"tomorrow" is computed from the SHIFT's date against
 * the Dublin day of `nowMs`, not from the reminder kind: a catch-up reminder
 * for a 06:00 shift that fires at 05:00 must say "today".
 */
export function buildShiftReminderMessage({ shift, locationName, coNames = [], nowMs }) {
  const start = effectiveShiftStart(shift)
  const end = effectiveShiftEnd(shift)
  const today = dublinDayStr(nowMs)
  const dayWord = shift.shift_date === today
    ? 'today'
    : shift.shift_date === addDaysISO(today, 1) ? 'tomorrow' : `on ${shift.shift_date}`
  const range = end ? `${formatLocalTime(start)}-${formatLocalTime(end)}` : formatLocalTime(start)
  let body = [locationName, shift.shift_templates?.name, range].filter(Boolean).join(' · ')
  if (coNames.length) body += ` · with ${joinNames(coNames)}`
  return { title: `Shift ${dayWord} at ${formatLocalTime(start)}`, body }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/shift-reminders.test.js`
Expected: `38 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shift-reminders.js src/lib/shift-reminders.test.js
git commit -m "SHIFTREMIND.1 — reminder copy: studio, shift, effective times, co-rostered first names

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The cron arm — read, decide, claim, send, exactly once

**Files:**
- Modify: `src/lib/shift-reminders.js`
- Modify: `src/lib/shift-reminders.test.js`

Signatures you build on:
- `fetchApiShiftRows(db, { locationIds, startDate, endDate, profileId, publishedOnly = false, viewer = null })` → `{ rows, error }` (`src/lib/roster-read.js:191`). Called **without** `viewer`, so rows keep `profiles.full_name`.
- `notifyUsers(userIds, payload)` → `{ sent, skipped, invalidated, failed, emailed, email_failed }`, never throws (`src/lib/notify.js:51`). It is push plus the registry-gated email fallback for users with **zero** device tokens. `notifyUsersOnce` is NOT used: it dedups through `push_event_sends`, and this PR's ledger is `push_reminder_sends`.

**Why this arm claims BEFORE it sends, when the task and booking arms send first:** their late window is 15 minutes, so an unwritable ledger costs three duplicates. This arm has no late window (Task 4), so send-then-ledger with an unwritable ledger (mig 619 missing, an outage) would re-send the same reminder every 5 minutes for up to ten hours. CLAUDE.md's invariant on claim-before-send (*"turns a possible duplicate into a permanent silent loss on a process kill unless … something later re-opens"*) is answered two ways: a failed send **releases** the claim, and what is at risk in the millisecond gap is one staff reminder, not a customer receipt.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/shift-reminders.test.js`:

```js
// ── the cron arm ────────────────────────────────────────────────────────────

// Records every write against push_reminder_sends so a test can assert the
// ORDER: claim (insert) -> send -> count update, or claim -> send -> release.
function makeDb({ leave = [], leaveError = null, ledger = [], ledgerError = null, insertError = null, deleteError = null } = {}) {
  const writes = []
  const chain = (result, record) => {
    const b = {}
    for (const m of ['select', 'eq', 'in', 'lte', 'gte']) {
      b[m] = (...args) => { if (record && m === 'eq') record.where[args[0]] = args[1]; return b }
    }
    b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
    return b
  }
  return {
    writes,
    from(table) {
      if (table === 'time_off_requests') return chain({ data: leave, error: leaveError })
      if (table === 'push_reminder_sends') {
        const b = chain({ data: ledger, error: ledgerError })
        b.insert = (row) => { writes.push({ op: 'insert', row }); return chain({ data: null, error: insertError }) }
        b.delete = () => { const w = { op: 'delete', where: {} }; writes.push(w); return chain({ data: null, error: deleteError }, w) }
        b.update = (patch) => { const w = { op: 'update', patch, where: {} }; writes.push(w); return chain({ data: null, error: null }, w) }
        return b
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const LOCATIONS = [{ id: 'loc-1', name: 'Studio North', timezone: 'Europe/Dublin' }]
const NOW = at('2026-09-21T19:00:00Z') // 20:00 Dublin, Mon 21 Sep
const SENT = { sent: 1, skipped: 0, invalidated: 0, failed: 0, emailed: 0, email_failed: 0 }
const OWN_ROW = { entity_type: 'shift', entity_id: 'assign-1', recipient_id: 'coach-1' }

describe('runShiftReminders', () => {
  beforeEach(() => {
    fetchApiShiftRows.mockReset().mockResolvedValue({ rows: [shift()], error: null })
    notifyUsers.mockReset().mockResolvedValue({ ...SENT })
    logWarn.mockReset()
    logError.mockReset()
  })

  it('reads PUBLISHED shifts for the Dublin today + tomorrow at every location', async () => {
    await runShiftReminders(makeDb(), { nowMs: NOW, locations: LOCATIONS })
    expect(fetchApiShiftRows).toHaveBeenCalledWith(expect.anything(), {
      locationIds: ['loc-1'], startDate: '2026-09-21', endDate: '2026-09-22', publishedOnly: true,
    })
  })

  it('claims the ledger row, THEN sends on the shift_reminder category, then records the counts', async () => {
    const db = makeDb()
    let writesAtSend = null
    notifyUsers.mockImplementation(async () => { writesAtSend = db.writes.map((w) => w.op); return { ...SENT } })

    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })

    expect(writesAtSend).toEqual(['insert']) // the claim was already written when the push went out
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(notifyUsers).toHaveBeenCalledWith(['coach-1'], {
      title: 'Shift tomorrow at 6:00am',
      body: 'Studio North · Early · 6:00am-2:00pm',
      category: 'shift_reminder',
      emailSubject: 'Shift tomorrow at 6:00am',
      data: { type: 'shift_reminder', assignment_id: 'assign-1', block_date: '2026-09-22', location_id: 'loc-1', lead_minutes: 600 },
    })
    expect(db.writes).toEqual([
      { op: 'insert', row: { ...OWN_ROW, lead_time_minutes: 600, push_count: 0, push_invalidated: 0 } },
      { op: 'update', patch: { push_count: 1, push_invalidated: 0 }, where: OWN_ROW },
    ])
    expect(summary).toMatchObject({ shift_candidates: 1, shift_pushed: 1, shift_skipped_dup: 0, shift_send_failed: 0, shift_claim_failed: 0 })
  })

  it('second run in the same window: the ledger row stops it, nothing is sent or written', async () => {
    const db = makeDb({ ledger: [{ entity_id: 'assign-1', recipient_id: 'coach-1' }] })
    const summary = await runShiftReminders(db, { nowMs: NOW + 5 * 60 * 1000, locations: LOCATIONS })
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
    expect(summary).toMatchObject({ shift_candidates: 1, shift_skipped_dup: 1, shift_pushed: 0 })
  })

  it('two overlapping ticks: the loser hits the unique key (23505) on its claim and sends nothing', async () => {
    const db = makeDb({ insertError: { code: '23505' } })
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ shift_skipped_dup: 1, shift_claim_failed: 0 })
    expect(logError).not.toHaveBeenCalled()
  })

  it('the claim cannot be written (e.g. mig 619 not applied -> 23514): NOT sent, logged at error level', async () => {
    const db = makeDb({ insertError: { code: '23514', message: 'violates check constraint' } })
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ shift_claim_failed: 1, shift_pushed: 0 })
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('a pipeline failure RELEASES the claim, so the next tick retries', async () => {
    notifyUsers.mockResolvedValue({ ...SENT, sent: 0, failed: 1 })
    const db = makeDb()
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(db.writes.map((w) => w.op)).toEqual(['insert', 'delete'])
    expect(db.writes[1].where).toEqual(OWN_ROW)
    expect(summary).toMatchObject({ shift_send_failed: 1, shift_pushed: 0 })
  })

  it('a throwing sender is treated the same way: released, counted, never rethrown', async () => {
    notifyUsers.mockRejectedValue(new Error('expo down'))
    const db = makeDb()
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(db.writes.map((w) => w.op)).toEqual(['insert', 'delete'])
    expect(summary.shift_send_failed).toBe(1)
  })

  it('a failed release is logged at error level: that reminder will not retry', async () => {
    notifyUsers.mockResolvedValue({ ...SENT, sent: 0, failed: 1 })
    await runShiftReminders(makeDb({ deleteError: { message: 'boom' } }), { nowMs: NOW, locations: LOCATIONS })
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('an opted-out / no-device coach (nothing sent, nothing failed) KEEPS the claim: there is nothing to retry against', async () => {
    notifyUsers.mockResolvedValue({ ...SENT, sent: 0, skipped: 1 })
    const db = makeDb()
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(db.writes.map((w) => w.op)).toEqual(['insert', 'update'])
    expect(summary).toMatchObject({ shift_skipped_no_recipient: 1, shift_pushed: 0 })
  })

  it('an email-fallback delivery counts as delivered', async () => {
    notifyUsers.mockResolvedValue({ ...SENT, sent: 0, emailed: 1 })
    const db = makeDb()
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(db.writes.map((w) => w.op)).toEqual(['insert', 'update'])
    expect(summary).toMatchObject({ shift_emailed: 1, shift_send_failed: 0 })
  })

  it('a coach on approved leave gets nothing, and is not named to colleagues', async () => {
    const mate = shift({ id: 'assign-9', profile_id: 'coach-9', profiles: { id: 'coach-9', full_name: 'Sam Sample' } })
    fetchApiShiftRows.mockResolvedValue({ rows: [shift(), mate], error: null })
    const db = makeDb({ leave: [{ profile_id: 'coach-9', status: 'approved', start_date: '2026-09-22', end_date: '2026-09-22' }] })
    await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(notifyUsers.mock.calls[0][0]).toEqual(['coach-1'])
    expect(notifyUsers.mock.calls[0][1].body).toBe('Studio North · Early · 6:00am-2:00pm')
  })

  it('two coaches on one block each get their own reminder naming the other', async () => {
    const mate = shift({ id: 'assign-9', profile_id: 'coach-9', profiles: { id: 'coach-9', full_name: 'Sam Sample' } })
    fetchApiShiftRows.mockResolvedValue({ rows: [shift(), mate], error: null })
    await runShiftReminders(makeDb(), { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers.mock.calls.map(([ids, p]) => [ids[0], p.body])).toEqual([
      ['coach-1', 'Studio North · Early · 6:00am-2:00pm · with Sam'],
      ['coach-9', 'Studio North · Early · 6:00am-2:00pm · with Alex'],
    ])
  })

  it('leave read failure fails OPEN: the reminder still goes, and it is logged', async () => {
    const db = makeDb({ leaveError: { message: 'boom' } })
    await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalled()
  })

  it('ledger read failure fails CLOSED for this tick: throws before any claim or send', async () => {
    const db = makeDb({ ledgerError: { message: 'boom' } })
    await expect(runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })).rejects.toThrow(/ledger read failed/)
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })

  it('a shift read failure throws; no locations means no reads at all', async () => {
    fetchApiShiftRows.mockResolvedValue({ rows: [], error: { message: 'down' } })
    await expect(runShiftReminders(makeDb(), { nowMs: NOW, locations: LOCATIONS })).rejects.toThrow(/shift read failed/)
    fetchApiShiftRows.mockClear()
    const summary = await runShiftReminders(makeDb(), { nowMs: NOW, locations: [] })
    expect(fetchApiShiftRows).not.toHaveBeenCalled()
    expect(summary.shift_candidates).toBe(0)
  })

  it('nothing due means the ledger is never touched', async () => {
    const db = makeDb()
    const from = vi.spyOn(db, 'from')
    await runShiftReminders(db, { nowMs: at('2026-09-21T12:00:00Z'), locations: LOCATIONS })
    expect(from.mock.calls.map(([t]) => t)).toEqual(['time_off_requests'])
    expect(notifyUsers).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/shift-reminders.test.js`
Expected: `16 failed | 38 passed`, every failure `TypeError: runShiftReminders is not a function`.

- [ ] **Step 3: Minimal implementation**

In `src/lib/shift-reminders.js` add three imports under the existing three:

```js
import { fetchApiShiftRows } from './roster-read'
import { notifyUsers } from './notify'
import { logWarn, logError } from './log'
```

and append:

```js
function emptySummary() {
  return {
    shift_candidates: 0,
    shift_pushed: 0,
    shift_emailed: 0,
    shift_skipped_dup: 0,
    shift_skipped_no_recipient: 0,
    shift_send_failed: 0,
    shift_claim_failed: 0,
  }
}

// Narrow a push_reminder_sends delete/update to this shift's own ledger row.
const ownLedgerRow = (query, s) =>
  query.eq('entity_type', 'shift').eq('entity_id', s.id).eq('recipient_id', s.profile_id)

/**
 * The cron arm. Reads today's + tomorrow's PUBLISHED live shifts at every
 * location, decides what is due, and sends each reminder once.
 *
 * CLAIM BEFORE SEND, unlike the task and booking arms (send, then ledger).
 * Their late window is 15 minutes, so an unwritable ledger costs three
 * duplicates. This arm has no late window (see the header): if the ledger row
 * cannot be written (mig 619 not applied yet, a constraint, an outage), a
 * send-then-ledger order would re-send the same reminder every 5 minutes for
 * up to ten hours. So the ledger row is inserted first, the unique key
 * settles a race between two overlapping ticks, and a send that fails
 * outright RELEASES the claim so the next tick retries. The cost is CLAUDE.md's
 * "claim before send" trade: a process killed in the few milliseconds between
 * the claim and the send loses that one reminder. For a staff reminder that
 * is the right side of the trade; for a customer receipt it would not be.
 *
 * Failure posture:
 *   - shift read fails   -> throw (the route logs it; nothing was sent).
 *   - leave read fails   -> fail OPEN: a reminder to someone on holiday is
 *                           mild, a lost reminder is not.
 *   - ledger read fails  -> throw: fail CLOSED for this tick, next tick retries.
 *   - claim insert fails -> that reminder is NOT sent, logged at error level.
 *   - send fails         -> claim released, next tick retries.
 *
 * @param {object} db  service-role supabase client
 * @param {object} opts
 * @param {number} [opts.nowMs]
 * @param {Array<{id:string,name?:string,timezone?:string}>} opts.locations
 */
export async function runShiftReminders(db, { nowMs = Date.now(), locations = [] } = {}) {
  const summary = emptySummary()
  const locationIds = locations.map((l) => l.id).filter(Boolean)
  if (locationIds.length === 0) return summary

  const today = dublinDayStr(nowMs)
  const tomorrow = addDaysISO(today, 1)
  const tzByLocation = Object.fromEntries(locations.map((l) => [l.id, l.timezone || DEFAULT_TZ]))
  const nameByLocation = Object.fromEntries(locations.map((l) => [l.id, l.name || '']))

  // Two days across the estate is tens of rows, far under the 1,000-row cap.
  // publishedOnly is the D1 rule: coaches never see an unpublished shift.
  const { rows, error: shiftErr } = await fetchApiShiftRows(db, {
    locationIds, startDate: today, endDate: tomorrow, publishedOnly: true,
  })
  if (shiftErr) throw new Error(`shift read failed: ${shiftErr.message || shiftErr}`)
  if (rows.length === 0) return summary

  let onLeave = new Set()
  const profileIds = [...new Set(rows.map((r) => r.profile_id).filter(Boolean))]
  const { data: leaveRows, error: leaveErr } = await db
    .from('time_off_requests')
    .select('profile_id, start_date, end_date, status')
    .eq('status', 'approved')
    .in('profile_id', profileIds)
    .lte('start_date', tomorrow)
    .gte('end_date', today)
  if (leaveErr) logWarn('shift-reminders', 'leave read failed — reminding without the leave check', { err: leaveErr })
  else onLeave = leaveKeysFor(leaveRows, [today, tomorrow])

  const timeDue = dueShiftReminders(rows, { nowMs, tzByLocation, onLeave })
  if (timeDue.length === 0) return summary
  summary.shift_candidates = timeDue.length

  // One batched ledger read, only once something is time-due (most ticks: never).
  const { data: ledgerRows, error: ledgerErr } = await db
    .from('push_reminder_sends')
    .select('entity_id, recipient_id')
    .eq('entity_type', 'shift')
    .in('entity_id', timeDue.map((d) => d.shift.id))
  if (ledgerErr) throw new Error(`reminder ledger read failed: ${ledgerErr.message || ledgerErr}`)
  const sentKeys = new Set((ledgerRows || []).map((r) => reminderKey(r.entity_id, r.recipient_id)))

  const fresh = dueShiftReminders(rows, { nowMs, tzByLocation, onLeave, sentKeys })
  summary.shift_skipped_dup = timeDue.length - fresh.length

  for (const d of fresh) {
    const s = d.shift
    const { error: claimErr } = await db.from('push_reminder_sends').insert({
      entity_type: 'shift',
      entity_id: s.id,
      recipient_id: s.profile_id,
      lead_time_minutes: d.leadMinutes,
      push_count: 0,
      push_invalidated: 0,
    })
    if (claimErr) {
      if (claimErr.code === '23505') { summary.shift_skipped_dup++; continue } // an overlapping tick claimed it
      summary.shift_claim_failed++
      logError('shift-reminders', 'ledger claim failed — reminder NOT sent (without a ledger row it would repeat every 5 minutes)', { err: claimErr, assignment: s.id })
      continue
    }

    const { title, body } = buildShiftReminderMessage({
      shift: s,
      locationName: nameByLocation[s.location_id],
      coNames: coRosteredFirstNames(s, rows, onLeave),
      nowMs,
    })
    let result = null
    try {
      result = await notifyUsers([s.profile_id], {
        title,
        body,
        category: 'shift_reminder',
        emailSubject: title,
        data: {
          type: 'shift_reminder',
          assignment_id: s.id,
          block_date: s.shift_date,
          location_id: s.location_id,
          lead_minutes: d.leadMinutes,
        },
      })
    } catch (err) {
      logWarn('shift-reminders', 'notify threw', { err: err?.message, assignment: s.id })
    }

    const delivered = !!result && ((result.sent || 0) > 0 || (result.emailed || 0) > 0)
    if (!result || (!delivered && (result.failed || 0) > 0)) {
      summary.shift_send_failed++
      const { error: releaseErr } = await ownLedgerRow(db.from('push_reminder_sends').delete(), s)
      if (releaseErr) logError('shift-reminders', 'claim release failed — this reminder will NOT retry', { err: releaseErr, assignment: s.id })
      continue
    }

    // Diagnostics only (mig 169: push_count / push_invalidated).
    const { error: countErr } = await ownLedgerRow(db.from('push_reminder_sends').update({
      push_count: result.sent || 0,
      push_invalidated: result.invalidated || 0,
    }), s)
    if (countErr) logWarn('shift-reminders', 'ledger count update failed', { err: countErr, assignment: s.id })

    if ((result.sent || 0) > 0) summary.shift_pushed++
    else if ((result.emailed || 0) > 0) summary.shift_emailed++
    else summary.shift_skipped_no_recipient++
  }

  return summary
}
```

Every column named above exists: `time_off_requests(profile_id, start_date, end_date, status)` in mig 011; `push_reminder_sends(entity_type, entity_id, recipient_id, lead_time_minutes, push_count, push_invalidated)` in mig 169.

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/shift-reminders.test.js && npm run check:select-columns`
Expected: `54 passed`; the column check exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shift-reminders.js src/lib/shift-reminders.test.js
git commit -m "SHIFTREMIND.1 — the shift arm: published live shifts, leave-aware, claim-before-send on push_reminder_sends

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Wire the arm into `/api/cron/send-push-reminders`

**Files:**
- Modify: `src/app/api/cron/send-push-reminders/route.js`
- Create: `src/app/api/cron/send-push-reminders/route.test.js` (the route has none today)

No new cron, no `vercel.json` entry, no new heartbeat row: `vercel.json` already carries 79 crons, this one already ticks every 5 minutes (`*/5 * * * *`), and its heartbeat row (`send-push-reminders`, mig 171) keeps covering it. The arm must be isolated exactly like the task and booking blocks, so a shift failure never costs a task reminder or the heartbeat.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/cron/send-push-reminders/route.test.js`:

```js
// SHIFTREMIND.1 — the shift arm's WIRING in the push-reminder cron. The rule
// itself is pinned in src/lib/shift-reminders.test.js; what is locked here is
// that the route calls it with the clock and the locations it already read,
// reports its counters, and survives it throwing.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const LOCATIONS = [{ id: 'loc-1', name: 'Studio North', timezone: 'Europe/Dublin', notification_config: null }]

function makeBuilder(table) {
  const b = {}
  for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lte', 'order', 'range']) b[m] = () => b
  b.then = (resolve, reject) =>
    Promise.resolve({ data: table === 'locations' ? LOCATIONS : [], error: null }).then(resolve, reject)
  return b
}
const fakeDb = { from: (table) => makeBuilder(table) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => ({ sent: 0, skipped: 0, invalidated: 0, failed: 0 })) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/shift-reminders', () => ({ runShiftReminders: vi.fn() }))

const { GET } = await import('./route.js')
const { runShiftReminders } = await import('@/lib/shift-reminders')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError } = await import('@/lib/log')

const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  runShiftReminders.mockResolvedValue({
    shift_candidates: 2, shift_pushed: 1, shift_emailed: 0,
    shift_skipped_dup: 1, shift_skipped_no_recipient: 0, shift_send_failed: 0,
  })
})

describe('GET /api/cron/send-push-reminders — shift arm', () => {
  it('401 without the cron bearer, and the shift arm never runs', async () => {
    const res = await GET(req('Bearer wrong'))
    expect(res.status).toBe(401)
    expect(runShiftReminders).not.toHaveBeenCalled()
  })

  it('runs the shift arm with the tick clock and the location rows (name + timezone included)', async () => {
    const before = Date.now()
    await GET(req())
    expect(runShiftReminders).toHaveBeenCalledTimes(1)
    const [db, opts] = runShiftReminders.mock.calls[0]
    expect(db).toBe(fakeDb)
    expect(opts.locations).toEqual(LOCATIONS)
    expect(opts.nowMs).toBeGreaterThanOrEqual(before)
    expect(opts.nowMs).toBeLessThanOrEqual(Date.now())
  })

  it('reports the shift counters beside the task and booking ones', async () => {
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ ok: true, task_pushed: 0, booking_pushed: 0, shift_candidates: 2, shift_pushed: 1, shift_skipped_dup: 1 })
  })

  it('a throwing shift arm is logged and costs nothing else: 200, heartbeat stamped', async () => {
    runShiftReminders.mockRejectedValue(new Error('reminder ledger read failed: boom'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(logError).toHaveBeenCalledWith('cron-push-reminders', 'shift block threw', expect.anything())
    expect(stampHeartbeat).toHaveBeenCalledWith('send-push-reminders')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/cron/send-push-reminders/route.test.js`
Expected: `3 failed | 1 passed`. The first failure reads `expected "vi.fn()" to be called 1 times, but got 0 times`.

- [ ] **Step 3: Minimal implementation (three edits to `route.js`)**

(a) Imports, under `import { selectAll } from '@/lib/select-all'` (line 40):

```js
import { runShiftReminders } from '@/lib/shift-reminders'
```

(b) The locations read (line 75) also needs the studio's name for the message. Change

```js
    .select('id, timezone, notification_config')
```

to

```js
    .select('id, name, timezone, notification_config')
```

(c) Directly ABOVE the line `if (Object.values(summary).some(v => Array.isArray(v) ? v.length > 0 : v > 0)) {` (line 374), insert:

```js
  // -------------------------- SHIFTS --------------------------
  // SHIFTREMIND.1 — one reminder per published shift assignment: 20:00 Dublin
  // the evening before for a start before 08:00, otherwise 2 hours before.
  // The rule, the ledger use and the failure posture live in
  // src/lib/shift-reminders.js. Isolated like the two blocks above: a shift
  // failure must never cost a task or booking reminder, or the heartbeat.
  try {
    Object.assign(summary, await runShiftReminders(db, { nowMs, locations: locations || [] }))
  } catch (err) {
    logError('cron-push-reminders', 'shift block threw', { err })
  }

```

Also extend the file's header comment (the `// Routing:` list, lines 18-25) with one bullet: `//   - Shifts (published, live shift_assignments) → push to the coach, category='shift_reminder'. See src/lib/shift-reminders.js.`

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/cron/send-push-reminders/route.test.js src/lib/shift-reminders.test.js`
Expected: `4 passed` and `54 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/send-push-reminders/route.js src/app/api/cron/send-push-reminders/route.test.js
git commit -m "SHIFTREMIND.1 — send-push-reminders runs the shift arm, isolated from tasks and bookings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### PR gate

- [ ] **Focused tests:**

```bash
npx vitest run src/lib/shift-reminders.test.js src/lib/shift-reminder-registration.test.js src/app/api/cron/send-push-reminders/route.test.js mobile/lib/notification-nav.test.js src/lib/push-channels.test.js shared/permission-bundles.test.js src/lib/shared-permissions.test.js tests/shared-pair-sync.test.js tests/ota-trigger-paths.test.js
```

Expected: all passed. (`shared-pair-sync` proves the new `src/lib` exports collide with no `shared/` export name.)

- [ ] **Lint and the relevant checks:**

```bash
npm run lint && npm run check:guardrails && npm run check:select-columns && npm run check:route-guards && npm run check:rls-restrictive && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every command exits 0. `check:route-guards` still sees `CRON_SECRET` in the cron route. `check:ota-paths` passes because no new top-level directory was added under `mobile/`; **the merge WILL publish an OTA** (`shared/**`, `mobile/lib/**`).

- [ ] **Open the PR.** Title: `SHIFTREMIND.1 — shift reminders: 20:00 the evening before an early start, otherwise 2 hours before`. The body must state, in this order: (1) **operator step first: apply mig 619 via Supabase MCP to `iyvtbjjxdggiadzwwvdj`, then `get_advisors`**; (2) merge between 08:00 and 20:00 Dublin; (3) the merge publishes an OTA; (4) the rule and the `swapped` correction; (5) email fallback is ON. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **CHANGELOG.** After `gh pr create`, add ONE row keyed `| #<PR> | SHIFTREMIND.1 — … |` directly under the table header in `docs/CHANGELOG.md` (never edit another row: `merge=union` duplicates an edited row), commit, push.

- [ ] **After merge, verify live (read-only).** On the next tick inside a reminder window, the cron's JSON (Vercel runtime logs, scope `cron-push-reminders`, message `tick`) carries `shift_candidates` / `shift_pushed`. A non-zero `shift_claim_failed` means mig 619 is not applied.
