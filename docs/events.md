# Events (race + workshop + seminar + open_day + masterclass)

> Reference doc extracted from CLAUDE.md on 2026-06-01. Multi-kind events on the race_events table (mig 081/082/122).

Was titled "Teams + race events" until the events expansion (mig 122 + commits 728bced…f22a360). Same `race_events` table on disk; the table now holds any kind of standalone event via the `kind` discriminator column. URL space is `/events/*` operator and `/event/[slug]` public; the legacy `/races/*` and `/race/[slug]` URLs forever-rewrite to the new paths so externally shared signup links keep working.

Three migrations form the current architecture:
- **Mig 081** introduced `teams` + `team_members` (kept) and shoehorned race tracking into the booking flow (`event_types.is_timed_event`, `bookings.race_started_at`, etc — all DEPRECATED in mig 082, see below).
- **Mig 082** unmerged race events into a standalone first-class entity. Race events got their own table, URL space, and signup widget — independent of the Calendly-style booking flow.
- **Mig 122** added the `kind` discriminator to `race_events`, turning it into a multi-kind events table. App-level UI gates on `kind` to show / hide race-specific bits (waves, race-day control panel, TV display); the underlying data shape (waves[], team_members per-seat capture, race_payments, member/non-member pricing) is uniform across kinds.

The deprecated mig 081 columns stay on disk per the codebase convention. The table is intentionally NOT renamed `events` — see the architectural decision in the events-expansion commits: a rename would cascade through every FK / RLS policy / sequence-step source_type reference, which isn't worth the churn.

### Kind capability matrix

| Capability                          | race | workshop / seminar / open_day / masterclass |
|-------------------------------------|------|---------------------------------------------|
| Per-seat name + email capture       | ✅   | ✅ (every seat — solo, +1 friend, group)    |
| Member vs non-member pricing (mig 084) | ✅   | ✅ (same code path)                         |
| Revolut Race payment pipeline        | ✅   | ✅ (same code path)                         |
| Single time slot                    | n/a  | ✅ (auto-becomes one synthetic wave)        |
| Multiple waves with capacity         | ✅   | ❌                                          |
| Team name required                   | ✅   | ❌ (synthesised from captain on submit)     |
| Race-day control panel + start/finish/reset timing | ✅ | ❌ (page redirects, API 4xx) |
| Race-timing cron (race.starts_in_24h etc) | ✅ | ❌ (cron filtered to kind='race') |
| TV display board                     | ✅   | ❌ (API 404s, no operator link)             |

Adding a new kind: one CHECK-constraint value in mig 122 + one entry in `KINDS` (RaceEventForm) + one entry in `KIND_COPY` (RaceSignupWidget) + one entry in `KIND_BADGE` (events index page).

### Schema (current)

