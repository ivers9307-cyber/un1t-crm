# Studio Devices — iPad + Mac apps for in-studio use

Design + phased build plan for two new surfaces of the existing platform:

- **iPad** — handheld and (eventually) mounted devices used by coaches,
  reception, and self-service members.
- **Mac** — desktop app for reception and back-of-house, wrapping the
  existing web CRM in a native window.

The kiosk surface (mounted-iPad self-service check-in) is **parked**
behind Phases 1–3 and will get its own design pass after the
foundational work ships. It's listed here as a future Phase 4 with a
sketch only.

## Status & resume notes

Use this section to track decisions and where we left off when picking
the work back up.

- [ ] **Phase 0 — Studio-device PIN auth.** Not started. Cross-cutting
      foundation for Phases 1, 2, and 3. Detailed in its own section
      below.
- [ ] **Phase 1 — CF Studio universal binary + iPad layouts.** Not
      started. Prereq for Phase 3.
- [ ] **Phase 2 — Mac shell (Tauri) wrapping un1t-crm.** Not started.
      Independent of Phase 1.
- [ ] **Phase 3 — Coach In-Class mode.** Not started. Blocked on
      Phase 1.
- [ ] **Phase 4 — Self-service kiosk.** Scoping deferred. Trigger this
      when reception flow / member check-in workflow is confirmed.

**Open decisions still to make:**

- [ ] PIN length: 4 digits (easy to remember, easier to brute force)
      vs 6 digits (industry default for phone PINs)?
- [ ] PIN uniqueness: globally unique so PIN alone identifies a
      staffer, or per-staff with a "who are you?" picker before the
      PIN entry?
- [ ] Lockout policy after N failed PIN attempts (recommend 5
      attempts then 15-minute lockout per device).
- [ ] How studio public IPs get registered — admin UI vs config
      file vs DNS lookup? And what's the recovery process when
      the studio's ISP changes the IP?
- [ ] Device pairing: do studio devices need to be explicitly
      "paired" (registered as trusted) by an admin, or is a network
      gate sufficient?
- [ ] Mac auto-launch policy: launch on boot vs launch on login vs
      manual launch?
- [ ] Per-Mac default URL: should the office Mac open to `/dashboard`
      and the reception Mac open to `/schedule`? Or one URL fits all?
- [ ] Coach in-class mode: offline attendance support in v1 or v2?
      Affects effort meaningfully.
- [ ] Update cadence for the Mac DMG: every main merge, every
      tagged release, or on-demand?
- [ ] Kiosk: how do members check in **today**? Wristband scan, phone
      number, Glofox app, manual at the desk? Drives the kiosk's
      primary action when we scope it.
- [ ] Hardware: existing iPads/Macs in the studio or new buy? Affects
      iOS version floor + Apple Silicon assumption.

**Locked decisions:**

- ✅ iPad approach: extend existing CF Studio iOS app to universal,
      not a new app or PWA.
- ✅ Mac approach: Tauri shell wrapping the existing web CRM, not
      Electron, not a native SwiftUI app.
- ✅ Kiosk: parked. Phase 4. Will scope after Phases 1–3 ship.
- ✅ Studio devices auth via PIN, 5-minute idle timeout, network-gated
      to the studio wifi only. Personal devices (phones) keep the
      existing email/password flow unchanged.

## Goal

Give the studio team purpose-built devices for in-studio operations:

- A **Mac** at reception and one in the office, running the un1t-crm
  CRM as a native-feeling desktop app — dock icon, persistent session,
  one launch to "the system the studio is run from."
- An **iPad** for coaches to use during class — roster, attendance
  marking, member info, all optimised for the larger touch canvas.
- A **shared visual + auth model** with what already exists, so we're
  not maintaining a parallel product. The iPad ships as the same
  TestFlight binary as the iPhone CF Studio app. The Mac shell wraps
  the same web CRM that staff already use in Safari.

The bar is "internal tool" quality, not "App Store front page" quality.

## Background

Already in place:

- **un1t-crm** (Next.js 16 web CRM) — full-feature staff CRM. Lives
  at the production domain; staff log in with Supabase auth + session
  cookies. The vast majority of the product surface is here.
