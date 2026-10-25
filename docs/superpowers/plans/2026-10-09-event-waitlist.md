# Event waitlist (EVENT-WAITLIST.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an event is sold out, people can join a waitlist; when a spot frees, everyone waiting is told at once and the first to complete a booking gets it. Staff and hosts can see the list and trigger an offer round.

**Architecture:** One table, `event_waitlist`, per event (not per time). A public join form on the sold-out event page writes it. A cron (`event-waitlist-offers`, every 10 min) finds upcoming events with waiting people and room in at least one time, and sends an offer (email, plus WhatsApp when a phone and an approved template exist) to everyone who has not been offered in the last 24 h, with a claim link to the event's normal signup page. The register route is the arbiter: first to pay (or to confirm a free entry) wins, and a waitlist token on that signup marks the row claimed. Staff (teams page) and hosts (event page) see the list, remove people, and can run an offer round now.

**Tech Stack:** Postgres (mig 713 + a `cron_heartbeats` row), a cron route (Bearer `CRON_SECRET`, `stampHeartbeat`), public routes with rate limits, Postmark + the WhatsApp template helper, React (public widget, staff and host lists), vitest.

**Worktree:** `~/code/un1t-crm-evmove9`, branch `event-waitlist`, off `origin/main` after EVENT-MOVE.6 merged.

**Decisions fixed (Richard, 9 Oct):** per EVENT; offer EVERYONE at once; first to pay wins. Mine, to keep it small: one offer per person per 24 h at most; offers go by email always (administrative consent, unrecoverable) and by WhatsApp only when the location has an APPROVED template named `event_waitlist_offer` (Richard creates it in Meta; until then email only); the list expires when the event date passes; no Mia tool in this PR; no per-time preference stored.

**Facts to verify by reading:** sold-out logic `src/app/api/public/events/[slug]/route.js` (`registration_state`, `is_full` per wave, confirmed-only counting) and `src/lib/event-signups.js` (`wouldFit`, `spotsLeft`); the public register route (`findOrCreateRaceContact`, `applyFormMarketingConsent`, rate limits, the 409 `wave_full`); `RaceSignupWidget.jsx` closed/full rendering (`KIND_COPY`, pill, `<fieldset disabled>`); WhatsApp send pattern `src/lib/automations/booking-whatsapp-confirm.js` + `transactionalWhatsappSuppression` (`src/lib/transactional-consent.js:142`, select `wa_status, whatsapp_administrative` yourself); email `sendTransactionalEmail` + `checkTransactionalConsent`; a cron example with heartbeat (`src/app/api/cron/event-reminders/route.js`, `vercel.json`, `cron_heartbeats` row in a migration, `stampHeartbeat`); the teams page (`RaceTeamsManager.jsx`) and host page (`HostAttendeeTable.jsx`, `src/app/host/(portal)/events/[id]/page.js`) for where the list goes; the staff/host route gates (`/api/events/[id]/teams`, `src/lib/host-move-session.js` for the host pattern); public-path allowlists are NOT needed (the form lives on the existing `/event/[slug]` page); operator-editable copy pattern (`moved_email_*`, `resolveEventEmail({ kind })`).

---

### Task 1: Migration 713
`supabase/migrations/713_event_waitlist.sql`:
```sql
create table if not exists public.event_waitlist (
  id              uuid primary key default gen_random_uuid(),
  race_event_id   uuid not null references public.race_events(id) on delete cascade,
  location_id     uuid not null references public.locations(id) on delete cascade,
  contact_id      uuid references public.contacts(id) on delete set null,
  name            text not null,
  email           text not null,
  phone           text,
  headcount       int not null default 1 check (headcount between 1 and 50),
  status          text not null default 'waiting' check (status in ('waiting','offered','claimed','expired','removed')),
  source          text not null default 'public' check (source in ('public','staff','host','agent')),
  marketing_consent boolean,
  last_offered_at timestamptz,
  offer_count     int not null default 0,
  claimed_registration_id uuid references public.race_registrations(id) on delete set null,
  removed_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (race_event_id, email)
);
```
Indexes on `(race_event_id, status)` and `(status, last_offered_at)`. RLS on, `revoke all … from anon, authenticated`. `updated_at` trigger if the repo has a shared one (grep `set_updated_at`). Two copy columns on `race_events`: `waitlist_email_subject`, `waitlist_email_intro`. A `cron_heartbeats` row for `event-waitlist-offers` (read how mig 406/623 insert one; interval 10 min, grace sized so one missed tick never pages). Comments. Guard tests + commit `EVENT-WAITLIST.1 — mig 713: event_waitlist, offer copy, cron heartbeat`.

