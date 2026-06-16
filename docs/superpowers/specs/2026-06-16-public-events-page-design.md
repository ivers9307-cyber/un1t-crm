# Public Events Page — Design

**Status:** approved in design dialogue 2026-06-16. Goes to `writing-plans` next.

**Goal:** A public, customer-facing **events listing** at `/[location]/events` (e.g. `un1tdublin.com/stillorgan/events`), styled like the un1tdublin.com marketing site, where customers browse a studio's **upcoming events and click through to book**. The per-event booking flow already exists and is reused unchanged.

**Locked decisions (design dialogue):**
1. **Placement:** under the marketing layer — canonical page `src/app/welcome/[location]/events/page.js`, pretty path `/[location]/events` (mirrors how `/stillorgan` → `/welcome/stillorgan`). Reuses the `/welcome` layout (Poppins, black theme, public/no-AppShell chrome) + `SiteHeader`/`SiteFooter` + `lp-*` reveal classes.
2. **Booking:** **reuse the existing `/event/[slug]` flow as-is** — this page is listing-only; each card links to the working booking widget (free + paid via Revolut + member pricing + waves, all done). No change to the booking flow or its API.

---

## Context (verified by recon)
- **Events = `race_events`** (multi-kind: `race` / `workshop` / `seminar` / `open_day` / `masterclass`), per-location, slug-keyed. Public/upcoming = `active = true` AND `race_date >= today` (Dublin, via `todayIsoDublin()`). Pricing fields: `member_pricing_enabled`, `member_fee_cents`, `non_member_fee_cents` (NULL non_member fee = free for all). Registration window: `registration_opens_at` / `registration_closes_at`. Capacity is per-wave (`race_waves.capacity`) and **never exposed raw to the public**.
- **Per-event booking EXISTS:** `/event/[slug]` (`RaceSignupWidget`) + `/api/public/events/[slug]` (+ `/register`, `/check-member`) + `/event-pay/[id]` + `/event/[slug]/confirmed`. Untouched by this work.
- **Marketing styling EXISTS:** `/welcome/[location]` landing pages — Poppins-only, black bg + white text, `lp-*` scroll-reveal (`lp-reveal`/`lp-d1..3`/`lp-btn`), `SiteHeader`/`SiteFooter`/`RevealManager` in `src/components/landing-page/`, `/welcome` layout sets the font + public chrome. Pretty paths via `next.config.js` rewrites; `/welcome` + the pretty slugs are in the `proxy.js` publicPaths + AppShell `PUBLIC_PATHS` (so no auth, no CRM sidebar).
- **Shared helpers:** `shared/events.js` — `eventKindLabel(kind)`, `eventKindTone(kind)`, `orderEventsForBrowse(events)`, `todayIsoDublin()`.
- **No public listing exists today** — only per-event pages reachable by a shared link. This page fills that gap.

## Architecture

**Server-rendered page, no new API.** The page is public + read-only, so it queries `race_events` directly server-side (`createServerClient`) and renders — no client-fetched endpoint needed (the booking widget keeps its own `/api/public/events/[slug]`). Because it's service-role, the SELECT is **explicitly limited to public-safe columns + public rows** (active + upcoming + this location).

**`src/app/welcome/[location]/events/page.js`** (server component):
1. Resolve the location from the `[location]` slug using the **same resolver the existing `/welcome/[location]/page.js` uses** (landing-page public_path → location). 404 (`notFound()`) if unknown.
2. Query upcoming public events for that location:
   - `race_events` where `location_id = loc.id` (OR `shared = true`, matching the staff `/events` filter) AND `active = true` AND `race_date >= todayIsoDublin()`, ordered nearest-first (`orderEventsForBrowse` / `race_date ASC`).
   - Select only public-safe fields: `slug, name, description, kind, race_date, start_time, member_pricing_enabled, member_fee_cents, non_member_fee_cents, registration_opens_at, registration_closes_at`. Embed `race_waves(capacity)` + a registrations count **only to compute a coy state badge** (see below) — raw numbers are NOT rendered.
3. Map each row through a **pure view-model helper** (testable) → card data.
4. Render with the marketing look: `SiteHeader` (studio logo + its primary CTA), a page hero ("What's on at <studio>"), a responsive grid of event cards (`lp-reveal` staggered), `SiteFooter`. Empty state when there are no upcoming events. `generateMetadata` for OG previews.
5. Each card's CTA links to the existing **`/event/[slug]`** booking page.

