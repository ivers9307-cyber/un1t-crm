# champ-app native mobile app — design spec

- **Date:** 2026-06-19
- **Status:** Draft for review
- **Ticket:** CHAMP-NATIVE.1
- **Repos:** **champ-app** (new `mobile/` Expo app + a new `shared/` pure-logic seam; the web `src/` stays) and **un1t-crm** (one or more Supabase migrations for customer push tokens + a post-class native-push send path — champ-app shares the un1t-crm Supabase project + the email/push pipeline lives there).

## Goal

Ship champ-app as a **real installable native app on the public App Store + Google Play** so UN1T members install it like any app, and so we get **native push** — including the deferred Session Report "your session is ready" push. The app is a **full React Native rebuild** of the (just-refreshed, dark, mobile-first) champ-app surfaces in Expo — mirroring the mature `un1t-crm/mobile` staff app — reusing the already-pure shared logic (Session Report builder, zone maths, formatters) rather than a WebView wrapper. The whole app (all screens + push + account) ships as **one store release**; the *build* is phased internally.

## Why this shape (grounded)

- **champ-app is a Next.js 14 App Router web app** (SSR + server components + magic-link cookie auth, `force-dynamic` everywhere) — it can't static-export, so a webview/Capacitor wrap would be a remote-URL shell. The operator chose a **full native rebuild** for true native feel, offline capability, no Apple-4.2 webview risk, and consistency with the staff app.
- **The staff app (`un1t-crm/mobile`) is the proven template:** Expo + `expo-router` (file tabs) + **NativeWind** (re-uses the `un1t-*` Tailwind tokens) + `expo-secure-store` + EAS Build/Update + Expo push. champ-app's native app mirrors it, so tooling, accounts, and patterns are largely reused. Key inherited rule: **mobile cannot import `src/lib` — a `shared/` dir is the seam** (per the staff app's class-timer work).
- **The pure logic is already shareable:** `hr-session-report.js` (the versioned Session Report builder) is *already byte-identical* across un1t-crm + champ-app; `heart-rate.js` (`zoneBreakdown`/`ZONE_DEFS`), `format.js`, `goals.js` (`computeProgress`/`GOAL_DEFS`), and `share-card.js` are pure. Moving them to `champ-app/shared/` lets the RN screens reuse the exact maths the web uses.
- **Magic-link auth is awkward in RN** (needs universal-link plumbing); Supabase **email OTP code** is the clean mobile path with the same backend.

## Architecture

### App location & stack
A new Expo app at `champ-app/mobile/` (sibling to `src/`), matching `un1t-crm/mobile`:
- **`expo-router`** file-based routing; bottom tabs **Home · Sessions · Account** (same IA as the web `TabBar`).
- **NativeWind** with the dark `un1t-*` tokens (near-black canvas, white text, HR zone colours as the only colour) so the native UI matches the web identity. A small RN primitive set mirrors `src/components/ui/` (Card, Button, StatNumber, ZoneBar, Chip, EmptyState) as RN components.
- **`expo-secure-store`** for the Supabase session; **`react-native-svg`** for the HR chart + zone bars; **`@supabase/supabase-js`** (anon key + JWT).

### Shared pure-logic seam (`champ-app/shared/`)
Create `champ-app/shared/` and move the pure modules there: `hr-session-report.js`, `heart-rate.js`, `format.js`, `goals.js`, `share-card.js`. To avoid touching every web importer, leave **re-export shims** in `src/lib/<name>.js` (`export * from '../../shared/<name>'`) so existing `@/lib/...` imports keep working unchanged; the web's `session-report.fixture.json` guard moves/points at `shared/`. Mobile imports **only** from `shared/` (never `src/`). This keeps the report builder honestly identical across un1t-crm, champ-app web, and champ-app mobile.

### Auth — email OTP code
The app uses Supabase **email one-time-code**: `signInWithOtp({ email, options: { shouldCreateUser: false } })` → the member types the 6-digit code → `verifyOtp({ email, token, type: 'email' })`. Session persists in secure-store; refresh handled by supabase-js. No deep-link/universal-link dependency.
- **Supabase config:** the auth email template must include the `{{ .Token }}` code (it can carry both the web magic-link URL *and* the code, so one template serves both surfaces). Allowed — no web behaviour change.
- A member who isn't yet linked to a contact sees a "setting up your account" state (same soft-fail as the web), since `contacts.user_id` linking happens on first auth.

### Data access
Reads go **directly to Supabase** under customer-self RLS (`heart_rate_sessions`, `hr_samples`, `contact_achievements`, `contact_goals`, `contacts` — all already RLS-scoped via `private.auth_contact_id()`), JWT from secure-store. Orchestration (push-token registration) hits champ-app `/api` routes with `Authorization: Bearer <jwt>`. Mirrors the staff app's hybrid model. **Caveat inherited from the staff app:** never embed `profiles` from a mobile-direct select (no grant to `authenticated`); `contacts` embeds are fine.