- **CF Studio** (Expo / React Native iOS app) — staff-facing mobile
  app, currently iPhone-only. Recently rebranded from "UN1T CRM" and
  re-submitted to App Store Connect under a new public record for
  unlisted distribution (Apple thread in progress).
- **shared/permissions.js** — single source of truth for role gates
  and per-permission keys; both web and mobile read from it.
- **WEB_ONLY_OK** parity linter — flags features that exist on web
  but not mobile, with explicit overrides for things that genuinely
  shouldn't be on mobile (e.g. SMS, financial admin).
- **Existing distribution rails** — TestFlight + unlisted distribution
  for iOS, Vercel for web.

Out of scope for this doc:

- The kiosk's primary action (covered in Phase 4 sketch only).
- Apple Business Manager. The Apple thread already settled that ABM
  doesn't fit the studio's coach/contractor mix; CF Studio is going
  out via unlisted distribution, and the iPad ships as part of that.

## Architecture decisions

### Decision 1: Extend CF Studio to universal for iPad

Three options considered: extend the existing Expo iOS app to be
universal (iPad-capable), ship un1t-crm as a PWA on iPad, or build a
new native SwiftUI iPad app. We're going with **extend universal**.

The cost difference is dramatic — a universal binary is a one-flag
change in Expo config + adaptive layouts; the others require a new
codebase or feature regression to web-quality. We already own the
auth, the API client, the brand, every screen. iPad becomes a
form-factor variant.

The PWA was the cheaper option, but it permanently caps the iPad
experience at "web in a webview" — no push notifications, no native
camera/file flows, no offline. Universal binary preserves the
upgrade path.

The native SwiftUI option only makes sense if we needed deep iPad
features we can't get from Expo (Pencil, Stage Manager). Nothing on
the roadmap needs that.

### Decision 2: Tauri shell for Mac, not Electron

Four options considered: Tauri, Electron, PWA, native SwiftUI.

**Tauri** wins because:

- 10MB bundle vs Electron's ~120MB. Matters less for distribution
  cost than it does for IT experience — a small, fast-launching app
  reads as "professional" in a way Electron doesn't.
- Uses the system WKWebView, so the rendered un1t-crm picks up
  macOS native form controls, fonts, scrollbar behaviour. Looks like
  a Mac app, not a Chrome window.
- Rust core is rock-solid for the small native surface we need
  (window management, auto-update, deep-link, system tray).
- Native code-signing + notarisation flow via `tauri-action`.

**Electron** is the safer pick if we discover a browser API
un1t-crm relies on that WKWebView doesn't support. Pre-flight check
to run before committing: open un1t-crm in Safari (which uses
WKWebView) and confirm nothing is broken. As of 2026-05 Safari
support is at parity with Chrome for everything un1t-crm uses
(Next.js 16 SSR, Supabase auth cookies, fetch, ESM), so this is
unlikely.

**PWA** is "free" but lacks the polish we want for the studio's
front-desk experience — no real dock icon, no auto-launch, install
flow is fiddly.

**Native SwiftUI** is over-engineering for "wrap the web app."

### Decision 3: Sequence the work 0 → A → B → C → (D)

- **PR 0** = Studio-device PIN auth (foundation). Detailed below.
  Touches the web CRM auth surface. Must land before A or B can
  meaningfully use the PIN flow, but A and B can be developed in
  parallel against the new auth surface once it exists.
- **PR A** = iPad universal — prereq for C.
- **PR B** = Mac shell — independent of A, fastest payoff, serves
  the most people first (reception + office).
- **PR C** = Coach in-class — builds on A, adds meaningful new
  functionality.
- **PR D** = Kiosk — scope separately after A+B+C ship.

If A and B can be done in parallel by different runs, fine — they
share no code. C must follow A. Both A and B must follow 0.

## Phase 0 — Studio-device PIN auth (PR 0)

Foundation for Phases 1 + 2 + 3. The studio's Mac and iPads can't use
the same email + password flow that personal devices use — they're
shared, always-on, and used by multiple staff a day. We need a fast
login (PIN), an auto-lock (5-min idle), and a network gate so the
PIN is only honoured inside the studio.

### Requirements (locked)

- Staff have a numeric **PIN** stored on their profile.
- On studio devices, staff log in with PIN instead of email + password.
- After **5 minutes** of inactivity, the device auto-locks and
  requires the PIN again.