### Task 2: Lib
`src/lib/event-waitlist.js` (pure where possible, tested):
- `eventHasRoom(event)` using the public route's arithmetic (any wave with room for 1 in the event's capacity mode; confirmed-only, same as `is_full`).
- `joinWaitlist(db, { race, name, email, phone, headcount, consent, ip, source })`: `findOrCreateRaceContact` (mirror the register route's flags), upsert on `(race_event_id, email)` (re-joining a removed/expired row resets it to waiting), `applyFormMarketingConsent` when consent given, returns the row. Sends a "you're on the list" email (fixed short copy through the shell; subject "You're on the waitlist for {{event_name}}").
- `signWaitlistClaimToken({ waitlistId }, secret)` / verify, 14-day TTL, in `src/lib/event-waitlist-tokens.js`.
- `runWaitlistOffers(db, { now })`: for each published, active, upcoming event with rows in `('waiting','offered')` and `eventHasRoom` true: pick rows with `last_offered_at` null or older than 24 h; for each, send the offer email (`resolveEventEmail({ kind: 'waitlist' })`, defaults: subject "A spot opened up for {{event_name}}", intro "A place has come free. It goes to the first person to book: {{claim_url}}. If it's gone by the time you look, you stay on the list."), consent-gated; WhatsApp via the template helper when `phone` and an APPROVED `event_waitlist_offer` template exist at `race.location_id` (body params: name, event name, claim URL) and `transactionalWhatsappSuppression` allows; set `status='offered'`, `last_offered_at`, `offer_count+1`. Expire rows whose event date has passed. Returns counts `{ events, offered, expired, skipped }`. Range-paginate; never let one send failure stop the round (log, continue).
- `claimWaitlistOnRegistration(db, { token, registrationId })`: verifies the token, marks the row `claimed` with the registration id (CAS on status in waiting/offered). Called by the register route when the body carries `waitlist_token` (route change in Task 3).
Commit `EVENT-WAITLIST.1 — lib: join, offers round, claim`.

### Task 3: Routes
- `POST /api/public/events/[slug]/waitlist` `{ name, email, phone?, headcount?, consent? }`: rate limit `waitlist:${slug}:${ip}` 5/15min; event must be published+active+public and NOT have room (else 409 `has_room` with message "Spots are available, book directly"); `joinWaitlist`; `{ success, data: { id } }`.
- Register route: accept optional `waitlist_token`; after a successful registration (free confirmed, or paid pending), call `claimWaitlistOnRegistration` (best effort, logged). Note in the route header.
- `GET /api/cron/event-waitlist-offers` (Bearer `CRON_SECRET`): `runWaitlistOffers`, `stampHeartbeat('event-waitlist-offers')` on success; `vercel.json` schedule `*/10 * * * *`.
- Staff: `GET /api/events/[id]/waitlist` (list, `races` + manager at the event studio), `DELETE /api/events/[id]/waitlist/[rowId]` (status removed, `removed_by_name`), `POST /api/events/[id]/waitlist/offer` (run the round for this event now, ignoring the 24 h rule for rows never offered; respecting it otherwise). Host: `GET /api/host/events/[id]/waitlist`, `POST …/offer` (own event, `getCurrentHost`), no delete.
- OpenAPI entries; `check:route-guards` (cron secret recognised; public route exempt with reason).
Commit `EVENT-WAITLIST.1 — public join, claim on register, cron, staff + host routes`.

### Task 4: UI
- `RaceSignupWidget.jsx`: when `registration_state === 'full'` (and only then) render `EventWaitlistForm` below the closed banner: name, email, phone, team size (from `allowed_team_sizes`), consent checkbox worded like the register form, "Join the waitlist" → success copy "You're on the list. If a spot opens, we'll email you (and WhatsApp if you gave a number); the first to book gets it." Never show how many are waiting. When the page is opened with `?wl=<token>`, keep the token in the form's state and send it as `waitlist_token` on register; the banner says "A spot opened up. Book now; first come, first served."
- Teams page: a "Waitlist" section under the entries (count in the heading is fine for staff): rows name, email, phone, size, joined, last offered, status; Remove; "Offer now" button (confirm). Tests.
- Host page: same list read-only + "Offer now". Tests.
- Event form Emails section: "Waitlist offer" `EventEmailFields` (`showTemplate={false}`, tags `{{claim_url}}`), create + edit schemas/selects.
Commit `EVENT-WAITLIST.1 — public form, staff and host lists, offer copy`.

### Task 5: Spec, gate, PR
New spec `docs/superpowers/specs/2026-10-09-event-waitlist-design.md` (short: decisions, table, offer round, claim, surfaces, non-goals: per-time waitlists, Mia tool, guaranteed holds). Full CI mirror + build; PR leading with "🔴 Apply mig 713 before merging (cron heartbeat row: re-run the insert if the deploy is slow)"; changelog; memory note incl. the WhatsApp template Richard must create (`event_waitlist_offer`, body params name / event / link) for the WA leg to switch on.
