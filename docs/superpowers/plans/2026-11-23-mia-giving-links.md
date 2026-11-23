# Mia Giving Links (MIAGIVING.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `list_upcoming_events` also returns past events whose raffle or donation page is still open, across the organisation, so Mia sends the link instead of handing over.

**Architecture:** A new `src/lib/agent/event-giving.js` holds one pure shaper and one reader. `executeEventTool` calls the reader inside its `list_upcoming_events` arm and merges the result. The prompt gains one rule line.

**Tech Stack:** Next.js 16, supabase-js (service role), vitest, `tests/helpers/fake-db.js`.

**Spec:** `docs/superpowers/specs/2026-11-23-mia-giving-links-design.md`

## Global Constraints

- `GIVING_WINDOW_DAYS = 30`.
- UN1T events only: `host_id` null, `active` true, `status` 'published'.
- Organisation comes from the thread's studio row, never from model input.
- "Past" is judged on the event studio's own zone (`zoneOfLocation`), never a zone literal.
- Entry fields are exactly: `name, studio, this_conversation, date, charity, raffle_open, raffle_closes_label, donations_open, url`.
- Model-facing text has no em or en dashes and, because un1t.online prompts ban them, none of the words "limited", "spaces", "capacity".
- A failed read sets `still_giving_unreadable: true`; never an empty list in its place.
- Every `.select()` destructures `error`. No migration.

## Review Focus

1. Raffle open, charity off, event 40 days old: listed with `donations_open: false`.
2. Charity on, event exactly 30 days old: listed; 31 days: not listed.
3. Event dated today: not listed (it is still an upcoming event).
4. Raffle with `online_closes_at` in the past and charity off: not listed.
5. Organisation read fails: upcoming events still returned, plus `still_giving_unreadable`.

---

### Task 1: The reader and shaper

**Files:**
- Create: `src/lib/agent/event-giving.js`
- Test: `src/lib/agent/event-giving.test.js`

**Interfaces:**
- Produces:
  - `GIVING_WINDOW_DAYS: number`
  - `givingEntry({ event, raffle, location, threadLocationId, baseUrl, nowMs }) -> object | null` (pure; null when the event does not qualify)
  - `readStillGiving(db, { threadLocationId, nowMs?, baseUrlFor? }) -> Promise<{ entries: object[], unreadable: boolean }>`; never throws. `baseUrlFor(db, locationId)` defaults to `resolveCustomerBaseUrl`.

- [ ] **Step 1: Write failing tests** for `givingEntry` covering Review Focus 1 to 4, the exact key set, `charity` from `event.charity.name`, `raffle_closes_label` via `dateTimeLabel` from `offer-view.js`, `this_conversation`, a host event returning null, and that `JSON.stringify(entry)` contains no id.
- [ ] **Step 2: Write failing tests** for `readStillGiving` with `createFakeDb`: two studios in one organisation and one in another (the other organisation's event never appears); the thread studio's entries sort first, then by date descending; a `race_events` error gives `{ entries: [], unreadable: true }`; a `raffles` error keeps donation-qualified entries with `raffle_open: false` and `unreadable: true`.
- [ ] **Step 3: Run** `npx vitest run src/lib/agent/event-giving.test.js`; expect failures for the missing module.
- [ ] **Step 4: Implement.** Reads: thread `locations` row for `organization_id`; the organisation's active `locations` (`id, name, timezone, active`); `race_events` (`id, name, slug, race_date, location_id, host_id, active, status, charity_enabled, charity`) with `.in('location_id', ids).is('host_id', null).eq('active', true).eq('status', 'published').lt('race_date', <latest today across zones>).order('race_date', { ascending: false }).limit(200)`; `raffles` (`RAFFLE_COLS`) with `.in('race_event_id', eventIds)`. Use `onlineSalesState` from `@/lib/raffle-online`. Cap the result at 6 entries.
- [ ] **Step 5: Run** the test file; expect all passing.
- [ ] **Step 6: Commit** `MIAGIVING.1 — read past events still taking raffle entries or donations`.

### Task 2: Wire into the tool

**Files:**
- Modify: `src/lib/agent/event-tools.js` (the `list_upcoming_events` arm and its description)
- Test: `src/lib/agent/event-tools.test.js`

**Interfaces:**
- Consumes: `readStillGiving` from Task 1.
- Produces: tool result `{ events, still_giving?, still_giving_unreadable?, message? }`.

- [ ] **Step 1: Write failing tests**: no upcoming events and one giving entry returns `events: []` with `still_giving` and no "No upcoming" message; nothing at all returns the existing empty message; unreadable returns `still_giving_unreadable: true` and no empty message (Review Focus 5).
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/event-tools.test.js`; expect the new tests failing.
- [ ] **Step 3: Implement** the merge, and append to the tool description: what `still_giving` is, that each entry's `url` is the page to send, and to copy `raffle_closes_label` as written.
- [ ] **Step 4: Run** the test file; expect passing.
- [ ] **Step 5: Commit** `MIAGIVING.1 — list_upcoming_events carries still_giving`.

### Task 3: Prompt rule, fixtures, docs

**Files:**
- Modify: `src/lib/agent/prompt.js`, `src/lib/agent/prompt.test.js`, `src/lib/agent/__fixtures__/*.json`
- Create: `docs/changelog/entries/<PR>.md`
- Modify: `docs/rules/conventions.md`, `CLAUDE.md` (one line each)

- [ ] **Step 1: Write a failing test** in `prompt.test.js`: every variant's prompt contains the exported `GIVING_RULE`, and the rule contains none of the banned words or dashes.
- [ ] **Step 2: Implement** `export const GIVING_RULE`, appended after the events relay line in every variant: send the entry's url when asked about a past event's raffle or donations; name the studio when `this_conversation` is false; copy `raffle_closes_label`; never state an amount raised; never raise giving unprompted; `still_giving_unreadable` means unknown, so say you cannot check and offer the team.
- [ ] **Step 3: Regenerate** the pinned fixtures from the real builders with a temporary test file, after proving it reproduces the current fixtures unchanged on `origin/main` code; delete the temporary file.
- [ ] **Step 4: Run** `npx vitest run src/lib/agent`; expect passing.
- [ ] **Step 5: Run** lint and the `check:*` gates from the CI mirror, then `npm run build`.
- [ ] **Step 6: Commit** and open the PR.