- PIN login is only accepted when the device is on the studio wifi.
  Off-wifi requests fall back to the normal email + password flow
  (or are rejected outright, depending on the surface).
- Personal devices (iPhone CF Studio) keep the existing flow
  unchanged — no PIN entry, no idle timeout.

### Threat model + design choices

- **Brute force a 4-digit PIN** — only 10,000 combinations. Mitigated
  with strict rate limiting (5 attempts then 15-minute lockout per
  device-user pair) **and** the network gate (attacker would need
  to be physically on studio wifi to even try). Recommend **6-digit
  PIN** as the default; 4 is a fallback if 6 is too many for staff
  to remember.
- **Shoulder-surfing the PIN** — non-trivial but real. The PIN entry
  UI uses masked keypad input (numbers obscured as you type, like
  iPhone unlock).
- **Stolen device leaving the studio** — network gate fails; PIN
  login no longer works. Last cached session expires within 5 min
  (the auto-lock timeout). After that, the device is dead weight
  to anyone who finds it — no further session can be created without
  the email + password flow that requires the staffer's full creds.
- **Studio IP changes** (ISP renumber) — PIN login breaks until
  admin updates the trusted IP. Documented recovery path: admin
  logs into web CRM from off-site with normal email + password,
  edits the location's trusted IP, devices work again.
- **VPN / mobile hotspot bypass** — a staffer could in theory put
  their phone in hotspot mode to mimic the studio IP. The IP gate
  isn't watertight against insiders; combined with device pairing
  (next section), it's good enough for our threat profile.

### Data model

Three additions to the schema:

```sql
-- 1. PIN on each staff profile.
ALTER TABLE profiles
  ADD COLUMN pin_hash text,
  ADD COLUMN pin_set_at timestamptz,
  ADD COLUMN pin_failed_count int NOT NULL DEFAULT 0,
  ADD COLUMN pin_locked_until timestamptz;

-- pin_hash uses bcrypt or argon2id. NULL means "no PIN set" —
-- staff member can't use studio devices until they set one.
-- pin_failed_count + pin_locked_until enforce the 5-strike rule.

-- 2. Trusted IPs per location.
CREATE TABLE location_trusted_ips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  ip_cidr inet NOT NULL,         -- supports /32 host or /24 subnet
  label text,                    -- "Stillorgan main wifi", etc.
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id)
);

CREATE INDEX ON location_trusted_ips USING gist (ip_cidr inet_ops);

-- 3. Paired studio devices.
CREATE TABLE studio_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id),
  device_token text NOT NULL UNIQUE,   -- random secret stored on the device
  device_kind text NOT NULL,           -- 'mac' | 'ipad'
  label text,                          -- "Reception Mac", "Coach iPad 1"
  paired_at timestamptz NOT NULL DEFAULT now(),
  paired_by uuid REFERENCES profiles(id),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
```

`device_token` is generated server-side at pairing and stored once on
the device (Keychain on Mac, SecureStore on iPad). Every PIN-login
request sends the token; revoking a device in admin sets
`revoked_at` and the token is rejected from then on.

### Auth flow

**Setting a PIN (one-time, from any browser):**

1. Staffer logs into web CRM normally (email + password).
2. Goes to `/account` → "Set studio PIN".
3. Enters a 6-digit PIN, confirms it. Hashed, written to
   `profiles.pin_hash`.

**Pairing a studio device (one-time, by admin):**

1. Admin opens the Mac shell / iPad app for the first time. App
   detects no `device_token` in local secure storage.
2. App shows a "Pair this device" screen with a one-time code
   generated locally.
3. Admin opens web CRM → Admin → Studio Devices → "Pair new device",
   enters the code + a label + assigns to a location.
4. Server creates a `studio_devices` row, returns the
   `device_token`, which the app stores in secure storage.
5. Device is now paired. PIN login enabled.

**PIN login (every shift / unlock):**

1. App POSTs to `/api/auth/pin-login` with: device_token, PIN.
2. Server:
   - Looks up the device, ensures `revoked_at IS NULL`.
   - Checks the request IP against `location_trusted_ips` for the
     device's location. Reject if no match.
   - Looks up profiles with PIN-matching for that location (we
     don't ask "who are you?" — the PIN itself identifies the
     staffer within a location).
   - Verifies the PIN against `pin_hash`. On match, issues a
     standard Supabase session with the `auth_pin_session` flag.
   - On mismatch, increments `pin_failed_count`. At 5, sets
     `pin_locked_until = now() + interval '15 minutes'`.
