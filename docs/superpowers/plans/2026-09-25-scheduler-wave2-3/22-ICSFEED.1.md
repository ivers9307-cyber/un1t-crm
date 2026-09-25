## PR ICSFEED.1 — a coach subscribes to their own published shifts in Apple, Google or Outlook Calendar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every staff member can get a private calendar link (iCalendar, RFC 5545) that shows their own PUBLISHED shifts at every studio they are rostered at, two weeks back and eight weeks ahead. Apple Calendar, Google Calendar and Outlook subscribe to it and poll it. The link is a secret token: the coach can replace it (the old one dies at once) or turn it off, and it stops answering the moment the person is deactivated. On the phone, the Schedule tab gets a "Subscribe to my shifts" row that makes the link and hands it straight to the calendar app.

**Why:** 00-INDEX default 5 (flagged REVIEW, cheap to change before merge): *"The calendar feed carries published shifts only, two weeks back and eight ahead, both studios, and stops working when the coach is deactivated."* Coaches pulled for it in the 19 Sep product review: the roster lives in our app, their life lives in their calendar.

**Architecture:** One pure iCalendar writer (`src/lib/ics.js`), one pure shifts-to-events mapper (`src/lib/staff-calendar-feed.js`), one token module shaped exactly like `src/lib/widget-token.js` (`src/lib/calendar-feed-token.js`), one IO module (`src/lib/staff-calendar-feed-server.js`). Two routes: the anonymous feed `GET /api/calendar-feed/<token>.ics`, and the session-only management route `GET/POST/DELETE /api/me/calendar-feed`. Migration 632 adds `staff_calendar_feeds`, one row per person, storing only the sha256 of the token, service-role only. Web gets a card on `/account`; the phone gets one row on the Schedule tab, with its decisions in `mobile/lib/`.

**Tech Stack:** Next.js 16 route handlers, Supabase Postgres (PGlite for the migration replay), Vitest (node + jsdom), Expo / React Native (`Linking`, `Share`, `Platform`).

**Size / ships:** M. **Migration 632** (reserved in 00-INDEX) + web deploy + **OTA** (`mobile/lib/**`, `mobile/components/**` and `mobile/app/**` change, so merging publishes a phone update at 100%).

**DEPLOY ORDER (strict):**
1. **Apply mig 632 FIRST** (steps at the end). Alone it changes nothing: a new, empty, service-role-only table.
2. **Then merge.** Without the table, the feed route's lookup errors (it answers 503, never an empty calendar) and `/api/me/calendar-feed` answers 500. A Vercel preview of this branch runs against prod, so the preview is broken until 632 is applied. Expected; apply before checking the preview.
3. A phone that has not taken the OTA simply has no Subscribe row. Harmless in either order.

**Batch 4 pairing:** this PR rides beside 14 BLOCKEDIT.1, which merges FIRST (00-INDEX "Build order"). Both touch `mobile/app/(staff)/(tabs)/schedule.jsx`. This PR's edit there is two lines (one import, one JSX line before `</ScrollView>`), so rebase after BLOCKEDIT.1 lands and re-find the anchors by text, not line number. Task 13 is the optional hook for BLOCKEDIT.1's coach-visible briefing note.

---

### What was found (verified against `origin/main` at `6eb3ef65`, #1756)

**No iCalendar code exists.** `grep -rn "BEGIN:VCALENDAR" src shared mobile` finds one inline string in `src/components/RaceConfirmedPage.jsx:100-116` (a client-side "Add to calendar" `data:` URI for one race). It has no folding and no escaping and is not reusable. So `src/lib/ics.js` is new.

**Three token schemes are in use; the widget one is the right model.**

| Scheme | Where | Stored | Why not / why |
|---|---|---|---|
| Plaintext token column | `contact_preferences.unsubscribe_token` (mig 005, a v4 UUID) | the working token itself | A DB read, backup or support query yields working links. Wrong for a link that exposes a person's movements. |
| Stateless HMAC | `src/lib/event-checkin-tokens.js`, `src/lib/campaign-web-view.js` | nothing | Cannot be revoked one at a time without a counter column; rotating the server secret kills every link at once. |
| **sha256 of a 256-bit random token** | `src/lib/widget-token.js` + mig 607 (`widget_tokens.token_hash text not null unique`), also bridge and fleet device tokens | only the hash | A row leak yields nothing usable; revocation is a row change; lookup is an index hit on the hash, so no plaintext is ever compared. **Used here.** |

`hashWidgetToken`'s comment (`widget-token.js:21-25`) already argues why plain sha256 with no salt is right for 256 bits of CSPRNG output. The cost, accepted: the URL is shown once. A coach who wants it on a new device makes a new link (the old one stops). iCloud and Google sync a subscription across the coach's own devices, so this is rare.