### Screens (RN rebuilds of the dark web surfaces)
- **Login** — email + OTP-code entry (two-step), dark-branded UN1T wordmark.
- **Home/dashboard** — greeting, recent sessions (effort + zone bar), achievements, goals, connect-device CTA.
- **Sessions list** — session cards (date, effort, zone bar, "mostly {zone}").
- **Session detail** — effort hero, "how this compares" (the Slice 1–3 comparison logic from the shared builder), stat row, achievements unlocked, **HR chart via `react-native-svg`** (port the web `HrChart` polyline + zone-band maths to `<Polyline>`/`<Rect>`), zone breakdown, the editable `next_action` CTA. The web "Share" button → the **native share sheet** (`expo-sharing`/RN `Share`) sharing the public `/share/<token>` link (minted via the existing mint endpoint).
- **Account** — index + achievements / goals (add/edit) / devices (the wearable onboarding + strap scan, reusing the existing bridge/scan APIs) / integrations (OAuth providers).

### Push (unblocks Session Report native push)
- **Migration (un1t-crm, shared project):** a customer push-token table — `champ_push_tokens` (`contact_id`, `expo_token`, `platform`, `created_at`, unique on token), RLS customer-self insert/delete (`contact_id = private.auth_contact_id()`), service-role read for the sender. (Distinct from the staff `device_tokens` (mig 023), which is keyed to staff profiles.)
- **Registration:** `expo-notifications` gets the Expo push token on login (after permission), registered via `POST /api/mobile/push-token` (champ-app) → upsert into `champ_push_tokens`. Pruned on `DeviceNotRegistered`.
- **Send path (un1t-crm):** a `sendCustomerPush()` helper (mirroring `src/lib/push.js`) fans out via Expo Push. The **Session Report native push** fires from the existing post-class flow (when a session ends + the report is ready): "Your session is ready — N UN1T Points" deep-linking to `/sessions/[id]` in the app. Per-member opt-in (a notifications preference; default on, with an in-app toggle on Account).

### Distribution
- New **bundle id** `ie.champfitness.app` (iOS + Android), a new Apple App Store record + Google Play record (separate from the staff app), under the existing Apple Developer + Google Play accounts (or a CHAMP entity if preferred).
- **Public** App Store + Play listings (icons, screenshots, privacy nutrition labels, customer-facing review) — *not* the staff app's closed ABM/Internal-Testing tracks.
- **EAS Build** both platforms; **EAS Submit** for iOS; **manual `.aab` upload** for Android (the org's `iam.disableServiceAccountKeyCreation` policy blocks automated Android submit — same constraint the staff app documented).
- **EAS Update OTA** for JS-only changes post-launch (path-filtered workflow like the staff app).

## In scope
- `champ-app/mobile/` Expo app: expo-router tabs, NativeWind dark primitives, OTP auth, secure-store, all screens above, react-native-svg HR chart, native share.
- `champ-app/shared/` pure-logic seam + `src/lib` re-export shims.
- Customer push: migration + registration route + send path + the Session Report native push + opt-in.
- EAS Build/Submit/Update config + store packaging (icons, splash, listings) for iOS + Android.

## Out of scope (deliberate)
- **The web app** stays (the native app is additive; the web remains at app.champfitness.ie). No web behaviour change beyond the import-shim refactor.
- **Offline-first sync** — v1 is online (reads need network); a sync engine is a later effort.
- **Apple Watch / wearable companion apps** — separate.
- **Migrating the web to static export / abandoning SSR** — no.
- **The staff app** — untouched.

## Build phases (PRs → one store release)
0. **Scaffold + foundation** — Expo app, `shared/` seam + shims, NativeWind dark tokens + RN primitives, Supabase client + secure-store, OTP auth, tab shell. (App boots, you can log in, empty tabs.)
1. **Read screens** — Home, Sessions list, Session detail (HR chart, comparisons).
2. **Account screens** — index, achievements, goals, devices, integrations.
3. **Push** — migration + registration + send path + Session Report native push + opt-in toggle.
4. **Store packaging + submit** — bundle id, icons/splash, EAS profiles, listings, screenshots, privacy labels; iOS EAS Submit + manual Android upload; public review.

## Testing
- **Pure shared logic** (`shared/*`) — Vitest, already covered (report builder fixture, zones, format, goals); the move keeps the tests.
- **RN screens** — verified by EAS build + on-device QA (RN screens aren't unit-tested, matching the staff app's posture); any new pure helpers get Vitest cover.
- **Push** — token registration + send path unit-tested where pure; real push verified on a device.
- champ-app web CI (Vitest + Vercel) must stay green through the shim refactor.

## Risks / open questions
1. **Public App Store review** is stricter than the staff app's ABM track (privacy labels, account-deletion URL, data-safety form). Plan the metadata early. *Default: full public listings.*
2. **Shared-seam blast radius** — moving `heart-rate.js` etc. to `shared/` touches many web importers; the re-export shims keep churn near-zero, but the web CI + a `next build` must confirm. *Default: shims + verify.*
3. **OTP email template** — needs `{{ .Token }}` added (alongside the existing magic-link URL). Dashboard config, no code. *Default: dual-purpose template.*
4. **Apple/Google accounts** — reuse the existing UN1T Developer accounts vs a CHAMP entity. *Default: reuse existing; new app records + bundle.*
5. **Scale/timeline** — the largest effort to date (5 build phases + store review calendar time + manual Android submit). Expectations set accordingly.
