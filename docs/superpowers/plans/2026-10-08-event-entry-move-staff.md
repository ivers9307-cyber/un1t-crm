# Event entry move (staff PR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can move one event entry (a `race_registrations` row, with its people and payment) from one event to another, across studios, with a history row, a "your entry has moved" email, and a Move anyway choice when the target wave is full.

**Architecture:** One pure rules module (`src/lib/registration-move.js`) decides eligibility and the price gap; one Postgres function (`move_race_registration`, mig 708) performs the writes atomically, cloning the team when the move crosses studios; two staff routes call the module; the teams page gains a dialog, a chip and a footer. The moved email reuses the confirmation shell with `kind: 'moved'` copy on the event.

**Tech Stack:** Next.js 16 App Router routes (service-role Supabase client), Postgres/plpgsql, Zod, vitest (node for libs/routes, jsdom for components), React + Tailwind `un1t-*` tokens, Postmark via `sendTransactionalEmail`.

**Spec:** `docs/superpowers/specs/2026-10-08-event-entry-move-design.md` (read it first; it holds the rules table and the decisions).

**Worktree:** `~/code/un1t-crm-evmove`, branch `event-registration-move`, off `origin/main`. Run every command from there. Never `git stash`.

**House rules that bite here** (from `CLAUDE.md`):
- Every `/api` route runs on the service role: enforce access in code, 404 not 403 for ids.
- Destructure `error` on every Supabase read and write. Builders are thenables: `try { await … } catch {}`, never `.catch`.
- A new table and a new function are closed to clients: the migration states `revoke all … from anon, authenticated` and `revoke execute … from public, anon, authenticated`.
- Column names in a `.select()` are checked by `check:select-columns` against the migrations; the function name by `check:rpc-names`.
- Customer-facing copy is operator-editable (the two `moved_email_*` columns).
- Never render event capacity to customers; the targets endpoint is staff-only.
- Every `<button>` inside a `<form>` carries `type`.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/708_registration_moves.sql` | Create `registration_moves`, add `race_events.moved_email_subject/intro`, create `move_race_registration()`. |
| `src/lib/registration-move.js` | Error codes, `entryLabel`, `entryHeadcount`, `computePriceGapCents`, `evaluateMove` (pure), `listMoveTargets`, `moveRegistration` (db). |
| `src/lib/registration-move.test.js` | Unit tests for every rule, the gap, the label, the headcount, the loaders. |
| `src/lib/event-email.js` | Two new merge tags, `old_event_name` and `old_when`. |
| `src/lib/race-confirmations.js` | `buildMovedDefaults`, `sendRegistrationMovedEmail`. |
| `src/lib/contact-events.js` | `EVENT_TYPES.RACE_MOVED`. |
| `src/app/api/event-registrations/[id]/move-targets/route.js` | GET eligible targets for staff. |
| `src/app/api/event-registrations/[id]/move/route.js` | POST the move. |
| `src/app/api/events/[id]/teams/route.js` | GET also returns `last_move` per entry and `moved_out`. |
| `src/app/api/events/[id]/route.js` | UpdateSchema + loadRace carry the two moved-email columns. |
| `src/components/RaceEventForm.jsx` | Emails section gains "Entry moved" fields. |
| `src/components/MoveEntryDialog.jsx` | The dialog. |
| `src/components/RaceTeamsManager.jsx` | Move action, chip, footer. |
| `src/app/(members)/events/[id]/teams/page.js` | Passes `canMoveEntries`. |
| `src/lib/openapi.js` | Registers the two routes. |
| `docs/changelog/entries/<PR>.md` | One row, after `gh pr create`. |

---

### Task 1: Migration 708

**Files:**
- Create: `supabase/migrations/708_registration_moves.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 708 — EVENT-MOVE.1: move an event entry to another event.
--
-- WHY. Staff had no way to carry a customer's entry (team, people, payment,
-- history) from one event to another: the only options were cancel-and-rebook
-- (money and QR lost) or a note. See docs/superpowers/specs/
-- 2026-10-08-event-entry-move-design.md.
--
-- WHAT. (1) registration_moves: one row per move, the history behind the
-- "Moved from" chip and the source event's "moved out" footer. (2) Two
-- operator-editable copy columns on race_events for the "your entry has
-- moved" email (NULL = the built-in default, same pattern as mig 385).
-- (3) move_race_registration(): the writes of a move in ONE transaction.
-- Every eligibility rule runs in JS first (src/lib/registration-move.js);
-- the function only writes, and leans on UNIQUE(race_event_id, team_id) as
-- the last line of defence. When the target studio differs from the source
-- studio the team is CLONED into the target studio (teams are unique per
-- studio, and team-member edits are authorised on the team's home studio);
-- the original team row keeps the source event's history.
--
-- Service role only: no client grant on the table, no client EXECUTE on the
-- function (mig 667/677 defaults, stated explicitly). Safe to apply before
-- the code deploys (nothing reads any of it until then).

create table if not exists public.registration_moves (
  id               uuid primary key default gen_random_uuid(),
  registration_id  uuid not null references public.race_registrations(id) on delete cascade,
  from_event_id    uuid references public.race_events(id) on delete set null,
  from_wave_id     uuid references public.race_waves(id) on delete set null,
  to_event_id      uuid references public.race_events(id) on delete set null,
  to_wave_id       uuid references public.race_waves(id) on delete set null,
  from_team_id     uuid references public.teams(id) on delete set null,
  to_team_id       uuid references public.teams(id) on delete set null,
  headcount        int not null default 1,
  price_gap_cents  int not null default 0,
  forced           boolean not null default false,
  actor_type       text not null check (actor_type in ('staff', 'host', 'agent')),
  actor_id         uuid,
  actor_name       text not null default '',
  note             text,
  notified_at      timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists registration_moves_registration_idx on public.registration_moves (registration_id, created_at desc);
create index if not exists registration_moves_from_event_idx on public.registration_moves (from_event_id);
create index if not exists registration_moves_to_event_idx on public.registration_moves (to_event_id);

alter table public.registration_moves enable row level security;
revoke all on public.registration_moves from anon, authenticated;

comment on table public.registration_moves is
  'EVENT-MOVE.1 (mig 708): one row per move of a race_registrations row to another event. Service role only. from_team_id = to_team_id unless the move crossed studios (then to_team_id is the clone).';

alter table public.race_events
  add column if not exists moved_email_subject text,
  add column if not exists moved_email_intro text;

comment on column public.race_events.moved_email_subject is 'EVENT-MOVE.1 — subject of the "your entry has moved" email; NULL = default.';
comment on column public.race_events.moved_email_intro is 'EVENT-MOVE.1 — intro copy of the "your entry has moved" email; NULL = default.';

create or replace function public.move_race_registration(
  p_registration_id uuid,
  p_to_event_id     uuid,
  p_to_wave_id      uuid,
  p_headcount       int,
  p_price_gap_cents int,
  p_forced          boolean,
  p_actor_type      text,
  p_actor_id        uuid,
  p_actor_name      text,
  p_note            text
) returns public.registration_moves
language plpgsql
set search_path = public
as $$
declare
  v_reg        race_registrations%rowtype;
  v_from_loc   uuid;
  v_to_loc     uuid;
  v_team_name  text;
  v_candidate  text;
  v_n          int := 1;
  v_to_team_id uuid;
  v_move       registration_moves;
begin
  select * into v_reg from race_registrations where id = p_registration_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select location_id into v_from_loc from race_events where id = v_reg.race_event_id;
  select location_id into v_to_loc from race_events where id = p_to_event_id;
  if v_to_loc is null then
    raise exception 'target_not_found' using errcode = 'P0002';
  end if;

  v_to_team_id := v_reg.team_id;

  -- Cross-studio: clone the team into the target studio.
  if v_reg.team_id is not null and v_from_loc is distinct from v_to_loc then
    select name into v_team_name from teams where id = v_reg.team_id;
    v_candidate := v_team_name;
    while exists (select 1 from teams where location_id = v_to_loc and name = v_candidate) loop
      v_n := v_n + 1;
      v_candidate := v_team_name || ' (' || v_n || ')';
    end loop;
    insert into teams (location_id, name, size, captain_contact_id, notes)
      select v_to_loc, v_candidate, size, captain_contact_id, notes
      from teams where id = v_reg.team_id
      returning id into v_to_team_id;
    insert into team_members (team_id, contact_id, name, email, role, is_member,
                              member_validation_status, member_contact_id, member_validated_at)
      select v_to_team_id, contact_id, name, email, role, is_member,
             member_validation_status, member_contact_id, member_validated_at
      from team_members where team_id = v_reg.team_id;
  end if;

  update race_registrations
     set race_event_id = p_to_event_id,
         wave_id       = p_to_wave_id,
         team_id       = v_to_team_id,
         updated_at    = now()
   where id = p_registration_id;

  update race_payments
     set race_event_id = p_to_event_id
   where race_registration_id = p_registration_id;

  delete from event_reminder_sends where registration_id = p_registration_id;

  insert into registration_moves (
    registration_id, from_event_id, from_wave_id, to_event_id, to_wave_id,
    from_team_id, to_team_id, headcount, price_gap_cents, forced,
    actor_type, actor_id, actor_name, note
  ) values (
    p_registration_id, v_reg.race_event_id, v_reg.wave_id, p_to_event_id, p_to_wave_id,
    v_reg.team_id, v_to_team_id, coalesce(p_headcount, 1), coalesce(p_price_gap_cents, 0), coalesce(p_forced, false),
    p_actor_type, p_actor_id, coalesce(p_actor_name, ''), nullif(btrim(coalesce(p_note, '')), '')
  ) returning * into v_move;

  return v_move;
end
$$;

revoke execute on function public.move_race_registration(uuid, uuid, uuid, int, int, boolean, text, uuid, text, text)
  from public, anon, authenticated;

comment on function public.move_race_registration(uuid, uuid, uuid, int, int, boolean, text, uuid, text, text) is
  'EVENT-MOVE.1 (mig 708): the writes of an entry move in one transaction. Rules are checked in src/lib/registration-move.js before calling. Service role only.';
```

- [ ] **Step 2: Run the migration guards**

Run: `npm test -- tests/table-default-acl-guard.test.js tests/function-execute-guard.test.js tests/migration-duplicate-prefixes.test.js 2>&1 | tail -15`
Expected: all PASS (the table has its `revoke all`, the function its `revoke execute`, and 708 is a fresh prefix). If `migration-duplicate-prefixes` does not exist, skip it.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/708_registration_moves.sql
git commit -m "EVENT-MOVE.1 — mig 708: registration_moves, moved-email copy columns, move_race_registration()"
```

---

### Task 2: Pure helpers — label, headcount, price gap

**Files:**
- Create: `src/lib/registration-move.js`
- Create: `src/lib/registration-move.test.js`

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest'
import { entryLabel, entryHeadcount, computePriceGapCents } from './registration-move.js'

describe('entryLabel', () => {
  it('names a team of two or more by the team name', () => {
    expect(entryLabel({ teams: { name: 'The Crushers', team_members: [{ name: 'A' }, { name: 'B' }] } })).toBe('The Crushers')
  })
  it('names a team of one by the person, not the team', () => {
    expect(entryLabel({ teams: { name: 'Mark Kelly', team_members: [{ name: 'Mark Kelly', role: 'captain' }] } })).toBe('Mark Kelly')
  })
  it('names a team-less entry by its lead contact', () => {
    expect(entryLabel({ teams: null, contact: { first_name: 'Aoife', last_name: 'Byrne' } })).toBe('Aoife Byrne')
  })
  it('falls back to "Entry" when nothing is known', () => {
    expect(entryLabel({})).toBe('Entry')
  })
})

describe('entryHeadcount', () => {
  it('counts the team members', () => {
    expect(entryHeadcount({ teams: { size: 4, team_members: [{}, {}] } })).toBe(2)
  })
  it('falls back to teams.size when members are not loaded', () => {
    expect(entryHeadcount({ teams: { size: 3 } })).toBe(3)
  })
  it('is 1 for a team-less entry', () => {
    expect(entryHeadcount({ teams: null })).toBe(1)
    expect(entryHeadcount({})).toBe(1)
  })
})

describe('computePriceGapCents', () => {
  const source = { member_pricing_enabled: true, member_fee_cents: 2000, non_member_fee_cents: 3000 }
  const target = { member_pricing_enabled: true, member_fee_cents: 2500, non_member_fee_cents: 3500 }
  it('charges the member rate for members and the non-member rate otherwise', () => {
    const members = [{ is_member: true }, { is_member: false }]
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: target, members })).toBe(500 + 500)
  })
  it('is negative when the target is cheaper', () => {
    expect(computePriceGapCents({ sourceEvent: target, targetEvent: source, members: [{ is_member: false }] })).toBe(-500)
  })
  it('uses the non-member rate for everyone when member pricing is off', () => {
    const t = { member_pricing_enabled: false, member_fee_cents: 0, non_member_fee_cents: 3500 }
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: t, members: [{ is_member: true }] })).toBe(1500)
  })
  it('treats a missing fee as free', () => {
    expect(computePriceGapCents({ sourceEvent: {}, targetEvent: target, members: [{ is_member: false }] })).toBe(3500)
  })
  it('counts one person for a team-less entry', () => {
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: target, members: [] })).toBe(500)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/registration-move.test.js 2>&1 | tail -5`
Expected: FAIL, "Failed to resolve import ./registration-move.js".

- [ ] **Step 3: Write the helpers**

```js
// registration-move — move an event ENTRY (one race_registrations row: its
// people, its payment, its history) to another event. EVENT-MOVE.1.
//
// The unit is the entry, never the team: today every entry is a team (a solo
// is a team of one), and team-less single bookings are coming. Nothing here
// may assume `teams` is set.
//
// Split: the RULES are pure functions in this file (unit-tested with plain
// objects); the WRITES are one Postgres function, move_race_registration
// (mig 708), so a half-applied move cannot exist. Money is never touched: a
// price gap is computed, recorded and shown, nothing more.
//
// Spec: docs/superpowers/specs/2026-10-08-event-entry-move-design.md