3. Device receives the session, persists it locally, behaves
   like a normal logged-in session — but with a 5-minute idle
   timer running.

**Auto-lock (after 5 min idle):**

- Client-side idle detector tracks the last interaction (touch,
  click, keypress, navigation, API call).
- After 5 minutes of no interaction, an overlay covers the UI:
  "Locked. Enter your PIN."
- User enters PIN → same `/api/auth/pin-login` flow → on success,
  overlay dismisses, session continues.
- The underlying session is **not** invalidated by the lock — it's
  the same staffer, just re-confirming. If a *different* PIN is
  entered (different staffer), the lock resolves to that staffer
  and the session is rotated to their identity. This is how shift
  changeovers work.

**Server-side enforcement:**

- Every API call from a paired studio device includes the
  `device_token` header.
- Middleware checks the session's `last_pin_activity_at` claim
  (refreshed on every API call) — if > 5 minutes old, the
  session is treated as locked and API calls return 401.
- Client sees the 401, locks the UI, prompts for PIN.

### PIN management UI

**For staff (web CRM, in /account):**

- "Set studio PIN" button if no PIN set yet.
- "Change PIN" button if a PIN is set.
- "Forgot your PIN" link → email a one-time reset link.

**For admins (web CRM, in /admin/studio-devices):**

- List of paired devices per location.
- Pair new device flow.
- Revoke device.
- View recent PIN-login activity (success / failure / lockout) —
  feeds into the existing audit log.
- Manage `location_trusted_ips` per location.

### Where the PIN flow applies

| Surface | PIN auth? | Notes |
|---|---|---|
| Web CRM in a normal browser | No | Existing email + password. Personal devices not on studio wifi. |
| Mac shell (Tauri) | **Yes** | Always — Mac shell is a studio device. |
| iPad CF Studio (in-studio) | **Yes** | When the app is launched on a paired studio iPad. |
| iPhone CF Studio (personal) | No | Same app binary but a different device class. Not paired, no PIN flow surfaced. |

The device-pairing model is what discriminates: an Expo iOS app
running on an unpaired iPhone never enters the PIN flow; the same
app on a paired iPad does.

### Scope per phase

- **Phase 0** ships: schema + APIs + web admin UI + PIN-set UI on
  /account + the idle-timer wrapper as a web component (used by
  the Mac shell automatically) + the PIN-login screen.
- **Phase 1** (iPad) consumes Phase 0: pairing flow on first
  launch, PIN screen, idle-timer wrapping the app's root view.
- **Phase 2** (Mac shell) consumes Phase 0: device-token storage
  in Keychain, pairing flow in the shell, idle-timer fires
  whether un1t-crm's web idle-timer fires or not (belt-and-braces).

### Edge cases

- **Studio loses internet** — PIN login can't validate (no
  server). Devices keep the current session usable until the
  next API call fails. Once internet is back, normal operation
  resumes. No special handling beyond a clear "no connection"
  UI state.
- **Staffer forgets PIN** — uses the "Forgot your PIN" reset flow
  from any web browser they can log into normally.
- **Staffer leaves the company** — admin disables their profile,
  the next PIN login attempt fails (profile inactive). Standard
  deactivation handles this; no new code needed.
- **Multiple PINs that hash-collide** — bcrypt won't collide in
  practice. Per-location PIN uniqueness is enforced in the set-PIN
  flow as a UX nicety so two staffers don't pick the same PIN
  by accident.

### Effort estimate

5–7 days of focused work. Schema + APIs + admin UI is the bulk.
The client-side idle timer + PIN overlay is small. Pairing flow
is fiddly (one-time code, secure storage) — half a day.

### Open questions (also tracked in resume notes)

- 4-digit vs 6-digit PIN default.
- PIN uniqueness scope (globally unique vs per-location).
- Lockout policy after N failed attempts.
- Trusted-IP management UX (manual entry vs auto-detect).
- Device pairing required, or is the network gate alone enough?
  Recommend pairing required — defence in depth.

## Phase 1 — CF Studio universal binary + iPad layouts (PR A)

