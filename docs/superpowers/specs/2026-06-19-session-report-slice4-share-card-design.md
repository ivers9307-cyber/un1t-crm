# Session Report — Slice 4: shareable post-class card (public link) — design spec

- **Date:** 2026-06-19
- **Status:** Draft for review
- **Ticket:** SESSION-REPORT.4
- **Slice:** The buildable half of Slice 4 — a **server-rendered, publicly-shareable post-class card** (image + link-preview) a member opts into sharing to socials. (Native push, the other half of the original Slice 4, stays deferred until a native customer app exists.)
- **Repos:** **champ-app** (all the feature code — public routes, card image, mint endpoint, session-view button) + **un1t-crm** (one migration only: `heart_rate_sessions.share_token`; spec/plan live here too).

## Goal

Let a member tap **Share** on a finished session and get a public link whose preview is a distinctive, on-brand card of that session — so it looks great pasted into a story/DM and pulls non-members toward UN1T. The card is a *public* artifact, so it must be **genuinely well-designed, not a generic AI-app card** (per the standing design bar): the member's **hardest training zone of the session drives the card's colour** (every share looks different) and their **real heart-rate trace is the hero line** inside that colour band (the "B+C hybrid" Richard approved). Built on the report data product Slices 1–3 already produce.

## Why this shape (grounded)

- The report `next_action`/data already exist; `loadSessionReport` returns the stats/zones/highlight/`vs_category` (`champ-app/src/lib/load-session-report.js`). The card reuses it; it adds only the member name (first + initial) + the per-second HR trace (`hr_samples`).
- **`next/og` `ImageResponse` is built into champ-app's Next 14.2 — zero new deps**, runs in the `nodejs` runtime alongside the Supabase client, and Next's `opengraph-image` file convention auto-wires the `og:image` meta for link previews.
- Zone colours live in the shared `ZONE_DEFS` (`heart-rate.js`) — the card's band colour + zone bar reuse them, staying in sync with the app.
- The public-link model (Richard's choice over download-only) needs a capability-token surface (like the existing deposit/race public pages): an unguessable per-session `share_token`, minted on explicit opt-in.

## Architecture

### 1. Share token + opt-in (migration 294)

`heart_rate_sessions` gains `share_token text UNIQUE` (nullable), minted the first time the member shares. Nothing is public until they act; it's revocable.

- **`POST /api/sessions/[id]/share`** (champ-app, customer-self): verifies the session is the caller's via the RLS client (`createServerClient` — a customer sees only their own session), then sets `share_token` (random, `crypto.randomUUID()`) via the **service client** (writes to `heart_rate_sessions` are service-role) if not already set. Returns `{ url }` (the public `/share/<token>` URL). Idempotent (reuses an existing token).
- **`DELETE /api/sessions/[id]/share`** — nulls the token ("Stop sharing"). Revocable.

Migration `294_hr_session_share_token.sql`: `ALTER TABLE heart_rate_sessions ADD COLUMN share_token text; CREATE UNIQUE INDEX … ON heart_rate_sessions (share_token) WHERE share_token IS NOT NULL;`. No RLS change (public reads go through the service client, keyed by the unguessable token — the capability-token pattern).

### 2. Public routes (champ-app, unauthenticated)

- **`src/app/share/[token]/page.jsx`** — public viewer: renders the card visually + a **CTA** (below) + `generateMetadata` setting `og:image`/`twitter:card` (summary_large_image) so a pasted link shows the card. Resolves the session by `share_token` via the **service client**; 404 (notFound) on unknown/revoked token.
- **`src/app/share/[token]/opengraph-image.jsx`** — the card PNG via `ImageResponse` (Next OG-image convention; 1200×630). Also reachable directly as the share image.
- **`src/middleware.js`** — add `/share/` (+ the OG image path) to champ-app's public-paths allowlist so the global auth gate lets unauthenticated visitors through (the one must-get-right step, mirroring un1t-crm's deposit-page allowlist).
- Both run `export const runtime = 'nodejs'` (service client + report loader need node; `next/og` runs node fine).

### 3. The card image — "B+C hybrid" (the approved look)

`ImageResponse` at 1200×630, rendered from a `loadShareCard(serviceClient, token)` bundle. Layout (per the approved mockup):
- **Top colour band (~48%)** filled with the session's **dominant zone colour** + the **HR trace** as a white hero polyline; UN1T wordmark (top-left) + `First L. · CLASS · date` (top-right).
- **Lower white area** — big `effort_points` + "UN1T pts", a stats row (avg / peak / minutes), the **zone bar** (`ZONE_DEFS` colours), and the highlight + `vs_category` line.
- **Branding/privacy:** UN1T black/white; member shown as **first name + last initial** (public URL). Font: the Noto Sans bundled with `next/og` (zero-dep) — embedding Poppins (brand font) is a flagged optional upgrade.