**`src/lib/public-events.js`** (pure, unit-tested) — `toBrowseCard(event, { wavesFull })` → `{ slug, title, kindLabel, dateLabel, priceLabel, badge }`:
- `dateLabel`: e.g. "Sat 12 Jul" (format `race_date`; anchor on noon UTC of the date — the Dublin wall-clock caveat is about times, the date label is safe).
- `priceLabel`: `non_member_fee_cents` null → **"Free"**; else **"From €{min(member,non_member)/100}"** (or just "€{non_member}" if no member pricing). Detail lives on the booking page.
- `badge`: `registration_closes_at` past → don't list it (filtered out); `registration_opens_at` future → "Opens {date}"; all capacity-bearing waves full → "Sold out"; else none.
- `kindLabel` via `eventKindLabel`. (Kind colour tones are adapted to the dark theme — a subtle white/translucent chip, not the CRM light-theme emerald/sky map.)

**`src/components/landing-page/PublicEventsList.jsx`** — presentational (server component): the hero heading + the cards grid + empty state. Cards: kind chip + `dateLabel` + `title` + `priceLabel` + optional `badge` + a "View & book →" `lp-btn`-style link to `/event/[slug]`. Mobile = stacked; desktop = 2-up grid. Uses only `un1t`/marketing classes (no raw hex), Poppins inherited from the `/welcome` layout.

**Pretty path + discovery:**
- Add a `next.config.js` rewrite `/[location]/events` → `/welcome/[location]/events` mirroring the existing `/[location]` → `/welcome/[location]` rule. Pretty paths are public by prefix in `proxy.js`/AppShell (`/stillorgan*` already matches), so no new public-path entry needed for existing studios.
- Add an **"Events" link** to the marketing `SiteHeader` nav so every studio page links to `/[location]/events` (discovery). Single small addition.

## Permissions / safety
Fully public (no auth, no permission key, no mobile surface). The service-role SELECT is safe because it is hard-scoped to `location_id` + `active` + `race_date >= today` and selects only public-safe columns — raw capacity/registration counts are reduced to a coy badge, never rendered. (Per the "service-role route → enforce scope in app code" rule: the scope here is the public-visibility filter itself.)

## Out of scope
- Any change to `/event/[slug]` booking, its API, or payments (reused as-is).
- Kind/date **filtering or search** on the listing (v1 = nearest-first chronological list; a gym has few upcoming events. Add filter pills later if the list grows).
- A cross-location "all studios" events page (per-location, like the landing pages; the `/welcome` chooser already routes per studio).
- Operator-editable "events block" inside the landing-page editor (separate page chosen, not a block).
- Pagination (show all upcoming; revisit if a studio ever has dozens).

## Decomposition (2 tasks)
1. **Pure view-model helper + tests** — `src/lib/public-events.js` `toBrowseCard` (+ any small date/price/badge helpers) with `public-events.test.js` covering free/paid/member-pricing, the date label, and each badge state. TDD.
2. **The page + component + wiring** — `welcome/[location]/events/page.js` (location resolve + scoped query + render + `generateMetadata`), `PublicEventsList.jsx`, the `next.config.js` rewrite, and the `SiteHeader` "Events" link. Empty state + 404 for unknown location.

Worktree-isolated; Vercel PR check = build gate (new route/page + rewrite — the Vercel build is the real resolve check).

---

## Self-review
- **Placeholders:** none — every field/column/helper names the real `race_events` column or shared helper from recon; the resolver + rewrite reuse the existing `/welcome/[location]` mechanics.
- **Consistency:** "reuse booking as-is" held throughout (cards link to `/event/[slug]`, no API/flow change); "marketing styling" pinned to the real `/welcome` layout + `lp-*` + `SiteHeader`/`Footer`; capacity-coy posture matches the existing public API's "no raw capacity" rule.
- **Scope:** one listing page + one pure helper + a rewrite + a header link; filtering/search/cross-location/pagination explicitly deferred.
- **Ambiguity:** "events" pinned to `race_events` (the multi-kind events with public booking), NOT classes/bookings; "upcoming/public" pinned to `active && race_date >= todayIsoDublin()`; price/badge rules made explicit in the helper.
- **Safety:** the one risk in a public service-role page (over-exposure) is addressed — explicit public-safe column list + hard public-visibility filter + coy badge instead of raw counts.