import { wouldFit, spotsLeft } from './event-signups'
import { dublinTodayStr } from './dublin-time'
import { logError, logWarn } from './log'

export const MOVE_ERRORS = Object.freeze({
  NOT_FOUND: 'not_found',
  NOT_ACTIVE: 'not_active',
  CHECKED_IN: 'checked_in',
  SAME_EVENT: 'same_event',
  TARGET_UNAVAILABLE: 'target_unavailable',
  DIFFERENT_PAYEE: 'different_payee',
  ALREADY_ENTERED: 'already_entered',
  HEADCOUNT_NOT_ALLOWED: 'headcount_not_allowed',
  WAVE_REQUIRED: 'wave_required',
  WRONG_EVENT: 'wrong_event',
  WAVE_FULL: 'wave_full',
})

// Plain-English for the dialog. Keyed by code so the route never invents copy.
export const MOVE_ERROR_MESSAGES = Object.freeze({
  not_found: 'That entry no longer exists.',
  not_active: 'Only a confirmed entry or one awaiting payment can be moved.',
  checked_in: 'Someone on this entry has already checked in, so it cannot move.',
  same_event: 'That is the event the entry is already on. Use the wave select to change its time.',
  target_unavailable: 'The target event is not published or has already happened.',
  different_payee: 'The target event is paid to a different host, so the payment cannot follow.',
  already_entered: 'This team already has an entry on the target event.',
  headcount_not_allowed: 'The target event does not accept an entry of this size.',
  wave_required: 'Pick a time on the target event.',
  wrong_event: 'That time does not belong to the target event.',
  wave_full: 'That time is full.',
})

/** The team row's live roster, if loaded. Never assumes a team. */
function membersOf(registration) {
  const list = registration?.teams?.team_members
  return Array.isArray(list) ? list : []
}

/**
 * What the UI calls an entry: the team name for a team of two or more, else
 * the person (captain, lead contact), else "Entry".
 */
export function entryLabel(registration) {
  const team = registration?.teams || null
  const members = membersOf(registration)
  if (team?.name && (members.length > 1 || (members.length === 0 && Number(team.size) > 1))) return team.name
  const captain = members.find((m) => m?.role === 'captain') || members[0]
  if (captain?.name) return captain.name
  const c = registration?.contact
  const contactName = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim()
  if (contactName) return contactName
  if (team?.name) return team.name
  return 'Entry'
}

/** People on the entry: the loaded roster, else teams.size, else 1. */
export function entryHeadcount(registration) {
  const members = membersOf(registration)
  if (members.length > 0) return members.length
  const size = Number(registration?.teams?.size)
  return Number.isFinite(size) && size > 0 ? size : 1
}

/** Per-person ticket price on an event for a member / non-member, in cents. */
export function perPersonFeeCents(event, isMember) {
  const nonMember = Number(event?.non_member_fee_cents) || 0
  if (!event?.member_pricing_enabled) return nonMember
  return isMember ? (Number(event?.member_fee_cents) || 0) : nonMember
}

/**
 * (target per-person − source per-person) summed over the people on the
 * entry. Signed; 0 when prices match. A roster of zero (team-less entry)
 * counts as one non-member.
 */