Pure helpers (in a shared, unit-tested `card-data` module so the image route stays thin):
- `dominantZone(zones)` → the band colour: the **highest-intensity zone with a real share of time** (highest `id` with `seconds ≥ max(30, 10% of total)`), else the max-seconds zone; if that resolves to Z1 (grey warm-up), fall back to a default brand accent. Returns `{ id, name, color }`.
- `tracePolyline(samples, { width, height })` → downsamples `hr_samples` to ~80 points and maps to SVG polyline coordinates for the hero line. Empty/short samples → no trace (band shows colour only; summary-only syncs degrade gracefully).
- `cardModel(report, { name, dominant })` → the flat field set the JSX renders (name, class, date, points, avg/peak/min, zones, highlight, category line).

### 4. Public share page CTA — reuses Slice 3's editable config

The `/share/[token]` page shows the card + a **"Book a class at UN1T"** button using the operator-editable `booking_url` / `membership_signup_url` + labels from Slice 3 (read via the service client from the session's location `settings.customer_agent`). So the only marketing copy on the public surface is already operator-controllable post-deploy (the [[customer-comms-editable]] rule), and a non-member who clicks lands in the funnel. The card image itself carries only the member's own stats + brand mark.

### 5. Session-view Share button

On the champ-app session view (after the Slice 3 CTA): a **Share** button that calls the mint endpoint, then invokes the device's native share sheet (`navigator.share({ url })`) on mobile or copy-link on desktop. A subtle "Stop sharing" appears once shared (calls DELETE). One tap to share.

## In scope

- mig 294 (`heart_rate_sessions.share_token`).
- champ-app: mint/revoke endpoint; public `/share/[token]` page + `opengraph-image`; middleware allowlist; `loadShareCard` + pure card helpers (`dominantZone`, `tracePolyline`, `cardModel`); the `ImageResponse` card; the session-view Share button.

## Out of scope (deliberate)

- **Native push** (the other half of Slice 4) — deferred until a native app exists.
- **Per-network variants** (square/story) — one 1200×630 card for v1.
- **Editable card copy** — the card is the member's own stats + brand mark; the only marketing copy (the share-page CTA) reuses Slice 3's editable URLs/labels.
- **un1t-crm UI change** — none (just the migration).
- **A broader champ-app design refresh** — worthwhile later (the app is on placeholder Tailwind), tracked as a future effort, not this slice.

## Data flow

```
member taps Share (session view) → POST /api/sessions/[id]/share
   → verify session is caller's (RLS client) → set share_token (service client) → returns /share/<token>
   → navigator.share({ url })  (or copy on desktop)

someone opens /share/<token>  (public, no login)
   → middleware allows /share/ → page resolves session by token (service client)
   → loadShareCard: report (loadSessionReport) + contact first+initial + hr_samples trace + dominantZone
   → page renders the card + the editable "Book a class" CTA + OG meta (og:image → the opengraph-image route)
   → opengraph-image route renders the 1200×630 PNG via next/og ImageResponse
```

## Edge cases

- **Unknown / revoked token** → `notFound()` (404) on both the page + image.
- **No `hr_samples`** (summary-only device sync) → no trace; band shows colour + stats only (graceful).
- **Dominant zone = warm-up (Z1)** → fall back to a default brand accent (avoid a flat grey card).
- **Walk-in / null-contact session** → has no owner to mint a token; the Share button is hidden (no contact) so it's never shareable.
- **`next/og` SVG support** — the HR trace renders as an inline SVG polyline (satori-supported); if a satori limitation surfaces, fall back to a data-URI `<img>` of the SVG. (Resolved in the plan/implementation.)
- **CTA URLs unset** → the share-page CTA is omitted (same null-gating as Slice 3); the card still renders.

## Testing

- **Pure helpers:** `dominantZone` (highest-intensity-with-real-time, Z1 fallback, all-empty fallback), `tracePolyline` (downsample + coordinate mapping, empty samples → no line), `cardModel` (report → card fields, first+initial name). Unit-tested.
- **Mint/revoke route:** customer-self only (caller can't mint another member's session → 404), idempotent mint, revoke nulls the token.
- **Public resolution:** unknown/revoked token → 404; valid token → card data (service client).
- **Renderers:** `next build` covers the `ImageResponse`/JSX + the page; a render smoke check on the card model.

## Rollout

- mig 294 applied to prod before merge (additive column + partial unique index; advisor-checked).
- Two PRs: un1t-crm (migration + spec/plan) and champ-app (all feature code). champ-app auto-deploys to `app.champfitness.ie`.
- Feature is opt-in + additive; reversible (revert + the column is harmless if unused). No public exposure until a member shares.

## Open questions

1. **Name on the public card** — first name + last initial assumed (privacy on a public URL). Confirm, or first-name-only / display-name. *Default: first + last initial.*
2. **Font** — Noto Sans (bundled, zero-dep) for v1, or embed Poppins (brand font, one committed TTF). *Default: Noto Sans v1; Poppins a fast follow.*
3. **Revoke UI** — a "Stop sharing" control on the session view from day one (vs mint-only). *Default: include it (cheap, good privacy hygiene).*
4. **Dominant-zone rule** — "highest-intensity zone with ≥10% of time (min 30s), else max-seconds, Z1→brand accent." Confirm the heuristic. *Default: as stated.*