### Changes

**App config** — flip the Expo iOS config:

```js
// mobile/app.config.js
ios: {
  bundleIdentifier: 'com.un1tdublin.crm',
  supportsTablet: true,     // ← new
  requireFullScreen: false, // allow Split View / Stage Manager
  ...
}
```

**Asset variants** — iPad needs:

- Splash screen sized for iPad portrait + landscape (Expo handles
  this via the `splash.image` config if we provide higher-resolution
  source).
- App icon — same icon is fine for both; Expo generates the iPad
  variants from the source.

**Layout adaptation** — iPad is 1024+ pt wide; phone is 375–430. The
screens that benefit most from a bigger canvas:

- **Schedule** — week view becomes much more readable at full iPad
  width; can show 7 days side-by-side without horizontal scroll.
- **Contacts** — master-detail pattern: list on the left (~360pt),
  detail pane on the right. Tapping a contact updates the detail
  pane without a full navigation push.
- **Approvals** — list + detail same pattern.
- **Radar (Churn + Lead)** — denser table layouts, multi-column
  filter bar.
- **Policies viewer** — wider content column, sidebar table of
  contents on iPad only.

Each of these is a per-screen change that conditionally uses a
multi-column layout when the device width exceeds a threshold (~700
pt is the conventional iPad portrait split). React Native's
`useWindowDimensions()` + a small `useIsTablet()` hook is sufficient
— no third-party responsive library needed.

**Orientation** — unlock orientation on iPad. The phone is
portrait-locked; iPad should support both portrait + landscape, with
Stage Manager / Split View enabled.

**Touch targets** — audit pass for buttons that are tight at 44pt
minimum. Most existing screens already hit this, but the Schedule
calendar block taps and Radar action buttons want verification at
iPad scale.

### Distribution

Same TestFlight / unlisted record as the iPhone build. A universal
binary ships to both form factors automatically — no second App
Store Connect submission, no second review cycle. Test it on a real
iPad via TestFlight before any production rollout.

### Out of scope for PR A

- Coach in-class mode (Phase 3).
- iPad-specific features like Pencil support, Stage Manager
  optimisations, drag-and-drop. We'll add these only if a clear use
  case emerges.
- Apple Pencil / external keyboard shortcuts. Not relevant to the
  studio's actual use cases.

### Effort estimate

3–5 days of focused work. Most of the time is in the layout audit
and adaptive layouts on the high-value screens. The Expo config
change itself is 5 minutes.

## Phase 2 — Mac shell (Tauri) wrapping un1t-crm (PR B)

### Architecture

A new repo or workspace folder — `cf-studio-mac/` — containing:

- A Tauri config that loads `https://un1tdublin.com` (or whatever
  the production domain is) into a native window.
- Native code only for: window management, system tray (optional),
  deep-link URL scheme handler (`cfstudio://...`), auto-update.
- No application code — un1t-crm is the application; this is just
  the shell.

Persistent session works for free: WKWebView writes cookies to its
own data directory under `~/Library/WebKit/CF Studio/`, persisting
across launches. Reception logs in once, never again unless the
session expires.

### Configuration

`tauri.conf.json` settings:

```json
{
  "package": { "productName": "CF Studio" },
  "build": { "devPath": "https://un1tdublin.com" },
  "tauri": {
    "windows": [{
      "title": "CF Studio",
      "width": 1400,
      "height": 900,
      "minWidth": 1024,
      "minHeight": 700,
      "fullscreen": false,
      "resizable": true,
      "decorations": true
    }],
    "macOSPrivateApi": true,
    "allowlist": { ... }
  }
}
```

Single-instance: opening the app twice focuses the existing window
rather than launching a second one. Tauri has a built-in plugin for
this (`tauri-plugin-single-instance`).

### Per-Mac launch routing (deferred)

Open question — should the reception Mac launch into `/schedule`
while the office Mac launches into `/dashboard`? Two ways to handle
this:

- **Static config baked at build time** — one DMG per role. Adds
  build complexity, but very predictable.
- **Runtime config in a local file** — same DMG everywhere, each
  Mac has a `~/.cfstudio/config.json` that the shell reads on
  launch to decide which URL to load.

Recommend the runtime approach — one binary, configurable per
device. Defer the actual implementation to Phase 2 follow-up if
nobody asks for it; default to the dashboard.