export function computePriceGapCents({ sourceEvent, targetEvent, members }) {
  const roster = Array.isArray(members) && members.length > 0 ? members : [{ is_member: false }]
  let gap = 0
  for (const m of roster) {
    const isMember = m?.is_member === true
    gap += perPersonFeeCents(targetEvent, isMember) - perPersonFeeCents(sourceEvent, isMember)
  }
  return gap
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/registration-move.test.js 2>&1 | tail -5`
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/registration-move.js src/lib/registration-move.test.js
git commit -m "EVENT-MOVE.1 — entry label, headcount and price gap helpers"
```

---

### Task 3: The rules — `evaluateMove`

**Files:**
- Modify: `src/lib/registration-move.js`
- Modify: `src/lib/registration-move.test.js`

- [ ] **Step 1: Write the failing tests** (append to the test file)

```js
import { evaluateMove, MOVE_ERRORS } from './registration-move.js'

const TODAY = '2026-10-08'
function base(over = {}) {
  return {
    registration: { id: 'r1', status: 'confirmed', race_event_id: 'e1', wave_id: 'w1', team_id: 't1',
      teams: { id: 't1', name: 'The Crushers', size: 2, team_members: [{ is_member: false }, { is_member: false }] } },
    sourceEvent: { id: 'e1', host_id: null, location_id: 'L1', allowed_team_sizes: [1, 2, 4] },
    targetEvent: { id: 'e2', host_id: null, location_id: 'L1', active: true, status: 'published', race_date: '2026-10-25',
      capacity_mode: 'teams', allowed_team_sizes: [1, 2, 4], waves: [{ id: 'w9', capacity: 10 }] },
    targetWave: { id: 'w9', race_event_id: 'e2', capacity: 10 },
    targetWaveRegistrations: [],
    checkinCount: 0,
    existingOnTarget: null,
    force: false,
    today: TODAY,
    ...over,
  }
}

describe('evaluateMove', () => {
  it('passes a clean move', () => {
    expect(evaluateMove(base())).toEqual({ ok: true })
  })
  it('not_active for cancelled and no_show', () => {
    expect(evaluateMove(base({ registration: { ...base().registration, status: 'cancelled' } })).error).toBe(MOVE_ERRORS.NOT_ACTIVE)
    expect(evaluateMove(base({ registration: { ...base().registration, status: 'no_show' } })).error).toBe(MOVE_ERRORS.NOT_ACTIVE)
  })
  it('allows an entry awaiting payment', () => {
    expect(evaluateMove(base({ registration: { ...base().registration, status: 'pending_payment' } })).ok).toBe(true)
  })
  it('checked_in when anyone has checked in', () => {
    expect(evaluateMove(base({ checkinCount: 1 })).error).toBe(MOVE_ERRORS.CHECKED_IN)
  })
  it('same_event when the target is the source', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, id: 'e1' } })).error).toBe(MOVE_ERRORS.SAME_EVENT)
  })
  it('target_unavailable for draft, inactive or past events', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, status: 'draft' } })).error).toBe(MOVE_ERRORS.TARGET_UNAVAILABLE)
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, active: false } })).error).toBe(MOVE_ERRORS.TARGET_UNAVAILABLE)
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, race_date: '2026-10-07' } })).error).toBe(MOVE_ERRORS.TARGET_UNAVAILABLE)
  })
  it('a target on today is still available', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, race_date: TODAY } })).ok).toBe(true)
  })
  it('different_payee when host_id differs; NULL equals NULL', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, host_id: 'h1' } })).error).toBe(MOVE_ERRORS.DIFFERENT_PAYEE)
    expect(evaluateMove(base({ sourceEvent: { ...base().sourceEvent, host_id: 'h1' }, targetEvent: { ...base().targetEvent, host_id: 'h1' } })).ok).toBe(true)
  })
  it('allows a move to another studio', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, location_id: 'L2' } })).ok).toBe(true)
  })
  it('already_entered only at the same studio', () => {
    expect(evaluateMove(base({ existingOnTarget: { id: 'r7', status: 'confirmed' } })).error).toBe(MOVE_ERRORS.ALREADY_ENTERED)
    expect(evaluateMove(base({ existingOnTarget: { id: 'r7', status: 'cancelled' } })).ok).toBe(true)
    expect(evaluateMove(base({ existingOnTarget: { id: 'r7', status: 'confirmed' }, targetEvent: { ...base().targetEvent, location_id: 'L2' } })).ok).toBe(true)
  })
  it('headcount_not_allowed when the target does not accept the size', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, allowed_team_sizes: [1, 4] } })).error).toBe(MOVE_ERRORS.HEADCOUNT_NOT_ALLOWED)
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, allowed_team_sizes: null } })).ok).toBe(true)
  })
  it('wave_required when the target has waves and none was given', () => {
    expect(evaluateMove(base({ targetWave: null })).error).toBe(MOVE_ERRORS.WAVE_REQUIRED)
  })
  it('no wave needed when the target has no waves', () => {
    expect(evaluateMove(base({ targetWave: null, targetEvent: { ...base().targetEvent, waves: [] } })).ok).toBe(true)
  })
  it('wrong_event when the wave belongs elsewhere', () => {
    expect(evaluateMove(base({ targetWave: { id: 'w9', race_event_id: 'e3', capacity: 10 } })).error).toBe(MOVE_ERRORS.WRONG_EVENT)
  })
  it('wave_full in teams mode counts confirmed entries, with spots_left', () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, status: 'confirmed', team: { size: 1 } }))
    const r = evaluateMove(base({ targetWaveRegistrations: full }))
    expect(r.error).toBe(MOVE_ERRORS.WAVE_FULL)
    expect(r.spots_left).toBe(0)
  })
  it('wave_full in people mode needs room for the whole entry', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, status: 'confirmed', team: { size: 1 } }))
    const r = evaluateMove(base({ targetWaveRegistrations: nine, targetEvent: { ...base().targetEvent, capacity_mode: 'people' } }))
    expect(r.error).toBe(MOVE_ERRORS.WAVE_FULL)
    expect(r.spots_left).toBe(1)
  })
  it('force skips wave_full and nothing else', () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, status: 'confirmed', team: { size: 1 } }))
    expect(evaluateMove(base({ targetWaveRegistrations: full, force: true })).ok).toBe(true)
    expect(evaluateMove(base({ checkinCount: 1, force: true })).error).toBe(MOVE_ERRORS.CHECKED_IN)
  })
  it('an uncapped wave always fits', () => {
    expect(evaluateMove(base({ targetWave: { id: 'w9', race_event_id: 'e2', capacity: null } })).ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/registration-move.test.js 2>&1 | tail -5`
Expected: FAIL, "evaluateMove is not a function" (or not exported).

- [ ] **Step 3: Implement `evaluateMove`** (append to `registration-move.js`)

```js
const LIVE_STATUSES = new Set(['confirmed', 'pending_payment'])

/** Same payee when host_id matches, NULL (UN1T on Revolut) equal to NULL. */
export function samePayee(a, b) {
  return (a?.host_id || null) === (b?.host_id || null)
}

/**
 * Every rule in the spec's table, in order, on already-loaded rows. Pure.
 *
 * @param {object} args
 * @param {object} args.registration   race_registrations row with teams.team_members
 * @param {object} args.sourceEvent    race_events row
 * @param {object} args.targetEvent    race_events row with waves[]
 * @param {object|null} args.targetWave   race_waves row (null when none given)
 * @param {Array} args.targetWaveRegistrations  live rows in that wave ({status, team:{size}})
 * @param {number} args.checkinCount   race_checkins rows for the entry
 * @param {object|null} args.existingOnTarget  another entry of the same team on the target
 * @param {boolean} [args.force]       true = skip wave_full
 * @param {string} [args.today]        YYYY-MM-DD in Europe/Dublin
 * @returns {{ ok: true } | { ok: false, error: string, spots_left?: number|null }}
 */
export function evaluateMove({
  registration, sourceEvent, targetEvent, targetWave, targetWaveRegistrations,
  checkinCount, existingOnTarget, force = false, today = dublinTodayStr(),
}) {
  const fail = (error, extra = {}) => ({ ok: false, error, ...extra })
  if (!registration) return fail(MOVE_ERRORS.NOT_FOUND)
  if (!LIVE_STATUSES.has(registration.status)) return fail(MOVE_ERRORS.NOT_ACTIVE)
  if ((checkinCount || 0) > 0) return fail(MOVE_ERRORS.CHECKED_IN)
  if (!targetEvent) return fail(MOVE_ERRORS.TARGET_UNAVAILABLE)
  if (targetEvent.id === registration.race_event_id) return fail(MOVE_ERRORS.SAME_EVENT)
  if (targetEvent.active !== true || targetEvent.status !== 'published') return fail(MOVE_ERRORS.TARGET_UNAVAILABLE)
  if (!targetEvent.race_date || String(targetEvent.race_date).slice(0, 10) < today) return fail(MOVE_ERRORS.TARGET_UNAVAILABLE)
  if (!samePayee(sourceEvent, targetEvent)) return fail(MOVE_ERRORS.DIFFERENT_PAYEE)

  const crossesStudio = (sourceEvent?.location_id || null) !== (targetEvent.location_id || null)
  if (!crossesStudio && registration.team_id && existingOnTarget && LIVE_STATUSES.has(existingOnTarget.status)) {
    return fail(MOVE_ERRORS.ALREADY_ENTERED)
  }

  const headcount = entryHeadcount(registration)
  const sizes = targetEvent.allowed_team_sizes
  if (Array.isArray(sizes) && sizes.length > 0 && !sizes.includes(headcount)) return fail(MOVE_ERRORS.HEADCOUNT_NOT_ALLOWED)

  const targetHasWaves = Array.isArray(targetEvent.waves) && targetEvent.waves.length > 0
  if (targetHasWaves && !targetWave) return fail(MOVE_ERRORS.WAVE_REQUIRED)
  if (targetWave && targetWave.race_event_id !== targetEvent.id) return fail(MOVE_ERRORS.WRONG_EVENT)

  if (targetWave && !force) {
    const mode = targetEvent.capacity_mode === 'people' ? 'people' : 'teams'
    const regs = Array.isArray(targetWaveRegistrations) ? targetWaveRegistrations : []
    if (!wouldFit(targetWave.capacity, regs, mode, headcount)) {
      return fail(MOVE_ERRORS.WAVE_FULL, { spots_left: spotsLeft(targetWave.capacity, regs, mode) })
    }
  }
  return { ok: true }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/registration-move.test.js 2>&1 | tail -5`
Expected: all passed (12 + 19).

- [ ] **Step 5: Commit**

```bash
git add src/lib/registration-move.js src/lib/registration-move.test.js
git commit -m "EVENT-MOVE.1 — evaluateMove: every eligibility rule, pure"
```

---

### Task 4: Loaders, `listMoveTargets`, `moveRegistration`

**Files:**
- Modify: `src/lib/registration-move.js`
- Modify: `src/lib/registration-move.test.js`
- Modify: `src/lib/contact-events.js` (one line)

- [ ] **Step 1: Add the contact event type**

In `src/lib/contact-events.js`, inside `EVENT_TYPES`, after `RACE_NO_SHOW`:

```js
  RACE_MOVED:           'race.moved',
```

- [ ] **Step 2: Write the failing tests** (append to the test file)

```js
import { vi } from 'vitest'
import { listMoveTargets, moveRegistration } from './registration-move.js'

// A recording fake db. Each `from(table)` returns a builder whose terminal
// (`maybeSingle`, `single`, or awaiting the chain) answers from `answers[table]`,
// which may be a function of the recorded ops.
function fakeDb(answers, { rpc } = {}) {
  const calls = []
  return {
    calls,
    rpc: rpc || vi.fn(async () => ({ data: null, error: null })),
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const answer = () => {
        const a = answers[table]
        const v = typeof a === 'function' ? a(q) : a
        return Promise.resolve(v ?? { data: null, error: null })
      }
      const b = {}
      for (const name of ['select', 'eq', 'neq', 'in', 'gte', 'order', 'limit', 'is', 'update', 'insert', 'not']) {
        b[name] = (...args) => { q.ops.push([name, ...args]); return b }
      }
      b.maybeSingle = () => answer()
      b.single = () => answer()
      b.then = (res, rej) => answer().then(res, rej)
      return b
    },
  }
}

const REG = {
  id: 'r1', status: 'confirmed', race_event_id: 'e1', wave_id: 'w1', team_id: 't1', contact_id: 'c1',
  teams: { id: 't1', name: 'The Crushers', size: 2, team_members: [{ id: 'm1', name: 'Aoife', role: 'captain', is_member: true }, { id: 'm2', name: 'Dan', role: 'member', is_member: false }] },
  race: { id: 'e1', name: 'Hatch Oct 18', race_date: '2026-10-18', location_id: 'L1', host_id: null, member_pricing_enabled: true, member_fee_cents: 2000, non_member_fee_cents: 3000 },
}
const TARGET = { id: 'e2', name: 'Hatch Oct 25', race_date: '2026-10-25', location_id: 'L1', host_id: null, active: true, status: 'published',
  capacity_mode: 'teams', allowed_team_sizes: [1, 2, 4], member_pricing_enabled: true, member_fee_cents: 2500, non_member_fee_cents: 3500,
  waves: [{ id: 'w9', race_event_id: 'e2', start_time: '11:00:00', label: null, capacity: 10 }], locations: { id: 'L1', name: 'Hatch St' } }

describe('listMoveTargets', () => {
  it('lists same-payee, published, upcoming events at allowed studios with spots and the price gap', async () => {
    const db = fakeDb({
      race_registrations: (q) => (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id') ? { data: REG } : { data: [] }),
      race_events: { data: [TARGET, { ...TARGET, id: 'e3', host_id: 'h1' }, { ...TARGET, id: 'e4', location_id: 'L9', locations: { id: 'L9', name: 'Elsewhere' } }] },
    })
    const r = await listMoveTargets(db, { registrationId: 'r1', allowedLocationIds: ['L1'], today: '2026-10-08' })
    expect(r.ok).toBe(true)
    expect(r.targets.map((t) => t.id)).toEqual(['e2'])
    expect(r.targets[0].price_gap_cents).toBe(1000)
    expect(r.targets[0].waves[0].spots_left).toBe(10)
    expect(r.entry).toMatchObject({ id: 'r1', label: 'The Crushers', headcount: 2 })
  })
  it('null allowedLocationIds means every studio', async () => {
    const db = fakeDb({
      race_registrations: (q) => (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id') ? { data: REG } : { data: [] }),
      race_events: { data: [TARGET, { ...TARGET, id: 'e4', location_id: 'L9', locations: { id: 'L9', name: 'Elsewhere' } }] },
    })
    const r = await listMoveTargets(db, { registrationId: 'r1', allowedLocationIds: null, today: '2026-10-08' })
    expect(r.targets.map((t) => t.id)).toEqual(['e2', 'e4'])
  })
  it('not_found for an unknown entry', async () => {
    const r = await listMoveTargets(fakeDb({ race_registrations: { data: null } }), { registrationId: 'nope' })
    expect(r).toEqual({ ok: false, error: 'not_found' })
  })
})

describe('moveRegistration', () => {
  function happyDb(over = {}) {
    const rpc = vi.fn(async () => ({ data: { id: 'mv1', registration_id: 'r1', to_event_id: 'e2', price_gap_cents: 1000 }, error: null }))
    const db = fakeDb({
      race_registrations: (q) => {
        if (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id')) return { data: REG }
        if (q.ops.some((o) => o[0] === 'eq' && o[1] === 'team_id')) return { data: over.existingOnTarget ?? null }
        return { data: over.waveRegs ?? [] }
      },
      race_events: { data: over.target ?? TARGET },
      race_checkins: { data: null, count: over.checkins ?? 0, error: null },
      ...over.answers,
    }, { rpc })
    return { db, rpc }
  }
  const actor = { type: 'staff', id: 'u1', name: 'Richard' }

  it('runs the rules, then the SQL function with the computed gap', async () => {
    const { db, rpc } = happyDb()
    const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })
    expect(r.ok).toBe(true)
    expect(rpc).toHaveBeenCalledWith('move_race_registration', expect.objectContaining({
      p_registration_id: 'r1', p_to_event_id: 'e2', p_to_wave_id: 'w9', p_headcount: 2, p_price_gap_cents: 1000,
      p_forced: false, p_actor_type: 'staff', p_actor_id: 'u1', p_actor_name: 'Richard',
    }))
  })
  it('refuses before writing when a rule fails', async () => {
    const { db, rpc } = happyDb({ checkins: 1 })
    const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })
    expect(r).toMatchObject({ ok: false, error: 'checked_in' })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('wave_full carries spots_left and force gets past it', async () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, status: 'confirmed', team: { size: 1 } }))
    const a = happyDb({ waveRegs: full })
    expect(await moveRegistration(a.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })).toMatchObject({ ok: false, error: 'wave_full', spots_left: 0 })
    const b = happyDb({ waveRegs: full })
    const r = await moveRegistration(b.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, force: true, notify: false })
    expect(r.ok).toBe(true)
    expect(b.rpc.mock.calls[0][1].p_forced).toBe(true)
  })
  it('refuses a target outside allowedEventIds as not_found', async () => {
    const { db, rpc } = happyDb()
    const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, allowedEventIds: new Set(['e5']) })
    expect(r).toMatchObject({ ok: false, error: 'not_found' })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('surfaces a function error without pretending success', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'duplicate key value violates unique constraint' } }))
    const { db } = happyDb()
    db.rpc = rpc
    const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('write_failed')
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/registration-move.test.js 2>&1 | tail -5`
Expected: FAIL on `listMoveTargets`/`moveRegistration` not exported.

- [ ] **Step 4: Implement the loaders and the two entry points** (append to `registration-move.js`)

```js
import { emitEvent, EVENT_TYPES } from './contact-events'
import { addEventAttendeesToHostList } from './host-contact-list'

const EVENT_COLUMNS = `
  id, name, slug, race_date, location_id, host_id, active, status, kind,
  capacity_mode, allowed_team_sizes,
  member_pricing_enabled, member_fee_cents, non_member_fee_cents, payment_currency,
  venue_name, accent_hex, hero_image_url, sending_location_id,
  moved_email_subject, moved_email_intro,
  waves:race_waves ( id, race_event_id, start_time, label, capacity, display_order ),
  locations:location_id ( id, name, is_host_anchor, organization_id )
`

/** The entry with its team, roster and source event. null when missing. */
export async function loadRegistrationForMove(db, registrationId) {
  const { data, error } = await db
    .from('race_registrations')
    .select(`
      id, status, race_event_id, wave_id, team_id, contact_id, registered_at,
      teams:team_id ( id, name, size, location_id,
        team_members ( id, name, email, role, is_member, contact_id ) ),
      wave:wave_id ( id, start_time, label ),
      race:race_event_id ( ${EVENT_COLUMNS} )
    `)
    .eq('id', registrationId)
    .maybeSingle()
  if (error) {
    logError('registration-move', 'entry load failed', { err: error, registrationId })
    return null
  }
  return data || null
}

async function loadEvent(db, eventId) {
  const { data, error } = await db.from('race_events').select(EVENT_COLUMNS).eq('id', eventId).maybeSingle()
  if (error) {
    logError('registration-move', 'target load failed', { err: error, eventId })
    return null
  }
  return data || null
}

/** Live rows in a wave, shaped for event-signups' counters. */
async function loadWaveRegistrations(db, waveId) {
  const { data, error } = await db
    .from('race_registrations')
    .select('id, status, team:teams!team_id ( size )')
    .eq('wave_id', waveId)
    .in('status', ['confirmed', 'pending_payment'])
  if (error) {
    logError('registration-move', 'wave load failed', { err: error, waveId })
    return []
  }
  return data || []
}

async function countCheckins(db, registrationId) {
  const { count, error } = await db
    .from('race_checkins')
    .select('id', { count: 'exact', head: true })
    .eq('race_registration_id', registrationId)
  if (error) {
    logError('registration-move', 'check-in count failed', { err: error, registrationId })
    // Fail toward "checked in": a move we cannot judge must not proceed.
    return 1
  }
  return count || 0
}

async function findExistingOnTarget(db, { teamId, targetEventId, registrationId }) {
  if (!teamId) return null
  const { data, error } = await db
    .from('race_registrations')
    .select('id, status')
    .eq('team_id', teamId)
    .eq('race_event_id', targetEventId)
    .neq('id', registrationId)
    .limit(1)
    .maybeSingle()
  if (error) {
    logError('registration-move', 'existing-entry check failed', { err: error, teamId, targetEventId })
    return { id: null, status: 'confirmed' } // fail closed: treat as taken
  }
  return data || null
}

function sortWaves(waves) {
  return (waves || []).slice().sort((a, b) =>
    (a.display_order ?? 0) - (b.display_order ?? 0) || String(a.start_time || '').localeCompare(String(b.start_time || '')))
}

function entrySummary(registration) {
  const members = membersOf(registration)
  return {
    id: registration.id,
    status: registration.status,
    label: entryLabel(registration),
    headcount: entryHeadcount(registration),
    member_count: members.filter((m) => m?.is_member === true).length,
    non_member_count: members.filter((m) => m?.is_member !== true).length,
    team_id: registration.team_id || null,
  }
}

/**
 * The events an entry may move to, for the dialog's picker: same payee,
 * published, upcoming, not the source, at an allowed studio, with each wave's
 * spots_left and this entry's price gap. Staff-only output (shows capacity).
 *
 * @param {object} db  service-role client
 * @param {object} args
 * @param {string} args.registrationId
 * @param {Set<string>|null} [args.allowedEventIds]   host caller: its own events
 * @param {string[]|null} [args.allowedLocationIds]   staff caller: getUserLocationIds (null = master)
 * @param {string} [args.today]
 */
export async function listMoveTargets(db, { registrationId, allowedEventIds = null, allowedLocationIds = null, today = dublinTodayStr() }) {
  const registration = await loadRegistrationForMove(db, registrationId)
  if (!registration) return { ok: false, error: MOVE_ERRORS.NOT_FOUND }
  const source = registration.race

  const { data: events, error } = await db
    .from('race_events')
    .select(EVENT_COLUMNS)
    .eq('active', true)
    .eq('status', 'published')
    .gte('race_date', today)
    .order('race_date', { ascending: true })
    .limit(200)
  if (error) {
    logError('registration-move', 'targets load failed', { err: error, registrationId })
    return { ok: false, error: 'load_failed' }
  }

  const members = membersOf(registration)
  const targets = []
  for (const ev of events || []) {
    if (ev.id === source?.id) continue
    if (!samePayee(source, ev)) continue
    if (allowedEventIds && !allowedEventIds.has(ev.id)) continue
    if (Array.isArray(allowedLocationIds) && !allowedLocationIds.includes(ev.location_id)) continue
    const mode = ev.capacity_mode === 'people' ? 'people' : 'teams'
    const waves = []
    for (const w of sortWaves(ev.waves)) {
      const regs = await loadWaveRegistrations(db, w.id)
      waves.push({ id: w.id, start_time: w.start_time, label: w.label, capacity: w.capacity, spots_left: spotsLeft(w.capacity, regs, mode) })
    }
    targets.push({
      id: ev.id, name: ev.name, race_date: ev.race_date, kind: ev.kind,
      location_id: ev.location_id, location_name: ev.locations?.name || '',
      crosses_studio: (ev.location_id || null) !== (source?.location_id || null),
      capacity_mode: mode,
      price_gap_cents: computePriceGapCents({ sourceEvent: source, targetEvent: ev, members }),
      currency: ev.payment_currency || source?.payment_currency || 'EUR',
      waves,
    })
  }
  return {
    ok: true,
    entry: entrySummary(registration),
    source: { event_id: source?.id || null, event_name: source?.name || '', race_date: source?.race_date || null, wave_id: registration.wave_id || null, location_id: source?.location_id || null },
    targets,
  }
}

/**
 * Move one entry. Rules first (pure), then the SQL function, then best-effort
 * after-effects that never fail the move.
 *
 * @returns {{ ok: true, move: object, registration: object }
 *         | { ok: false, error: string, spots_left?: number|null }}
 */
export async function moveRegistration(db, {
  registrationId, targetEventId, targetWaveId = null,
  actor, note = null, notify = true, force = false, allowedEventIds = null,
  today = dublinTodayStr(),
}) {
  const registration = await loadRegistrationForMove(db, registrationId)
  if (!registration) return { ok: false, error: MOVE_ERRORS.NOT_FOUND }
  if (allowedEventIds && !allowedEventIds.has(targetEventId)) return { ok: false, error: MOVE_ERRORS.NOT_FOUND }

  const targetEvent = await loadEvent(db, targetEventId)
  if (!targetEvent) return { ok: false, error: MOVE_ERRORS.NOT_FOUND }
  const targetWave = targetWaveId ? (targetEvent.waves || []).find((w) => w.id === targetWaveId) || { id: targetWaveId, race_event_id: null } : null

  const [targetWaveRegistrations, checkinCount, existingOnTarget] = await Promise.all([
    targetWave?.race_event_id ? loadWaveRegistrations(db, targetWave.id) : Promise.resolve([]),
    countCheckins(db, registrationId),
    findExistingOnTarget(db, { teamId: registration.team_id, targetEventId, registrationId }),
  ])

  const verdict = evaluateMove({
    registration, sourceEvent: registration.race, targetEvent, targetWave,
    targetWaveRegistrations, checkinCount, existingOnTarget, force, today,
  })
  if (!verdict.ok) return verdict

  const members = membersOf(registration)
  const priceGapCents = computePriceGapCents({ sourceEvent: registration.race, targetEvent, members })
  const { data: move, error: rpcErr } = await db.rpc('move_race_registration', {
    p_registration_id: registrationId,
    p_to_event_id: targetEventId,
    p_to_wave_id: targetWave?.id || null,
    p_headcount: entryHeadcount(registration),
    p_price_gap_cents: priceGapCents,
    p_forced: force === true,
    p_actor_type: actor?.type || 'staff',
    p_actor_id: actor?.id || null,
    p_actor_name: actor?.name || '',
    p_note: note || null,
  })
  if (rpcErr || !move) {
    logError('registration-move', 'move_race_registration failed', { err: rpcErr, registrationId, targetEventId })
    return { ok: false, error: 'write_failed' }
  }

  // After-effects: each in its own try, none may fail the move.
  const leadEmail = members.find((m) => m?.role === 'captain')?.email || members[0]?.email || null
  try {
    await emitEvent({
      db, eventType: EVENT_TYPES.RACE_MOVED, contactEmail: leadEmail || '',
      contactId: registration.contact_id || null, locationId: targetEvent.location_id || null,
      sourceType: 'race_registration', sourceId: registrationId,
      metadata: { from_event_id: registration.race_event_id, to_event_id: targetEventId, move_id: move.id, forced: force === true, price_gap_cents: priceGapCents },
    })
  } catch (e) { logWarn('registration-move', 'contact event failed', { err: e, registrationId }) }
  try {
    if (registration.contact_id && targetEvent.location_id) {
      const { error: actErr } = await db.from('activities').insert({
        contact_id: registration.contact_id, location_id: targetEvent.location_id, kind: 'event', type: 'event',
        subject: `Entry moved to ${targetEvent.name} by ${actor?.name || 'staff'}`,
        note: `From ${registration.race?.name || 'event'} (${registration.race?.race_date || ''}) to ${targetEvent.name} (${targetEvent.race_date || ''}).${note ? ` Note: ${note}` : ''}`,
        done: true,
      })
      if (actErr) logWarn('registration-move', 'timeline row failed', { err: actErr, registrationId })
    }
  } catch (e) { logWarn('registration-move', 'timeline row threw', { err: e, registrationId }) }
  try {
    if (targetEvent.host_id) await addEventAttendeesToHostList(db, targetEventId)
  } catch (e) { logWarn('registration-move', 'host contact list sync failed', { err: e, targetEventId }) }
  if (notify) {
    try {
      const { sendRegistrationMovedEmail } = await import('./race-confirmations')
      await sendRegistrationMovedEmail(db, { registrationId, moveId: move.id })
    } catch (e) { logError('registration-move', 'moved email threw; the move stands', { err: e, registrationId, moveId: move.id }) }
  }
  return { ok: true, move, registration: { id: registrationId, race_event_id: targetEventId, wave_id: targetWave?.id || null } }
}
```

Notes: (1) the two `import` lines at the top of this block (`contact-events`, `host-contact-list`) go at the top of the file with the other imports; (2) `race-confirmations` is imported dynamically inside `moveRegistration` so the pure helpers (`entryLabel`, used by the dialog) can be imported from a component test without pulling Postmark; (3) the moved email has no template pointer, so `EVENT_COLUMNS` carries only `moved_email_subject, moved_email_intro`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/registration-move.test.js 2>&1 | tail -8`
Expected: all passed. If `race_checkins` count comes back wrong, check the fake returns `{ count }` on the awaited chain (the `then` path).

- [ ] **Step 6: Run the select-column and rpc-name gates**

Run: `npm run check:select-columns 2>&1 | tail -5 && npm run check:rpc-names 2>&1 | tail -5`
Expected: both clean. `moved_email_subject/intro` and `move_race_registration` resolve from mig 708.

- [ ] **Step 7: Commit**

```bash
git add src/lib/registration-move.js src/lib/registration-move.test.js src/lib/contact-events.js
git commit -m "EVENT-MOVE.1 — listMoveTargets + moveRegistration on move_race_registration()"
```

---

### Task 5: Moved email

**Files:**
- Modify: `src/lib/event-email.js:54-83` (merge tags)
- Modify: `src/lib/event-email.test.js` (add cases)
- Modify: `src/lib/race-confirmations.js` (append)
- Create: `src/lib/race-confirmations.moved.test.js`
- Modify: `docs/superpowers/specs/2026-10-08-event-entry-move-design.md` (merge-tag names)

- [ ] **Step 1: Failing test for the two merge tags** (append to `src/lib/event-email.test.js`)

```js
import { applyEventMergeTags, applyEventMergeTagsHtml } from './event-email.js'

describe('event merge tags — EVENT-MOVE.1', () => {
  const contact = { first_name: 'Aoife', name: 'Aoife Byrne', email: 'a@x.ie' }
  it('fills old_event_name and old_when in plain text', () => {
    const out = applyEventMergeTags('Moved from {{old_event_name}} ({{old_when}}) to {{event_name}}', contact,
      { event_name: 'Oct 25', old_event_name: 'Oct 18', old_when: 'Saturday 18 October · 11:00' })
    expect(out).toBe('Moved from Oct 18 (Saturday 18 October · 11:00) to Oct 25')
  })
  it('escapes them in HTML', () => {
    const out = applyEventMergeTagsHtml('<p>{{old_event_name}}</p>', contact, { old_event_name: '<b>x</b>', old_when: '' })
    expect(out).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>')
  })
  it('blank when absent', () => {
    expect(applyEventMergeTags('[{{old_event_name}}]', contact, {})).toBe('[]')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/event-email.test.js -t "EVENT-MOVE" 2>&1 | tail -5`
Expected: FAIL, tags left unreplaced.

- [ ] **Step 3: Add the tags**

In `applyEventMergeTags`, after the `{{location}}` line:

```js
  // EVENT-MOVE.1 — only the "your entry has moved" email sets these.
  out = out.replaceAll('{{old_event_name}}', extras.old_event_name || '')
  out = out.replaceAll('{{old_when}}', extras.old_when || '')
```

In `applyEventMergeTagsHtml`, inside `safeExtras`:

```js
    old_event_name: escapeHtml(extras.old_event_name || ''),
    old_when: escapeHtml(extras.old_when || ''),
```

Update the spec's "Defaults live in code" paragraph: replace `old_event_name`, `old_event_date` and `old_wave_time` with `old_event_name` and `old_when` (date and wave together).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/event-email.test.js 2>&1 | tail -5`
Expected: all passed (the byte-for-byte characterisation tests must still pass; the tags only replace when present).

- [ ] **Step 5: Failing test for the sender** (`src/lib/race-confirmations.moved.test.js`)

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./postmark', () => ({ sendTransactionalEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('./transactional-consent', () => ({ checkTransactionalConsent: vi.fn(async () => ({ allowed: true })) }))
vi.mock('./event-comms-location', () => ({
  resolveEventCommsLocation: vi.fn(async () => null),
  pickAudienceVenueName: ({ venueName, eventLocation }) => venueName || eventLocation?.name || '',
}))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.test' }))

const { sendTransactionalEmail } = await import('./postmark')
const { checkTransactionalConsent } = await import('./transactional-consent')
const { sendRegistrationMovedEmail, buildMovedDefaults } = await import('./race-confirmations.js')

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret'

const MOVE = { id: 'mv1', registration_id: 'r1', notified_at: null, price_gap_cents: 1000,
  from_event: { id: 'e1', name: 'Hatch Oct 18', race_date: '2026-10-18' }, from_wave: { start_time: '11:00:00', label: null } }
const REG = {
  id: 'r1', status: 'confirmed', contact_id: 'c1', race_event_id: 'e2',
  contact: { id: 'c1', first_name: 'Aoife', last_name: 'Byrne', email: 'aoife@x.ie', phone: '+3531' },
  wave: { id: 'w9', start_time: '11:00:00', label: null },
  teams: { id: 't2', name: 'The Crushers', size: 2, team_members: [{ id: 'm1', name: 'Aoife Byrne', role: 'captain', is_member: true }, { id: 'm2', name: 'Dan Walsh', role: 'member', is_member: false }] },
  race: { id: 'e2', name: 'Hatch Oct 25', slug: 'hatch-oct25-1100', kind: 'race', race_date: '2026-10-25', location_id: 'L1', host_id: null,
    venue_name: 'Hatch St', accent_hex: null, hero_image_url: null, moved_email_subject: null, moved_email_intro: null,
    locations: { id: 'L1', name: 'UN1T Hatch', is_host_anchor: false, organization_id: 'o1' } },
}
const PAYMENT = { id: 'p1', amount_cents: 6400, currency: 'EUR', status: 'completed', member_count: 1, non_member_count: 1, member_fee_cents: 2000, non_member_fee_cents: 3000 }

function fakeDb({ stampRows = [{ id: 'mv1' }] } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      const q = { table, ops: [] }
      const b = {}
      for (const name of ['select', 'eq', 'in', 'order', 'limit', 'is']) b[name] = (...a) => { q.ops.push([name, ...a]); return b }
      b.update = (patch) => { writes.push({ table, patch }); return b }
      const answer = () => {
        if (table === 'registration_moves') return q.ops.some((o) => o[0] === 'is') ? { data: stampRows, error: null } : { data: MOVE, error: null }
        if (table === 'race_registrations') return { data: REG, error: null }
        if (table === 'race_payments') return { data: [PAYMENT], error: null }
        return { data: null, error: null }
      }
      b.maybeSingle = async () => answer()
      b.single = async () => answer()
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    },
  }
}

beforeEach(() => { sendTransactionalEmail.mockClear(); checkTransactionalConsent.mockResolvedValue({ allowed: true }) })

describe('sendRegistrationMovedEmail', () => {
  it('sends the new event details with a QR per person and stamps notified_at after the send', async () => {
    const db = fakeDb()
    const r = await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    expect(r.sent).toEqual(['email'])
    const call = sendTransactionalEmail.mock.calls[0][0]
    expect(call.to).toBe('aoife@x.ie')
    expect(call.tag).toBe('event-moved')
    expect(call.subject).toBe('Your entry has moved to Hatch Oct 25')
    expect(call.htmlBody).toContain('Hatch Oct 18')
    expect(call.htmlBody).toContain('checkin-qr?t=')
    expect((call.htmlBody.match(/checkin-qr\?t=/g) || []).length).toBe(2)
    expect(db.writes).toEqual([{ table: 'registration_moves', patch: expect.objectContaining({ notified_at: expect.any(String) }) }])
  })
  it('uses the operator subject and intro when set', async () => {
    const db = fakeDb()
    REG.race.moved_email_subject = 'New date for {{event_name}}'
    REG.race.moved_email_intro = 'You were on {{old_event_name}}.'
    try {
      await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
      const call = sendTransactionalEmail.mock.calls[0][0]
      expect(call.subject).toBe('New date for Hatch Oct 25')
      expect(call.htmlBody).toContain('You were on Hatch Oct 18.')
    } finally { REG.race.moved_email_subject = null; REG.race.moved_email_intro = null }
  })
  it('skips when consent refuses, and does not stamp', async () => {
    checkTransactionalConsent.mockResolvedValueOnce({ allowed: false, reason: 'bounced' })
    const db = fakeDb()
    const r = await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    expect(r.skipped).toEqual(['email:bounced'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })
  it('skips an already-notified move', async () => {
    const db = fakeDb()
    const notified = { ...MOVE, notified_at: '2026-10-08T10:00:00Z' }
    db.from = ((orig) => (table) => { const b = orig(table); if (table === 'registration_moves') { b.maybeSingle = async () => ({ data: notified, error: null }) } return b })(db.from)
    const r = await sendRegistrationMovedEmail(db, { registrationId: 'r1', moveId: 'mv1' })
    expect(r.skipped).toEqual(['email:already_sent'])
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
})

describe('buildMovedDefaults', () => {
  it('names both events and keeps the team list', () => {
    const d = buildMovedDefaults({ raceName: 'B', oldEventName: 'A', oldWhen: 'Sat 18 Oct · 11:00', captainFirstName: 'Aoife',
      raceDateLabel: 'Saturday 25 October 2026', waveLabel: '11:00', waveRowLabel: 'Wave', locationName: 'Hatch St',
      teamName: 'The Crushers', teamSize: 2, teamMembers: [{ name: 'Aoife', role: 'captain', is_member: true, qrSrc: 'x' }],
      amountLabel: '€64.00', memberCount: 1, nonMemberCount: 1, memberFeeLabel: '€20.00', nonMemberFeeLabel: '€30.00' })
    expect(d.subject).toBe('Your entry has moved to B')
    expect(d.introHtml).toContain('A')
    expect(d.introHtml).toContain('B')
    expect(d.memberQrs).toHaveLength(1)
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/lib/race-confirmations.moved.test.js 2>&1 | tail -5`
Expected: FAIL, `sendRegistrationMovedEmail` not exported.

- [ ] **Step 7: Implement the sender** (append to `src/lib/race-confirmations.js`, before the private `escapeHtml`)

```js
// ─── EVENT-MOVE.1 — "your entry has moved" ───────────────────────────────
//
// Same shell, consent gate, QR minting and Postmark path as the confirmation,
// with kind:'moved' copy (race_events.moved_email_subject/intro, mig 708).
// The send-once guard is registration_moves.notified_at, stamped AFTER the
// send for the reasons stampSendOnce spells out. Not gated by the payment's
// confirmation stamp: this is a different message.

/**
 * Default shell slots for the moved email. Mirrors buildConfirmationDefaults so
 * resolveEventEmail({ kind: 'moved' }) can layer operator copy on top.
 * @param {object} ctx  buildConfirmationDefaults' ctx plus { oldEventName, oldWhen }
 */
export function buildMovedDefaults(ctx) {
  const base = buildConfirmationDefaults(ctx)
  return {
    ...base,
    subject: `Your entry has moved to ${ctx.raceName}`,
    heading: `Your entry has moved, ${escapeHtml(ctx.captainFirstName || 'there')}.`,
    introHtml: `Your entry for <strong>${escapeHtml(ctx.oldEventName || '')}</strong>${ctx.oldWhen ? ` (${escapeHtml(ctx.oldWhen)})` : ''} is now on <strong>${escapeHtml(ctx.raceName)}</strong>. Your new tickets are below; the old ones no longer work.`,
    footerHtml: `<strong>What's next:</strong> arrive 30 minutes before your ${(ctx.waveRowLabel || 'wave').toLowerCase()}. Bring water, a towel, and your race-day energy. We'll send a reminder the day before.`,
  }
}

/**
 * Email the lead contact their new tickets after a move.
 * @param {object} db  service-role client
 * @param {{ registrationId: string, moveId: string }} args
 * @returns {Promise<{ sent: string[], skipped: string[], failed: string[] }>}
 */
export async function sendRegistrationMovedEmail(db, { registrationId, moveId }) {
  const result = { sent: [], skipped: [], failed: [] }

  const { data: move, error: moveErr } = await db
    .from('registration_moves')
    .select(`
      id, registration_id, notified_at, price_gap_cents,
      from_event:from_event_id ( id, name, race_date ),
      from_wave:from_wave_id ( start_time, label )
    `)
    .eq('id', moveId)
    .maybeSingle()
  if (moveErr || !move || move.registration_id !== registrationId) {
    result.failed.push(`load:${moveErr?.message || 'move_not_found'}`)
    return result
  }
  if (move.notified_at) {
    result.skipped.push('email:already_sent')
    return result
  }

  const { data: reg, error: regErr } = await db
    .from('race_registrations')
    .select(`
      id, status, contact_id, race_event_id,
      contact:contact_id ( id, first_name, last_name, email, phone ),
      wave:wave_id ( id, start_time, label ),
      teams:team_id ( id, name, size, team_members ( id, name, role, is_member ) ),
      race:race_event_id (
        id, name, slug, kind, race_date, location_id, host_id, sending_location_id,
        venue_name, accent_hex, hero_image_url,
        moved_email_subject, moved_email_intro,
        locations:location_id ( id, name, is_host_anchor, organization_id )
      )
    `)
    .eq('id', registrationId)
    .maybeSingle()
  if (regErr || !reg) {
    result.failed.push(`load:${regErr?.message || 'registration_not_found'}`)
    return result
  }
  const { data: payments, error: payErr } = await db
    .from('race_payments')
    .select('id, amount_cents, currency, status, member_count, non_member_count, member_fee_cents, non_member_fee_cents, created_at')
    .eq('race_registration_id', registrationId)
    .order('created_at', { ascending: false })
    .limit(5)
  if (payErr) logError('race-confirmations', 'moved email: payment read failed; sending without the amount', { err: payErr, registrationId })
  const payment = (payments || []).find((p) => p.status === 'completed') || null

  const race = reg.race || {}
  const contact = reg.contact || {}
  const toEmail = contact.email || null
  if (!toEmail) { result.skipped.push('email:no_email'); return result }

  let commsLocation = null
  try {
    commsLocation = await resolveEventCommsLocation(db, { location_id: race.location_id, host_id: race.host_id, sending_location_id: race.sending_location_id })
  } catch (e) {
    logError('race-confirmations', 'moved email: comms location resolver threw; sending from the event location', { err: e, registrationId })
  }
  const commsLocationId = commsLocation?.id || race.location_id || null

  const gate = await checkTransactionalConsent({
    db, contactId: reg.contact_id, channel: 'email', module: 'race-confirmations', meta: { moveId }, unrecoverable: true,
  })
  if (!gate.allowed) { result.skipped.push(`email:${gate.reason}`); return result }

  const team = reg.teams
  const wave = reg.wave
  const teamMembers = (team?.team_members || []).slice().sort((a, b) =>
    (a.role === 'captain' ? 0 : 1) - (b.role === 'captain' ? 0 : 1) || (a.name || '').localeCompare(b.name || ''))
  const appOrigin = (() => { try { return new URL(getAppUrl()).origin } catch { return '' } })()
  const checkinSecret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  const teamMembersWithQr = teamMembers.map((m) => {
    if (!appOrigin || !race.id || !checkinSecret) return { ...m, qrSrc: '' }
    const token = signCheckinToken({ eventId: race.id, registrationId: reg.id, memberId: m.id }, checkinSecret)
    return { ...m, qrSrc: `${appOrigin}/api/public/events/checkin-qr?t=${encodeURIComponent(token)}` }
  })
  const fromWaveLabel = move.from_wave ? (move.from_wave.label ? `${move.from_wave.label} · ${fmtWaveTime(move.from_wave.start_time)}` : fmtWaveTime(move.from_wave.start_time)) : ''
  const oldWhen = [fmtRaceDate(move.from_event?.race_date), fromWaveLabel].filter(Boolean).join(' · ')
  const captainFirstName = contact.first_name || (teamMembers[0]?.name || '').split(' ')[0] || ''
  const currency = payment?.currency || 'EUR'

  const ctx = {
    raceName: race.name || 'UN1T Race',
    raceDateLabel: fmtRaceDate(race.race_date),
    waveLabel: wave ? (wave.label ? `${wave.label} · ${fmtWaveTime(wave.start_time)}` : fmtWaveTime(wave.start_time)) : '',
    waveRowLabel: timeRowLabel(race.kind),
    locationName: pickAudienceVenueName({ venueName: race.venue_name, eventLocation: race.locations }),
    teamName: team?.name || '',
    teamSize: team?.size || teamMembers.length || 1,
    teamMembers: teamMembersWithQr,
    captainFirstName,
    amountLabel: payment && payment.amount_cents > 0 ? fmtMoney(payment.amount_cents, currency) : 'Free entry',
    memberCount: payment?.member_count || 0,
    nonMemberCount: payment?.non_member_count || 0,
    memberFeeLabel: payment?.member_fee_cents != null ? fmtMoney(payment.member_fee_cents, currency) : null,
    nonMemberFeeLabel: payment?.non_member_fee_cents != null ? fmtMoney(payment.non_member_fee_cents, currency) : null,
    oldEventName: move.from_event?.name || '',
    oldWhen,
  }
  const mergeContact = { first_name: contact.first_name || '', name: [contact.first_name, contact.last_name].filter(Boolean).join(' '), email: toEmail, phone: contact.phone || '' }
  const extras = { event_name: ctx.raceName, team_name: ctx.teamName, when: ctx.waveLabel || ctx.raceDateLabel, location: ctx.locationName, old_event_name: ctx.oldEventName, old_when: ctx.oldWhen }

  let outcome
  try {
    const { subject, htmlBody } = await resolveEventEmail({ db, kind: 'moved', race, contact: mergeContact, extras, defaults: buildMovedDefaults(ctx) })
    await sendTransactionalEmail({ to: toEmail, subject, htmlBody, contactId: reg.contact_id || null, locationId: commsLocationId, tag: 'event-moved' })
    outcome = { status: 'sent' }
  } catch (e) {
    outcome = { status: 'threw', reason: e?.message || 'failed' }
  }
  if (outcome.status !== 'sent') { result.failed.push(`email:${outcome.reason}`); return result }
  result.sent.push('email')

  // Stamp after the send (see stampSendOnce). Zero rows = a concurrent send already stamped it.
  const { data: stamped, error: stampErr } = await db
    .from('registration_moves')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', moveId)
    .is('notified_at', null)
    .select('id')
  if (stampErr) {
    result.failed.push(`email:stamp_failed:${stampErr.message}`)
    logError('race-confirmations', 'moved email sent but notified_at was NOT written', { err: stampErr, moveId })
  } else if (!Array.isArray(stamped) || stamped.length === 0) {
    result.failed.push('email:duplicate_send')
  }
  return result
}
```

`resolveEventEmail` reads `race['moved_email_subject']` and `race['moved_email_intro']` by the `${kind}_` prefix, so no change there. Widen its JSDoc `kind` to `'confirmation'|'reminder'|'moved'`.

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run src/lib/race-confirmations.moved.test.js src/lib/event-email.test.js 2>&1 | tail -8`
Expected: all passed.

- [ ] **Step 9: Commit**

```bash
git add src/lib/event-email.js src/lib/event-email.test.js src/lib/race-confirmations.js src/lib/race-confirmations.moved.test.js docs/superpowers/specs/2026-10-08-event-entry-move-design.md
git commit -m "EVENT-MOVE.1 — 'your entry has moved' email with fresh QRs, kind:'moved' copy"
```

---

### Task 6: Staff routes

**Files:**
- Create: `src/app/api/event-registrations/[id]/move-targets/route.js`
- Create: `src/app/api/event-registrations/[id]/move/route.js`
- Create: `src/app/api/event-registrations/[id]/move/route.test.js`
- Modify: `src/lib/openapi.js` (append two `registerPath` calls after the `/api/public/event-registrations/{id}` one)

- [ ] **Step 1: Write the failing route test**

```js
// EVENT-MOVE.1 — POST /api/event-registrations/[id]/move. The rules live in
// src/lib/registration-move.test.js; this pins the gate (both studios), the
// schema, the error mapping and the actor handed to the lib.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The route reads the target event itself (id + studio) to judge the target
// studio. One tiny builder answers that read; __targetLoc steers it per test.
vi.mock('@/lib/supabase', () => {
  const b = {
    select: () => b, eq: () => b,
    maybeSingle: async () => ({ data: { id: 'e0000000-0000-0000-0000-000000000002', location_id: globalThis.__targetLoc }, error: null }),
  }
  return { createServerClient: vi.fn(() => ({ from: () => b })) }
})
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/registration-move', async (importOriginal) => ({
  ...(await importOriginal()),
  loadRegistrationForMove: vi.fn(),
  moveRegistration: vi.fn(),
}))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { loadRegistrationForMove, moveRegistration } = await import('@/lib/registration-move')
const { POST } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const L2 = 'a0000000-0000-0000-0000-000000000002'
const E2 = 'e0000000-0000-0000-0000-000000000002'
const W9 = 'f0000000-0000-0000-0000-000000000009'
// Shape per src/lib/permissions.js hasPermissionForLocation (reads
// locations[].role / features and assignmentsByLocation[].permissions) and
// src/lib/role-at-location.js hasRoleAtLocation (reads rolesByLocation[loc]
// as a STRING). Pass a role of 'staff' to make a non-manager.
const manager = (locs, role = 'manager') => ({
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role, profileRole: role,
  activeLocation: { id: locs[0] },
  rolesByLocation: Object.fromEntries(locs.map((l) => [l, role])),
  assignmentsByLocation: Object.fromEntries(locs.map((l) => [l, { role, permissions: { races: true } }])),
  locations: locs.map((id) => ({ id, role, features: { races: true } })),
})
const props = { params: Promise.resolve({ id: 'r1' }) }
const post = (body) => new Request('http://localhost/api/event-registrations/r1/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const BODY = { target_event_id: E2, target_wave_id: W9, notify: true }

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.__targetLoc = L1
  loadRegistrationForMove.mockResolvedValue({ id: 'r1', race: { id: 'e1', location_id: L1 } })
})

describe('POST /api/event-registrations/[id]/move', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(post(BODY), props)).status).toBe(401)
  })
  it('404 when the caller cannot see the source studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L2]))
    expect((await POST(post(BODY), props)).status).toBe(404)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('403 for a non-manager at the source studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L1], 'staff'))
    expect((await POST(post(BODY), props)).status).toBe(403)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('404 when the caller cannot see the TARGET studio, before the lib runs', async () => {
    globalThis.__targetLoc = L2
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post(BODY), props)).status).toBe(404)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('400 on a bad body', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post({ target_event_id: 'nope' }), props)).status).toBe(400)
  })
  it('404 when the lib answers not_found', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    moveRegistration.mockResolvedValue({ ok: false, error: 'not_found' })
    expect((await POST(post(BODY), props)).status).toBe(404)
  })
  it('409 with spots_left on wave_full', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    moveRegistration.mockResolvedValue({ ok: false, error: 'wave_full', spots_left: 0 })
    const res = await POST(post(BODY), props)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, error: 'wave_full', spots_left: 0, message: 'That time is full.' })
  })
  it('400 with the plain-English message on another rule', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    moveRegistration.mockResolvedValue({ ok: false, error: 'checked_in' })
    const res = await POST(post(BODY), props)
    expect(res.status).toBe(400)
    expect((await res.json()).message).toMatch(/already checked in/)
  })
  it('hands the lib the actor, force and note, and answers the move', async () => {
    getCurrentUser.mockResolvedValue(manager([L1, L2]))
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv1' }, registration: { id: 'r1' } })
    const res = await POST(post({ ...BODY, force: true, note: ' asked for Saturday ' }), props)
    expect(res.status).toBe(200)
    expect(moveRegistration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      registrationId: 'r1', targetEventId: E2, targetWaveId: W9, force: true, notify: true, note: 'asked for Saturday',
      actor: { type: 'staff', id: 'u1', name: 'Richard' },
    }))
    const allowed = moveRegistration.mock.calls[0][1].allowedEventIds
    expect(allowed).toBeNull()
  })
})
```

The last assertion documents that the staff route does not pass `allowedEventIds` (that is the host fence); the target studio is judged by the route itself, which reads the target event's studio. If `hasPermissionForLocation` refuses the fake manager, read `isFeatureEnabledAtLocation` in `shared/permissions.js` and shape `locations[].features` the way it expects.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run 'src/app/api/event-registrations/[id]/move/route.test.js' 2>&1 | tail -5`
Expected: FAIL, cannot find `./route.js`.

- [ ] **Step 3: Write the move route**

```js
// /api/event-registrations/[id]/move — EVENT-MOVE.1
//
// POST — move an entry to another event (and wave). Manager+ holding `races`
// at BOTH the source and the target studio. Never moves money. See
// src/lib/registration-move.js for the rules and
// docs/superpowers/specs/2026-10-08-event-entry-move-design.md.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { loadRegistrationForMove, moveRegistration, MOVE_ERRORS, MOVE_ERROR_MESSAGES } from '@/lib/registration-move'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const MoveSchema = z.object({
  target_event_id: uuidLike,
  target_wave_id: uuidLike.nullable().optional(),
  notify: z.boolean().optional().default(true),
  note: z.string().trim().max(1000).nullable().optional(),
  force: z.boolean().optional().default(false),
})

const STATUS_FOR = { [MOVE_ERRORS.NOT_FOUND]: 404, [MOVE_ERRORS.WAVE_FULL]: 409, write_failed: 500, load_failed: 500 }

function refuse(user, locationId) {
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'races') || !hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const reg = await loadRegistrationForMove(db, params.id)
  if (!reg) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const sourceRefusal = refuse(user, reg.race?.location_id)
  if (sourceRefusal) return sourceRefusal

  const validation = await validateBody(request, MoveSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // The target studio is judged the same way. 404, so event ids cannot be
  // enumerated through this route.
  const { data: target, error: targetErr } = await db
    .from('race_events').select('id, location_id').eq('id', body.target_event_id).maybeSingle()
  if (targetErr || !target) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const targetRefusal = refuse(user, target.location_id)
  if (targetRefusal) return targetRefusal

  const result = await moveRegistration(db, {
    registrationId: params.id,
    targetEventId: body.target_event_id,
    targetWaveId: body.target_wave_id || null,
    actor: { type: 'staff', id: user.id, name: user.full_name || user.email || 'staff' },
    note: body.note || null,
    notify: body.notify,
    force: body.force,
    allowedEventIds: null,
  })
  if (!result.ok) {
    const status = STATUS_FOR[result.error] || 400
    return NextResponse.json({
      success: false, error: result.error,
      message: MOVE_ERROR_MESSAGES[result.error] || 'The move could not be completed.',
      ...(result.spots_left !== undefined ? { spots_left: result.spots_left } : {}),
    }, { status })
  }
  return NextResponse.json({ success: true, data: { move: result.move, registration: result.registration } })
}
```

- [ ] **Step 4: Write the targets route**

```js
// /api/event-registrations/[id]/move-targets — EVENT-MOVE.1
//
// GET — the events this entry may move to, with per-wave spots and the price
// gap. Staff-only (it shows capacity): manager+ holding `races` at the
// source studio; targets are limited to studios where the caller holds the
// same. Never public.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, getUserLocationIds } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { loadRegistrationForMove, listMoveTargets } from '@/lib/registration-move'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()
  const reg = await loadRegistrationForMove(db, params.id)
  if (!reg) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, reg.race?.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, reg.race?.location_id, 'races') || !hasRoleAtLocation(user, reg.race?.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const result = await listMoveTargets(db, { registrationId: params.id, allowedLocationIds: getUserLocationIds(user) })
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.error === 'not_found' ? 404 : 500 })
  }
  // Only studios where the caller may MOVE things (same gate as POST /move).
  const targets = result.targets.filter((t) =>
    hasPermissionForLocation(user, t.location_id, 'races') && hasRoleAtLocation(user, t.location_id, MANAGER_ROLES))
  return NextResponse.json({ success: true, data: { entry: result.entry, source: result.source, targets } })
}
```

- [ ] **Step 5: Register both in openapi.js** (after the `/api/public/event-registrations/{id}` block)

```js
registry.registerPath({
  method: 'get',
  path: '/api/event-registrations/{id}/move-targets',
  tags: ['Events'],
  summary: 'Events an entry may move to, with per-wave spots and the price gap (staff, manager+ at the source studio)',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Entry, source and targets', content: { 'application/json': { schema: z.object({}).passthrough().openapi('EntryMoveTargets') } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/event-registrations/{id}/move',
  tags: ['Events'],
  summary: 'Move an entry to another event; never moves money (staff, manager+ at both studios)',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      target_event_id: uuidLike, target_wave_id: uuidLike.nullable().optional(),
      notify: z.boolean().optional(), note: z.string().max(1000).nullable().optional(), force: z.boolean().optional(),
    }).openapi('EntryMoveRequest') } } },
  },
  responses: {
    200: { description: 'Moved', content: { 'application/json': { schema: z.object({}).passthrough().openapi('EntryMoveResult') } } },
    400: { description: 'A rule refused the move', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'The target wave is full (resend with force)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

Check the tag name used by neighbouring event routes (`grep -n "tags: \['Events'\]" src/lib/openapi.js | head -2`) and use that exact tag.

- [ ] **Step 6: Run the tests and the route guards**

Run: `npx vitest run 'src/app/api/event-registrations/[id]/move/route.test.js' 2>&1 | tail -8 && npm run check:route-guards 2>&1 | tail -4 && npm run check:location-scoping 2>&1 | tail -4`
Expected: tests pass; both guards clean (the routes call `getCurrentUser` and the lib's queries are scoped by the registration id and the event id, which the scoping check accepts; if it flags `race_events` in `listMoveTargets`, register `listMoveTargets` in the script's `SCOPING_HELPERS` with the reason "filters by allowedLocationIds after load; staff-only").

- [ ] **Step 7: Commit**

```bash
git add 'src/app/api/event-registrations/[id]/move' 'src/app/api/event-registrations/[id]/move-targets' src/lib/openapi.js
git commit -m "EVENT-MOVE.1 — staff routes: move-targets + move, judged at both studios"
```

---

### Task 7: Teams list carries the move history

**Files:**
- Modify: `src/app/api/events/[id]/teams/route.js:60-103`

- [ ] **Step 1: Add the history reads** (after the payments block, before the response)

```js
  // EVENT-MOVE.1 — the latest move INTO this event per entry (the "Moved from"
  // chip) and every move OUT of it (the footer). Both from registration_moves.
  let movedOut = []
  if (regIds.length > 0) {
    const { data: movesIn, error: movesInErr } = await db
      .from('registration_moves')
      .select('id, registration_id, created_at, actor_name, price_gap_cents, forced, from_event:from_event_id ( id, name, race_date )')
      .in('registration_id', regIds)
      .eq('to_event_id', params.id)
      .order('created_at', { ascending: false })
    if (movesInErr) logError('events-teams', 'moves-in read failed; chips omitted', { err: movesInErr, eventId: params.id })
    const lastMove = {}
    for (const m of movesIn || []) if (!lastMove[m.registration_id]) lastMove[m.registration_id] = m
    for (const r of regs) r.last_move = lastMove[r.id] || null
  } else {
    for (const r of regs) r.last_move = null
  }
  {
    const { data: movesOut, error: movesOutErr } = await db
      .from('registration_moves')
      .select('id, created_at, actor_name, registration:registration_id ( id, teams:team_id ( name, size, team_members ( name, role ) ) ), to_event:to_event_id ( id, name, race_date )')
      .eq('from_event_id', params.id)
      .order('created_at', { ascending: false })
      .limit(200)
    if (movesOutErr) logError('events-teams', 'moves-out read failed; footer omitted', { err: movesOutErr, eventId: params.id })
    movedOut = (movesOut || []).map((m) => ({
      id: m.id, created_at: m.created_at, actor_name: m.actor_name,
      label: entryLabel(m.registration || {}),
      to_event: m.to_event || null,
    }))
  }

  return NextResponse.json({ success: true, data: regs, moved_out: movedOut })
```

Replace the existing `return NextResponse.json({ success: true, data: regs })` with the one above, and add `import { entryLabel } from '@/lib/registration-move'` at the top. Note: the registration embed here carries `teams` for the (possibly cloned) team the entry now sits on, which is the right name to show.

- [ ] **Step 2: Run the existing route test and the column gate**

Run: `npx vitest run 'src/app/api/events/[id]/teams' 2>&1 | tail -5 && npm run check:select-columns 2>&1 | tail -3`
Expected: pass / clean.

- [ ] **Step 3: Commit**

```bash
git add 'src/app/api/events/[id]/teams/route.js'
git commit -m "EVENT-MOVE.1 — teams list carries last_move per entry and moved_out"
```

---

### Task 8: Event form — "Entry moved" email copy

**Files:**
- Modify: `src/app/api/events/[id]/route.js:64-69` and `:88-90`
- Modify: `src/app/api/events/[id]/route.test.js` (one case)
- Modify: `src/components/RaceEventForm.jsx:285-289`, `:572-576`, `:1380-1400`, `:1526-1600`

- [ ] **Step 1: Failing schema test** (append to `src/app/api/events/[id]/route.test.js`)

```js
describe('events UpdateSchema — EVENT-MOVE.1 moved-email copy', () => {
  it('accepts, clears and bounds the two fields', () => {
    expect(UpdateSchema.parse({ moved_email_subject: 'New date for {{event_name}}' }).moved_email_subject).toContain('event_name')
    expect(UpdateSchema.parse({ moved_email_intro: null }).moved_email_intro).toBeNull()
    expect(() => UpdateSchema.parse({ moved_email_intro: 'y'.repeat(4001) })).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run 'src/app/api/events/[id]/route.test.js' -t "EVENT-MOVE" 2>&1 | tail -5`
Expected: FAIL (unknown keys are stripped, so `moved_email_subject` is undefined).

- [ ] **Step 3: Add the two columns to the schema and the select**

In `UpdateSchema`, after `reminder_email_intro`:

```js
  // EVENT-MOVE.1 (mig 708) — copy for the "your entry has moved" email.
  moved_email_subject: z.string().max(4000).nullable().optional(),
  moved_email_intro: z.string().max(4000).nullable().optional(),
```

In `loadRace`'s select, after `reminder_email_subject, reminder_email_intro,`:

```js
      moved_email_subject, moved_email_intro,
```

Confirm the generic scalar patch in PUT copies these through (it copies every schema scalar; read the block around line 240 to be sure, and add them to any explicit allowlist you find).

- [ ] **Step 4: Form state, payload and fields**

In `RaceEventForm.jsx`, after the `reminderTemplateId` state (line 289):

```js
  const [movedSubject, setMovedSubject] = useState(race?.moved_email_subject || '')
  const [movedIntro, setMovedIntro] = useState(race?.moved_email_intro || '')
```

In the save payload, after `reminder_email_template_id` (line 576):

```js
      moved_email_subject: movedSubject.trim() || null,
      moved_email_intro: movedIntro.trim() || null,
```

After the "Pre-event reminder" block (the `</div>` closing the `pt-4 border-t` wrapper, around line 1400), add:

```jsx
          <div className="pt-4 border-t border-un1t-border">
            <EventEmailFields
              title="Entry moved"
              description="Sent when staff move an entry onto this event from another one. Carries the new date, time and fresh QR codes."
              subject={movedSubject}
              onSubject={setMovedSubject}
              subjectPlaceholder="Your entry has moved to {{event_name}}"
              intro={movedIntro}
              onIntro={setMovedIntro}
              introPlaceholder="Your entry for {{old_event_name}} ({{old_when}}) is now on {{event_name}}. Your new tickets are below."
              showTemplate={false}
              extraTags={['{{old_event_name}}', '{{old_when}}']}
            />
          </div>
```

In `EventEmailFields` add two props with defaults, `showTemplate = true` and `extraTags = []`; wrap the "Advanced: use a full template" `<div>` in `{showTemplate && ( … )}`; and render the extra tags after `{{location}}` in the merge-tag hint:

```jsx
          {extraTags.map((t) => (<span key={t}>, <code>{t}</code></span>))}
```

- [ ] **Step 5: Run the form tests and the schema test**

Run: `npx vitest run src/components/RaceEventForm 'src/app/api/events/[id]/route.test.js' 2>&1 | tail -6`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/api/events/[id]/route.js' 'src/app/api/events/[id]/route.test.js' src/components/RaceEventForm.jsx
git commit -m "EVENT-MOVE.1 — event form: operator-editable 'entry moved' email copy"
```

---

### Task 9: The dialog

**Files:**
- Create: `src/components/MoveEntryDialog.jsx`
- Create: `src/components/MoveEntryDialog.test.jsx`

- [ ] **Step 1: Failing component test**

```jsx
// @vitest-environment jsdom
// EVENT-MOVE.1 — the move dialog: loads targets, shows the gap and the studio
// notice, posts the move, and turns a wave_full answer into Move anyway / Don't move.
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import MoveEntryDialog from './MoveEntryDialog.jsx'

const TARGETS = {
  entry: { id: 'r1', label: 'The Crushers', headcount: 2, status: 'confirmed' },
  source: { event_id: 'e1', event_name: 'Hatch Oct 18', race_date: '2026-10-18', wave_id: 'w1', location_id: 'L1' },
  targets: [
    { id: 'e2', name: 'Hatch Oct 25', race_date: '2026-10-25', location_id: 'L1', location_name: 'Hatch St', crosses_studio: false, price_gap_cents: 1000, currency: 'EUR',
      waves: [{ id: 'w9', start_time: '11:00:00', label: null, capacity: 10, spots_left: 6 }, { id: 'w10', start_time: '12:30:00', label: null, capacity: 10, spots_left: 0 }] },
    { id: 'e4', name: 'Stillorgan Nov 1', race_date: '2026-11-01', location_id: 'L2', location_name: 'Stillorgan', crosses_studio: true, price_gap_cents: 0, currency: 'EUR', waves: [] },
  ],
}
const registration = { id: 'r1', status: 'confirmed', teams: { name: 'The Crushers', size: 2, team_members: [{ name: 'Aoife', role: 'captain', email: 'a@x.ie' }, { name: 'Dan' }] } }

function stubFetch(responses) {
  const fetchMock = vi.fn(async (url, init) => {
    const r = responses.shift()
    return { ok: r.status < 400, status: r.status, json: async () => r.body }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('MoveEntryDialog', () => {
  it('lists targets, shows the price gap, and posts the move', async () => {
    const fetchMock = stubFetch([{ status: 200, body: { success: true, data: TARGETS } }, { status: 200, body: { success: true, data: {} } }])
    const onMoved = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={() => {}} />)
    await screen.findByText(/Move The Crushers to another event/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w9' } })
    expect(screen.getByText(/€5\.00 more per person/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await waitFor(() => expect(onMoved).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/event-registrations/r1/move')
    expect(JSON.parse(init.body)).toMatchObject({ target_event_id: 'e2', target_wave_id: 'w9', notify: true, force: false })
  })
  it('names the studio when the move crosses one', async () => {
    stubFetch([{ status: 200, body: { success: true, data: TARGETS } }])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e4' } })
    expect(screen.getByText(/moves the entry to Stillorgan/)).toBeTruthy()
  })
  it('wave_full offers Move anyway, which resends with force', async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 409, body: { success: false, error: 'wave_full', spots_left: 0, message: 'That time is full.' } },
      { status: 200, body: { success: true, data: {} } },
    ])
    const onMoved = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={() => {}} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w10' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await screen.findByText(/This time is full/)
    fireEvent.click(screen.getByRole('button', { name: /Move anyway/ }))
    await waitFor(() => expect(onMoved).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).force).toBe(true)
  })
  it("Don't move returns to the form without posting again", async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 409, body: { success: false, error: 'wave_full', spots_left: 0, message: 'That time is full.' } },
    ])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w10' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await screen.findByText(/This time is full/)
    fireEvent.click(screen.getByRole('button', { name: /Don't move/ }))
    expect(screen.getByRole('button', { name: /^Move entry$/ })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('says so when nothing is eligible', async () => {
    stubFetch([{ status: 200, body: { success: true, data: { ...TARGETS, targets: [] } } }])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText(/No other upcoming events are paid to the same host/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/MoveEntryDialog.test.jsx 2>&1 | tail -5`
Expected: FAIL, cannot resolve `./MoveEntryDialog.jsx`.

- [ ] **Step 3: Write the dialog**

```jsx
'use client'
// MoveEntryDialog — EVENT-MOVE.1. Move one entry (team or single) to another
// event. Shared by the staff teams page now and the host portal next (PR 2);
// only the two endpoints differ, so they are props with staff defaults.
//
// Never moves money: a price gap is shown, the move records it, staff collect
// or waive it afterwards. A full wave is a warning with two choices.

import { useEffect, useMemo, useState } from 'react'
import { Loader2, AlertTriangle, Coins, MapPin } from 'lucide-react'
import { Modal, Button } from '@/components/ui'
import { entryLabel } from '@/lib/registration-move'

function money(cents, currency = 'EUR') {
  const major = (Math.abs(cents) / 100).toFixed(2)
  return currency === 'EUR' ? `€${major}` : currency === 'GBP' ? `£${major}` : `${major} ${currency}`
}
function fmtDate(d) {
  if (!d) return ''
  try { return new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' }) } catch { return d }
}
function waveLabel(w) {
  return `${w.label ? `${w.label} · ` : ''}${(w.start_time || '').slice(0, 5)}`
}

export default function MoveEntryDialog({
  open, registration, onClose, onMoved, onError,
  targetsUrl = `/api/event-registrations/${registration?.id}/move-targets`,
  moveUrl = `/api/event-registrations/${registration?.id}/move`,
}) {
  const [data, setData] = useState(null)        // { entry, source, targets }
  const [loadError, setLoadError] = useState(null)
  const [targetEventId, setTargetEventId] = useState('')
  const [targetWaveId, setTargetWaveId] = useState('')
  const [notify, setNotify] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [fullWarning, setFullWarning] = useState(null) // { spots_left, message }
  const [formError, setFormError] = useState(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setData(null); setLoadError(null); setTargetEventId(''); setTargetWaveId(''); setFullWarning(null); setFormError(null)
    ;(async () => {
      try {
        const r = await fetch(targetsUrl, { cache: 'no-store' })
        const j = await r.json()
        if (cancelled) return
        if (!r.ok || j.success === false) { setLoadError(j.error || `Could not load events (${r.status})`); return }
        setData(j.data)
      } catch (e) {
        if (!cancelled) setLoadError(e.message || 'Network error')
      }
    })()
    return () => { cancelled = true }
  }, [open, targetsUrl])

  const label = data?.entry?.label || entryLabel(registration || {})
  const leadFirstName = (registration?.teams?.team_members || []).find((m) => m?.role === 'captain')?.name?.split(' ')[0]
    || registration?.contact?.first_name || 'the customer'
  const target = useMemo(() => (data?.targets || []).find((t) => t.id === targetEventId) || null, [data, targetEventId])
  const studios = useMemo(() => Array.from(new Set((data?.targets || []).map((t) => t.location_name))), [data])
  const gap = target?.price_gap_cents || 0
  const headcount = data?.entry?.headcount || 1
  const perPerson = headcount > 0 ? Math.round(gap / headcount) : gap

  async function submit(force) {
    if (!targetEventId) { setFormError('Pick a target event.'); return }
    if (target && target.waves.length > 0 && !targetWaveId) { setFormError('Pick a time on the target event.'); return }
    setBusy(true); setFormError(null)
    try {
      const r = await fetch(moveUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_event_id: targetEventId, target_wave_id: targetWaveId || null, notify, note: note.trim() || null, force }),
      })
      const j = await r.json()
      if (r.status === 409 && j.error === 'wave_full') { setFullWarning({ spots_left: j.spots_left, message: j.message }); return }
      if (!r.ok || j.success === false) { setFormError(j.message || j.error || 'The move could not be completed.'); return }
      onMoved?.(j.data)
    } catch (e) {
      onError?.(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  const waveField = target && target.waves.length > 0
  const timeWord = 'Time'

  const footer = fullWarning ? (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div className="text-sm text-amber-700 inline-flex items-center gap-2">
        <AlertTriangle size={14} /> This time is full{Number.isFinite(fullWarning.spots_left) ? ` (${fullWarning.spots_left} left)` : ''}. Move anyway?
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={() => setFullWarning(null)} disabled={busy}>Don&apos;t move</Button>
        <Button type="button" variant="primary" onClick={() => submit(true)} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : null} Move anyway
        </Button>
      </div>
    </div>
  ) : (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button type="button" variant="primary" onClick={() => submit(false)} disabled={busy || !data || (data.targets || []).length === 0}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : null} Move entry
      </Button>
    </div>
  )

  return (
    <Modal open={open} onClose={onClose} title={`Move ${label} to another event`} footer={footer} size="md">
      <p className="text-sm text-un1t-subtle mb-4">
        The entry, its people and its payment travel together. Nothing is charged or refunded by this move.
      </p>
      {loadError && <div className="text-sm text-red-700 mb-3">{loadError}</div>}
      {!data && !loadError && (
        <div className="text-sm text-un1t-subtle inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading events…</div>
      )}
      {data && data.targets.length === 0 && (
        <div className="text-sm text-un1t-subtle">No other upcoming events are paid to the same host.</div>
      )}
      {data && data.targets.length > 0 && (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(false) }}>
          <div>
            <label htmlFor="move-target-event" className="block text-sm text-un1t-subtle mb-1">Target event</label>
            <select
              id="move-target-event"
              value={targetEventId}
              onChange={(e) => { setTargetEventId(e.target.value); setTargetWaveId(''); setFullWarning(null) }}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            >
              <option value="">Choose an event…</option>
              {studios.length > 1
                ? studios.map((s) => (
                  <optgroup key={s} label={s}>
                    {data.targets.filter((t) => t.location_name === s).map((t) => (
                      <option key={t.id} value={t.id}>{fmtDate(t.race_date)} · {t.name}</option>
                    ))}
                  </optgroup>
                ))
                : data.targets.map((t) => (<option key={t.id} value={t.id}>{fmtDate(t.race_date)} · {t.name}</option>))}
            </select>
            <p className="text-[11px] text-un1t-muted mt-1">Only upcoming events paid to the same host are listed.</p>
          </div>

          {waveField && (
            <div>
              <label htmlFor="move-target-wave" className="block text-sm text-un1t-subtle mb-1">{timeWord}</label>
              <select
                id="move-target-wave"
                value={targetWaveId}
                onChange={(e) => { setTargetWaveId(e.target.value); setFullWarning(null) }}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              >
                <option value="">Choose a time…</option>
                {target.waves.map((w) => (
                  <option key={w.id} value={w.id}>
                    {waveLabel(w)}{w.spots_left === null ? '' : w.spots_left === 0 ? ' · full' : ` · ${w.spots_left} left`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {target?.crosses_studio && (
            <div className="text-sm text-un1t-text bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 inline-flex items-start gap-2">
              <MapPin size={14} className="mt-0.5 shrink-0" />
              <span>This moves the entry to {target.location_name}. The team is copied there.</span>
            </div>
          )}

          {target && gap !== 0 && (
            <div className="text-sm text-amber-700 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2 flex items-start gap-2">
              <Coins size={14} className="mt-0.5 shrink-0" />
              <span>
                Target price is {money(perPerson, target.currency)} {gap > 0 ? 'more' : 'less'} per person ({money(gap, target.currency)} for this entry).
                {gap > 0 ? ' Collect it with a payment link afterwards, or leave it.' : ' Nothing is refunded by this move.'}
              </span>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-un1t-text">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            Email {leadFirstName} the new tickets and QR codes
          </label>

          <div>
            <label htmlFor="move-note" className="block text-sm text-un1t-subtle mb-1">Note (internal, optional)</label>
            <input
              id="move-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              placeholder="Customer asked to switch dates"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
          </div>

          {formError && <div className="text-sm text-red-700">{formError}</div>}
        </form>
      )}
    </Modal>
  )
}
```

If `Button` does not accept `type`, check `src/components/ui/Button.jsx` and pass it through (every button in a form must carry a type; the footer buttons sit outside the `<form>`, inside the Modal footer, so the lint will not fire there but keep `type="button"` anyway). The price-gap sentence for the test must read "€5.00 more per person" for gap 1000 over headcount 2.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/MoveEntryDialog.test.jsx 2>&1 | tail -8`
Expected: 5 passed. If `getByLabelText(/^Time|^Wave/)` cannot find the select, the label text is "Time": use `/^Time$/`.

- [ ] **Step 5: Commit**

```bash
git add src/components/MoveEntryDialog.jsx src/components/MoveEntryDialog.test.jsx
git commit -m "EVENT-MOVE.1 — MoveEntryDialog: targets, price gap, studio notice, Move anyway / Don't move"
```

---

### Task 10: Teams page wiring — action, chip, footer

**Files:**
- Modify: `src/components/RaceTeamsManager.jsx`
- Modify: `src/app/(members)/events/[id]/teams/page.js:55-57`
- Create: `src/components/RaceTeamsManager.move.test.jsx`

- [ ] **Step 1: Failing component test**

```jsx
// @vitest-environment jsdom
// EVENT-MOVE.1 — Move to event is gated like Cancel entry, the chip reads the
// last move in, and the footer lists moves out.
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import RaceTeamsManager from './RaceTeamsManager.jsx'

const race = { id: 'e2', allowed_team_sizes: [2], waves: [{ id: 'w9', start_time: '11:00:00', label: null, display_order: 0 }] }
const reg = {
  id: 'r1', status: 'confirmed', wave_id: 'w9', payment: null,
  teams: { id: 't1', name: 'The Crushers', size: 2, team_members: [] },
  last_move: { id: 'mv1', created_at: '2026-10-08T09:00:00Z', actor_name: 'Richard', price_gap_cents: 1000, forced: false, from_event: { id: 'e1', name: 'Hatch Oct 18', race_date: '2026-10-18' } },
}
const movedOut = [{ id: 'mv2', created_at: '2026-10-08T10:00:00Z', actor_name: 'Richard', label: 'Wolves', to_event: { id: 'e5', name: 'Hatch Nov 1', race_date: '2026-11-01' } }]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [reg], moved_out: movedOut }) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceTeamsManager — Move to event', () => {
  it('hidden without canMoveEntries', async () => {
    render(<RaceTeamsManager race={race} canMoveEntries={false} />)
    await screen.findByText(/1 team registered/)
    expect(screen.queryByRole('button', { name: /Move to event/ })).toBeNull()
  })
  it('shown with canMoveEntries', async () => {
    render(<RaceTeamsManager race={race} canMoveEntries />)
    await screen.findByText(/1 team registered/)
    expect(screen.getByRole('button', { name: /Move to event/ })).toBeTruthy()
  })
  it('shows the Moved from chip and the outstanding gap', async () => {
    render(<RaceTeamsManager race={race} canMoveEntries />)
    await screen.findByText(/Moved from Hatch Oct 18/)
    expect(screen.getByText(/€10\.00 difference outstanding/)).toBeTruthy()
  })
  it('lists entries moved out of this event', async () => {
    render(<RaceTeamsManager race={race} />)
    await screen.findByText(/1 entry moved to other events/)
    expect(screen.getByText(/Wolves/)).toBeTruthy()
    expect(screen.getByText(/Hatch Nov 1/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/RaceTeamsManager.move.test.jsx 2>&1 | tail -5`
Expected: FAIL on the "shown" case and the chip/footer cases.

- [ ] **Step 3: Wire the manager**

In `RaceTeamsManager.jsx`:

1. Imports: add `ArrowRightCircle` to the lucide import and `import MoveEntryDialog from './MoveEntryDialog'`.
2. Signature: `export default function RaceTeamsManager({ race, canCancelEntries = false, canMoveEntries = false })`.
3. State: add `const [movedOut, setMovedOut] = useState([])` and in `load()` after `setRegistrations(j.data || [])` add `setMovedOut(Array.isArray(j.moved_out) ? j.moved_out : [])`.
4. Pass `canMove={canMoveEntries}` to `<TeamCard>`.
5. After the `<div className="space-y-3">…</div>` that renders the cards, add the footer:

```jsx
      {movedOut.length > 0 && (
        <details className="text-sm text-un1t-subtle">
          <summary className="cursor-pointer select-none">
            {movedOut.length} {movedOut.length === 1 ? 'entry' : 'entries'} moved to other events
          </summary>
          <ul className="mt-2 space-y-1 pl-4">
            {movedOut.map((m) => (
              <li key={m.id}>
                {m.label} → {m.to_event?.name || 'another event'}{m.to_event?.race_date ? ` (${m.to_event.race_date})` : ''} · {new Date(m.created_at).toLocaleDateString('en-IE')} · {m.actor_name}
              </li>
            ))}
          </ul>
        </details>
      )}
```

6. `TeamCard` signature: `function TeamCard({ registration, waves, onChanged, onError, canCancel = false, canMove = false })` and state `const [moving, setMoving] = useState(false)`.
7. In the card's header chip row, after the `Members` chip:

```jsx
          {registration.last_move && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-700 inline-flex items-center gap-1"
              title={`Moved from ${registration.last_move.from_event?.name || 'another event'} by ${registration.last_move.actor_name} on ${new Date(registration.last_move.created_at).toLocaleDateString('en-IE')}${registration.last_move.forced ? ' (wave was full)' : ''}`}
            >
              <ArrowRightCircle size={10} /> Moved from {registration.last_move.from_event?.name || 'another event'}
            </span>
          )}
          {registration.last_move?.price_gap_cents > 0 && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-700">
              €{(registration.last_move.price_gap_cents / 100).toFixed(2)} difference outstanding
            </span>
          )}
```

8. In the action row, before the cancel branch, when the entry is live:

```jsx
          {canMove && (registration.status === 'confirmed' || registration.status === 'pending_payment') && (
            <button
              type="button"
              onClick={() => setMoving(true)}
              disabled={busy}
              className="text-[11px] text-un1t-accent hover:underline inline-flex items-center gap-1 disabled:opacity-40"
              title="Move this entry to another event"
            >
              <ArrowRightCircle size={11} /> Move to event
            </button>
          )}
```

9. At the end of the card's JSX (inside the outer `<div>`), render the dialog:

```jsx
      {moving && (
        <MoveEntryDialog
          open
          registration={registration}
          onClose={() => setMoving(false)}
          onMoved={() => { setMoving(false); onChanged() }}
          onError={onError}
        />
      )}
```

10. The header count reads "team(s) registered"; leave it (the gates test pins it).

In `src/app/(members)/events/[id]/teams/page.js`, pass the new prop with the same decision as cancel:

```jsx
      <RaceTeamsManager
        race={race}
        canCancelEntries={hasRoleAtLocation(user, race.location_id, MANAGER_ROLES)}
        canMoveEntries={hasRoleAtLocation(user, race.location_id, MANAGER_ROLES)}
      />
```

- [ ] **Step 4: Run both manager tests and the chip lint**

Run: `npx vitest run src/components/RaceTeamsManager 2>&1 | tail -6 && npm run check:guardrails 2>&1 | tail -4`
Expected: all pass; guardrails clean (`bg-sky-500/10 text-sky-700` and `bg-amber-500/10 text-amber-700` satisfy `no-low-contrast-chip`).

- [ ] **Step 5: Commit**

```bash
git add src/components/RaceTeamsManager.jsx src/components/RaceTeamsManager.move.test.jsx 'src/app/(members)/events/[id]/teams/page.js'
git commit -m "EVENT-MOVE.1 — teams page: Move to event action, Moved from chip, moved-out footer"
```

---

### Task 11: Whole-suite gate, build, PR, changelog

- [ ] **Step 1: CI mirror**

Run: `npm test 2>&1 | tail -6 && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths`
Expected: every command exits 0. Fix anything red before moving on; do not add allowlist entries to silence a real finding.

- [ ] **Step 2: Production build** (new routes and a new component were added)

Run: `npm run build 2>&1 | tail -15`
Expected: "Compiled successfully", both new routes listed.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "EVENT-MOVE.1 — move an event entry to another event (staff)" --body "$(cat <<'EOF'
Staff can move one event entry (team or single person, with its people and payment) to another event, across studios, from the teams page.

- mig 708: `registration_moves` history, `race_events.moved_email_subject/intro`, `move_race_registration()` (atomic; clones the team when the move crosses studios). **Apply before merge.**
- `src/lib/registration-move.js`: the rules (pure, tested) + `listMoveTargets` + `moveRegistration`. Never moves money; a price gap is shown and recorded.
- `POST /api/event-registrations/[id]/move`, `GET …/move-targets` — manager+ holding `races` at both studios. A full wave answers 409 `wave_full`; the dialog offers Move anyway (force) or Don't move.
- "Your entry has moved" email with fresh QR codes, operator-editable copy on the event form.
- Teams page: Move to event action, Moved from chip (+ outstanding gap), moved-out footer.

Spec: docs/superpowers/specs/2026-10-08-event-entry-move-design.md. Host portal is PR 2 on the same function.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Changelog entry** (with the PR number from the previous step, e.g. 1950)

Create `docs/changelog/entries/<PR>.md` holding exactly one row:

```
| #<PR> | EVENT-MOVE.1 — move an event entry to another event (staff) | 2026-10-08. Staff move an entry (team or single person) to another event from the teams page, across studios; its payment follows, a `registration_moves` row records it, the customer gets new tickets by email, a full wave can be forced. Never moves money: a price gap is shown and recorded. Mig 708. Host portal next. |
```

Run: `npx vitest run tests/changelog-entries.test.js 2>&1 | tail -3`
Expected: pass. Then:

```bash
git add docs/changelog/entries/<PR>.md
git commit -m "EVENT-MOVE.1 — changelog entry"
git push
```

- [ ] **Step 5: Report**

Report the PR URL, that mig 708 must be applied via the Supabase MCP against `iyvtbjjxdggiadzwwvdj` before merge (then `get_advisors` type=security), and that the first real move should be eyeballed on a Vercel preview with a test entry: the teams page of the source and target events, the email, and the `registration_moves` row.

---

## Self-review against the spec

- **Rules table:** every code has a test in Task 3; `already_entered` only at the same studio; `wave_full` carries `spots_left`; `force` skips only `wave_full`. ✔
- **Cross-studio clone:** mig 708 function, Task 1; the dialog's studio notice, Task 9; the moved-out footer uses the entry's current team name, Task 7. ✔
- **Price gap:** computed in Task 2, recorded via the function, shown in the dialog (Task 9) and on the chip (Task 10). ✔
- **Email:** Task 5, `kind: 'moved'`, consent-gated, QR per person, `notified_at` stamped after the send; copy editable in Task 8. ✔
- **After-effects:** contact event, timeline row, host list sync, Task 4. ✔
- **Routes and auth at both studios:** Task 6; openapi registered. ✔
- **Host PR 2 seam:** `allowedEventIds` on both lib entry points; dialog takes `targetsUrl`/`moveUrl`. ✔
- **Not in this PR (by spec):** Mia tool, host portal, SMS, cross-payee moves.