- **`teams`** (mig 081, kept) — per-location, persistent across events. UNIQUE `(location_id, name)` so a returning team booking with the same name auto-links to the same row. Carries `size`, `captain_contact_id`, `notes`. The persistence is the point — leaderboards / "best time across N events" need the team_id link. For non-race kinds, the team row exists but is essentially a registration grouping (synthesised name on signup); the FK is satisfied without changing the registration storage path.
- **`team_members`** (mig 081, kept) — captain row has `contact_id` set; non-captain members have name+email captured via the signup form with `contact_id = NULL`. Per-seat capture for ALL kinds.
- **`race_events`** (mig 082, multi-kind from mig 122) — one row per event occurrence. Per-location. UNIQUE `(location_id, slug)`. Carries `name, slug, race_date, start_time, registration_opens_at, registration_closes_at, capacity, allowed_team_sizes (INT[]), description, active, kind`. No relation to `event_types` — completely standalone.
- **`race_registrations`** (mig 082, extended in 083) — one row per (race_event, team) with UNIQUE constraint preventing double-registration. Carries `status, race_started_at, race_finished_at, registered_at`. **`wave_id`** added in mig 083 — FK to race_waves, nullable at the schema level so race-event delete can cascade-set-null but required by app code at signup time. For non-race kinds, `race_started_at` / `race_finished_at` stay NULL forever (the API gates on kind='race' so they're never written).
- **`race_waves`** (mig 083) — one row per start-time slot in a race. Carries `start_time, capacity, label, display_order`. UNIQUE `(race_event_id, start_time)` so two waves can't share a start time. For non-race kinds, exactly one wave is auto-created on submit from the form's "Start time" + "Capacity" inputs (the wave is essentially the event's time slot).

### Operator UI

- **`/events`** — index of events at the active location. Sidebar entry "Events" gated on the `races` permission key (kept internally — gates UI for the entire multi-kind feature; renaming the key would cascade to every per-role default + every location's saved overrides). Each row shows a kind pill (race=emerald, workshop=sky, seminar=indigo, open_day=amber, masterclass=pink) so kinds visually distinguish at a glance. Race-only "Race day" link is hidden for non-race kinds; "Teams" → "Attendees" for non-race kinds.
- **`/events/new`** + **`/events/[id]/edit`** — `<RaceEventForm>` (filename keeps the Race prefix — file path matches import sites; only operator-facing UI says "Event"). Kind picker at the top (5 cards: race, workshop, seminar, open_day, masterclass). Race kind shows the original waves UI + TV display logos section; non-race kinds show a single "Start time" + "Capacity" input pair and hide TV logos. Group-size selector relabels "n-person" → "n-seat" for non-race kinds. The `KINDS` metadata table at the top of the file drives all per-kind labels + flags (`showWaves`, `showLogos`).
- **`/events/[id]/control`** — race-day operator UI. Race-only — page redirects to `/events/[id]/edit` if `kind != 'race'`. `<RaceControlPanel>` polls `/api/events/[id]/control-board` every 2s. Three sections: On Course (sorted longest-on-course first, the most-likely-next-finisher heuristic), Next Up (registration order), Completed (fastest first leaderboard view). Live elapsed timer ticks at 500ms.

### Public signup

- **`/event/[slug]`** — standalone public signup page (operator and shared externally). `<RaceSignupWidget>` is kind-aware (filename keeps the Race prefix for the same reason as RaceEventForm). For race kind: original team-first signup (team name + size radio + wave picker + N-1 member name+email pairs + captain contact details). For non-race kinds: hide team name + wave picker (single auto-selected wave); "Team size" → "How many seats?" / "How many spots?"; per-seat capture still renders for N>1. The `KIND_COPY` map at the top of the file holds every kind-keyed string. Validates the registration window state (`not_yet_open` / `open` / `closed` / `full`) from the public events API. Confirmation card after success.

**Public/operator capacity split.** The public events API (`/api/public/events/[slug]`) deliberately strips raw capacity numbers from its response — neither event-level capacity nor per-wave `remaining_capacity` are ever exposed to public callers. Each wave object only carries `is_full: boolean`. The widget renders "Full" next to a wave card when `is_full`, nothing otherwise (clickability implies availability). Operator surfaces (`/events` index showing "X / Y signups", `<RaceEventForm>` with numeric capacity inputs) go through the auth-gated `/api/events` endpoints which DO return raw capacity. Customers see "is this slot bookable" — operators see the actual numbers.

### API surface

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/events` | GET | manager+ | List events at location(s) |
| `/api/events` | POST | manager+ | Create event (CreateSchema accepts `kind`, default 'race') |
| `/api/events/[id]` | GET | manager+ | Read one event + registrations |
| `/api/events/[id]` | PUT | manager+ | Update event fields (kind NOT accepted on update — locked after creation to prevent orphaning data) |
| `/api/events/[id]` | DELETE | manager+ | Soft-delete (active=false) |
| `/api/events/[id]/control-board` | GET | manager+ | Race-day polling endpoint (404 if `kind != 'race'`) |
| `/api/registrations/[id]/race-start` | POST | manager+ | Stamp `race_started_at = NOW()` (409 if `kind != 'race'`) |
| `/api/registrations/[id]/race-finish` | POST | manager+ | Stamp `race_finished_at = NOW()` (409 if `kind != 'race'`) |
| `/api/registrations/[id]/race-reset` | POST | manager+ | Clear both timestamps (409 if `kind != 'race'`) |
| `/api/public/events/[slug]` | GET | public | Event details + capacity state (returns `kind` so widget renders correctly) |
| `/api/public/events/[slug]/register` | POST | public, rate-limited | Signup (kind-agnostic) |
| `/api/public/events/[slug]/display` | GET | public | TV display board data (404 if `kind != 'race'`) |

Legacy `/api/races/*`, `/api/public/races/*`, `/race/[slug]`, `/race-pay/[paymentId]` and `/races` URLs are alive forever via Next.js rewrites in `next.config.js`. Operator emails / shared QR codes / calendar invites that pre-date the events expansion keep working.

Race-only routes deliberately NOT renamed: `/api/cron/race-timing-events` (Vercel cron config + race-specific by definition), `/api/registrations/[id]/race-{start,finish,reset}` (race-day timing — gates internally on kind), `/api/webhooks/revolut/race-payments` (Revolut's webhook URL is configured against this exact path, renaming = friction without benefit).

### Public-signup flow internals

`POST /api/public/events/[slug]/register` does, in order: validate body shape, check event active + registration window + capacity, find-or-create the captain contact by `(location_id, lower(email))`, find-or-create the team by `(location_id, name)` updating size/captain on conflict, refresh `team_members` (clear + re-insert captain + N−1 others), insert the `race_registration`. UNIQUE `(race_event_id, team_id)` surfaces double-registration as a clean 409 with `code: 'already_registered'`. Capacity is soft-enforced (count vs configured) — concurrent signups could in theory both squeeze in over the cap; acceptable for v1.

For non-race kinds, the widget client-side synthesises a `team_name` from the captain (e.g., `"Richard"` for solo or `"Richard (+3)"` for a group buy) before POSTing — the server is indifferent. team_name is stored as-is so the operator's "teams" tab on the event detail page shows something meaningful.

### Race members + per-head pricing (mig 084)

Per-head pricing for races, with live UN1T-member validation and a brand-new payment table that stays separate from the cars deposit flow.

- **Schema** — `race_events` gets `member_pricing_enabled BOOLEAN`, `member_fee_cents INT NULL`, `non_member_fee_cents INT NULL`, `members_only BOOLEAN`, `payment_currency TEXT DEFAULT 'EUR'`. `team_members` gets `is_member`, `member_validation_status` (`not_applicable`/`pending`/`verified`/`failed`), `member_contact_id`, `member_validated_at`. `race_registrations` gets `team_composition` (`all_members`/`mixed`/`all_non_members`) plus `active_payment_id` and a `pending_payment` status state.
- **`race_payments`** — NEW standalone table. Carries `race_event_id`, `race_registration_id`, captain contact details, `amount_cents`, `currency`, per-team breakdown columns (`member_count`, `non_member_count`, `member_fee_cents`, `non_member_fee_cents`), lifecycle status (`pending`/`completed`/`failed`/`abandoned`/`refunded`), `payment_provider` (default `revolut`), `payment_provider_ref` (Revolut order id), `payment_checkout_token`, all the `*_at` timestamps including `confirmation_email_sent_at` + `confirmation_sms_sent_at` (idempotency stamps), and a `metadata` JSONB for future analytics. **Deliberately separate from `cars.deposit_*`** — UN1T (gym + races) and CCF Autos (cars) are different businesses. Phase 2 will generalise this into a polymorphic `orders` table; the column shape was chosen to make that future migration a renamed-table operation.
- **Pricing model** — per-head. A 4-person team with 2 verified members + 2 non-members pays `2 × member_fee + 2 × non_member_fee`. `null` fees mean free entry for that category. `members_only=true` blocks any team containing an unverified member at signup time (server-side gate; client-side UX hint).
- **Member match key** — email only. The signup form shows a prominent amber notice telling members to use the email on their UN1T account. Match is `(location_id, lower(email))` against `contacts` where `pipeline_stage_slug = 'active_member'` (CLASSIFY.2 — was `lead_status = 'member'`). Same response shape regardless of whether the email is unknown or known-but-not-a-member, so the public endpoint can't be used to enumerate contacts.
- **Lib helpers** — `src/lib/member-validation.js` exports `validateMemberByEmail`, `validateTeamRoster`, and pure `computeTeamPricing` (heavily unit-tested — pricing is what operators trust to bill correctly). `src/lib/race-payments.js` owns `createRacePayment` (free entry skips Revolut entirely; paid entry creates the order using `registration.id` as the idempotency key), `markRacePaymentStatus` (idempotent webhook-driven state changes), and `refreshRacePaymentFromProvider` (live-refresh on the public status read so the front-end gets the answer even if the webhook is slow). `src/lib/race-confirmations.js` is UN1T-branded email + SMS, deliberately not sharing copy or templates with `booking-confirmations.js` or `deposit-receipts.js`.
- **Webhook split** — `/api/webhooks/revolut/race-payments` is a SECOND webhook URL configured in the Revolut dashboard. Verifies its own signature (shares `REVOLUT_WEBHOOK_SECRET` with cars in v1; can split later via `REVOLUT_RACE_WEBHOOK_SECRET`). The cars handler at `/api/webhooks/revolut` doesn't change — it stays cars-only and returns `{skipped: 'unknown_order'}` if a misrouted race webhook hits it.
- **Public flow** — captain fills the form → `/api/public/races/[slug]/register` validates the roster, computes pricing, creates the registration in `pending_payment`, calls `createRacePayment`, returns `{ payment: { id, free, token, url } }`. Free → push to `/race/[slug]/confirmed`. Paid → push to `/race-pay/[paymentId]` which mounts Revolut Embedded Checkout against the existing order token. On success → `/race/[slug]/confirmed?registration=...` polls the registration until the webhook flips it to `confirmed` (~2s in practice).
- **Revolut SDK separation** — the generic `src/lib/revolut.js` HTTP client is the only shared piece (it's pure transport). The cars deposit page and the new `RaceCheckoutPage.jsx` each own their own SDK lifecycle — no shared component.
- **Email lookup is a high-volume keystroke endpoint** — `/api/public/races/[slug]/check-member` is rate-limited at 60/min/IP and short-circuits when the race has no member-relevant config (no `member_pricing_enabled` AND no `members_only`).

### What's deferred to Phase 2 / v3

- **Orders tab + events/tags for retargeting.** Generic `orders` table that rolls up race_payments + cars deposits + future memberships, with retry-detection (failed/abandoned → completed within N days = "recovered"). `contact_events` log + `contact_tags` for time-based retargeting (race.starts_in_24h, race.completed_24h_ago, etc). Detailed plan in the deployment outline thread.
- **Cross-location member match.** v1 scopes member lookup to the race's location only — a Cork member registering for a Dublin race won't auto-verify even if both gyms are in the same org.
- **Refunds for cancelled registrations** — `refundOrder()` exists in `src/lib/revolut.js`; needs a wired-up operator UI + state transition.
- Email customer their result — straightforward Postmark template once race_registration timing exists; iterate `team_members[*].email` for recipients.
- Public leaderboard / results page (`/race/[slug]/results`).
- Hard capacity enforcement via UNIQUE constraint or trigger (current is soft).
- Returning-team badge in the race-day UI ("3rd time at this event").
- Realtime sync via Supabase Realtime instead of 2s polling.
- Auto-promoting non-captain members to standalone CRM contacts.

### Architectural note: why the unmerge

Mig 081 tried to layer race tracking on top of event_types/bookings via an `is_timed_event` flag + extra columns. The booking widget rendered team fields conditionally, slot generation produced calendar slots that don't match a "race runs once on Saturday" reality, and `max_advance_days` accidentally hid race signup pages until ~3 days before the event. The clunkiness was structural — a Calendly-style "pick a slot from recurring availability" abstraction is the wrong shape for "register your team for the event next month, capacity 12." Mig 082 separates the two concerns into independent tables and URL spaces; the booking flow goes back to being clean, races get to be themselves.