### Auth

No new auth code. The web CRM's existing Supabase auth + cookie
session is the auth. The Mac shell is a window pointed at the same
URL.

If session expires, the user sees the same login screen they'd see
in Safari. No keychain integration, no system credentials —
intentionally simple.

### Distribution + auto-update

**Build** — `tauri build` produces a notarised `.dmg` (assuming
the Apple Developer ID Application cert + notarisation credentials
are configured in CI).

**Hosting** — DMG hosted on the un1t-crm domain at a known path,
e.g. `https://un1tdublin.com/downloads/cf-studio-mac-latest.dmg`.
Notarisation means macOS Gatekeeper won't complain on first open.

**Auto-update** — Tauri's built-in updater watches a JSON manifest
at `https://un1tdublin.com/downloads/cf-studio-mac-updater.json`
that contains the current version, download URL, and signature.
The shell checks on launch (+ periodically) and prompts the user
to install when a new version is available. Manifest signed with
a private key whose public key is baked into the Tauri config.

**CI** — `tauri-action` on the new repo: every push to `main`
runs `tauri build`, signs + notarises the DMG, uploads it to the
hosting URL, updates the updater manifest. End-to-end automated.

### Effort estimate

2–3 days for the MVP (working signed/notarised DMG). +1–2 days for
auto-update + updater manifest signing.

## Phase 3 — Coach In-Class mode in CF Studio (PR C)

### Flow

The coach holds the iPad, walks the floor. From the existing iPad
universal CF Studio app:

1. Coach opens the **My Schedule** screen, sees today's classes.
2. Taps a class card whose start time is within ±30 min of now.
3. Enters **In-Class mode** — a screen that takes over the iPad
   canvas:
   - Top bar: class name, time, capacity, "End class" button.
   - Roster: each booked member is a card with photo, name,
     attendance toggle (Present / Late / Absent), medical/flag
     indicators, swipeable secondary actions (message member,
     view contact, mark no-show).
   - Bottom action bar: "Add walk-in" button, search field for
     adding non-booked members.
4. Coach marks attendance throughout class. State syncs to the CRM
   as it changes.
5. Coach taps "End class" — class is finalised, attendance is
   written to the canonical attendance record.

### Reuse

Most APIs already exist:

- Class roster: `/api/schedule/blocks/[id]/assignments` (server side)
  + the class-detail surface already used by web Schedule.
- Attendance writes: existing attendance table via UniFi door
  unlocks + manual override flow. Coach-marked attendance hits the
  same table with a `marked_by` flag.
- Member info / contact actions: existing contact endpoints.

What's new:

- The In-Class screen layout itself — purpose-built for iPad use
  in-class.
- The "Add walk-in" flow — search non-booked members, add them to
  the roster on the fly.
- The "End class" finalisation hook (probably a small new endpoint:
  `POST /api/schedule/blocks/[id]/finalise`).

### Offline support (open question)

In-class wifi is generally good but not perfect. The decision is
whether attendance marks are:

- **v1 (simple)**: every tap is a network call. If wifi drops, the
  tap is queued in-memory and retried on reconnect. Tap state is
  lost if the app is killed mid-class.
- **v2 (proper offline-first)**: tap state is written to local
  storage immediately, synced to the server when online. Survives
  app kills. More complexity (conflict resolution, sync state UI).

Recommend **v1** for the first release — measure how often coaches
actually lose connectivity. If it's a real problem, add v2 in a
follow-up.

### Effort estimate

4–5 days for v1 (online-only). +2–3 days for v2 (offline-first)
if we decide to fold that in.

## Phase 4 (parked) — Self-service kiosk

Sketch only. This gets its own design pass when we trigger it.

A mounted iPad in the studio entrance running a locked-down app
that lets members check themselves in to class. Three plausible
implementations:

- **A) Kiosk mode inside CF Studio** — a special "kiosk role" the
  app boots into. Uses iOS Guided Access to prevent escape. Same
  codebase, but mixing two products in one bundle.
- **B) Separate iPad kiosk app** — own bundle, own distribution.
  Cleaner separation, double the maintenance.
- **C) Web kiosk at `/kiosk` on un1t-crm** — Safari full-screen
  + Guided Access. Cheapest by miles. Might be good enough.