**The public-path allowlists: which of the four apply to an API route.** CLAUDE.md's invariant is about public PAGES. The precedent for a public API route is `/api/mobile/review-login`, whose proxy comment (`src/proxy.js:237-240`) says: *"Not a public PAGE, so the other three allowlists (AppShell, brands, tenant-domains) don't apply — nothing renders a shell, and the mobile app calls the canonical CRM host, never a brand hostname."* The same holds here:
1. `src/proxy.js`: **YES.** `publicPaths` (line 217) is bare-prefix; `publicExactPaths` (line 241) is segment-matched (`pathname === p || pathname.startsWith(p + '/')`, line 246). The feed goes in **`publicExactPaths` as `'/api/calendar-feed'`**, so `/api/calendar-feeds` or `/api/calendar-feed-admin` are NOT public by inheritance, and `/api/me/calendar-feed` stays gated. The matcher (`proxy.js:393`) only skips image extensions, so a `.ics` path does reach the proxy.
2. `AppShell` `PUBLIC_PATHS` (`src/components/AppShell.jsx:78`): **NO.** It decides whether a PAGE renders its chrome. A route handler never renders AppShell.
3. `src/lib/brands.js` `un1t-marketing` `allowedPaths` (line 80): **NO, deliberately.** The URL is always minted from `getAppUrl()` (`src/lib/app-url.js:16`), which is a CRM host (`crm.repset.ie`; `getCrmHostnames()` at `brands.js:312` puts `NEXT_PUBLIC_APP_URL`'s host in the CRM set). On `un1tdublin.com` the feed has no business existing; the fallback rewrite to `/welcome` is the correct answer there.
4. `DB_BRAND_DEFAULTS.allowedPaths` (`src/lib/tenant-domains-edge.js:83`): **NO, same reason.**

Task 7's test pins BOTH directions: admitted anonymously on both CRM hosts, and not served on the marketing or a tenant host. `src/public-compliance-paths.test.jsx` is the "public on EVERY host" guard, which is exactly what this path is not, so it is untouched. The legacy-host 308 never touches `/api/*` (`src/lib/legacy-host-redirect.js:53`), so a feed URL on `crm.un1tdublin.com` keeps working if that flag is ever flipped.

**`check:route-guards`** (`scripts/check-route-guards.mjs`): an unguarded route must be in `EXEMPT` (line 118) with a reason, like `src/app/api/preferences/[token]/route.js` (line 125). `/api/public/**` is auto-passed (line 250), but `/api/public/` is ALSO in the marketing and tenant allowlists (point 3 above), so the feed does not live there.

**Deactivation: four doors, one lock.** A person goes inactive through `PUT /api/staff/[id]` with `active:false` (`src/app/api/staff/[id]/route.js:167`), `DELETE /api/staff/[id]` (line 459), the tombstone (`/api/staff/[id]/permanent`, which refuses unless `active=false` first, line 123), or a hand-run SQL flip. A tombstone can never be active again (`CHECK profiles_tombstone_is_inactive`, mig 622:271-274). The widget credential faced the same four doors and chose a check at use time (`src/lib/widget-auth.js:40-47`: `if (isTombstone(profile) || profile.active === false) return null`), with mig 622 deleting its rows (line 613) as a second lock. **Decision: the feed route's active check IS the lock** (D5). It is the one door every fetch passes; no writer can forget it.

**Effective times.** A shift's effective start is `shift_assignments.start_time_override` else `shift_blocks.start_time` (the same `COALESCE(a.start_time_override, b.start_time)` mig 604 and mig 622 use; also `src/lib/checklist-instances.js:193`, `src/lib/swap-lifecycle.js:444`). Blocks carry a snapshot of the template time, so the template is never the fallback. `shift_blocks` has `CHECK (end_time > start_time)` (mig 067), so no block crosses midnight; `time` allows `'24:00:00'`, which WORKTIME.1 met as an end time. Published = `shift_blocks.roster_id → rosters.status = 'published'` (the ROSTER-FIX.1 derivation in `src/lib/roster-read.js:134`). Live = `status <> 'cancelled'` (`isLiveAssignment`, `src/lib/roster.js:440`).

**Wall clock to UTC** already exists and is DST-correct for any zone: `wallMsInTz(dateStr, 'HH:MM', tz)` and `resolveTz(tz)` in `src/lib/tz-time.js:202,119`. `locations.timezone` exists (mig 004, default `'Europe/Dublin'`), as do `locations.name` and `locations.address`.

**Rate limiting lesson (UNSUB-RL.1, `src/lib/consent-token-guard.js`).** A per-IP limit is the wrong axis for URLs fetched by a provider: Google Calendar fetches every subscriber's feed from a shared egress pool, exactly the Gmail one-click case that cost unsubscribes. So: no per-IP budget; a per-TOKEN budget on a token that resolves (D8).

**Where the phone opens external URLs.** `Linking.openURL` (e.g. `mobile/app/(staff)/events/[id].jsx:60`, `mobile/app/(member)/account/integrations.jsx:159`); `Share.share` for the fallback (`mobile/app/(member)/sessions/[id]/wrapped.jsx:235`). Do NOT use `Linking.canOpenURL` for `webcal:`: on iOS it answers false for any scheme not listed in `LSApplicationQueriesSchemes`, and on Android 11+ for anything not declared in `<queries>`, both native config that an OTA cannot change. `openURL` itself needs neither. So the phone tries `openURL` and falls back on a throw.

**Web placement.** `/account` (`src/app/account/page.js`) is "visible to every authenticated user" and already carries per-person settings (landing, signature, password, studio PIN). The card goes after `StudioPinSettings` (lines 96-102). With `STAFF_WEB_LOCK=1` (`src/lib/staff-web-lock.js`, default OFF) staff never reach web pages, so the phone row is the primary surface and the web card is the fallback.

---

### Decisions (made here, each justified)

**D1. Store only `sha256(token)`; token = `rcf_` + 32 random bytes base64url (43 chars).** Same shape and argument as `widget-token.js`. The `rcf_` prefix makes a pasted token recognisable in a support thread and lets `hashCalendarFeedToken` refuse anything that is not one before any DB call. A DB CHECK (`token_hash ~ '^[0-9a-f]{64}$'`) makes storing a plaintext token by mistake impossible.

**D2. One row per person, `profile_id` is the primary key.** Replace = one UPDATE of `token_hash` (atomic: there is never a moment with two live links or none). Turn off = DELETE. No history table: nothing reads it, and `rotated_at` answers "when did I last make a new link". Two concurrent "create" calls race to the PK; the loser gets 409.

**D3. The URL is `https://<getAppUrl()>/api/calendar-feed/rcf_….ics`.** The `.ics` suffix helps clients that sniff the extension (Outlook desktop, some Android apps). The route accepts the token with or without `.ics`. The server builds all three URLs (`url`, `webcal_url`, `google_url`) so the phone and the web never build one. `google_url` is `https://calendar.google.com/calendar/render?cid=<webcal url, encoded>`, the add-by-URL entry Google Calendar accepts.

**D4. Times are written in UTC (`DTSTART:20260928T050000Z`), converted from each studio's wall clock with `wallMsInTz` and `resolveTz(locations.timezone)`.** Rejected alternatives:
- *Floating local time* (no `Z`, no `TZID`): a phone in another zone shows 06:00 local, which is the wrong instant.
- *`TZID=Europe/Dublin` + a hand-written `VTIMEZONE`*: RFC 5545 §3.2.19 requires the `VTIMEZONE`; Outlook needs it; its rules are hand-maintained text that must match IANA; and Dublin's IANA rules use a negative DST save that tools disagree on. UTC needs no `VTIMEZONE`, is valid everywhere, and the conversion is the repo's existing, tested `tz-time.js`. Calendar apps display it in the viewer's zone, which for a coach in Dublin is Dublin. Task 4's tests pin both 2026 transitions (29 Mar and 25 Oct) and a non-Dublin studio.
- A `'24:00'` end is the next day's `00:00` in the studio's zone.
- An effective end at or before the start (a bad override) is written with no `DTEND`, which RFC 5545 §3.6.1 defines as ending at `DTSTART`. It never produces an invalid event.

**D5. Deactivation: the feed route refuses (404) any profile with `active = false` or `deleted_at` set; no route revokes the row.** One lock at the only door, covering all four deactivation paths. Consequences, accepted and flagged in Review notes: reactivation RESUMES the same link (as with `profile_locations`, which deactivation also keeps so reactivation restores it), and a tombstone keeps an inert row (a hash and three timestamps, no PII; the profile can never be active again, by DB CHECK). `staff_calendar_feeds.profile_id` is `ON DELETE CASCADE`, so if a profile row were ever deleted the feed goes with it. **`/api/staff/[id]/permanent` and `tombstone_staff_profile` are NOT touched** (their suite pins "no DELETE, one UPDATE"; a `CREATE OR REPLACE` of a security-critical function for an already-dead link is not worth it).

**D6. Content.** Own assignments only (`.eq('profile_id', …)`; no colleague row is ever read, so no colleague name can leak). Published and live only. Window: Dublin today −14 days to +56 days. `SUMMARY` = `<template name> · <studio name>`. `LOCATION` = `<studio name>, <address>` when the address is set. `DESCRIPTION` = one fixed line (Task 13 adds BLOCKEDIT.1's coach-visible briefing note if it is on main). Assignment `notes` and `partial_reason` are manager working notes (COACHSCOPE.1, `slimShiftRowForCoach`, `roster-read.js:145-172`) and never leave the building: they are not selected at all. No pay, no rates, no minimums, no capacity. `UID` = `shift-<assignment id>@repset.ie`, stable for the life of the assignment, so an edited shift replaces itself and a removed or cancelled one disappears on the next poll. `DTSTAMP` and `LAST-MODIFIED` = the later of the assignment's and the block's `updated_at` (RFC 5545 §3.8.7.2: with no `METHOD`, `DTSTAMP` is the last revision time), so the output is deterministic for a given roster.

**D7. A read error is 503 + `Retry-After`, NEVER a 200 with an empty calendar.** A subscribed calendar REPLACES its whole copy with each fetch; an empty 200 would delete every shift from every subscriber's phone on a database blip. 503 makes the client keep its last good copy and retry. Same for a failed token lookup.

**D8. Rate limit: per token, never per IP.** `calfeed:token:<first 32 hex of the hash>`, 30 per 15 minutes (an iPhone, iPad and Mac each on the 5-minute setting is 9). Refused → 429 with `Retry-After` (`rateLimitResponse`, `src/lib/rate-limit.js:151`). No per-IP budget on unknown tokens: enumeration of 256-bit tokens is hopeless, an unknown token costs one unique-index lookup (the same as a limiter call would), and a per-IP budget peeked before the lookup would refuse valid holders who share Google's egress IPs (UNSUB-RL.1). The limiter fails open (`rate-limit.js:16`).

**D9. Caching.** `Cache-Control: private, max-age=900` on a feed (the client may reuse it for 15 minutes; no shared cache ever holds it, so a replaced or turned-off link dies server-side at once). `no-store` on 404/503 and on the management responses (the POST body carries the only copy of the URL). `X-Robots-Tag: noindex, nofollow`. `REFRESH-INTERVAL;VALUE=DURATION:PT60M` and `X-PUBLISHED-TTL:PT60M` ask for hourly polling; Apple honours the user's own setting and Google polls on its own schedule (hours). Said plainly in the UI copy.

**D10. `last_fetched_at` is stamped at most every 15 minutes** (skipped when the stored value is younger), awaited but never fatal (a failed stamp is logged, the feed is still served). It is the only way a coach or a support session can see "my calendar is actually polling".

**D11. Management is the caller's OWN feed only; no id parameter exists.** `POST` without `replace: true` when a link exists answers **409 `feed_exists`** (so a double tap or a second device never silently kills the first subscription); `replace: true` rotates. `POST` and `DELETE` refuse (403) while a master is impersonating (`user.impersonatingFrom`) or in a support session acting as someone (`user.supportSession?.impersonatedUserId`): minting another person's private URL into a master's browser hands them a long-lived secret. `GET` returns `{ active, created_at, rotated_at, last_fetched_at }` and can never return the URL (it is not stored). No `WEB_PERMISSIONS` key: every staff member may subscribe to their own shifts, so `check:mobile-parity` has nothing to reconcile.

**D12. `X-WR-CALNAME` is the constant `Rostered shifts`.** This is staff-facing, not customer-facing (the operator-editable rule is for customer copy), and every calendar app lets the coach rename it.

---

### Files

| File | Responsibility | OTA bundle path? |
|---|---|---|
| `supabase/migrations/632_staff_calendar_feeds.sql` (create) | the table, RLS on with no policies, browser grants revoked, self-check | no |
| `tests/migration-632-staff-calendar-feeds.test.js` (create) | PGlite replay of 632 | no |
| `src/lib/ics.js` (create) | RFC 5545 writer: `escapeIcsText`, `foldIcsLine`, `formatIcsUtc`, `buildIcsCalendar` | no |
| `src/lib/ics.test.js` (create) | escaping, 75-octet folding (multi-byte safe), CRLF, DTEND rule | no |
| `src/lib/calendar-feed-token.js` (create) | `generateCalendarFeedToken`, `hashCalendarFeedToken`, `tokenFromFeedFile`, `calendarFeedUrls` | no |
| `src/lib/calendar-feed-token.test.js` (create) | token shape, hash, file parsing, URL building | no |
| `src/lib/staff-calendar-feed.js` (create) | pure: window, `wallInstant`, `shiftToFeedEvent`, `buildStaffShiftFeed` | no |
| `src/lib/staff-calendar-feed.test.js` (create) | DST, override, `24:00`, published/live filter, UID, no notes | no |
| `src/lib/staff-calendar-feed-server.js` (create) | IO: resolve token, load shifts, stamp fetch, status, issue, revoke | no |
| `src/lib/staff-calendar-feed-server.test.js` (create) | the IO against `fakeDb` | no |
| `src/app/api/calendar-feed/[file]/route.js` (create) | the anonymous feed | no |
| `src/app/api/calendar-feed/[file]/route.test.js` (create) | 404/429/503/200 | no |
| `src/app/api/me/calendar-feed/route.js` (create) | GET status, POST create or replace, DELETE turn off | no |
| `src/app/api/me/calendar-feed/route.test.js` (create) | scoping, 409, impersonation, no-store | no |
| `src/proxy.js` (modify: comment block above line 241, and line 241) | `'/api/calendar-feed'` in `publicExactPaths` | no |
| `src/calendar-feed-path.test.js` (create) | proxy admits on CRM hosts, not on brand hosts; look-alikes stay gated | no |
| `scripts/check-route-guards.mjs` (modify: `EXEMPT`, lines 118-139) | the feed route's exemption + reason | no |
| `src/components/CalendarFeedCard.jsx` (create) | the `/account` card | no |
| `src/components/CalendarFeedCard.test.jsx` (create) | jsdom: create, replace (confirm), turn off, 409 | no |
| `src/app/account/page.js` (modify: import after line 23; card after lines 96-102) | mounts the card | no |
| `mobile/lib/calendar-feed.js` (create) | row model, sync label, open order, prompt copy | **yes** |
| `mobile/lib/calendar-feed.test.js` (create) | the decision table | **yes** (test-only over-trigger, accepted per CLAUDE.md) |
| `mobile/lib/calendar-feed-api.js` (create) | three `api()` wrappers | **yes** |
| `mobile/lib/calendar-feed-api.test.js` (create) | wire contract | **yes** (test-only over-trigger) |
| `mobile/components/schedule/CalendarSubscribeRow.jsx` (create) | the Schedule-tab row | **yes** |
| `mobile/app/(staff)/(tabs)/schedule.jsx` (modify: import after line 42; one line before `</ScrollView>` at line 746) | mounts the row in the Me view | **yes** |
| `src/lib/openapi.js` (modify: after the `/api/widget/tokens/{id}` registration, ~line 7187) | four operations + schemas | no |
| `src/lib/openapi.test.js` (modify: append one `it`) | pins them | no |
| `eslint.guardrails.config.mjs` (modify: `no-unchecked-supabase-write` files list, after line 290) | arm the new IO module (born clean) | no |
| `docs/roster-v2.md` (modify: append a section) | the rule, in one place | no |
| `docs/CHANGELOG.md` (modify, after `gh pr create`) | row `#<PR>` | no |

**Deliberately untouched:** `src/components/AppShell.jsx`, `src/lib/brands.js`, `src/lib/tenant-domains-edge.js`, `src/public-compliance-paths.test.jsx` (see "public-path allowlists" above); `src/app/api/staff/[id]/route.js`, `src/app/api/staff/[id]/permanent/route.js`, mig 622 (D5); `mobile/lib/schedule-api.js` and its exhaustive-exports test (a conflict hotspot for 14/17/19/20; the new wrappers live in their own file); `shared/**` (the phone never builds a URL or reads a shift for this).

**Prerequisite:** a fresh worktree off `origin/main` (CLAUDE.md "Worktrees"; memory `dev-workflow-worktrees`), after BLOCKEDIT.1 has merged if it is ready:

```bash
git fetch origin main
git worktree add ~/code/un1t-crm-icsfeed1 -b icsfeed-1 origin/main
cd ~/code/un1t-crm-icsfeed1 && npm ci
```

Run focused tests with `npx vitest run <files>`. Run the full suite and `npm run build` once, at the gate (8GB machine: close the dev server and other worktrees' watchers first). Never `git stash`.

---

### Task 1: Migration 632 and its PGlite replay

**Files:**
- Create: `supabase/migrations/632_staff_calendar_feeds.sql`
- Create: `tests/migration-632-staff-calendar-feeds.test.js`

There is no local Supabase stack, so without a replay the DDL would first run on prod (the 613/618/622/624/628 convention). The replay also proves the grant fence against Supabase's DEFAULT privileges, which grant every new `public` table to `anon`, `authenticated` and `service_role`: the test sets the same default, so the REVOKE is what does the work.

- [ ] **Step 1: Write the failing test**

```js
// ICSFEED.1 — behavioural test for migration 632, against the REAL file.
//
// Same reason as the 613/618/622/624/628 replays: no local Supabase stack, so
// without this the DDL would get its first execution on prod. Boots PGlite,
// recreates the three API roles and Supabase's DEFAULT privileges (every new
// table in public is granted to anon, authenticated and service_role), applies
// the real 632 file, and proves the header's claims — above all that the
// browser roles end up with NOTHING on a table of secret-link hashes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_632 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/632_staff_calendar_feeds.sql'),
  'utf8',
)

const ME = '10000000-0000-0000-0000-00000000000a'
const OTHER = '10000000-0000-0000-0000-00000000000b'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  -- What Supabase does for every table created in public. The migration must
  -- undo it for the browser roles itself.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY,
    active boolean DEFAULT true,
    deleted_at timestamptz
  );
  INSERT INTO public.profiles (id) VALUES ('${ME}'), ('${OTHER}');
`

async function boot({ before = '' } = {}) {
  const pg = new PGlite()
  await pg.exec(BASE_SCHEMA)
  if (before) await pg.exec(before)
  return pg
}

let db
beforeAll(async () => {
  db = await boot()
  await db.exec(MIG_632)
}, 60_000)

afterAll(async () => { await db?.close() })

async function inTx(fn) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}

describe('migration 632 — staff_calendar_feeds', () => {
  it('has exactly the documented shape', async () => {
    const { rows } = await db.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'staff_calendar_feeds' ORDER BY column_name`)
    expect(rows).toEqual([
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'last_fetched_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'profile_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'rotated_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'token_hash', data_type: 'text', is_nullable: 'NO' },
    ])
  })

  it('has RLS on and NO policies, so only the service role can reach it', async () => {
    const rls = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.staff_calendar_feeds'::regclass`)
    expect(rls.rows).toEqual([{ relrowsecurity: true }])
    const pol = await db.query(`SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'public.staff_calendar_feeds'::regclass`)
    expect(pol.rows).toEqual([{ n: 0 }])
  })

  it('takes every privilege away from anon and authenticated, despite the default grants', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const { rows } = await db.query(`SELECT has_table_privilege($1, 'public.staff_calendar_feeds', $2) AS ok`, [role, priv])
        expect(rows[0].ok, `${role} still holds ${priv}`).toBe(false)
      }
    }
  })

  it('the browser role is refused outright, not shown an empty table', async () => {
    await db.exec('SET ROLE authenticated')
    try {
      await expect(db.query('SELECT * FROM public.staff_calendar_feeds')).rejects.toThrow(/permission denied/)
    } finally {
      await db.exec('RESET ROLE')
    }
  })

  it('leaves the service role the four privileges the routes use', async () => {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const { rows } = await db.query(`SELECT has_table_privilege('service_role', 'public.staff_calendar_feeds', $1) AS ok`, [priv])
      expect(rows[0].ok, `service_role lacks ${priv}`).toBe(true)
    }
  })

  it('stores only a lowercase sha256 hex: a plaintext token cannot be written by mistake', async () => {
    await expect(db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${ME}', 'rcf_${'x'.repeat(43)}')`))
      .rejects.toThrow(/staff_calendar_feeds_token_hash_is_sha256/)
    await expect(db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${ME}', '${'A'.repeat(64)}')`))
      .rejects.toThrow(/staff_calendar_feeds_token_hash_is_sha256/)
  })

  it('one link per person, and a hash can belong to one person only', async () => {
    await inTx(async () => {
      await db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${ME}', '${HASH_A}')`)
      await expect(db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${ME}', '${HASH_B}')`))
        .rejects.toThrow(/staff_calendar_feeds_pkey/)
    })
    await inTx(async () => {
      await db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${ME}', '${HASH_A}')`)
      await expect(db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${OTHER}', '${HASH_A}')`))
        .rejects.toThrow(/staff_calendar_feeds_token_hash_key/)
    })
  })

  it('replacing the link is one UPDATE; created_at defaults, rotated_at/last_fetched_at start empty', async () => {
    await inTx(async () => {
      const ins = await db.query(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${ME}', '${HASH_A}')
        RETURNING created_at IS NOT NULL AS has_created, rotated_at, last_fetched_at`)
      expect(ins.rows).toEqual([{ has_created: true, rotated_at: null, last_fetched_at: null }])
      const upd = await db.query(`UPDATE public.staff_calendar_feeds SET token_hash = '${HASH_B}', rotated_at = now()
        WHERE profile_id = '${ME}' RETURNING token_hash`)
      expect(upd.rows).toEqual([{ token_hash: HASH_B }])
    })
  })

  it('goes with its profile if a profile row is ever deleted (ON DELETE CASCADE)', async () => {
    await inTx(async () => {
      await db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${OTHER}', '${HASH_B}')`)
      await db.exec(`DELETE FROM public.profiles WHERE id = '${OTHER}'`)
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.staff_calendar_feeds`)
      expect(rows).toEqual([{ n: 0 }])
    })
  })

  it('re-running the file is a no-op', async () => {
    await db.exec(MIG_632)
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'public.staff_calendar_feeds'::regclass`)
    expect(rows).toEqual([{ n: 0 }])
  })
})

describe('the self-check aborts the WHOLE file', () => {
  it('when a same-named table of another shape already exists, CREATE IF NOT EXISTS keeps it and the DO block raises', async () => {
    const other = await boot({ before: 'CREATE TABLE public.staff_calendar_feeds (profile_id uuid PRIMARY KEY, token_hash text)' })
    try {
      await expect(other.exec(MIG_632)).rejects.toThrow(/mig 632: staff_calendar_feeds has the wrong shape/)
      await other.exec('ROLLBACK')
      const { rows } = await other.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.staff_calendar_feeds'::regclass`)
      expect(rows).toEqual([{ relrowsecurity: false }])
    } finally {
      await other.close()
    }
  })

  it('without the REVOKE the grant check fires: the default grants are real and the file must remove them', async () => {
    const other = await boot()
    try {
      const noRevoke = MIG_632.replace('REVOKE ALL ON public.staff_calendar_feeds FROM anon, authenticated;', '')
      expect(noRevoke).not.toBe(MIG_632)
      await expect(other.exec(noRevoke)).rejects.toThrow(/mig 632: browser roles still hold/)
      await other.exec('ROLLBACK')
      expect((await other.query(`SELECT to_regclass('public.staff_calendar_feeds') AS t`)).rows).toEqual([{ t: null }])
    } finally {
      await other.close()
    }
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run tests/migration-632-staff-calendar-feeds.test.js`
Expected: fails to load with `ENOENT: no such file or directory, open '…/632_staff_calendar_feeds.sql'`.

- [ ] **Step 3: Write the migration**

```sql
-- 632 — ICSFEED.1: per-person calendar subscription (iCalendar feed) links.
--
-- NOT APPLIED YET. Apply BEFORE the ICSFEED.1 code deploys: the feed route
-- and /api/me/calendar-feed read and write this table, and without it the
-- feed answers 503 and the management route 500. Applied alone this file
-- changes no behaviour: a new, empty table nothing else reads. Behaviour is
-- proven ahead of apply by a PGlite replay
-- (tests/migration-632-staff-calendar-feeds.test.js), which runs this file
-- verbatim.
--
-- WHAT
--   public.staff_calendar_feeds — ONE row per person who has a calendar link.
--     profile_id      uuid PK → profiles(id) ON DELETE CASCADE
--     token_hash      text NOT NULL UNIQUE, CHECK lowercase sha256 hex
--     created_at      timestamptz NOT NULL DEFAULT now()
--     rotated_at      timestamptz   — set when the person makes a new link
--     last_fetched_at timestamptz   — stamped by the feed at most every 15 min
--
-- WHY A HASH (the widget_tokens / mig 607 model, src/lib/widget-token.js)
--   The link is `…/api/calendar-feed/rcf_<43 base64url chars>.ics`: 256 bits
--   of CSPRNG output. Only its sha256 is stored, so a row read (a backup, a
--   support query, a leaked export) yields no working link. Unsalted sha256 is
--   correct for 256 random bits: there is no dictionary to stretch against;
--   this is a lookup key, not a password hash. The CHECK makes it impossible to
--   store the plaintext by mistake. Cost, accepted: the URL is shown ONCE.
--
-- WHY ONE ROW PER PERSON (profile_id is the PK)
--   "Make a new link" is one UPDATE of token_hash: there is never a moment
--   with two live links, or none. "Turn off" is a DELETE. Two concurrent
--   creates race to the PK and the loser gets a 409.
--
-- DEACTIVATION is NOT handled here. The feed route refuses any profile with
--   active = false or deleted_at set (the widget-auth ACTIVEUSER.1 lock), which
--   covers every door (PUT active:false, DELETE /api/staff/[id], the tombstone,
--   a hand-run SQL flip). A tombstone keeps an inert row: a hash and three
--   timestamps, no PII, for a profile the mig 622 CHECK keeps inactive forever.
--
-- ACCESS: service role only. RLS on with NO policies (zero permissive
--   policies deny authenticated and anon outright), AND the table-level
--   privileges Supabase grants by default are revoked from both browser roles
--   (a table-level GRANT is what made mig 153's column REVOKE a no-op, so the
--   fence is the table, not columns). service_role keeps its four DML
--   privileges, granted explicitly so the file does not depend on defaults.
--   Expected advisor note afterwards: INFO rls_enabled_no_policy on this
--   table, exactly as widget_tokens carries since mig 607. By design.
--
-- LOCKS: CREATE TABLE only. No existing table is touched.
--
-- REPLAYING THIS FILE IS A NO-OP (IF NOT EXISTS; REVOKE/GRANT/COMMENT are
-- idempotent). One explicit transaction, so a failed self-check leaves
-- NOTHING applied (the 613/614/618/622/624/628 convention).
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; run IMMEDIATELY before applying, stop if any
-- answer differs from "Expected")
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The name is free:
--       SELECT to_regclass('public.staff_calendar_feeds') AS t;
--     Expected: t = NULL.
-- (b) The FK target is what the file assumes:
--       SELECT data_type FROM information_schema.columns
--        WHERE table_schema='public' AND table_name='profiles' AND column_name='id';
--     Expected: uuid.
-- (c) Supabase's default privileges on new public tables (information; KEEP
--     the output — it explains why the REVOKE line exists):
--       SELECT pg_get_userbyid(defaclrole) AS owner, defaclacl
--         FROM pg_default_acl
--        WHERE defaclnamespace = 'public'::regnamespace AND defaclobjtype = 'r';
--     Expected: rows granting anon, authenticated and service_role.
-- (d) list_migrations shows no 632.
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (e) SELECT column_name, data_type, is_nullable FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='staff_calendar_feeds' ORDER BY 1;
--     Expected 5 rows: created_at timestamptz NO, last_fetched_at timestamptz YES,
--     profile_id uuid NO, rotated_at timestamptz YES, token_hash text NO.
-- (f) SELECT relrowsecurity FROM pg_class WHERE oid = 'public.staff_calendar_feeds'::regclass;
--     Expected: true.
--     SELECT count(*) FROM pg_policy WHERE polrelid = 'public.staff_calendar_feeds'::regclass;
--     Expected: 0.
-- (g) SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--       FROM information_schema.table_privileges
--      WHERE table_schema='public' AND table_name='staff_calendar_feeds' GROUP BY 1 ORDER BY 1;
--     Expected: NO row for anon or authenticated. service_role holds at least
--     DELETE,INSERT,SELECT,UPDATE. (postgres, the owner, holds everything.)
-- (h) SELECT conname FROM pg_constraint
--      WHERE conrelid = 'public.staff_calendar_feeds'::regclass ORDER BY 1;
--     Expected: staff_calendar_feeds_pkey, staff_calendar_feeds_profile_id_fkey,
--     staff_calendar_feeds_token_hash_is_sha256, staff_calendar_feeds_token_hash_key.
-- (i) SELECT count(*) FROM public.staff_calendar_feeds;   Expected: 0.
-- (j) get_advisors (security, then performance). Expected: the INFO
--     rls_enabled_no_policy for staff_calendar_feeds (by design, see ACCESS);
--     nothing else new.
--
-- ROLLBACK (forward-only repo; this is a NEW migration, never an edit here):
--   Revert the ICSFEED.1 code FIRST and let it deploy. Then:
--     BEGIN; DROP TABLE IF EXISTS public.staff_calendar_feeds; COMMIT;
--   Every link anyone subscribed to stops working; re-applying later means
--   everyone makes a new link. Usually unnecessary: the table is inert
--   without the code.

BEGIN;

CREATE TABLE IF NOT EXISTS public.staff_calendar_feeds (
  profile_id      uuid        NOT NULL,
  token_hash      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  rotated_at      timestamptz,
  last_fetched_at timestamptz,
  CONSTRAINT staff_calendar_feeds_pkey PRIMARY KEY (profile_id),
  CONSTRAINT staff_calendar_feeds_profile_id_fkey
    FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT staff_calendar_feeds_token_hash_key UNIQUE (token_hash),
  CONSTRAINT staff_calendar_feeds_token_hash_is_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE public.staff_calendar_feeds ENABLE ROW LEVEL SECURITY;

-- Deliberately NO policies (see ACCESS in the header).
REVOKE ALL ON public.staff_calendar_feeds FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_calendar_feeds TO service_role;

-- Self-check (the mig 153b habit: verify the catalog, not this text).
-- CREATE TABLE IF NOT EXISTS silently KEEPS a same-named table of another
-- shape; a RAISE here aborts the transaction, so nothing half-applies.
DO $$
DECLARE
  v_cols   text;
  v_bad    text;
  v_cons   int;
BEGIN
  SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'staff_calendar_feeds';
  IF v_cols IS DISTINCT FROM
     'created_at:timestamp with time zone:NO,last_fetched_at:timestamp with time zone:YES,profile_id:uuid:NO,rotated_at:timestamp with time zone:YES,token_hash:text:NO' THEN
    RAISE EXCEPTION 'mig 632: staff_calendar_feeds has the wrong shape (%); a table of that name existed before this file and CREATE TABLE IF NOT EXISTS kept it', v_cols;
  END IF;

  SELECT count(*) INTO v_cons
    FROM pg_constraint
   WHERE conrelid = 'public.staff_calendar_feeds'::regclass
     AND conname IN ('staff_calendar_feeds_pkey', 'staff_calendar_feeds_profile_id_fkey',
                     'staff_calendar_feeds_token_hash_key', 'staff_calendar_feeds_token_hash_is_sha256');
  IF v_cons <> 4 THEN
    RAISE EXCEPTION 'mig 632: expected 4 constraints on staff_calendar_feeds, found %', v_cons;
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.staff_calendar_feeds'::regclass) THEN
    RAISE EXCEPTION 'mig 632: RLS is not enabled on staff_calendar_feeds';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.staff_calendar_feeds'::regclass) THEN
    RAISE EXCEPTION 'mig 632: staff_calendar_feeds must carry NO policies (service role only)';
  END IF;

  SELECT string_agg(r || ':' || p, ',' ORDER BY r, p) INTO v_bad
    FROM unnest(ARRAY['anon', 'authenticated']) AS r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
   WHERE has_table_privilege(r, 'public.staff_calendar_feeds', p);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 632: browser roles still hold %', v_bad;
  END IF;

  IF NOT (has_table_privilege('service_role', 'public.staff_calendar_feeds', 'SELECT')
      AND has_table_privilege('service_role', 'public.staff_calendar_feeds', 'INSERT')
      AND has_table_privilege('service_role', 'public.staff_calendar_feeds', 'UPDATE')
      AND has_table_privilege('service_role', 'public.staff_calendar_feeds', 'DELETE')) THEN
    RAISE EXCEPTION 'mig 632: service_role lacks a privilege the routes need';
  END IF;
END $$;

COMMENT ON TABLE public.staff_calendar_feeds IS
  'ICSFEED.1 (mig 632): one private calendar-subscription link per person. Only sha256(token) is stored; the URL is shown once. Service role only (RLS on, no policies, browser grants revoked). The feed route refuses a profile with active=false or deleted_at set, so deactivation stops the link without a write here.';
COMMENT ON COLUMN public.staff_calendar_feeds.token_hash IS
  'sha256 hex of the rcf_ token in the feed URL. Never the token itself (CHECK staff_calendar_feeds_token_hash_is_sha256).';
COMMENT ON COLUMN public.staff_calendar_feeds.last_fetched_at IS
  'Last time a calendar app fetched the feed; stamped at most every 15 minutes. Shown to the person as "last checked by your calendar".';

COMMIT;
```

- [ ] **Step 4: Run it, expect PASS, then the two checks that replay every migration**

Run: `npx vitest run tests/migration-632-staff-calendar-feeds.test.js`
Expected: `12 passed`.

Run: `npm run check:rls-restrictive && npm run check:select-columns`
Expected: both exit 0. `check:select-columns` now knows `staff_calendar_feeds`, which every later task's selects depend on.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/632_staff_calendar_feeds.sql tests/migration-632-staff-calendar-feeds.test.js
git commit -m "ICSFEED.1 — mig 632: staff_calendar_feeds (one hashed calendar link per person, service role only)

Only sha256(token) is stored (the mig 607 widget_tokens model), with a CHECK
that refuses anything but lowercase sha256 hex. profile_id is the PK so a new
link is one UPDATE. RLS on with no policies and the default browser grants
revoked; the PGlite replay proves the REVOKE is what removes them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Do NOT apply the migration yourself. Applying it is the operator's step ("Migration apply steps").

---

### Task 2: `src/lib/ics.js`, the iCalendar writer

**Files:**
- Create: `src/lib/ics.test.js`
- Create: `src/lib/ics.js`

- [ ] **Step 1: Write the failing test**

```js
// ICSFEED.1 — the RFC 5545 writer. Every rule here is one a real calendar
// client has been seen to choke on: bare LF line ends, lines over 75 octets,
// a fold that splits a UTF-8 character, an unescaped comma in a LOCATION.

import { describe, it, expect } from 'vitest'
import { escapeIcsText, foldIcsLine, formatIcsUtc, buildIcsCalendar } from './ics'

const octets = (s) => Buffer.byteLength(s, 'utf8')
const unfold = (s) => s.replace(/\r\n /g, '')

describe('escapeIcsText (RFC 5545 §3.3.11)', () => {
  it('escapes backslash, semicolon, comma and every newline form', () => {
    expect(escapeIcsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne')
    expect(escapeIcsText('x\r\ny\rz')).toBe('x\\ny\\nz')
  })
  it('escapes the backslash FIRST, so an escape is never double-escaped', () => {
    expect(escapeIcsText('\\,')).toBe('\\\\\\,')
  })
  it('drops control characters but keeps a tab', () => {
    expect(escapeIcsText('bell\u0007 tab\t end\u007f')).toBe('bell tab\t end')
  })
  it('null and undefined are empty', () => {
    expect(escapeIcsText(null)).toBe('')
    expect(escapeIcsText(undefined)).toBe('')
  })
})

describe('foldIcsLine (RFC 5545 §3.1)', () => {
  it('leaves a line of 75 octets alone and folds one of 76', () => {
    expect(foldIcsLine('x'.repeat(75))).toBe('x'.repeat(75))
    expect(foldIcsLine('x'.repeat(76))).toBe(`${'x'.repeat(75)}\r\n x`)
  })

  it('no physical line exceeds 75 octets, continuations start with ONE space, and unfolding restores the line', () => {
    const line = `DESCRIPTION:${'x'.repeat(200)}`
    const physical = foldIcsLine(line).split('\r\n')
    expect(physical[0]).toHaveLength(75)
    for (const p of physical) expect(octets(p)).toBeLessThanOrEqual(75)
    for (const p of physical.slice(1)) expect(p[0]).toBe(' ')
    expect(unfold(foldIcsLine(line))).toBe(line)
  })

  it('never splits a multi-byte character (2-, 3- and 4-byte UTF-8)', () => {
    const line = `SUMMARY:${'é·😀'.repeat(40)}`
    const physical = foldIcsLine(line).split('\r\n')
    expect(physical.length).toBeGreaterThan(1)
    for (const p of physical) {
      expect(octets(p)).toBeLessThanOrEqual(75)
      // A lone surrogate would not survive a UTF-8 round trip.
      expect(Buffer.from(p, 'utf8').toString('utf8')).toBe(p)
    }
    expect(unfold(foldIcsLine(line))).toBe(line)
  })
})

describe('formatIcsUtc', () => {
  it('writes the UTC basic form with a Z', () => {
    expect(formatIcsUtc(Date.UTC(2026, 8, 28, 5, 0, 0))).toBe('20260928T050000Z')
    expect(formatIcsUtc(Date.UTC(2026, 0, 1, 0, 0, 9))).toBe('20260101T000009Z')
  })
  it('throws on a non-finite instant rather than writing 1970', () => {
    expect(() => formatIcsUtc(NaN)).toThrow(RangeError)
    expect(() => formatIcsUtc(null)).toThrow(RangeError)
  })
})

describe('buildIcsCalendar', () => {
  const EVENT = {
    uid: 'shift-a1@repset.ie',
    dtstampMs: Date.UTC(2026, 8, 21, 8, 15),
    lastModifiedMs: Date.UTC(2026, 8, 21, 8, 15),
    startMs: Date.UTC(2026, 8, 28, 5, 0),
    endMs: Date.UTC(2026, 8, 28, 6, 0),
    summary: 'Morning · Studio One',
    location: 'Studio One, 1 Example Street, Dublin',
    description: 'Rostered shift.',
  }

  it('uses CRLF only, begins and ends the calendar, and every line fits 75 octets', () => {
    const out = buildIcsCalendar({ prodId: '-//T//T//EN', name: 'Rostered shifts', refreshMinutes: 60, events: [EVENT] })
    expect(out.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//T//EN\r\n')).toBe(true)
    expect(out.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    for (const line of out.split('\r\n')) expect(octets(line)).toBeLessThanOrEqual(75)
  })

  it('writes the event with escaped text and UTC times', () => {
    const lines = unfold(buildIcsCalendar({ prodId: '-//T//T//EN', events: [EVENT] })).split('\r\n')
    expect(lines).toEqual(expect.arrayContaining([
      'BEGIN:VEVENT',
      'UID:shift-a1@repset.ie',
      'DTSTAMP:20260921T081500Z',
      'LAST-MODIFIED:20260921T081500Z',
      'DTSTART:20260928T050000Z',
      'DTEND:20260928T060000Z',
      'SUMMARY:Morning · Studio One',
      'LOCATION:Studio One\\, 1 Example Street\\, Dublin',
      'DESCRIPTION:Rostered shift.',
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT',
    ]))
  })

  it('asks for hourly refresh when told to, and names the calendar', () => {
    const lines = buildIcsCalendar({ prodId: '-//T//T//EN', name: 'Rostered shifts', refreshMinutes: 60, events: [] }).split('\r\n')
    expect(lines).toEqual(expect.arrayContaining([
      'X-WR-CALNAME:Rostered shifts',
      'NAME:Rostered shifts',
      'REFRESH-INTERVAL;VALUE=DURATION:PT60M',
      'X-PUBLISHED-TTL:PT60M',
    ]))
  })

  it('omits DTEND when the end is not after the start (RFC 5545 §3.6.1: the event ends at DTSTART)', () => {
    const out = buildIcsCalendar({ prodId: '-//T//T//EN', events: [{ ...EVENT, endMs: EVENT.startMs }] })
    expect(out).not.toContain('DTEND')
    const out2 = buildIcsCalendar({ prodId: '-//T//T//EN', events: [{ ...EVENT, endMs: null }] })
    expect(out2).not.toContain('DTEND')
  })

  it('an empty calendar is still a valid calendar', () => {
    expect(buildIcsCalendar({ prodId: '-//T//T//EN', events: [] }))
      .toBe('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//T//EN\r\nCALSCALE:GREGORIAN\r\nEND:VCALENDAR\r\n')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/ics.test.js`
Expected: `Failed to resolve import "./ics"`.

- [ ] **Step 3: Write the module**

```js
// src/lib/ics.js
// ICSFEED.1 — the smallest correct iCalendar (RFC 5545) writer this repo needs.
//
// Pure: no IO, no clock. Written for SUBSCRIBED calendars (Apple, Google,
// Outlook poll a URL and replace their copy), so there is no METHOD and no
// VTIMEZONE: every time is written in UTC (`…Z`), which RFC 5545 allows
// everywhere and which needs no time-zone rules shipped in the file. Callers
// convert wall clock to UTC first (src/lib/tz-time.js wallMsInTz).
//
// The three rules clients actually enforce:
//   • CRLF line ends, never a bare LF (§3.1);
//   • no line longer than 75 OCTETS — folded with CRLF + one space, and a
//     fold must never split a multi-byte UTF-8 character (§3.1);
//   • TEXT values escape \ ; , and newlines (§3.3.11).

const CRLF = '\r\n'
const MAX_OCTETS = 75

function utf8Length(codePoint) {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

// Keep TAB, LF and CR (the newlines are escaped below); drop every other
// control character. Iterated by code point, so no control-character regex.
function stripControls(s) {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c !== 0x7f)) out += ch
  }
  return out
}

/** RFC 5545 TEXT escaping. The backslash goes first so no escape is escaped twice. */
export function escapeIcsText(value) {
  if (value == null) return ''
  return stripControls(String(value))
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Fold one content line to at most 75 octets per physical line. A
 * continuation line starts with one space, which counts toward its 75.
 * Iterates by code point, so a character is never split across a fold.
 */
export function foldIcsLine(line) {
  const parts = []
  let current = ''
  let bytes = 0
  let limit = MAX_OCTETS
  for (const ch of String(line)) {
    const n = utf8Length(ch.codePointAt(0))
    if (bytes + n > limit) {
      parts.push(current)
      current = ''
      bytes = 0
      limit = MAX_OCTETS - 1
    }
    current += ch
    bytes += n
  }
  parts.push(current)
  return parts.join(`${CRLF} `)
}

/** UTC basic form, e.g. 20260928T050000Z. Throws on a non-finite instant. */
export function formatIcsUtc(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new RangeError('formatIcsUtc: invalid instant')
  }
  const d = new Date(ms)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

/**
 * @param {object} cal
 * @param {string} cal.prodId          PRODID value
 * @param {string} [cal.name]          calendar display name (X-WR-CALNAME + RFC 7986 NAME)
 * @param {number} [cal.refreshMinutes] polling hint (RFC 7986 REFRESH-INTERVAL + X-PUBLISHED-TTL)
 * @param {Array<{uid:string, dtstampMs:number, lastModifiedMs?:number|null, startMs:number,
 *   endMs?:number|null, summary:string, location?:string|null, description?:string|null,
 *   status?:string}>} cal.events
 * @returns {string} the calendar, CRLF line ends, folded
 */
export function buildIcsCalendar({ prodId, name = null, refreshMinutes = null, events = [] }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodId}`, 'CALSCALE:GREGORIAN']
  if (name) lines.push(`X-WR-CALNAME:${escapeIcsText(name)}`, `NAME:${escapeIcsText(name)}`)
  if (refreshMinutes) {
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${refreshMinutes}M`, `X-PUBLISHED-TTL:PT${refreshMinutes}M`)
  }
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${formatIcsUtc(e.dtstampMs)}`)
    if (e.lastModifiedMs != null) lines.push(`LAST-MODIFIED:${formatIcsUtc(e.lastModifiedMs)}`)
    lines.push(`DTSTART:${formatIcsUtc(e.startMs)}`)
    if (e.endMs != null && e.endMs > e.startMs) lines.push(`DTEND:${formatIcsUtc(e.endMs)}`)
    lines.push(`SUMMARY:${escapeIcsText(e.summary)}`)
    if (e.location) lines.push(`LOCATION:${escapeIcsText(e.location)}`)
    if (e.description) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`)
    lines.push(`STATUS:${e.status || 'CONFIRMED'}`, 'TRANSP:OPAQUE', 'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldIcsLine).join(CRLF) + CRLF
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/ics.test.js`
Expected: `14 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ics.js src/lib/ics.test.js
git commit -m "ICSFEED.1 — src/lib/ics.js: a small RFC 5545 writer (CRLF, 75-octet folds that never split a character, TEXT escaping, UTC times)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `src/lib/calendar-feed-token.js`, the link's shape in one place

**Files:**
- Create: `src/lib/calendar-feed-token.test.js`
- Create: `src/lib/calendar-feed-token.js`

- [ ] **Step 1: Write the failing test**

```js
// ICSFEED.1 — the calendar link's credential: shape, hash, URL. Mirrors
// src/lib/widget-token.js on purpose (mig 607's model).

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  CALENDAR_FEED_TOKEN_PREFIX, CALENDAR_FEED_PATH,
  generateCalendarFeedToken, hashCalendarFeedToken, tokenFromFeedFile, calendarFeedUrls,
} from './calendar-feed-token'

const TOKEN = `rcf_${'A'.repeat(43)}`

describe('generateCalendarFeedToken', () => {
  it('is rcf_ + 43 base64url characters (32 random bytes), and never repeats', () => {
    const a = generateCalendarFeedToken()
    const b = generateCalendarFeedToken()
    expect(a).toMatch(/^rcf_[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
    expect(CALENDAR_FEED_TOKEN_PREFIX).toBe('rcf_')
  })
})

describe('hashCalendarFeedToken', () => {
  it('is the sha256 hex of the whole token', () => {
    expect(hashCalendarFeedToken(TOKEN)).toBe(createHash('sha256').update(TOKEN).digest('hex'))
    expect(hashCalendarFeedToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/)
  })
  it('refuses anything that is not exactly a calendar token, before any lookup', () => {
    for (const bad of [null, undefined, 42, '', 'rcf_', `rwt_${'A'.repeat(43)}`, `rcf_${'A'.repeat(42)}`,
      `rcf_${'A'.repeat(44)}`, `${TOKEN}.ics`, `rcf_${'A'.repeat(42)}=`, `rcf_${'A'.repeat(42)}/`]) {
      expect(hashCalendarFeedToken(bad), String(bad)).toBe(null)
    }
  })
})

describe('tokenFromFeedFile (the [file] path segment)', () => {
  it('takes the token with or without .ics', () => {
    expect(tokenFromFeedFile(`${TOKEN}.ics`)).toBe(TOKEN)
    expect(tokenFromFeedFile(TOKEN)).toBe(TOKEN)
  })
  it('refuses everything else', () => {
    for (const bad of [null, '', 'feed.ics', `${TOKEN}.ics.ics`, `${TOKEN}.txt`, `../${TOKEN}.ics`, '%E0%A4%A.ics']) {
      expect(tokenFromFeedFile(bad), String(bad)).toBe(null)
    }
  })
})

describe('calendarFeedUrls', () => {
  it('builds the https, webcal and Google add-by-URL links from the app origin', () => {
    const urls = calendarFeedUrls('https://crm.example.test/', TOKEN)
    expect(urls.url).toBe(`https://crm.example.test${CALENDAR_FEED_PATH}/${TOKEN}.ics`)
    expect(urls.webcal_url).toBe(`webcal://crm.example.test/api/calendar-feed/${TOKEN}.ics`)
    expect(urls.google_url).toBe(
      `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(urls.webcal_url)}`,
    )
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/calendar-feed-token.test.js`
Expected: `Failed to resolve import "./calendar-feed-token"`.

- [ ] **Step 3: Write the module**

```js
// src/lib/calendar-feed-token.js
// ICSFEED.1 — the calendar link's credential, in one place. Server-only
// (node:crypto). Same model as src/lib/widget-token.js and mig 607:
//
//   • the token is rcf_ + 32 CSPRNG bytes (base64url, 43 chars), shown to the
//     person ONCE, never stored, never logged;
//   • only its sha256 is stored (staff_calendar_feeds.token_hash, mig 632).
//     Plain sha256 with no salt is correct for 256 random bits: there is no
//     dictionary to stretch against, this is a lookup key. Looking the HASH up
//     by a unique index is the constant-time compare: the plaintext is never
//     compared against anything.
//   • the rcf_ prefix lets hashCalendarFeedToken refuse a non-token before any
//     database call, and makes a pasted link recognisable in a support thread.

import { createHash, randomBytes } from 'node:crypto'

export const CALENDAR_FEED_TOKEN_PREFIX = 'rcf_'
export const CALENDAR_FEED_PATH = '/api/calendar-feed'

const TOKEN_RE = /^rcf_[A-Za-z0-9_-]{43}$/
const FILE_RE = /^(rcf_[A-Za-z0-9_-]{43})(?:\.ics)?$/

/** A new plaintext token. Returned to the person ONCE. */
export function generateCalendarFeedToken() {
  return CALENDAR_FEED_TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

/** sha256 hex of a calendar token, or null for anything that is not exactly one. */
export function hashCalendarFeedToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null
  return createHash('sha256').update(token).digest('hex')
}

/** The token inside the route's [file] segment (`<token>.ics` or `<token>`), else null. */
export function tokenFromFeedFile(file) {
  if (typeof file !== 'string' || !file) return null
  let s
  try {
    s = decodeURIComponent(file)
  } catch {
    return null
  }
  const m = s.match(FILE_RE)
  return m ? m[1] : null
}

/**
 * The three links a person is given. Built HERE and nowhere else, so the web
 * card and the phone can never disagree about a URL.
 *   url         https — paste into any calendar app
 *   webcal_url  webcal:// — Apple Calendar and Outlook open a subscribe dialog
 *   google_url  Google Calendar's add-by-URL page (Android has no webcal handler)
 */
export function calendarFeedUrls(baseUrl, token) {
  const origin = String(baseUrl).replace(/\/+$/, '')
  const url = `${origin}${CALENDAR_FEED_PATH}/${token}.ics`
  const webcalUrl = url.replace(/^https?:\/\//i, 'webcal://')
  return {
    url,
    webcal_url: webcalUrl,
    google_url: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcalUrl)}`,
  }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/calendar-feed-token.test.js`
Expected: `6 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar-feed-token.js src/lib/calendar-feed-token.test.js
git commit -m "ICSFEED.1 — calendar-feed-token: rcf_ token, sha256 lookup key, and the three links, built in one place

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `src/lib/staff-calendar-feed.js`, shifts to events (pure)

**Files:**
- Create: `src/lib/staff-calendar-feed.test.js`
- Create: `src/lib/staff-calendar-feed.js`

The fixtures use neutral studio names and a placeholder address (the repo is public; SCHEDHYGIENE.1).

- [ ] **Step 1: Write the failing test**

```js
// ICSFEED.1 — which shifts become calendar events, and at what instant.
// Run this file under two machine time zones (see Step 4): nothing here may
// depend on the machine's clock zone, only on the studio's.

import { describe, it, expect } from 'vitest'
import {
  FEED_DAYS_BACK, FEED_DAYS_AHEAD, feedWindow, wallInstant, isPublishedLiveRow,
  shiftToFeedEvent, buildStaffShiftFeed,
} from './staff-calendar-feed'

const STUDIO = { id: 'loc-1', name: 'Studio One', address: '1 Example Street, Dublin', timezone: 'Europe/Dublin' }
const NYC = { id: 'loc-9', name: 'Studio Nine', address: null, timezone: 'America/New_York' }
const GEN = Date.UTC(2026, 8, 25, 10, 0)

function row(over = {}, block = {}) {
  return {
    id: 'a1', status: 'scheduled', start_time_override: null, end_time_override: null,
    updated_at: '2026-09-20T10:00:00.000Z',
    ...over,
    shift_blocks: {
      location_id: 'loc-1', block_date: '2026-09-28', start_time: '06:00:00', end_time: '07:00:00',
      updated_at: '2026-09-21T08:15:00+00:00',
      rosters: { status: 'published' },
      shift_templates: { name: 'Morning' },
      ...block,
    },
  }
}

const unfoldedLines = (ics) => ics.replace(/\r\n /g, '').split('\r\n')

describe('feedWindow — two weeks back, eight ahead (00-INDEX default 5)', () => {
  it('is Dublin today −14 to +56', () => {
    expect(FEED_DAYS_BACK).toBe(14)
    expect(FEED_DAYS_AHEAD).toBe(56)
    expect(feedWindow('2026-09-25')).toEqual({ from: '2026-09-11', to: '2026-11-20' })
  })
})

describe('wallInstant — studio wall clock to UTC, DST-correct', () => {
  it('Irish Summer Time is UTC+1, Irish winter time is UTC+0', () => {
    expect(wallInstant('2026-09-28', '06:00:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 8, 28, 5, 0))
    expect(wallInstant('2026-12-01', '06:00:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 11, 1, 6, 0))
  })
  it('either side of the 2026 transitions (29 March, 25 October)', () => {
    expect(wallInstant('2026-03-28', '06:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 2, 28, 6, 0))
    expect(wallInstant('2026-03-30', '06:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 2, 30, 5, 0))
    expect(wallInstant('2026-10-24', '06:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 9, 24, 5, 0))
    expect(wallInstant('2026-10-26', '06:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 9, 26, 6, 0))
  })
  it("'24:00' is the next day's midnight in the studio's zone", () => {
    expect(wallInstant('2026-10-26', '24:00:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 9, 27, 0, 0))
    expect(wallInstant('2026-09-28', '24:00:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 8, 28, 23, 0))
  })
  it('an unreadable time is null, never a guess', () => {
    expect(wallInstant('2026-09-28', null, 'Europe/Dublin')).toBe(null)
    expect(wallInstant('2026-09-28', '6am', 'Europe/Dublin')).toBe(null)
    expect(wallInstant('2026-02-30', '06:00', 'Europe/Dublin')).toBe(null)
  })
})

describe('isPublishedLiveRow — published and not cancelled, nothing else', () => {
  it('a published, scheduled shift qualifies', () => {
    expect(isPublishedLiveRow(row())).toBe(true)
    expect(isPublishedLiveRow(row({ status: 'confirmed' }))).toBe(true)
    expect(isPublishedLiveRow(row({ status: 'completed' }))).toBe(true)
  })
  it('draft, unpublished (no roster) and cancelled do not', () => {
    expect(isPublishedLiveRow(row({}, { rosters: { status: 'draft' } }))).toBe(false)
    expect(isPublishedLiveRow(row({}, { rosters: null }))).toBe(false)
    expect(isPublishedLiveRow(row({ status: 'cancelled' }))).toBe(false)
    expect(isPublishedLiveRow(null)).toBe(false)
    expect(isPublishedLiveRow({ id: 'x', status: 'scheduled' })).toBe(false)
  })
})

describe('shiftToFeedEvent', () => {
  it('maps a block shift: stable UID, UTC times, template · studio, studio + address', () => {
    expect(shiftToFeedEvent(row(), STUDIO, GEN)).toEqual({
      uid: 'shift-a1@repset.ie',
      dtstampMs: Date.parse('2026-09-21T08:15:00Z'),
      lastModifiedMs: Date.parse('2026-09-21T08:15:00Z'),
      startMs: Date.UTC(2026, 8, 28, 5, 0),
      endMs: Date.UTC(2026, 8, 28, 6, 0),
      summary: 'Morning · Studio One',
      location: 'Studio One, 1 Example Street, Dublin',
      description: 'Rostered shift, as published. Open the app for swaps and changes.',
    })
  })

  it("uses the coach's override where there is one (the effective time, not the block's)", () => {
    const e = shiftToFeedEvent(row({ start_time_override: '06:30:00', end_time_override: '06:45:00' }), STUDIO, GEN)
    expect(e.startMs).toBe(Date.UTC(2026, 8, 28, 5, 30))
    expect(e.endMs).toBe(Date.UTC(2026, 8, 28, 5, 45))
  })

  it('LAST-MODIFIED is the later of the assignment and the block, so a moved block counts', () => {
    const e = shiftToFeedEvent(row({ updated_at: '2026-09-24T12:00:00Z' }), STUDIO, GEN)
    expect(e.lastModifiedMs).toBe(Date.parse('2026-09-24T12:00:00Z'))
    expect(e.dtstampMs).toBe(e.lastModifiedMs)
  })

  it('with no readable updated_at, DTSTAMP falls back to the generation time and LAST-MODIFIED is left out', () => {
    const e = shiftToFeedEvent(row({ updated_at: null }, { updated_at: null }), STUDIO, GEN)
    expect(e.dtstampMs).toBe(GEN)
    expect(e.lastModifiedMs).toBe(null)
  })

  it("reads the studio's own zone", () => {
    const e = shiftToFeedEvent(row({}, { location_id: 'loc-9' }), NYC, GEN)
    expect(e.startMs).toBe(Date.UTC(2026, 8, 28, 10, 0))
    expect(e.location).toBe('Studio Nine')
  })

  it('an unknown zone or a missing studio row falls back to Dublin and a bare template name', () => {
    expect(shiftToFeedEvent(row(), { ...STUDIO, timezone: 'Mars/Base' }, GEN).startMs).toBe(Date.UTC(2026, 8, 28, 5, 0))
    const e = shiftToFeedEvent(row(), undefined, GEN)
    expect(e.startMs).toBe(Date.UTC(2026, 8, 28, 5, 0))
    expect(e.summary).toBe('Morning')
    expect(e.location).toBe(null)
  })

  it('an end at or before the start is dropped (the event ends at DTSTART), never written backwards', () => {
    expect(shiftToFeedEvent(row({ end_time_override: '05:00:00' }), STUDIO, GEN).endMs).toBe(null)
  })

  it('an unreadable start skips the shift', () => {
    expect(shiftToFeedEvent(row({}, { start_time: null }), STUDIO, GEN)).toBe(null)
  })
})

describe('buildStaffShiftFeed', () => {
  const LOCS = { 'loc-1': STUDIO }

  it('writes only published, live shifts, in start order', () => {
    const ics = buildStaffShiftFeed({
      rows: [
        row({ id: 'late' }, { block_date: '2026-09-29' }),
        row({ id: 'draft' }, { rosters: { status: 'draft' } }),
        row({ id: 'gone', status: 'cancelled' }),
        row({ id: 'early' }),
      ],
      locationsById: LOCS,
      generatedAtMs: GEN,
    })
    const uids = unfoldedLines(ics).filter((l) => l.startsWith('UID:'))
    expect(uids).toEqual(['UID:shift-early@repset.ie', 'UID:shift-late@repset.ie'])
  })

  it('names the calendar and asks for hourly refresh', () => {
    const lines = unfoldedLines(buildStaffShiftFeed({ rows: [], locationsById: {}, generatedAtMs: GEN }))
    expect(lines).toEqual(expect.arrayContaining([
      'PRODID:-//Repset//Staff shift feed//EN',
      'X-WR-CALNAME:Rostered shifts',
      'REFRESH-INTERVAL;VALUE=DURATION:PT60M',
    ]))
  })

  it("never writes an assignment's notes or partial reason (manager working notes, COACHSCOPE.1)", () => {
    const ics = buildStaffShiftFeed({
      rows: [row({ notes: 'PRIVATE NOTE', partial_reason: 'PRIVATE REASON' })],
      locationsById: LOCS,
      generatedAtMs: GEN,
    })
    expect(ics).not.toContain('PRIVATE')
  })

  it('is deterministic for a given roster (DTSTAMP is the revision time, not now)', () => {
    const a = buildStaffShiftFeed({ rows: [row()], locationsById: LOCS, generatedAtMs: GEN })
    const b = buildStaffShiftFeed({ rows: [row()], locationsById: LOCS, generatedAtMs: GEN + 3_600_000 })
    expect(a).toBe(b)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/staff-calendar-feed.test.js`
Expected: `Failed to resolve import "./staff-calendar-feed"`.

- [ ] **Step 3: Write the module**

```js
// src/lib/staff-calendar-feed.js
// ICSFEED.1 — a person's own published shifts as a subscribed calendar. Pure.
//
// WHAT GOES IN (00-INDEX default 5): the person's OWN assignments, PUBLISHED
// (block → rosters.status = 'published', the ROSTER-FIX.1 derivation) and LIVE
// (not cancelled, isLiveAssignment), at every studio, Dublin today −14 to +56.
//
// WHAT NEVER GOES IN: colleagues (only the person's own rows are ever read),
// assignment notes and partial_reason (manager working notes, COACHSCOPE.1 —
// not even selected), pay, rates, minimums, capacity.
//
// TIMES are written in UTC from each studio's own wall clock
// (locations.timezone via resolveTz; unknown → Europe/Dublin). Effective time
// = the coach's override, else the block's snapshot time (the mig 604/622
// COALESCE). A '24:00' end is the next day's midnight. An end at or before the
// start is dropped (RFC 5545: the event then ends at DTSTART).
//
// UID = shift-<assignment id>@repset.ie, stable for the assignment's life, so
// an edit replaces the event and a removed or cancelled shift disappears on the
// next poll. DTSTAMP/LAST-MODIFIED = the later updated_at of assignment and
// block, so the output is byte-identical until the roster changes.

import { addDaysISO } from '@/lib/dublin-time'
import { resolveTz, wallMsInTz } from '@/lib/tz-time'
import { isLiveAssignment } from '@/lib/roster'
import { buildIcsCalendar } from '@/lib/ics'

export const FEED_DAYS_BACK = 14
export const FEED_DAYS_AHEAD = 56
export const FEED_CALENDAR_NAME = 'Rostered shifts'
export const FEED_PRODID = '-//Repset//Staff shift feed//EN'
export const FEED_REFRESH_MINUTES = 60
export const FEED_EVENT_DESCRIPTION = 'Rostered shift, as published. Open the app for swaps and changes.'

/** The date window, from a Dublin YYYY-MM-DD today. */
export function feedWindow(todayIso) {
  return { from: addDaysISO(todayIso, -FEED_DAYS_BACK), to: addDaysISO(todayIso, FEED_DAYS_AHEAD) }
}

function hhmm(time) {
  const m = String(time ?? '').match(/^(\d{2}):(\d{2})(?::\d{2})?$/)
  return m ? `${m[1]}:${m[2]}` : null
}

/** UTC ms of wall-clock `time` (HH:MM[:SS]) on `dateIso` in `tz`; '24:00' = next day 00:00; null if unreadable. */
export function wallInstant(dateIso, time, tz) {
  const t = hhmm(time)
  if (!t) return null
  if (t === '24:00') {
    return wallMsInTz(addDaysISO(dateIso, 1), '00:00', tz)
  }
  return wallMsInTz(dateIso, t, tz)
}

function msOrNull(iso) {
  const n = Date.parse(iso ?? '')
  return Number.isFinite(n) ? n : null
}

/** Published (block's roster is published) and live (not cancelled). */
export function isPublishedLiveRow(a) {
  return !!a && isLiveAssignment(a) && a.shift_blocks?.rosters?.status === 'published'
}

/** One assignment row (FEED_SHIFT_SELECT shape) → an event for buildIcsCalendar, or null. */
export function shiftToFeedEvent(a, location, generatedAtMs) {
  const b = a.shift_blocks
  const tz = resolveTz(location?.timezone)
  const startMs = wallInstant(b.block_date, a.start_time_override || b.start_time, tz)
  if (startMs == null) return null
  const endMs = wallInstant(b.block_date, a.end_time_override || b.end_time, tz)

  const stamps = [msOrNull(a.updated_at), msOrNull(b.updated_at)].filter((n) => n != null)
  const modified = stamps.length ? Math.max(...stamps) : null

  const studio = location?.name || null
  const shiftName = b.shift_templates?.name || 'Shift'
  return {
    uid: `shift-${a.id}@repset.ie`,
    dtstampMs: modified ?? generatedAtMs,
    lastModifiedMs: modified,
    startMs,
    endMs: endMs != null && endMs > startMs ? endMs : null,
    summary: studio ? `${shiftName} · ${studio}` : shiftName,
    location: [studio, location?.address].filter(Boolean).join(', ') || null,
    description: FEED_EVENT_DESCRIPTION,
  }
}

/**
 * @param {object} args
 * @param {Array<object>} args.rows          FEED_SHIFT_SELECT rows (the person's own)
 * @param {Record<string, object>} args.locationsById  id → { name, address, timezone }
 * @param {number} args.generatedAtMs         DTSTAMP fallback only
 * @returns {string} the iCalendar body
 */
export function buildStaffShiftFeed({ rows, locationsById, generatedAtMs }) {
  const events = (rows || [])
    .filter(isPublishedLiveRow)
    .map((a) => shiftToFeedEvent(a, locationsById?.[a.shift_blocks.location_id], generatedAtMs))
    .filter(Boolean)
    .sort((x, y) => x.startMs - y.startMs || (x.uid < y.uid ? -1 : x.uid > y.uid ? 1 : 0))
  return buildIcsCalendar({
    prodId: FEED_PRODID,
    name: FEED_CALENDAR_NAME,
    refreshMinutes: FEED_REFRESH_MINUTES,
    events,
  })
}
```

- [ ] **Step 4: Run it under two machine time zones, expect PASS both times**

Run: `TZ=Europe/Dublin npx vitest run src/lib/staff-calendar-feed.test.js && TZ=America/Los_Angeles npx vitest run src/lib/staff-calendar-feed.test.js`
Expected: `19 passed` twice (CLAUDE.md: test date code under Dublin AND a US zone).

- [ ] **Step 5: Commit**

```bash
git add src/lib/staff-calendar-feed.js src/lib/staff-calendar-feed.test.js
git commit -m "ICSFEED.1 — staff-calendar-feed: own published live shifts → UTC events (override → block, studio zone, 24:00, stable UIDs)

Times go out in UTC from each studio's wall clock via tz-time.js, so no
VTIMEZONE is needed and both 2026 DST transitions are pinned. Assignment notes
and partial_reason are manager notes and are never written.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `src/lib/staff-calendar-feed-server.js`, the IO

**Files:**
- Create: `src/lib/staff-calendar-feed-server.test.js`
- Create: `src/lib/staff-calendar-feed-server.js`

`fakeDb` / `queriesOf` from `src/lib/time-off.test-helpers.js` record every chain, so the tests assert what the code ASKED for, not only what it did with the answer.

- [ ] **Step 1: Write the failing test**

```js
// ICSFEED.1 — the calendar feed's database work.
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { fakeDb, queriesOf } from '@/lib/time-off.test-helpers'
import {
  FEED_SHIFT_SELECT, FEED_TOKEN_RL, TOUCH_INTERVAL_MS,
  resolveCalendarFeed, loadFeedShifts, touchFeedFetched,
  getCalendarFeedStatus, issueCalendarFeed, revokeCalendarFeed,
} from './staff-calendar-feed-server'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const TOKEN = `rcf_${'A'.repeat(43)}`
const HASH = createHash('sha256').update(TOKEN).digest('hex')
const ME = '10000000-0000-0000-0000-00000000000a'
const sha = (t) => createHash('sha256').update(t).digest('hex')

function dbFor({ feed = { profile_id: ME, last_fetched_at: null }, feedError = null, profile = { id: ME, active: true, deleted_at: null }, profileError = null } = {}) {
  return fakeDb((q) => {
    if (q.table === 'staff_calendar_feeds') return { data: feed, error: feedError }
    if (q.table === 'profiles') return { data: profile, error: profileError }
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
}

describe('resolveCalendarFeed', () => {
  it('a malformed token is unknown and costs no query', async () => {
    const db = dbFor()
    expect(await resolveCalendarFeed(db, 'nope')).toEqual({ status: 'unknown' })
    expect(db.queries).toEqual([])
  })

  it('looks the HASH up, never the plaintext, then reads only that profile', async () => {
    const db = dbFor()
    const r = await resolveCalendarFeed(db, TOKEN)
    expect(r).toEqual({ status: 'ok', feed: { profile_id: ME, last_fetched_at: null }, tokenHash: HASH })
    const [lookup] = queriesOf(db, 'staff_calendar_feeds')
    expect(lookup.eq).toEqual({ token_hash: HASH })
    expect(JSON.stringify(db.queries)).not.toContain(TOKEN)
    const [p] = queriesOf(db, 'profiles')
    expect(p.eq).toEqual({ id: ME })
    expect(p.columns).toBe('id, active, deleted_at')
  })

  it('an unknown hash is unknown, and no profile is read', async () => {
    const db = dbFor({ feed: null })
    expect(await resolveCalendarFeed(db, TOKEN)).toEqual({ status: 'unknown' })
    expect(queriesOf(db, 'profiles')).toEqual([])
  })

  it('a deactivated person, a tombstone and a missing profile are all inactive (D5)', async () => {
    for (const profile of [
      { id: ME, active: false, deleted_at: null },
      { id: ME, active: false, deleted_at: '2026-09-20T00:00:00Z' },
      null,
    ]) {
      expect(await resolveCalendarFeed(dbFor({ profile }), TOKEN)).toEqual({ status: 'inactive' })
    }
  })

  it('a missing `active` never locks anyone out (the getCurrentUser rule: strictly === false)', async () => {
    const r = await resolveCalendarFeed(dbFor({ profile: { id: ME, deleted_at: null } }), TOKEN)
    expect(r.status).toBe('ok')
  })

  it('a failed read is an error, not an unknown token', async () => {
    expect(await resolveCalendarFeed(dbFor({ feedError: { message: 'boom' } }), TOKEN)).toEqual({ status: 'error' })
    expect(await resolveCalendarFeed(dbFor({ profileError: { message: 'boom' } }), TOKEN)).toEqual({ status: 'error' })
  })
})

describe('loadFeedShifts', () => {
  const ROWS = [
    { id: 'a1', shift_blocks: { location_id: 'loc-1' } },
    { id: 'a2', shift_blocks: { location_id: 'loc-2' } },
    { id: 'a3', shift_blocks: { location_id: 'loc-1' } },
  ]
  const LOCS = [{ id: 'loc-1', name: 'Studio One' }, { id: 'loc-2', name: 'Studio Two' }]
  const shiftsDb = ({ shiftError = null, locError = null, rows = ROWS } = {}) => fakeDb((q) => {
    if (q.table === 'shift_assignments') return { data: shiftError ? null : rows, error: shiftError }
    if (q.table === 'locations') return { data: locError ? null : LOCS, error: locError }
    throw new Error(`unexpected ${q.table}`)
  })

  it("reads only the person's own assignments, inside the window", async () => {
    const db = shiftsDb()
    const r = await loadFeedShifts(db, ME, { from: '2026-09-11', to: '2026-11-20' })
    expect(r.error).toBe(null)
    const [q] = queriesOf(db, 'shift_assignments')
    expect(q.eq).toEqual({ profile_id: ME })
    expect(q.calls).toContainEqual(['gte', 'shift_blocks.block_date', '2026-09-11'])
    expect(q.calls).toContainEqual(['lte', 'shift_blocks.block_date', '2026-11-20'])
    expect(q.columns).toBe(FEED_SHIFT_SELECT)
  })

  it('selects no colleague, no note, no pay', () => {
    expect(FEED_SHIFT_SELECT).not.toMatch(/profiles|notes|partial_reason|rate|salary|min_coaches|max_coaches/)
  })

  it('reads each studio once, and keys them by id', async () => {
    const db = shiftsDb()
    const r = await loadFeedShifts(db, ME, { from: '2026-09-11', to: '2026-11-20' })
    const locQs = queriesOf(db, 'locations')
    expect(locQs).toHaveLength(1)
    expect(locQs[0].columns).toBe('id, name, address, timezone')
    expect(locQs[0].calls).toContainEqual(['in', 'id', ['loc-1', 'loc-2']])
    expect(Object.keys(r.locationsById).sort()).toEqual(['loc-1', 'loc-2'])
    expect(r.rows).toHaveLength(3)
  })

  it('no shifts → no studio read', async () => {
    const db = shiftsDb({ rows: [] })
    const r = await loadFeedShifts(db, ME, { from: '2026-09-11', to: '2026-11-20' })
    expect(r).toEqual({ rows: [], locationsById: {}, error: null })
    expect(queriesOf(db, 'locations')).toEqual([])
  })

  it('either read failing is an error the route turns into 503 (never an empty calendar)', async () => {
    expect((await loadFeedShifts(shiftsDb({ shiftError: { message: 'x' } }), ME, { from: 'a', to: 'b' })).error).toBeTruthy()
    expect((await loadFeedShifts(shiftsDb({ locError: { message: 'x' } }), ME, { from: 'a', to: 'b' })).error).toBeTruthy()
  })
})

describe('touchFeedFetched (D10)', () => {
  const NOW = Date.parse('2026-09-25T10:00:00Z')
  const touchDb = (error = null) => fakeDb(() => ({ data: null, error }))

  it('stamps a feed never fetched, or last fetched 15+ minutes ago', async () => {
    for (const last of [null, new Date(NOW - TOUCH_INTERVAL_MS).toISOString()]) {
      const db = touchDb()
      await touchFeedFetched(db, { profile_id: ME, last_fetched_at: last }, NOW)
      const [u] = queriesOf(db, 'staff_calendar_feeds', 'update')
      expect(u.payload).toEqual({ last_fetched_at: '2026-09-25T10:00:00.000Z' })
      expect(u.eq).toEqual({ profile_id: ME })
    }
  })

  it('skips a feed fetched in the last 15 minutes', async () => {
    const db = touchDb()
    await touchFeedFetched(db, { profile_id: ME, last_fetched_at: new Date(NOW - 60_000).toISOString() }, NOW)
    expect(db.queries).toEqual([])
  })

  it('a failed stamp resolves (logged), it never fails the feed', async () => {
    const { logWarn } = await import('@/lib/log')
    await expect(touchFeedFetched(touchDb({ message: 'boom' }), { profile_id: ME, last_fetched_at: null }, NOW)).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('management: status, issue, revoke', () => {
  it('status maps the row and never returns the hash', async () => {
    const db = fakeDb(() => ({ data: { created_at: 'c', rotated_at: null, last_fetched_at: 'l', token_hash: HASH }, error: null }))
    const r = await getCalendarFeedStatus(db, ME)
    expect(r).toEqual({ data: { active: true, created_at: 'c', rotated_at: null, last_fetched_at: 'l' }, error: null })
    expect(queriesOf(db, 'staff_calendar_feeds')[0].eq).toEqual({ profile_id: ME })
  })

  it('status with no row is inactive', async () => {
    const r = await getCalendarFeedStatus(fakeDb(() => ({ data: null, error: null })), ME)
    expect(r.data).toEqual({ active: false, created_at: null, rotated_at: null, last_fetched_at: null })
  })

  it('issue (no replace) INSERTS the hash of the token it returns', async () => {
    const db = fakeDb(() => ({ data: null, error: null }))
    const r = await issueCalendarFeed(db, ME)
    expect(r.token).toMatch(/^rcf_[A-Za-z0-9_-]{43}$/)
    expect(r.replaced).toBe(false)
    const [ins] = queriesOf(db, 'staff_calendar_feeds', 'insert')
    expect(ins.payload).toEqual({ profile_id: ME, token_hash: sha(r.token) })
    expect(queriesOf(db, 'staff_calendar_feeds', 'update')).toEqual([])
  })

  it('issue (no replace) over an existing link is a conflict, and no token escapes', async () => {
    const db = fakeDb(() => ({ data: null, error: { code: '23505', message: 'duplicate key' } }))
    expect(await issueCalendarFeed(db, ME)).toEqual({ conflict: true })
  })

  it('issue (replace) is ONE update of the hash: the old link dies in the same statement', async () => {
    const NOW = Date.parse('2026-09-25T10:00:00Z')
    const db = fakeDb((q) => (q.action === 'update' ? { data: [{ profile_id: ME }], error: null } : { data: null, error: null }))
    const r = await issueCalendarFeed(db, ME, { replace: true, nowMs: NOW })
    expect(r.replaced).toBe(true)
    const [u] = queriesOf(db, 'staff_calendar_feeds', 'update')
    expect(u.payload).toEqual({ token_hash: sha(r.token), rotated_at: '2026-09-25T10:00:00.000Z', last_fetched_at: null })
    expect(u.eq).toEqual({ profile_id: ME })
    expect(queriesOf(db, 'staff_calendar_feeds', 'insert')).toEqual([])
  })

  it('issue (replace) with nothing to replace creates one', async () => {
    const db = fakeDb((q) => (q.action === 'update' ? { data: [], error: null } : { data: null, error: null }))
    const r = await issueCalendarFeed(db, ME, { replace: true })
    expect(r.replaced).toBe(false)
    expect(queriesOf(db, 'staff_calendar_feeds', 'insert')).toHaveLength(1)
  })

  it('a failed write returns the error and no token', async () => {
    const db = fakeDb(() => ({ data: null, error: { code: 'XX000', message: 'boom' } }))
    const r = await issueCalendarFeed(db, ME)
    expect(r.token).toBeUndefined()
    expect(r.error).toBeTruthy()
  })

  it("revoke deletes only the caller's row and says whether there was one", async () => {
    const db = fakeDb(() => ({ data: [{ profile_id: ME }], error: null }))
    expect(await revokeCalendarFeed(db, ME)).toEqual({ revoked: true, error: null })
    const [d] = queriesOf(db, 'staff_calendar_feeds', 'delete')
    expect(d.eq).toEqual({ profile_id: ME })
    expect(await revokeCalendarFeed(fakeDb(() => ({ data: [], error: null })), ME)).toEqual({ revoked: false, error: null })
  })
})

describe('FEED_TOKEN_RL (D8)', () => {
  it('is a per-token budget roomy enough for three devices on a 5-minute refresh', () => {
    expect(FEED_TOKEN_RL).toEqual({ max: 30, windowMs: 15 * 60_000 })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/staff-calendar-feed-server.test.js`
Expected: `Failed to resolve import "./staff-calendar-feed-server"`.

- [ ] **Step 3: Write the module**

```js
// src/lib/staff-calendar-feed-server.js
// ICSFEED.1 — the calendar feed's database work. Service-role client only
// (the table has no browser grants, mig 632).
//
// SCOPE: every read here is pinned to ONE profile — the one the token
// resolves to (the feed) or the session's own id (management). There is no id
// parameter anywhere a caller controls. That is the tenant boundary: a person's
// own shifts, at whichever studios they are rostered, and nobody else's rows.
//
// DEACTIVATION (D5): resolveCalendarFeed refuses a profile with active=false
// or deleted_at set. That one check covers PUT active:false, DELETE
// /api/staff/[id], the tombstone and a hand-run SQL flip; no deactivation path
// needs to know this table exists (the widget-auth ACTIVEUSER.1 lock).

import { generateCalendarFeedToken, hashCalendarFeedToken } from '@/lib/calendar-feed-token'
import { isTombstone } from '@/lib/staff-tombstone'
import { logError, logWarn } from '@/lib/log'

/** Own assignment + its block. No colleague, no note, no pay (see the pure module's header). */
export const FEED_SHIFT_SELECT = `
  id, status, start_time_override, end_time_override, updated_at,
  shift_blocks!inner (
    location_id, block_date, start_time, end_time, updated_at,
    rosters:roster_id ( status ),
    shift_templates ( name )
  )
`

/** D8 — per TOKEN, never per IP (Google fetches every feed from shared egress; UNSUB-RL.1). */
export const FEED_TOKEN_RL = Object.freeze({ max: 30, windowMs: 15 * 60_000 })

/** D10 — last_fetched_at is stamped at most this often. */
export const TOUCH_INTERVAL_MS = 15 * 60_000

// PostgREST's silent per-select cap. One person over 70 days is ~200 rows at
// most; hitting the cap would mean something is badly wrong, so say so.
const POSTGREST_ROW_CAP = 1000

/**
 * @returns {Promise<{status:'ok', feed:{profile_id:string,last_fetched_at:string|null}, tokenHash:string}
 *   | {status:'unknown'} | {status:'inactive'} | {status:'error'}>}
 */
export async function resolveCalendarFeed(db, token) {
  const tokenHash = hashCalendarFeedToken(token)
  if (!tokenHash) return { status: 'unknown' }

  const { data: feed, error } = await db
    .from('staff_calendar_feeds')
    .select('profile_id, last_fetched_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  if (error) {
    logError('calendar-feed', 'token lookup failed', { err: error })
    return { status: 'error' }
  }
  if (!feed) return { status: 'unknown' }

  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('id, active, deleted_at')
    .eq('id', feed.profile_id)
    .maybeSingle()
  if (profileError) {
    logError('calendar-feed', 'profile read failed', { err: profileError })
    return { status: 'error' }
  }
  // Strictly `=== false`, as in getCurrentUser: a missing `active` never locks
  // anyone out. A tombstone is always active=false too (mig 622 CHECK); both
  // tests are kept, as widget-auth keeps them.
  if (!profile || isTombstone(profile) || profile.active === false) return { status: 'inactive' }

  return { status: 'ok', feed, tokenHash }
}

/** The person's own assignments in the window, plus the studios they sit at. */
export async function loadFeedShifts(db, profileId, { from, to }) {
  const { data, error } = await db
    .from('shift_assignments')
    .select(FEED_SHIFT_SELECT)
    .eq('profile_id', profileId)
    .gte('shift_blocks.block_date', from)
    .lte('shift_blocks.block_date', to)
    .order('id')
  if (error) {
    logError('calendar-feed', 'shift read failed', { err: error })
    return { rows: [], locationsById: {}, error }
  }
  const rows = data || []
  if (rows.length >= POSTGREST_ROW_CAP) {
    logWarn('calendar-feed', 'shift read hit the row cap; the feed may be missing shifts', { rows: rows.length })
  }

  const ids = [...new Set(rows.map((r) => r.shift_blocks?.location_id).filter(Boolean))]
  if (ids.length === 0) return { rows, locationsById: {}, error: null }

  const { data: locs, error: locError } = await db
    .from('locations')
    .select('id, name, address, timezone')
    .in('id', ids)
  if (locError) {
    logError('calendar-feed', 'studio read failed', { err: locError })
    return { rows: [], locationsById: {}, error: locError }
  }
  return { rows, locationsById: Object.fromEntries((locs || []).map((l) => [l.id, l])), error: null }
}

/** D10 — stamp last_fetched_at when older than 15 minutes. Never throws, never fails the feed. */
export async function touchFeedFetched(db, feed, nowMs) {
  const last = Date.parse(feed?.last_fetched_at ?? '')
  if (Number.isFinite(last) && nowMs - last < TOUCH_INTERVAL_MS) return
  try {
    const { error } = await db
      .from('staff_calendar_feeds')
      .update({ last_fetched_at: new Date(nowMs).toISOString() })
      .eq('profile_id', feed.profile_id)
    if (error) logWarn('calendar-feed', 'last_fetched_at stamp failed', { err: error })
  } catch (e) {
    logWarn('calendar-feed', 'last_fetched_at stamp threw', { err: e })
  }
}

/** { active, created_at, rotated_at, last_fetched_at } for the caller. Never the hash. */
export async function getCalendarFeedStatus(db, profileId) {
  const { data, error } = await db
    .from('staff_calendar_feeds')
    .select('created_at, rotated_at, last_fetched_at')
    .eq('profile_id', profileId)
    .maybeSingle()
  if (error) return { data: null, error }
  return {
    data: {
      active: !!data,
      created_at: data?.created_at ?? null,
      rotated_at: data?.rotated_at ?? null,
      last_fetched_at: data?.last_fetched_at ?? null,
    },
    error: null,
  }
}

/**
 * Make a link. With replace, the existing row's hash is swapped in ONE UPDATE
 * (the old link dies in the same statement). Without it, an existing link is a
 * conflict (D11), decided by the primary key, so two racing creates cannot both win.
 *
 * @returns {Promise<{token:string, replaced:boolean} | {conflict:true} | {error:object}>}
 */
export async function issueCalendarFeed(db, profileId, { replace = false, nowMs = Date.now() } = {}) {
  const token = generateCalendarFeedToken()
  const tokenHash = hashCalendarFeedToken(token)

  if (replace) {
    const { data, error } = await db
      .from('staff_calendar_feeds')
      .update({ token_hash: tokenHash, rotated_at: new Date(nowMs).toISOString(), last_fetched_at: null })
      .eq('profile_id', profileId)
      .select('profile_id')
    if (error) return { error }
    if ((data || []).length > 0) return { token, replaced: true }
    // Nothing to replace (turned off elsewhere in the meantime): create one.
  }

  const { error } = await db
    .from('staff_calendar_feeds')
    .insert({ profile_id: profileId, token_hash: tokenHash })
  if (error) {
    if (error.code === '23505') return { conflict: true }
    return { error }
  }
  return { token, replaced: false }
}

/** Turn the caller's link off. `revoked` says whether there was one. */
export async function revokeCalendarFeed(db, profileId) {
  const { data, error } = await db
    .from('staff_calendar_feeds')
    .delete()
    .eq('profile_id', profileId)
    .select('profile_id')
  if (error) return { revoked: false, error }
  return { revoked: (data || []).length > 0, error: null }
}
```

- [ ] **Step 4: Run it, expect PASS; then the schema and tombstone sweeps**

Run: `npx vitest run src/lib/staff-calendar-feed-server.test.js tests/staff-tombstone-readers.test.js`
Expected: `23 passed` for the new file, and the tombstone sweep passes (the one `from('profiles')` read is pinned by `.eq('id', …)`).

Run: `npm run check:select-columns`
Expected: exit 0 (every column above resolves against migs 004, 067, 072, 100, 622 and 632).

- [ ] **Step 5: Commit**

```bash
git add src/lib/staff-calendar-feed-server.js src/lib/staff-calendar-feed-server.test.js
git commit -m "ICSFEED.1 — staff-calendar-feed-server: resolve by hash, refuse the inactive, own shifts only, one-UPDATE replace

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The anonymous feed, `GET /api/calendar-feed/<token>.ics`

**Files:**
- Create: `src/app/api/calendar-feed/[file]/route.test.js`
- Create: `src/app/api/calendar-feed/[file]/route.js`
- Modify: `scripts/check-route-guards.mjs` (`EXEMPT`, lines 118-139)

Quote bracketed paths in zsh (CLAUDE.md "zsh + bracketed paths").

- [ ] **Step 1: Write the failing test**

```js
// ICSFEED.1 — the anonymous calendar feed. The token in the path is the only
// credential (calendar apps cannot hold a session), so this suite pins every
// refusal to one indistinguishable 404, and pins that a read failure is a 503
// and NEVER an empty 200 (a subscribed calendar replaces its whole copy).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response('{"success":false}', { status: 429 })),
}))
vi.mock('@/lib/dublin-time', async (importOriginal) => ({
  ...(await importOriginal()),
  dublinTodayStr: () => '2026-09-25',
}))

const { createServerClient } = await import('@/lib/supabase')
const { checkRateLimit, rateLimitResponse } = await import('@/lib/rate-limit')
const { fakeDb, queriesOf } = await import('@/lib/time-off.test-helpers')
const { GET } = await import('./route.js')

const TOKEN = `rcf_${'A'.repeat(43)}`
const HASH = createHash('sha256').update(TOKEN).digest('hex')
const ME = '10000000-0000-0000-0000-00000000000a'
const LOC = { id: 'loc-1', name: 'Studio One', address: null, timezone: 'Europe/Dublin' }

function row(id, block = {}, over = {}) {
  return {
    id, status: 'scheduled', start_time_override: null, end_time_override: null, updated_at: '2026-09-20T10:00:00Z',
    ...over,
    shift_blocks: {
      location_id: 'loc-1', block_date: '2026-09-28', start_time: '06:00:00', end_time: '07:00:00',
      updated_at: '2026-09-20T10:00:00Z', rosters: { status: 'published' }, shift_templates: { name: 'Morning' },
      ...block,
    },
  }
}

function makeDb({
  feed = { profile_id: ME, last_fetched_at: null }, feedError = null,
  profile = { id: ME, active: true, deleted_at: null },
  rows = [row('a1'), row('draft', { rosters: { status: 'draft' } }), row('gone', {}, { status: 'cancelled' })],
  shiftError = null,
} = {}) {
  const db = fakeDb((q) => {
    if (q.table === 'staff_calendar_feeds' && q.action === 'select') return { data: feed, error: feedError }
    if (q.table === 'staff_calendar_feeds' && q.action === 'update') return { data: null, error: null }
    if (q.table === 'profiles') return { data: profile, error: null }
    if (q.table === 'shift_assignments') return { data: shiftError ? null : rows, error: shiftError }
    if (q.table === 'locations') return { data: [LOC], error: null }
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
  createServerClient.mockReturnValue(db)
  return db
}

const call = (file) => GET(
  new Request(`https://crm.example.test/api/calendar-feed/${file}`),
  { params: Promise.resolve({ file }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date(), retryAfterSec: 0 })
})

describe('GET /api/calendar-feed/[file] — refusals', () => {
  it('404s a file that is not a feed token, and reads nothing', async () => {
    for (const file of ['feed.ics', `${TOKEN}.txt`, 'rcf_short.ics', `${TOKEN}.ics.ics`]) {
      const db = makeDb()
      const res = await call(file)
      expect(res.status, file).toBe(404)
      expect(db.queries).toEqual([])
    }
  })

  it('an unknown, a deactivated and a tombstoned link get the SAME 404, and no shift is read', async () => {
    const answers = []
    for (const opts of [
      { feed: null },
      { profile: { id: ME, active: false, deleted_at: null } },
      { profile: { id: ME, active: false, deleted_at: '2026-09-20T00:00:00Z' } },
    ]) {
      const db = makeDb(opts)
      const res = await call(`${TOKEN}.ics`)
      answers.push([res.status, await res.text(), res.headers.get('cache-control')])
      expect(queriesOf(db, 'shift_assignments')).toEqual([])
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1)
    expect(answers[0]).toEqual([404, 'Not found', 'no-store'])
  })

  it('looks the token up by its sha256', async () => {
    const db = makeDb()
    await call(`${TOKEN}.ics`)
    expect(queriesOf(db, 'staff_calendar_feeds')[0].eq).toEqual({ token_hash: HASH })
  })

  it('a failed lookup is 503 + Retry-After, not a 404 that would read as "link revoked"', async () => {
    makeDb({ feedError: { message: 'down' } })
    const res = await call(`${TOKEN}.ics`)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('900')
  })

  it('a failed shift read is 503, NEVER an empty 200 (that would wipe every subscriber\'s shifts)', async () => {
    makeDb({ shiftError: { message: 'down' } })
    const res = await call(`${TOKEN}.ics`)
    expect(res.status).toBe(503)
    expect(await res.text()).not.toContain('BEGIN:VCALENDAR')
  })

  it('rate-limits per TOKEN (never per IP) and reads no shift when refused', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(), retryAfterSec: 60 })
    const db = makeDb()
    const res = await call(`${TOKEN}.ics`)
    expect(res.status).toBe(429)
    expect(rateLimitResponse).toHaveBeenCalled()
    const [, key, budget] = checkRateLimit.mock.calls[0]
    expect(key).toBe(`calfeed:token:${HASH.slice(0, 32)}`)
    expect(budget).toEqual({ max: 30, windowMs: 900_000 })
    expect(queriesOf(db, 'shift_assignments')).toEqual([])
  })
})

describe('GET /api/calendar-feed/[file] — the feed', () => {
  it('answers text/calendar with the published live shifts only', async () => {
    makeDb()
    const res = await call(`${TOKEN}.ics`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('private, max-age=900')
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    const body = await res.text()
    expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(body).toContain('UID:shift-a1@repset.ie')
    expect(body).toContain('DTSTART:20260928T050000Z')
    expect(body).not.toContain('shift-draft')
    expect(body).not.toContain('shift-gone')
  })

  it('also answers without the .ics suffix', async () => {
    makeDb()
    expect((await call(TOKEN)).status).toBe(200)
  })

  it("reads the resolved person's own shifts, two weeks back to eight ahead of Dublin today", async () => {
    const db = makeDb()
    await call(`${TOKEN}.ics`)
    const [q] = queriesOf(db, 'shift_assignments')
    expect(q.eq).toEqual({ profile_id: ME })
    expect(q.calls).toContainEqual(['gte', 'shift_blocks.block_date', '2026-09-11'])
    expect(q.calls).toContainEqual(['lte', 'shift_blocks.block_date', '2026-11-20'])
  })

  it('stamps last_fetched_at when stale, and not when fresh', async () => {
    let db = makeDb()
    await call(`${TOKEN}.ics`)
    expect(queriesOf(db, 'staff_calendar_feeds', 'update')).toHaveLength(1)
    db = makeDb({ feed: { profile_id: ME, last_fetched_at: new Date(Date.now() - 60_000).toISOString() } })
    await call(`${TOKEN}.ics`)
    expect(queriesOf(db, 'staff_calendar_feeds', 'update')).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run 'src/app/api/calendar-feed/[file]/route.test.js'`
Expected: `Failed to resolve import "./route.js"`.

- [ ] **Step 3: Write the route**

```js
// src/app/api/calendar-feed/[file]/route.js
// ICSFEED.1 — GET /api/calendar-feed/<token>.ics — a person's own published
// shifts as an iCalendar feed, for Apple, Google and Outlook to subscribe to.
//
// ANONYMOUS BY DESIGN. Calendar apps poll a URL and can hold no session, so
// the rcf_ token in the path IS the credential (256 random bits; only its
// sha256 is stored, mig 632). Public via the proxy's publicExactPaths
// ('/api/calendar-feed', segment-matched) and check:route-guards EXEMPT. NOT on
// the brand or tenant allowlists: the URL is always minted on the CRM host.
//
// ANSWERS
//   404  not a token, unknown, replaced, turned off, or the person is
//        deactivated or deleted. ONE answer for all of them, so the response
//        says nothing about which.
//   429  this token over FEED_TOKEN_RL (per token, never per IP: Google fetches
//        every feed from shared egress — the UNSUB-RL.1 lesson).
//   503  a read failed. NEVER an empty 200: a subscribed calendar replaces its
//        whole copy with each fetch, so an empty body would delete every shift
//        from every subscriber's phone on a database blip.
//   200  text/calendar. private, max-age=900: no shared cache ever holds it, so
//        a replaced or turned-off link stops at once server-side.
// HEAD is answered by Next from this GET.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { dublinTodayStr } from '@/lib/dublin-time'
import { tokenFromFeedFile } from '@/lib/calendar-feed-token'
import { buildStaffShiftFeed, feedWindow } from '@/lib/staff-calendar-feed'
import {
  FEED_TOKEN_RL, resolveCalendarFeed, loadFeedShifts, touchFeedFetched,
} from '@/lib/staff-calendar-feed-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function notFound() {
  return new NextResponse('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  })
}

function unavailable() {
  return new NextResponse('Calendar temporarily unavailable', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '900' },
  })
}

export async function GET(request, props) {
  const { file } = await props.params
  const token = tokenFromFeedFile(file)
  if (!token) return notFound()

  const db = createServerClient()
  const resolved = await resolveCalendarFeed(db, token)
  if (resolved.status === 'error') return unavailable()
  if (resolved.status !== 'ok') return notFound()

  const limit = await checkRateLimit(db, `calfeed:token:${resolved.tokenHash.slice(0, 32)}`, FEED_TOKEN_RL)
  if (!limit.allowed) return rateLimitResponse(limit)

  const nowMs = Date.now()
  const { rows, locationsById, error } = await loadFeedShifts(db, resolved.feed.profile_id, feedWindow(dublinTodayStr()))
  if (error) return unavailable()

  const body = buildStaffShiftFeed({ rows, locationsById, generatedAtMs: nowMs })
  await touchFeedFetched(db, resolved.feed, nowMs)

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="shifts.ics"',
      'Cache-Control': 'private, max-age=900',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}
```

- [ ] **Step 4: Add the route-guards exemption**

In `scripts/check-route-guards.mjs`, inside `const EXEMPT = {` (line 118), after the `'src/app/api/preferences/[token]/route.js'` entry (lines 125-126), add:

```js
  'src/app/api/calendar-feed/[file]/route.js':
    'Capability-token URL (ICSFEED.1, mig 632): a calendar app polls it and can hold no session. The rcf_ token (256 random bits, only its sha256 stored) resolves to ONE profile and the route reads only that profile\'s own published shifts; refuses (404) an inactive or deleted profile; per-TOKEN rate limit (never per IP: Google fetches from shared egress). Public via the proxy\'s publicExactPaths only — not on brand or tenant hosts.',
```

- [ ] **Step 5: Run it, expect PASS**

Run: `npx vitest run 'src/app/api/calendar-feed/[file]/route.test.js' && npm run check:route-guards && npm run check:location-scoping`
Expected: `10 passed`; both checks exit 0 (the route file queries no tenant table itself; its reads live in the IO module and are pinned to one profile).

- [ ] **Step 6: Commit**

```bash
git add 'src/app/api/calendar-feed/[file]/route.js' 'src/app/api/calendar-feed/[file]/route.test.js' scripts/check-route-guards.mjs
git commit -m "ICSFEED.1 — GET /api/calendar-feed/<token>.ics: the anonymous feed (one 404 for every refusal, 503 never an empty calendar, per-token limit)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The proxy admits the feed on the CRM host only

**Files:**
- Create: `src/calendar-feed-path.test.js`
- Modify: `src/proxy.js` (the comment above line 241, and line 241)

- [ ] **Step 1: Write the failing test**

```js
// ICSFEED.1 — which hosts serve the calendar feed anonymously.
//
// Deliberately NOT in src/public-compliance-paths.test.jsx: that file guards
// paths that must be public on EVERY host. This one must be public on the CRM
// hosts only (the URL is always minted from getAppUrl()), and must NOT be
// served on the marketing host or a tenant host. Both directions are pinned,
// so an entry added "for completeness" to brands.js fails here.
//
// Scaffolding mirrors public-compliance-paths.test.jsx: the REAL proxy, the
// REAL brand registry and the REAL DB brand defaults; only Supabase and the
// tenant_domains row lookup are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ssrClient = {
  auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  from: () => { throw new Error('no table access expected in these tests') },
}
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ssrClient }))

let tenantBrandImpl = async () => null
vi.mock('@/lib/tenant-domains-edge', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveTenantDomainBrand: (...args) => tenantBrandImpl(...args),
}))

import { proxy } from './proxy.js'
import { BRANDS } from './lib/brands.js'
import { DB_BRAND_DEFAULTS } from './lib/tenant-domains-edge.js'

const FEED = `/api/calendar-feed/rcf_${'A'.repeat(43)}.ics`
const TENANT_HOST = 'fitness.example.com'

function makeReq({ host, path }) {
  return {
    method: 'GET',
    headers: new Headers({ host }),
    url: `https://${host}${path}`,
    nextUrl: { pathname: path, search: '', clone: () => new URL(`https://${host}${path}`) },
    cookies: { getAll: () => [], get: () => undefined, set: () => {} },
  }
}
const admitted = (res) => res.headers.get('x-middleware-next') === '1'
const rewrittenTo = (res) => res.headers.get('x-middleware-rewrite')

beforeEach(() => {
  vi.clearAllMocks()
  ssrClient.auth.getUser.mockResolvedValue({ data: { user: null } })
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
  tenantBrandImpl = async () => null
})
afterEach(() => { vi.unstubAllEnvs() })

describe('the feed is anonymous on the CRM hosts', () => {
  for (const host of ['crm.repset.ie', 'crm.un1tdublin.com']) {
    it(`${host} admits it without consulting a session`, async () => {
      const res = await proxy(makeReq({ host, path: FEED }))
      expect(admitted(res)).toBe(true)
      expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
    })
  }

  it('also without the .ics suffix', async () => {
    const res = await proxy(makeReq({ host: 'crm.repset.ie', path: FEED.replace(/\.ics$/, '') }))
    expect(admitted(res)).toBe(true)
  })
})

describe('nothing else inherits the exemption', () => {
  for (const path of ['/api/calendar-feeds/x', '/api/calendar-feed-admin', '/api/me/calendar-feed']) {
    it(`${path} still needs a session`, async () => {
      const res = await proxy(makeReq({ host: 'crm.repset.ie', path }))
      expect(admitted(res)).toBe(false)
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/login')
    })
  }
})

describe('brand and tenant hosts do NOT serve it (deliberate)', () => {
  it('the marketing host rewrites it to /welcome', async () => {
    const res = await proxy(makeReq({ host: 'un1tdublin.com', path: FEED }))
    expect(rewrittenTo(res)).toContain('/welcome')
  })

  it('a tenant host rewrites it to /welcome', async () => {
    tenantBrandImpl = async (hostname) =>
      hostname && hostname.split(':')[0] === TENANT_HOST
        ? { id: `tenant:${TENANT_HOST}`, hostnames: [TENANT_HOST], ...DB_BRAND_DEFAULTS }
        : null
    const res = await proxy(makeReq({ host: TENANT_HOST, path: FEED }))
    expect(rewrittenTo(res)).toContain('/welcome')
  })

  it('no brand allowlist and not the tenant defaults name it', () => {
    for (const b of BRANDS) {
      expect(b.allowedPaths.some((p) => FEED.startsWith(p)), `brand ${b.id}`).toBe(false)
    }
    expect(DB_BRAND_DEFAULTS.allowedPaths.some((p) => FEED.startsWith(p))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/calendar-feed-path.test.js`
Expected: the three "CRM hosts" tests fail (`expected false to be true`: the proxy sends the feed to `/login`). The rest pass already.

- [ ] **Step 3: Change the proxy**

In `src/proxy.js`, directly above `const publicExactPaths = ['/api/mobile/review-login']` (line 241), extend the comment block (which ends with the review-login paragraph) with:

```js
  //
  // /api/calendar-feed — ICSFEED.1, a person's own published shifts as an
  // iCalendar feed. Apple, Google and Outlook poll it with no session, so the
  // rcf_ token in the path is the credential; the route self-guards (sha256
  // lookup, refuses an inactive or deleted profile, per-token rate limit) and
  // is in check:route-guards EXEMPT. Segment-matched here, not a bare prefix,
  // so a future /api/calendar-feeds or /api/calendar-feed-admin is NOT public
  // by inheritance. Like review-login it is not a PAGE, and the URL is always
  // minted on the CRM host (getAppUrl), so AppShell, brands and tenant-domains
  // do not list it: on a brand host it SHOULD fall back
  // (src/calendar-feed-path.test.js pins both directions).
```

and change line 241 to:

```js
  const publicExactPaths = ['/api/mobile/review-login', '/api/calendar-feed']
```

- [ ] **Step 4: Run it and the existing proxy guards, expect PASS**

Run: `npx vitest run src/calendar-feed-path.test.js src/public-compliance-paths.test.jsx src/proxy.test.js`
Expected: all pass (`9 passed` for the new file; the other two unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/proxy.js src/calendar-feed-path.test.js
git commit -m "ICSFEED.1 — proxy: /api/calendar-feed is public on the CRM hosts (segment-matched), and deliberately not on brand or tenant hosts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Management, `GET/POST/DELETE /api/me/calendar-feed`

**Files:**
- Create: `src/app/api/me/calendar-feed/route.test.js`
- Create: `src/app/api/me/calendar-feed/route.js`

- [ ] **Step 1: Write the failing test**

```js
// ICSFEED.1 — the caller's OWN calendar link. This runs on the service-role
// client, so `.eq('profile_id', user.id)` IS the gate; no id parameter exists
// and a body that names one is refused.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { fakeDb, queriesOf } = await import('@/lib/time-off.test-helpers')
const { GET, POST, DELETE } = await import('./route.js')

const ME = { id: '10000000-0000-0000-0000-00000000000a', email: 'coach@example.test' }
const sha = (t) => createHash('sha256').update(t).digest('hex')
const URL_RE = /^https:\/\/crm\.example\.test\/api\/calendar-feed\/(rcf_[A-Za-z0-9_-]{43})\.ics$/

function makeDb(resolve = () => ({ data: null, error: null })) {
  const db = fakeDb(resolve)
  createServerClient.mockReturnValue(db)
  return db
}
const post = (body) => POST(new Request('http://x/api/me/calendar-feed', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
}))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(ME)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.test')
})
afterEach(() => { vi.unstubAllEnvs() })

describe('auth', () => {
  it('401 on every verb without a session, and nothing is read', async () => {
    getCurrentUser.mockResolvedValue(null)
    const db = makeDb()
    expect((await GET()).status).toBe(401)
    expect((await post({})).status).toBe(401)
    expect((await DELETE()).status).toBe(401)
    expect(db.queries).toEqual([])
  })

  it('POST and DELETE refuse while a master views as someone (their secret would land in the master\'s browser)', async () => {
    for (const u of [
      { ...ME, impersonatingFrom: { id: 'master-1' } },
      { ...ME, supportSession: { mode: 'act_on_behalf', impersonatedUserId: ME.id } },
    ]) {
      getCurrentUser.mockResolvedValue(u)
      const db = makeDb()
      expect((await post({})).status).toBe(403)
      expect((await DELETE()).status).toBe(403)
      expect(db.queries).toEqual([])
    }
  })

  it('a body naming another profile is refused, not obeyed', async () => {
    const db = makeDb()
    expect((await post({ profile_id: 'someone-else' })).status).toBe(400)
    expect(db.queries).toEqual([])
  })
})

describe('GET — status only, never a URL', () => {
  it("reads the caller's own row and returns no hash and no URL", async () => {
    const db = makeDb(() => ({ data: { created_at: '2026-09-01T00:00:00Z', rotated_at: null, last_fetched_at: null, token_hash: 'f'.repeat(64) }, error: null }))
    const res = await GET()
    const body = await res.json()
    expect(body).toEqual({ success: true, data: { active: true, created_at: '2026-09-01T00:00:00Z', rotated_at: null, last_fetched_at: null } })
    expect(queriesOf(db, 'staff_calendar_feeds')[0].eq).toEqual({ profile_id: ME.id })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('500 on a failed read', async () => {
    makeDb(() => ({ data: null, error: { message: 'down' } }))
    expect((await GET()).status).toBe(500)
  })
})

describe('POST — make a link', () => {
  it('creates one and returns the three links ONCE, with no-store', async () => {
    const db = makeDb()
    const res = await post(undefined)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const { data } = await res.json()
    const token = data.url.match(URL_RE)[1]
    expect(data.webcal_url).toBe(data.url.replace('https://', 'webcal://'))
    expect(data.google_url).toBe(`https://calendar.google.com/calendar/render?cid=${encodeURIComponent(data.webcal_url)}`)
    expect(data.replaced).toBe(false)
    const [ins] = queriesOf(db, 'staff_calendar_feeds', 'insert')
    expect(ins.payload).toEqual({ profile_id: ME.id, token_hash: sha(token) })
  })

  it('409 feed_exists when a link already exists and replace was not asked for', async () => {
    makeDb(() => ({ data: null, error: { code: '23505', message: 'duplicate key' } }))
    const res = await post({})
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, code: 'feed_exists' })
    expect(JSON.stringify(body)).not.toContain('rcf_')
  })

  it('replace: true swaps the hash on the caller\'s own row', async () => {
    const db = makeDb((q) => (q.action === 'update' ? { data: [{ profile_id: ME.id }], error: null } : { data: null, error: null }))
    const { data } = await (await post({ replace: true })).json()
    const token = data.url.match(URL_RE)[1]
    expect(data.replaced).toBe(true)
    const [u] = queriesOf(db, 'staff_calendar_feeds', 'update')
    expect(u.eq).toEqual({ profile_id: ME.id })
    expect(u.payload.token_hash).toBe(sha(token))
  })

  it('500 and no link when the write fails', async () => {
    makeDb(() => ({ data: null, error: { code: 'XX000', message: 'down' } }))
    const res = await post({})
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('rcf_')
  })

  it('500 and NO row written when the app URL is not configured (no orphaned link)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    const db = makeDb()
    expect((await post({})).status).toBe(500)
    expect(db.queries).toEqual([])
  })
})

describe('DELETE — turn it off', () => {
  it("deletes the caller's own row", async () => {
    const db = makeDb(() => ({ data: [{ profile_id: ME.id }], error: null }))
    const body = await (await DELETE()).json()
    expect(body).toEqual({ success: true, data: { revoked: true } })
    expect(queriesOf(db, 'staff_calendar_feeds', 'delete')[0].eq).toEqual({ profile_id: ME.id })
  })

  it('turning off nothing is still a success (idempotent)', async () => {
    makeDb(() => ({ data: [], error: null }))
    expect(await (await DELETE()).json()).toEqual({ success: true, data: { revoked: false } })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/me/calendar-feed/route.test.js`
Expected: `Failed to resolve import "./route.js"`.

- [ ] **Step 3: Write the route**

```js
// src/app/api/me/calendar-feed/route.js
// ICSFEED.1 — the caller's OWN calendar link.
//
//   GET     { active, created_at, rotated_at, last_fetched_at }. Never the URL:
//           only its hash is stored (mig 632), so it cannot be shown again.
//   POST    { replace?: boolean } → { url, webcal_url, google_url, replaced }.
//           The ONLY time the URL exists outside the person's calendar app.
//           An existing link without replace:true is 409 feed_exists, so a
//           double tap or a second device never silently kills the first one.
//   DELETE  turn it off (idempotent).
//
// SCOPE: the service-role client, so `.eq('profile_id', user.id)` inside the
// IO module IS the gate. No id parameter exists; a body naming one is refused
// by the strict schema. Every staff member may subscribe to their own shifts,
// so there is no permission key (check:mobile-parity has nothing to pair).
//
// IMPERSONATION: POST and DELETE refuse while a master views as someone. A
// minted link is a long-lived secret; making one for another person would land
// it in the master's browser.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { getAppUrl } from '@/lib/app-url'
import { logError } from '@/lib/log'
import { calendarFeedUrls } from '@/lib/calendar-feed-token'
import { getCalendarFeedStatus, issueCalendarFeed, revokeCalendarFeed } from '@/lib/staff-calendar-feed-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const IssueSchema = z.object({ replace: z.boolean().optional() }).strict()

function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}
const unauthorized = () => json({ success: false, error: 'Unauthorized' }, 401)
const viewingAsSomeone = (user) => !!(user.impersonatingFrom || user.supportSession?.impersonatedUserId)
const impersonating = () => json({
  success: false,
  error: 'A calendar link can only be made or turned off by the person it belongs to, not while viewing as them.',
}, 403)

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  const db = createServerClient()
  const { data, error } = await getCalendarFeedStatus(db, user.id)
  if (error) {
    logError('calendar-feed', 'status read failed', { err: error })
    return json({ success: false, error: 'Could not read your calendar link.' }, 500)
  }
  return json({ success: true, data })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  if (viewingAsSomeone(user)) return impersonating()

  const validation = await validateBody(request, IssueSchema, { allowEmpty: true })
  if (!validation.ok) return validation.response

  // Resolve the origin BEFORE minting, so a misconfigured deploy cannot leave a
  // live link behind that nobody was ever shown.
  let base
  try {
    base = getAppUrl()
  } catch (e) {
    logError('calendar-feed', 'NEXT_PUBLIC_APP_URL is not set', { err: e })
    return json({ success: false, error: 'Calendar links are not configured on this server.' }, 500)
  }

  const db = createServerClient()
  const result = await issueCalendarFeed(db, user.id, { replace: validation.data.replace === true })
  if (result.conflict) {
    return json({
      success: false,
      code: 'feed_exists',
      error: 'You already have a calendar link. Make a new one to replace it.',
    }, 409)
  }
  if (result.error) {
    logError('calendar-feed', 'issue failed', { err: result.error })
    return json({ success: false, error: 'Could not make your calendar link.' }, 500)
  }
  return json({ success: true, data: { ...calendarFeedUrls(base, result.token), replaced: result.replaced } })
}

export async function DELETE() {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  if (viewingAsSomeone(user)) return impersonating()

  const db = createServerClient()
  const { revoked, error } = await revokeCalendarFeed(db, user.id)
  if (error) {
    logError('calendar-feed', 'revoke failed', { err: error })
    return json({ success: false, error: 'Could not turn off your calendar link.' }, 500)
  }
  return json({ success: true, data: { revoked } })
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/me/calendar-feed/route.test.js && npm run check:route-guards && npm run check:location-scoping`
Expected: `12 passed`; both checks exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/me/calendar-feed/route.js src/app/api/me/calendar-feed/route.test.js
git commit -m "ICSFEED.1 — /api/me/calendar-feed: own link only; POST shows the URL once (409 when one exists), DELETE turns it off, refused while viewing as someone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The web card on `/account`

**Files:**
- Create: `src/components/CalendarFeedCard.test.jsx`
- Create: `src/components/CalendarFeedCard.jsx`
- Modify: `src/app/account/page.js` (import after line 23; card after the `StudioPinSettings` block, lines 96-102)

- [ ] **Step 1: Write the failing test**

```jsx
// @vitest-environment jsdom
//
// ICSFEED.1 — the /account calendar card. Pins the flows: create shows the
// link once; "Make a new link" asks first and sends replace:true; "Turn off"
// asks first and DELETEs; a 409 is surfaced, not swallowed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import CalendarFeedCard from './CalendarFeedCard'

const LINKS = {
  url: 'https://crm.example.test/api/calendar-feed/rcf_x.ics',
  webcal_url: 'webcal://crm.example.test/api/calendar-feed/rcf_x.ics',
  google_url: 'https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2Fcrm.example.test%2Fapi%2Fcalendar-feed%2Frcf_x.ics',
  replaced: false,
}
const OFF = { active: false, created_at: null, rotated_at: null, last_fetched_at: null }
const ON = { active: true, created_at: '2026-09-01T09:00:00Z', rotated_at: null, last_fetched_at: '2026-09-25T09:00:00Z' }
const ok = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) })

function mockFetch(handlers) {
  global.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    const h = handlers[method]
    if (!h) throw new Error(`unexpected ${method} ${url}`)
    return typeof h === 'function' ? h(url, init) : h
  })
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); delete global.fetch; vi.restoreAllMocks() })

describe('CalendarFeedCard', () => {
  it('with no link: one button, and the link appears once it is made', async () => {
    let state = OFF
    mockFetch({ GET: () => ok(state), POST: () => { state = ON; return ok(LINKS) } })
    render(<CalendarFeedCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Get my calendar link' }))
    expect(await screen.findByDisplayValue(LINKS.url)).toBeTruthy()
    const post = global.fetch.mock.calls.find(([, i]) => i?.method === 'POST')
    expect(JSON.parse(post[1].body)).toEqual({ replace: false })
    expect(screen.getByRole('link', { name: 'Open in Apple Calendar or Outlook' }).getAttribute('href')).toBe(LINKS.webcal_url)
    expect(screen.getByRole('link', { name: 'Add to Google Calendar' }).getAttribute('href')).toBe(LINKS.google_url)
    expect(screen.getByText(/shown once/i)).toBeTruthy()
  })

  it('with a link: shows it is on, and "Make a new link" does nothing unless confirmed', async () => {
    mockFetch({ GET: () => ok(ON), POST: () => ok({ ...LINKS, replaced: true }) })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<CalendarFeedCard />)
    expect(await screen.findByText(/last checked by your calendar/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }))
    expect(confirm).toHaveBeenCalled()
    expect(global.fetch.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false)

    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }))
    await waitFor(() => expect(global.fetch.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true))
    const post = global.fetch.mock.calls.find(([, i]) => i?.method === 'POST')
    expect(JSON.parse(post[1].body)).toEqual({ replace: true })
  })

  it('"Turn off" asks, then DELETEs', async () => {
    let state = ON
    mockFetch({ GET: () => ok(state), DELETE: () => { state = OFF; return ok({ revoked: true }) } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CalendarFeedCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    expect(await screen.findByRole('button', { name: 'Get my calendar link' })).toBeTruthy()
    expect(global.fetch.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(true)
  })

  it('a 409 shows the server\'s message', async () => {
    mockFetch({
      GET: () => ok(OFF),
      POST: () => ({ ok: false, status: 409, json: async () => ({ success: false, code: 'feed_exists', error: 'You already have a calendar link. Make a new one to replace it.' }) }),
    })
    render(<CalendarFeedCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Get my calendar link' }))
    expect((await screen.findByRole('alert')).textContent).toContain('You already have a calendar link')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/CalendarFeedCard.test.jsx`
Expected: `Failed to resolve import "./CalendarFeedCard"`.

- [ ] **Step 3: Write the component**

```jsx
'use client'

// ICSFEED.1 — /account: subscribe to your own published shifts.
//
// The link is shown ONCE, right after it is made (only its hash is stored,
// mig 632). Afterwards the card can say the link is on and when a calendar
// last fetched it, and offer a new link (the old one stops) or turning it off.
// Every URL comes from the server (calendarFeedUrls); nothing is built here.

import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui'

const ENDPOINT = '/api/me/calendar-feed'

function dublinStamp(iso) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return null
  return new Date(t).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export default function CalendarFeedCard() {
  const [status, setStatus] = useState(null) // null while loading
  const [links, setLinks] = useState(null)   // { url, webcal_url, google_url } — only right after POST
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINT, { cache: 'no-store' })
      const body = await res.json()
      if (body.success) setStatus(body.data)
      else setError(body.error || 'Could not load your calendar link.')
    } catch {
      setError('Could not load your calendar link.')
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function issue(replace) {
    if (replace && !window.confirm('Make a new link? Calendars using your current link will stop updating.')) return
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replace }),
      })
      const body = await res.json()
      if (!body.success) {
        setError(body.error || 'Could not make your calendar link.')
        if (res.status === 409) await load()
        return
      }
      setLinks(body.data)
      await load()
    } catch {
      setError('Could not make your calendar link.')
    } finally {
      setBusy(false)
    }
  }

  async function turnOff() {
    if (!window.confirm('Turn off your calendar link? Your calendar will stop getting your shifts.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(ENDPOINT, { method: 'DELETE' })
      const body = await res.json()
      if (!body.success) {
        setError(body.error || 'Could not turn off your calendar link.')
        return
      }
      setLinks(null)
      await load()
    } catch {
      setError('Could not turn off your calendar link.')
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(links.url)
      setCopied(true)
    } catch {
      setError('Copy failed. Select the link and copy it yourself.')
    }
  }

  const lastChecked = dublinStamp(status?.last_fetched_at)

  return (
    <div className="border-t border-un1t-border pt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Calendar</h2>
      <div className="p-4 rounded-xl bg-un1t-surface border border-un1t-border">
        <div className="flex items-start gap-3">
          <CalendarDays size={18} className="text-un1t-subtle mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-un1t-text">Subscribe to my shifts</div>
            <p className="text-xs text-un1t-subtle mt-1">
              Your published shifts at every studio, in Apple, Google or Outlook Calendar: two weeks back and
              eight weeks ahead. Your calendar app checks for changes on its own schedule (Google can take several
              hours). The link stops working if your account is deactivated.
            </p>

            {status?.active && (
              <p className="text-xs text-un1t-text mt-2">
                Your calendar link is on.{' '}
                {lastChecked
                  ? `Last checked by your calendar ${lastChecked}.`
                  : 'Your calendar has not checked it yet.'}
              </p>
            )}

            {links && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-un1t-text">
                  This link is shown once. Anyone who has it can see your shifts, so keep it to yourself.
                  If you shared it by mistake, make a new link.
                </p>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={links.url}
                    aria-label="Calendar link"
                    onFocus={(e) => e.target.select()}
                    className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded-lg border border-un1t-border bg-un1t-bg text-un1t-text"
                  />
                  <Button variant="secondary" size="sm" icon={copied ? Check : Copy} onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <a href={links.webcal_url} className="text-un1t-text underline">Open in Apple Calendar or Outlook</a>
                  <a href={links.google_url} target="_blank" rel="noopener noreferrer" className="text-un1t-text underline">
                    Add to Google Calendar
                  </a>
                </div>
              </div>
            )}

            {error && <p role="alert" className="text-xs text-red-700 mt-2">{error}</p>}

            <div className="flex flex-wrap gap-2 mt-3">
              {status && !status.active && (
                <Button size="sm" loading={busy} onClick={() => issue(false)}>Get my calendar link</Button>
              )}
              {status?.active && (
                <>
                  <Button size="sm" variant="secondary" loading={busy} onClick={() => issue(true)}>Make a new link</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={turnOff}>Turn off</Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Mount it on `/account`**

In `src/app/account/page.js`, after `import StudioPinSettings from '@/components/StudioPinSettings'` (line 23) add:

```js
import CalendarFeedCard from '@/components/CalendarFeedCard'
```

and after the `StudioPinSettings` wrapper's closing `</div>` (the block at lines 96-102) add:

```jsx
      <div className="mt-8">
        <CalendarFeedCard />
      </div>
```

Also add one line to the page's header comment list ("Currently exposes:"): `//   - Calendar subscription link (ICSFEED.1, /api/me/calendar-feed)`.

- [ ] **Step 5: Run it, expect PASS; then guardrails on the new files**

Run: `npx vitest run src/components/CalendarFeedCard.test.jsx && npx eslint --config eslint.guardrails.config.mjs src/components/CalendarFeedCard.jsx src/app/account/page.js`
Expected: `4 passed`; eslint clean (no low-contrast chip, no dead token, no untyped button: `Button` sets `type="button"`).

- [ ] **Step 6: Commit**

```bash
git add src/components/CalendarFeedCard.jsx src/components/CalendarFeedCard.test.jsx src/app/account/page.js
git commit -m "ICSFEED.1 — /account: calendar card (link shown once, new link and turn off ask first)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Phone decisions, `mobile/lib/calendar-feed.js` + the API wrappers (OTA bundle paths)

**Files:**
- Create: `mobile/lib/calendar-feed.test.js`
- Create: `mobile/lib/calendar-feed.js`
- Create: `mobile/lib/calendar-feed-api.test.js`
- Create: `mobile/lib/calendar-feed-api.js`

No RN component test runner exists (memory: decisions go in `mobile/lib/`), so everything the row decides is here and tested; the component only renders it.

- [ ] **Step 1: Write the failing tests**

`mobile/lib/calendar-feed.test.js`:

```js
// ICSFEED.1 — what the Schedule tab's calendar row says and does.
import { describe, it, expect } from 'vitest'
import { feedRowModel, lastSyncedLabel, subscribeOpenOrder, REPLACE_PROMPT, TURN_OFF_PROMPT } from './calendar-feed'

const NOW = Date.parse('2026-09-25T10:00:00Z')
const URLS = {
  url: 'https://crm.example.test/api/calendar-feed/rcf_x.ics',
  webcal_url: 'webcal://crm.example.test/api/calendar-feed/rcf_x.ics',
  google_url: 'https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2Fx',
}

describe('feedRowModel', () => {
  it('no link (or an unreadable status) offers to create one', () => {
    for (const s of [null, undefined, { active: false }]) {
      expect(feedRowModel(s, NOW)).toEqual({
        title: 'Subscribe to my shifts',
        subtitle: 'Add your published shifts to your calendar app.',
        action: 'create',
      })
    }
  })

  it('a live link says so, with when the calendar last checked', () => {
    expect(feedRowModel({ active: true, last_fetched_at: '2026-09-25T09:48:00Z' }, NOW)).toEqual({
      title: 'Calendar subscription on',
      subtitle: 'Your calendar last checked 12 min ago.',
      action: 'manage',
    })
  })

  it('a live link that has never been fetched says the calendar has not checked in', () => {
    expect(feedRowModel({ active: true, last_fetched_at: null }, NOW).subtitle)
      .toBe('Your calendar has not checked in yet.')
  })
})

describe('lastSyncedLabel', () => {
  it('reads a timestamp as a rough age', () => {
    expect(lastSyncedLabel('2026-09-25T09:59:40Z', NOW)).toBe('just now')
    expect(lastSyncedLabel('2026-09-25T09:48:00Z', NOW)).toBe('12 min ago')
    expect(lastSyncedLabel('2026-09-25T07:00:00Z', NOW)).toBe('3 h ago')
    expect(lastSyncedLabel('2026-09-22T10:00:00Z', NOW)).toBe('3 days ago')
  })
  it('garbage is null, and a clock-skewed future stamp is "just now"', () => {
    expect(lastSyncedLabel(null, NOW)).toBe(null)
    expect(lastSyncedLabel('nope', NOW)).toBe(null)
    expect(lastSyncedLabel('2026-09-25T10:05:00Z', NOW)).toBe('just now')
  })
})

describe('subscribeOpenOrder — which link to hand the OS first', () => {
  it('iOS: webcal opens Apple Calendar\'s subscribe sheet', () => {
    expect(subscribeOpenOrder('ios', URLS)).toEqual([URLS.webcal_url])
  })
  it('Android: Google Calendar\'s add-by-URL page first (no app claims webcal by default)', () => {
    expect(subscribeOpenOrder('android', URLS)).toEqual([URLS.google_url, URLS.webcal_url])
  })
  it('anything else: webcal, then Google', () => {
    expect(subscribeOpenOrder('web', URLS)).toEqual([URLS.webcal_url, URLS.google_url])
  })
  it('never hands the OS anything but webcal:// or https:// (a bad response cannot open javascript:)', () => {
    expect(subscribeOpenOrder('ios', { webcal_url: 'javascript:alert(1)' })).toEqual([])
    expect(subscribeOpenOrder('android', { google_url: 'http://calendar.google.com/x', webcal_url: null })).toEqual([])
    expect(subscribeOpenOrder('ios', null)).toEqual([])
  })
})

describe('prompt copy', () => {
  it('says what a new link does to the old one, and what turning off does', () => {
    expect(REPLACE_PROMPT.body).toMatch(/stop updating/)
    expect(TURN_OFF_PROMPT.body).toMatch(/stop getting your shifts/)
  })
})
```

`mobile/lib/calendar-feed-api.test.js`:

```js
// ICSFEED.1 — the wire contract of the three calendar-link calls.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn(() => Promise.resolve({ success: true, data: {} })) }))

const { api } = await import('./api')
const feed = await import('./calendar-feed-api')

beforeEach(() => { api.mockClear() })

describe('calendar-feed-api', () => {
  it('exports exactly these helpers', () => {
    expect(Object.keys(feed).sort()).toEqual(['createMyCalendarFeed', 'getMyCalendarFeed', 'turnOffMyCalendarFeed'])
  })
  it('getMyCalendarFeed GETs the caller\'s own status (no id: there is none to send)', () => {
    feed.getMyCalendarFeed()
    expect(api).toHaveBeenCalledWith('/api/me/calendar-feed')
  })
  it('createMyCalendarFeed POSTs replace as a strict boolean', () => {
    feed.createMyCalendarFeed()
    expect(api).toHaveBeenLastCalledWith('/api/me/calendar-feed', { method: 'POST', body: { replace: false } })
    feed.createMyCalendarFeed({ replace: true })
    expect(api).toHaveBeenLastCalledWith('/api/me/calendar-feed', { method: 'POST', body: { replace: true } })
  })
  it('turnOffMyCalendarFeed DELETEs', () => {
    feed.turnOffMyCalendarFeed()
    expect(api).toHaveBeenCalledWith('/api/me/calendar-feed', { method: 'DELETE' })
  })
})
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run mobile/lib/calendar-feed.test.js mobile/lib/calendar-feed-api.test.js`
Expected: both fail to resolve their modules.

- [ ] **Step 3: Write the modules**

`mobile/lib/calendar-feed.js`:

```js
// mobile/lib/calendar-feed.js
// ICSFEED.1 — the Schedule tab's "Subscribe to my shifts" row: what it says
// and which link it hands the OS. Pure, so it is tested here (there is no RN
// component test runner). The server builds every URL; this only chooses.
//
// Why no Linking.canOpenURL: on iOS it answers false for any scheme missing
// from LSApplicationQueriesSchemes, and on Android 11+ for anything missing
// from <queries> — both native config an OTA cannot change. openURL needs
// neither, so the row tries each link in order and falls back on a throw.

export const REPLACE_PROMPT = Object.freeze({
  title: 'Your calendar link',
  body: 'Make a new link to add your shifts on this phone? Calendars using your current link will stop updating.',
})

export const TURN_OFF_PROMPT = Object.freeze({
  title: 'Turn off your calendar link?',
  body: 'Your calendar will stop getting your shifts. You can make a new link any time.',
})

/** 'just now' | '12 min ago' | '3 h ago' | '3 days ago' | null */
export function lastSyncedLabel(iso, nowMs) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return null
  const mins = Math.round((nowMs - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

/** { title, subtitle, action: 'create' | 'manage' } for a GET /api/me/calendar-feed status. */
export function feedRowModel(status, nowMs) {
  if (status?.active !== true) {
    return { title: 'Subscribe to my shifts', subtitle: 'Add your published shifts to your calendar app.', action: 'create' }
  }
  const synced = lastSyncedLabel(status.last_fetched_at, nowMs)
  return {
    title: 'Calendar subscription on',
    subtitle: synced ? `Your calendar last checked ${synced}.` : 'Your calendar has not checked in yet.',
    action: 'manage',
  }
}

const OPENABLE = /^(webcal|https):\/\//

/** The links to try with Linking.openURL, in order. Only webcal:// and https:// ever reach the OS. */
export function subscribeOpenOrder(os, urls) {
  if (!urls) return []
  const order = os === 'ios'
    ? [urls.webcal_url]
    : os === 'android'
      ? [urls.google_url, urls.webcal_url]
      : [urls.webcal_url, urls.google_url]
  return order.filter((u) => typeof u === 'string' && OPENABLE.test(u))
}
```

`mobile/lib/calendar-feed-api.js`:

```js
// mobile/lib/calendar-feed-api.js
// ICSFEED.1 — the caller's OWN calendar link. Through api(), so the headers
// come from authHeaders() (CLAUDE.md: a hand-rolled Bearer drops
// x-impersonate-target, and the server refuses a link made while viewing as
// someone). No id parameter exists on the route, so none is sent.

import { api } from './api'

export function getMyCalendarFeed() {
  return api('/api/me/calendar-feed')
}

export function createMyCalendarFeed({ replace = false } = {}) {
  return api('/api/me/calendar-feed', { method: 'POST', body: { replace: replace === true } })
}

export function turnOffMyCalendarFeed() {
  return api('/api/me/calendar-feed', { method: 'DELETE' })
}
```

- [ ] **Step 4: Run them, expect PASS; mobile lint and imports**

Run: `npx vitest run mobile/lib/calendar-feed.test.js mobile/lib/calendar-feed-api.test.js && npm run check:mobile-lint && npm run check:mobile-imports`
Expected: `10 passed` + `4 passed`; both checks exit 0.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/calendar-feed.js mobile/lib/calendar-feed.test.js mobile/lib/calendar-feed-api.js mobile/lib/calendar-feed-api.test.js
git commit -m "ICSFEED.1 — phone: calendar row model, open order (iOS webcal, Android Google first), API wrappers

Bundle paths: publishes with the PR's OTA.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The Schedule-tab row (OTA bundle paths)

**Files:**
- Create: `mobile/components/schedule/CalendarSubscribeRow.jsx`
- Modify: `mobile/app/(staff)/(tabs)/schedule.jsx` (import after `import ManageMode from '../../../components/schedule/ManageMode'`, line 42; one line directly before `</ScrollView>`, line 746)

- [ ] **Step 1: Write the component**

```jsx
// mobile/components/schedule/CalendarSubscribeRow.jsx
// ICSFEED.1 — "Subscribe to my shifts" on the Schedule tab (Me view).
//
// No link yet → tap makes one and hands it straight to the calendar app
// (iOS: webcal:// → Apple Calendar's subscribe sheet; Android: Google
// Calendar's add-by-URL page). A link already exists → tap asks whether to make
// a new one here (the old one stops) or turn it off. If no calendar app takes
// the link, the Share sheet offers it instead, so the coach can paste it
// anywhere. Every decision lives in lib/calendar-feed.js.

import { useCallback, useState } from 'react'
import { View, Text, Pressable, Alert, Linking, Platform, Share, ActivityIndicator } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { getMyCalendarFeed, createMyCalendarFeed, turnOffMyCalendarFeed } from '../../lib/calendar-feed-api'
import { feedRowModel, subscribeOpenOrder, REPLACE_PROMPT, TURN_OFF_PROMPT } from '../../lib/calendar-feed'

export default function CalendarSubscribeRow() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await getMyCalendarFeed()
    // A failed read keeps the last good status; with none, the row offers
    // "create", and the server answers 409 if a link exists after all.
    if (r?.success) setStatus(r.data)
  }, [])

  useFocusEffect(useCallback(() => { load() }, [load]))

  async function openSubscription(urls) {
    for (const url of subscribeOpenOrder(Platform.OS, urls)) {
      try {
        await Linking.openURL(url)
        return
      } catch {
        // No app took it; try the next link.
      }
    }
    await Share.share({ message: urls.url }).catch(() => {})
  }

  async function issue(replace) {
    if (busy) return
    setBusy(true)
    try {
      const r = await createMyCalendarFeed({ replace })
      if (!r?.success) {
        if (r?.status === 409) await load()
        Alert.alert('Couldn’t make your calendar link', r?.error || 'Try again in a moment.')
        return
      }
      await openSubscription(r.data)
      await load()
    } finally {
      setBusy(false)
    }
  }

  function confirmTurnOff() {
    Alert.alert(TURN_OFF_PROMPT.title, TURN_OFF_PROMPT.body, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Turn off',
        style: 'destructive',
        onPress: async () => {
          setBusy(true)
          try {
            const r = await turnOffMyCalendarFeed()
            if (!r?.success) Alert.alert('Couldn’t turn it off', r?.error || 'Try again in a moment.')
            await load()
          } finally {
            setBusy(false)
          }
        },
      },
    ])
  }

  const model = feedRowModel(status, Date.now())

  function onPress() {
    if (model.action === 'create') {
      issue(false)
      return
    }
    Alert.alert(REPLACE_PROMPT.title, REPLACE_PROMPT.body, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: confirmTurnOff },
      { text: 'New link', onPress: () => issue(true) },
    ])
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={model.title}
      className="mt-6 flex-row items-center bg-un1t-surface border border-un1t-border rounded-2xl p-4 active:opacity-70"
    >
      <Ionicons name="calendar-outline" size={20} color="#111827" />
      <View className="flex-1 ml-3">
        <Text className="text-sm font-semibold text-un1t-text">{model.title}</Text>
        <Text className="text-xs text-un1t-subtle mt-0.5">{model.subtitle}</Text>
      </View>
      {busy ? <ActivityIndicator /> : <Ionicons name="chevron-forward" size={18} color="#94A3B8" />}
    </Pressable>
  )
}
```

- [ ] **Step 2: Mount it in the Me view**

In `mobile/app/(staff)/(tabs)/schedule.jsx`, after `import ManageMode from '../../../components/schedule/ManageMode'` add:

```js
import CalendarSubscribeRow from '../../../components/schedule/CalendarSubscribeRow'
```

and directly before the `</ScrollView>` that closes the tab's scroll view (the one followed by the `LeaveFloatingButtons` block), add:

```jsx
        {/* ICSFEED.1 — own published shifts in the coach's calendar app. Me view only, phone and iPad. */}
        {view === 'me' && <CalendarSubscribeRow />}
```

It sits inside the ScrollView's `pb-32`, so the floating leave buttons never cover it.

- [ ] **Step 3: Lint, imports, OTA paths**

Run: `npm run check:mobile-lint && npm run check:mobile-imports && npm run check:ota-paths`
Expected: all exit 0. `check:ota-paths` is clean: no new top-level entry under `mobile/` (the files are under `mobile/components/` and `mobile/lib/`, both in the `eas-update.yml` trigger at lines 154-156).

- [ ] **Step 4: Commit**

```bash
git add mobile/components/schedule/CalendarSubscribeRow.jsx 'mobile/app/(staff)/(tabs)/schedule.jsx'
git commit -m "ICSFEED.1 — phone: Subscribe to my shifts row on the Schedule tab (Me view)

Bundle paths: merging publishes an OTA at 100%.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: OpenAPI, the guardrail arm, and the roster doc

**Files:**
- Modify: `src/lib/openapi.js` (after the `DELETE /api/widget/tokens/{id}` registration, before the "Customer (champ-app member) self-service" banner, ~line 7187)
- Modify: `src/lib/openapi.test.js` (append one `it` inside `describe('getOpenApiSpec')`)
- Modify: `eslint.guardrails.config.mjs` (`no-unchecked-supabase-write` files list, after `'src/lib/waitlist-entry.js',` at line 290)
- Modify: `docs/roster-v2.md` (append)

- [ ] **Step 1: Write the failing spec test**: append inside `describe('getOpenApiSpec', …)` in `src/lib/openapi.test.js`:

```js
  // ICSFEED.1 — an anonymous token feed and the session-only management route.
  it('documents the calendar feed and its self-service management', () => {
    const feed = spec.paths['/api/calendar-feed/{file}']?.get
    expect(feed, 'missing GET /api/calendar-feed/{file}').toBeTruthy()
    expect(feed.security ?? []).toHaveLength(0)
    expect(feed.tags).toContain('Public')
    expect(Object.keys(feed.responses['200'].content)).toEqual(['text/calendar'])
    expect(Object.keys(feed.responses)).toEqual(expect.arrayContaining(['200', '404', '429', '503']))
    for (const m of ['get', 'post', 'delete']) {
      const op = spec.paths['/api/me/calendar-feed']?.[m]
      expect(op, `missing ${m.toUpperCase()} /api/me/calendar-feed`).toBeTruthy()
      expect(op.security).toContainEqual({ CookieAuth: [] })
      expect(op.tags).toContain('Me')
    }
    expect(Object.keys(spec.paths['/api/me/calendar-feed'].post.responses)).toEqual(expect.arrayContaining(['200', '403', '409']))
  })
```

Run: `npx vitest run src/lib/openapi.test.js`. Expected: this one `it` fails (`missing GET /api/calendar-feed/{file}`).

- [ ] **Step 2: Register the paths** in `src/lib/openapi.js` at the anchor above:

```js
// ============================================================================
// ICSFEED.1 — per-person calendar subscription (mig 632)
// ============================================================================
// The feed is anonymous by design (calendar apps hold no session); the rcf_
// token in the path is the credential. Management is session-only and acts on
// the caller's own link; no id parameter exists.

const CalendarFeedStatus = z.object({
  active: z.boolean(),
  created_at: z.string().nullable(),
  rotated_at: z.string().nullable(),
  last_fetched_at: z.string().nullable(),
}).openapi('CalendarFeedStatus')

const CalendarFeedLinks = z.object({
  url: z.string().openapi({ description: 'https feed URL. Shown ONCE: only its sha256 is stored (mig 632).' }),
  webcal_url: z.string().openapi({ description: 'webcal:// form: Apple Calendar and Outlook open a subscribe dialog.' }),
  google_url: z.string().openapi({ description: "Google Calendar's add-by-URL page for this feed." }),
  replaced: z.boolean(),
}).openapi('CalendarFeedLinks')

registry.registerPath({
  method: 'get',
  path: '/api/calendar-feed/{file}',
  tags: ['Public'],
  summary: "A person's own published shifts as an iCalendar feed",
  description:
    'Anonymous; `file` is `<rcf_ token>.ics` (the suffix is optional). RFC 5545, times in UTC. Contains the token holder\'s OWN published, not-cancelled shifts at every studio, Dublin today −14 to +56 days: template name · studio, the studio address, stable UIDs per assignment. No colleague, note or pay. ' +
    'One 404 for every refusal (not a token, unknown, replaced, turned off, or the person is deactivated or deleted). 429 per token (never per IP). 503 on a read failure, never an empty 200, because a subscribed calendar replaces its whole copy. Public on the CRM hosts only.',
  request: { params: z.object({ file: z.string().openapi({ description: '`<token>.ics`' }) }) },
  responses: {
    200: { description: 'iCalendar body', content: { 'text/calendar': { schema: z.string() } } },
    404: { description: 'Not found (every refusal)' },
    429: { description: 'Rate limited (per token)' },
    503: { description: 'Temporarily unavailable; Retry-After: 900' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/me/calendar-feed',
  tags: ['Me'],
  security: [{ CookieAuth: [] }, { BearerAuth: [] }],
  summary: "The caller's calendar link status",
  description: 'Never the URL: only its hash is stored, so it cannot be shown again. `last_fetched_at` is stamped at most every 15 minutes.',
  responses: {
    200: { description: 'Status', content: { 'application/json': { schema: SuccessResponse(CalendarFeedStatus) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/me/calendar-feed',
  tags: ['Me'],
  security: [{ CookieAuth: [] }, { BearerAuth: [] }],
  summary: 'Make (or replace) the caller\'s calendar link',
  description: 'Returns the links ONCE (Cache-Control: no-store). An existing link without `replace: true` is 409 `feed_exists`; `replace: true` swaps it in one statement (the old link stops at once). Refused (403) while a master is viewing as someone.',
  request: { body: { content: { 'application/json': { schema: z.object({ replace: z.boolean().optional() }).strict().openapi('CalendarFeedIssueBody') } } } },
  responses: {
    200: { description: 'The links, shown once', content: { 'application/json': { schema: SuccessResponse(CalendarFeedLinks) } } },
    400: { description: 'Validation failed', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Viewing as someone else', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'A link already exists (feed_exists)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/me/calendar-feed',
  tags: ['Me'],
  security: [{ CookieAuth: [] }, { BearerAuth: [] }],
  summary: 'Turn the caller\'s calendar link off',
  description: 'Idempotent: `revoked` says whether there was one. Refused (403) while a master is viewing as someone.',
  responses: {
    200: { description: '{ revoked }', content: { 'application/json': { schema: SuccessResponse(z.object({ revoked: z.boolean() })) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Viewing as someone else', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 3: Arm the write rule on the new IO module**: in `eslint.guardrails.config.mjs`, after `'src/lib/waitlist-entry.js',` (line 290) add:

```js
      // ICSFEED.1 — the calendar link's writes (issue, replace, revoke, the
      // last_fetched_at stamp). The stamp is best-effort by contract, which is
      // exactly the shape that reads as handled and is not. Born clean, armed
      // on arrival.
      'src/lib/staff-calendar-feed-server.js',
```

- [ ] **Step 4: Append to `docs/roster-v2.md`:**

```markdown
## Calendar subscription (ICSFEED.1, mig 632, 2026-09)

Every staff member can subscribe their calendar app to their OWN published
shifts: `/account` on web, "Subscribe to my shifts" on the phone's Schedule tab
(Me view). The feed is `GET /api/calendar-feed/<rcf_token>.ics`, anonymous by
design; only `sha256(token)` is stored (`staff_calendar_feeds`, one row per
person, service role only), so the URL is shown once and "Make a new link"
kills the old one in the same UPDATE.

Contents: own assignments, `rosters.status = 'published'`, not cancelled, every
studio, Dublin today −14 to +56 days. Effective time = override, else the
block's time; written in UTC from `locations.timezone` (no VTIMEZONE). UID =
`shift-<assignment id>@repset.ie`, so edits replace and removals disappear on
the next poll. No colleague, no assignment notes, no pay.

Deactivation: the feed answers 404 for a profile with `active = false` or
`deleted_at` set, so every deactivation path stops it with no write here;
reactivation resumes the same link. A read failure is 503, never an empty
calendar (a subscriber would lose every shift). Rate limit is per token, never
per IP. Public on the CRM hosts only (`publicExactPaths` in `src/proxy.js`).
```

- [ ] **Step 5: Run, expect PASS**

Run: `npx vitest run src/lib/openapi.test.js && npm run check:guardrails && npm run lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js eslint.guardrails.config.mjs docs/roster-v2.md
git commit -m "ICSFEED.1 — document the calendar feed (OpenAPI + roster doc) and arm the write guardrail on its IO module

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13 (conditional): BLOCKEDIT.1's coach-visible briefing note in `DESCRIPTION`

Do this ONLY if BLOCKEDIT.1 (#14) is on `main` when you reach this task. Check:

```bash
git fetch origin main && git log origin/main --oneline | grep -i "BLOCKEDIT.1" ; ls supabase/migrations | grep '^629_'
```

If both answer, read mig 629 for the exact column name of the COACH-VISIBLE briefing note (00-INDEX calls it "a separate coach-visible briefing note"; it is NOT `shift_blocks.notes`, which is a manager note). Then:
- [ ] add that column to the `shift_blocks!inner (…)` embed in `FEED_SHIFT_SELECT` (`src/lib/staff-calendar-feed-server.js`);
- [ ] in `shiftToFeedEvent`, set `description` to `` `${briefing}\n\n${FEED_EVENT_DESCRIPTION}` `` when the note is a non-blank string, else `FEED_EVENT_DESCRIPTION` (the `\n` is escaped by `escapeIcsText`);
- [ ] add a test to `src/lib/staff-calendar-feed.test.js`: a block with the note set produces `DESCRIPTION:<note>\n\nRostered shift…` in the unfolded output, and a blank note produces the fixed line only;
- [ ] if the new column's name contains `notes`, narrow the `FEED_SHIFT_SELECT` "no notes" assertion to the exact names it guards (`partial_reason`, a bare `notes` column) and say why in the test;
- [ ] run `npx vitest run src/lib/staff-calendar-feed.test.js src/lib/staff-calendar-feed-server.test.js && npm run check:select-columns`; commit `ICSFEED.1 — the coach-visible briefing note rides in DESCRIPTION (BLOCKEDIT.1)` with the `Co-Authored-By` line.

If BLOCKEDIT.1 is not on `main`, skip this task and leave Review note 9 in the PR body.

---

### PR gate

Close the dev server and any other worktree's watchers first (8GB machine). Rebase on `origin/main` (BLOCKEDIT.1 may have landed) and re-run the focused suites before the full gate.

- [ ] **The 12-command CI mirror (CLAUDE.md "Build, test & ship"):**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every command exits 0 and vitest reports `0 failed`.
- `check:route-guards` passes because of the new `EXEMPT` entry, and fails if that entry's file moves (stale-exemption check).
- `check:select-columns` proves every column in `FEED_SHIFT_SELECT`, the `locations` read and the `staff_calendar_feeds` reads resolves against the migrations (632 included). `mobile/**` is outside its scan and names no column.
- `check:mobile-parity` is untouched (no permission key, D11).
- `check:ota-paths` is clean (no new top-level `mobile/` entry).

- [ ] **The build:**

```bash
npm run build
```

Expected: `✓ Compiled successfully`, and the route table lists `ƒ /api/calendar-feed/[file]` and `ƒ /api/me/calendar-feed`. This is the only check that catches a bad `@/lib/…` import (vitest runs on mocked imports).

- [ ] **Independent review** (standing rule). Point the reviewer at: D1–D12; the "public-path allowlists" finding and `src/calendar-feed-path.test.js` (the deliberate deviation from "all four"); D7 (503 never an empty 200); D5 (no deactivation writer); the `FEED_SHIFT_SELECT` column list (nothing about anyone else, no notes, no pay).

- [ ] **Validate a real feed** once 632 is applied and the preview is up: make a link on the preview's `/account`, fetch it with `curl -s <url> | head -40`, and paste the body into an RFC 5545 validator (e.g. icalendar.org's). Then subscribe on a real iPhone (webcal) and in Google Calendar (the google link) to one coach's feed. Record what each client showed in the PR (memory `jsdom-cannot-see-layout`: a green suite is not a working subscription).

---

### Migration apply steps (after review is approved, BEFORE merge)

The operator is the orchestrating session, under Richard's 25 Sep merge authority.

1. `list_projects` → confirm `iyvtbjjxdggiadzwwvdj` is **un1t-crm**, not the sentinel project. `list_migrations` → confirm there is no 632.
2. Run pre-checks **(a)–(c)** from the migration header with `execute_sql`. Stop if any answer differs from "Expected".
3. Write the rollback record to the scratchpad (e.g. `<scratchpad>/mig-632-rollback.md`): the output of (c) and the ROLLBACK block from the header, noting "revert code first".
4. `apply_migration` with name `632_staff_calendar_feeds` and the file's contents verbatim.
5. Run post-checks **(e)–(i)**. Then `get_advisors` type `security`, then type `performance`. Expected: only the INFO `rls_enabled_no_policy` on `staff_calendar_feeds` (the same one `widget_tokens` carries, by design).
6. Only now: rebase, wait for **Test & lint** and **Next build** to go green on the final rebase, and merge.
7. After merge, watch the EAS Update run for the OTA (`eas-update.yml`). One phone update at a time: do not merge the next OTA PR until this run is green (standing rule). Then on prod: open `/account`, make a link, `curl` it (expect 200 `text/calendar`), make a new link, `curl` the OLD URL (expect 404), turn it off.

### PR

**Title:** `ICSFEED.1 — coaches subscribe to their own published shifts in Apple, Google or Outlook Calendar (mig 632, OTA)`

**Body must say, in this order:**
1. **Migration 632 is applied BEFORE merge** (steps above). Until it is, the feed answers 503 and `/api/me/calendar-feed` 500, and the Vercel preview is broken.
2. **🔴 This merge publishes an OTA at 100%.** Bundle paths: `mobile/lib/calendar-feed.js`, `mobile/lib/calendar-feed-api.js` (+ their tests, accepted no-op over-triggers), `mobile/components/schedule/CalendarSubscribeRow.jsx`, `mobile/app/(staff)/(tabs)/schedule.jsx`. The phone change is one row in the Schedule tab's Me view. Older phones have no row; nothing else changes.
3. What a coach gets (00-INDEX default 5): own published shifts, every studio, two weeks back and eight ahead, template · studio, the studio address; no colleague, no note, no pay. Works in Apple, Google and Outlook; Google polls on its own schedule (hours).
4. The link: `rcf_` token, only its sha256 stored (the mig 607 widget model), shown once; a new link kills the old one; turn off; refused while viewing as someone.
5. **Deactivation (D5):** the feed refuses an inactive or deleted profile, covering every deactivation path with no writer; reactivation resumes the same link.
6. **Public paths, a deliberate deviation from 00-INDEX's "all four allowlists":** proxy `publicExactPaths` only. AppShell is for pages; brands and tenant-domains are left out on purpose because the URL is always on the CRM host; `src/calendar-feed-path.test.js` pins both directions. `check:route-guards` EXEMPT with reason.
7. D7: a read failure is 503, never an empty calendar. D8: per-token rate limit, never per IP.
8. What the device check showed (iPhone webcal, Google add-by-URL) and the validator result.
9. Privacy: shift times, template names and studio names/addresses leave the building into the coach's calendar provider (Apple, Google, Microsoft), at the coach's own choice.
10. BLOCKEDIT.1 status (Task 13 done or skipped).
11. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### CHANGELOG

After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md`, then commit and push. Never edit another row: `merge=union` duplicates an edited row.

```
| #<PR> | ICSFEED.1 — coaches subscribe to their own published shifts in Apple, Google or Outlook Calendar | 2026-09-2x. **Mig 632 (applied before merge) + OTA.** `staff_calendar_feeds` (profile_id PK → profiles ON DELETE CASCADE, token_hash sha256 UNIQUE + CHECK hex, created/rotated/last_fetched), RLS on with no policies, browser grants revoked (PGlite replay proves the REVOKE removes Supabase's defaults). Anonymous `GET /api/calendar-feed/<rcf_token>.ics`: own published not-cancelled shifts, every studio, Dublin today −14..+56, UTC times from `locations.timezone` via `tz-time.js` (no VTIMEZONE; 2026 DST pinned; `24:00` = next midnight), UID `shift-<assignment>@repset.ie`, no colleague/notes/pay; one 404 for every refusal incl. an inactive or deleted profile (the deactivation lock, no writer); 503 never an empty 200; per-token limit 30/15 min, never per IP; `private, max-age=900`. `/api/me/calendar-feed` GET status / POST (URL shown once, 409 `feed_exists`, `replace:true` = one UPDATE) / DELETE; refused while viewing as someone. Proxy `publicExactPaths` only (brands/tenant deliberately not; `src/calendar-feed-path.test.js`), route-guards EXEMPT. New `src/lib/ics.js` (CRLF, 75-octet UTF-8-safe folds, TEXT escaping). Web card on /account; phone "Subscribe to my shifts" row (iOS webcal, Android Google add-by-URL, Share fallback). |
```

---

### Review notes / open questions

1. **The URL is shown once (D1).** A coach who deletes the subscription and wants it back, or wants it in a second calendar account, makes a new link, which kills the first. The alternative (a stateless HMAC link that can be shown again) cannot revoke one person's link without a counter column and dies wholesale on a secret rotation. Richard may prefer re-showable; it is a contained change to `calendar-feed-token.js` + the table.
2. **Deactivation suspends, it does not delete (D5).** Reactivating a coach resumes their old subscription with no action from them. If Richard wants a rehired coach to re-subscribe, the deactivation paths (`PUT`/`DELETE /api/staff/[id]`) would need a DELETE on `staff_calendar_feeds`; that is the "every writer must remember" shape this plan avoided.
3. **A tombstone keeps an inert row** (a hash and three timestamps, no PII; the profile can never be active again, mig 622 CHECK). Adding `staff_calendar_feeds` to `tombstone_staff_profile` step 7 is a `CREATE OR REPLACE` of a security-critical function for an already-dead link; left as a follow-up if Richard wants the rows gone.
4. **Not served on brand or tenant hosts** (deliberate, against the 00-INDEX one-liner "all four public-path allowlists"). If a future tenant wants feed URLs on its own domain, add `'/api/calendar-feed/'` to that tier and flip the pinned test.
5. **Google Calendar's polling** is Google's choice (commonly several hours to a day); `REFRESH-INTERVAL` is a hint Apple and Outlook honour and Google ignores. A coach who needs a same-hour change still gets the push notification (published changes already notify, SCHEDULE-CHANGE-LOG.1).
6. **No manager-side "revoke this coach's link".** A lost phone is handled by the coach making a new link; a leaver by deactivation. A manager control would need a staff_management-gated route; not built.
7. **Shifts at a studio the coach has left** still appear if they are still rostered there (own assignments are read wherever they are). That is correct while the assignment exists; `bulkUpsertShiftAssignments` already refuses new ones (`skipped_not_at_studio`).
8. **Calendar name** is the constant `Rostered shifts` (staff-facing; every client lets the coach rename it). If Richard wants the organisation's name there, it is one read of `organizations.name` via the coach's locations.
9. **BLOCKEDIT.1's briefing note** rides in `DESCRIPTION` only if #14 merged first (Task 13). If it merges after, a one-line follow-up adds it.
10. **Arrival stamps** (ARRIVALSHOW.1, #34) are not in the feed; a calendar event is the plan, not the record.
11. **`X-WR-TIMEZONE` is deliberately absent.** With UTC times it changes nothing in Apple or Google and has been seen to make some clients reinterpret times; leaving it out is the conservative choice.
12. **Device verification is owed** (iPhone webcal subscribe sheet; Android via the Google link; Outlook via the https link). jsdom and vitest cannot prove a calendar app accepts the feed.