The bigger question is **what the kiosk's primary action is**, which
depends on how members check in today:

- Phone number lookup?
- Wristband scan?
- Glofox app on their own phone?
- QR code on their booking confirmation?
- Manual at the front desk?

Pick this up when Phase 3 ships and we have a real conversation
with reception about how the in-studio flow actually works.

## Distribution + install summary

| Surface | Distribution | Install |
|---|---|---|
| iPhone CF Studio | TestFlight + unlisted App Store | App Store link (unlisted) or TestFlight invite |
| iPad CF Studio | Same TestFlight binary, universal | Same App Store link / TestFlight invite — iPad downloads the same app |
| Mac CF Studio | Notarised DMG on un1tdublin.com | Download + drag to /Applications. Auto-update from then on. |
| Web CRM | Vercel | Browser bookmark or PWA install |

No new Apple Developer accounts. No new TestFlight workflows. No new
App Store Connect records.

## Effort summary

- **Phase 0 (PIN auth foundation):** 5–7 days
- **Phase 1 (iPad universal):** 3–5 days
- **Phase 2 (Mac shell):** 2–3 days MVP + 1–2 days auto-update = 3–5 days
- **Phase 3 (Coach in-class):** 4–5 days v1 (+ 2–3 days for offline if added)
- **Phase 4 (Kiosk):** scope separately, ~5–10 days depending on path

Total for Phases 0–3 with v1 in-class: **15–22 days** of focused work,
or four to six PRs over the course of three to four weeks.

## Risks

- **WKWebView vs un1t-crm compatibility** — small risk that something
  in un1t-crm doesn't render right in WKWebView. Mitigation: open
  un1t-crm in Safari on a Mac before committing to Tauri. If it
  works in Safari, it works in the Tauri shell. As of 2026-05 this
  is very unlikely to fail.
- **Apple notarisation** — first-time notarisation can hit weird
  edge cases (entitlements, hardened runtime). Budget half a day
  for getting the CI pipeline working end-to-end the first time.
- **Universal binary breaking the iPhone build** — flipping
  `supportsTablet: true` shouldn't affect the iPhone build, but
  worth a TestFlight pass on a real iPhone after the Phase 1 PR
  ships before considering it done.
- **Stage Manager / Split View edge cases on iPad** — `requireFullScreen: false`
  means the iPad can run the app in a multi-window arrangement,
  which can surface layout bugs. Test in Stage Manager during
  Phase 1.
- **Mac auto-update key compromise** — if the private key signing
  the updater manifest leaks, an attacker could ship a malicious
  update to every Mac. Mitigation: key lives only in CI secrets,
  rotate annually.
- **PIN brute force from inside the studio** — anyone on studio wifi
  with a paired device can guess PINs at the rate-limit cap (5 per
  device-user pair per 15 min). Across 20 staff with 6-digit PINs,
  expected break time is in the millions of minutes — not a
  practical attack but worth re-evaluating if we ever drop to
  4-digit PINs.
- **PIN hash leakage** — if `profiles.pin_hash` ever shows up in a
  public payload, the network gate is the only thing standing
  between an attacker and offline PIN cracking. Mitigation: explicit
  test that `/api/staff` and any profile-returning endpoint never
  include `pin_hash` in their SELECTs. Add a parity-lint-style
  check.
- **Studio IP renumber locks out everyone** — practical operational
  risk. Mitigation: documented recovery path (admin edits trusted
  IP from off-site web session); consider auto-detect-and-prompt
  flow long term ("we noticed this device is at a new IP — is this
  still the studio?").

## References

- Existing iOS app config: `mobile/app.config.js`
- Existing mobile parity linter: `scripts/parity-lint.js` + the
  `WEB_ONLY_OK` registry it consults.
- Existing schedule + contacts surfaces (good candidates for the
  iPad master-detail layout): `src/app/schedule/`, `src/app/contacts/`,
  `src/components/ScheduleCalendar.jsx`.
- Apple unlisted distribution thread: handled separately; see the
  CF Studio submission notes in the project tracker.
- Tauri docs: <https://tauri.app/v1/guides/>
- Tauri auto-update: <https://tauri.app/v1/guides/distribution/updater>
- Expo universal binary: <https://docs.expo.dev/build-reference/ios-builds/>
