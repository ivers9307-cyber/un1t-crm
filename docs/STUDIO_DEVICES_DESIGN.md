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

- [ ] Kiosk: how do members check in **today**? Wristband scan, phone
      number, Glofox app, manual at the desk? Drives the kiosk's
      primary action when we scope it. (Phase 4 prerequisite.)
- [ ] Confirm iOS version on the existing iPads. Drives the
      `expo.ios.deploymentTarget` floor. If the iPads are stuck on
      iOS 15 or earlier we'll need to bump them; iOS 16+ is fine.

**Locked decisions:**

- ✅ iPad approach: extend existing CF Studio iOS app to universal,
      not a new app or PWA.
- ✅ Mac approach: Tauri shell wrapping the existing web CRM, not
      Electron, not a native SwiftUI app.
- ✅ Kiosk: parked. Phase 4. Will scope after Phases 1–3 ship.
- ✅ Studio devices auth via PIN, 5-minute idle timeout, network-gated
      to the studio wifi only. Personal devices (phones) keep the
      existing email/password flow unchanged.
- ✅ **PIN length: 4 digits.** Combined with the lockout policy,
      device pairing, and IP gate, 10,000-combo brute force is
      impractical from inside the studio. Math in the threat model.
- ✅ **PIN identifies the staffer.** Globally unique across the whole
      platform — no "who are you?" picker. Set-PIN UI enforces
      uniqueness ("that PIN is taken, pick another"). Implication:
      with 4-digit PINs and growing headcount the practical space
      thins out; revisit if we ever pass ~500 active staff.
- ✅ **Lockout policy: 5 failed attempts → 15-minute lockout.** Two
      layers — per-device AND per-staffer. With global PIN
      uniqueness, every wrong guess targets a specific staffer, so
      the per-profile lock is what bounds the attacker. After 5
      failures the staffer's PIN is frozen for 15 min; the device
      is also frozen so an attacker can't switch devices to keep
      guessing.
- ✅ **Device pairing required.** Every studio device gets an
      admin-issued `device_token` stored in secure storage. No
      token, no PIN flow — fall back to email + password login.
- ✅ **Trusted-IP management UX: admin UI, master-only.** Lives at
      `/admin/studio-devices` alongside the device-pairing UI.
      Master can add / edit / remove `location_trusted_ips` rows.
- ✅ **Mac auto-launch: launch on boot.** Tauri's auto-launch plugin
      registers the shell as a login item that starts when the Mac
      starts (not just on user login). Suits an always-on reception
      Mac.
- ✅ **Default landing URL: per-user setting, default `/dashboard`.**
      New `profiles.home_screen_path` column; editable on `/account`.
      Mac shell and iPad both load this URL after PIN unlock. Means
      reception staffers can set their landing to `/schedule`, admin
      staffers leave it on `/dashboard`, and the choice follows them
      across devices when they PIN in.
- ✅ **Coach in-class: v2 offline-first.** Tap state writes to local
      storage immediately, sync engine replays writes to the server
      when online. UI shows "N pending" while syncing. Adds ~2–3
      days to Phase 3 effort. Required because in-class wifi can dip
      and a missed mark is unacceptable.
- ✅ **Mac DMG update cadence: every main merge.** CI builds, signs,
      notarises, and uploads on every push to `main`. Auto-update
      prompts the user to install on the next launch.
- ✅ **Hardware: existing iPads + Mac.** No new buy. Action item:
      confirm the iPads' current iOS version (likely iOS 16+).
      Mac is almost certainly recent enough for Tauri.

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

**Brute force math (4-digit PIN + global uniqueness)**

The combo "4 digits + PIN-alone-identifies-staffer" needs care. The
attacker doesn't know which staffer they're trying to impersonate —
any successful PIN match logs them in as whoever owns that PIN.

- PIN space: 10,000 combinations (`0000`–`9999`).
- Staff PINs in active use: say 20 (current headcount). Any
  given guess hits a valid PIN with probability `20 / 10,000 = 0.2%`.
- Expected guesses to hit *some* staffer: 5,000.
- Per-device lockout: 5 attempts → 15-min cooldown. So a device
  can produce 5 attempts every 15 min → 480/day → ~10.5 days of
  uninterrupted guessing to expect a single hit.
- The attacker also needs to be physically on the studio wifi and
  holding a paired device the whole time. Both gates have to
  remain breached for 10+ days for a single random hit.

That's not airtight — a determined insider on a paired device could
eventually break in — but it's well above the "internal-tool
acceptable" bar, especially given that any successful brute force
would be visible in the audit log (10+ days of 5-attempts-every-15-min
patterns).

If we ever want to harden this further: longer cooldowns after each
hit (5 attempts → 15min, then 30min, then 60min), or progressive
delays inside a single window (each attempt waits longer than the
last). YAGNI for v1.

**Lockout model under PIN-alone-identifies-staffer**

The lockout is **per-device**, not per-staffer. With the
who-are-you-less PIN flow, a wrong PIN doesn't identify any
specific staffer to penalise — it just incremented the device's
failure counter. The per-profile lockout (`pin_failed_count` on the
profile) only fires in a separate flow: when a staffer's PIN is
*correctly entered N times in a row but session creation fails for
another reason*, which in practice doesn't happen with this design.

We'll keep the profile-level `pin_failed_count` column for future
use (e.g. if we add a "wrong device" signal) but it stays at zero
under the current rules. Per-device lockout (`studio_devices.failed_count`
+ `studio_devices.locked_until`) is the active gate.

**Other threats**

- **Shoulder-surfing the PIN** — non-trivial but real. PIN entry UI
  uses masked keypad input (numbers obscured as you type, like
  iPhone unlock). Anti-tailgating: after PIN unlock the original
  staffer's identity is shown briefly so a watcher sees who's
  logged in (helps reception spot a switched account).
- **Stolen device leaving the studio** — network gate fails; PIN
  login no longer works. Last cached session expires within 5 min
  (the auto-lock timeout). After that, the device is dead weight
  to anyone who finds it — no further session can be created
  without the email + password flow that requires full creds.
- **Studio IP changes** (ISP renumber) — PIN login breaks until
  master updates the trusted IP. Documented recovery path: master
  logs into web CRM from off-site with normal email + password,
  edits the location's trusted IP at `/admin/studio-devices`,
  devices work again.
- **VPN / mobile hotspot bypass** — a staffer could in theory put
  their phone in hotspot mode and try to mimic the studio IP. The
  IP gate isn't watertight against an insider with intent;
  combined with device pairing it's good enough for our threat
  profile.
- **PIN collision on set / change** — set-PIN UI enforces global
  uniqueness, with a clear error message. Race condition between
  two staffers setting the same PIN simultaneously is closed by a
  unique constraint on the hash (cheap server-side replay loop
  if the constraint violates).

### Data model

Four additions to the schema:

```sql
-- 1. PIN + landing-screen preference on each staff profile.
ALTER TABLE profiles
  ADD COLUMN pin_hash text UNIQUE,            -- globally unique
  ADD COLUMN pin_set_at timestamptz,
  ADD COLUMN pin_failed_count int NOT NULL DEFAULT 0,  -- reserved
  ADD COLUMN pin_locked_until timestamptz,             -- reserved
  ADD COLUMN home_screen_path text NOT NULL DEFAULT '/dashboard';

-- pin_hash uses bcrypt or argon2id. UNIQUE enforces global PIN
-- uniqueness (PIN-alone-identifies-staffer).
-- NULL pin_hash = staffer can't use studio devices until they set one.
-- pin_failed_count + pin_locked_until are reserved for future use
-- (see lockout-model note in the threat-model section). Per-device
-- lockout is the active gate.
-- home_screen_path is the URL the Mac shell / iPad loads after PIN
-- unlock. Editable on /account. Validated server-side to be a path,
-- not an arbitrary URL.

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
  device_token_hash text NOT NULL UNIQUE,  -- bcrypt of the device secret
  device_kind text NOT NULL,               -- 'mac' | 'ipad'
  label text,                              -- "Reception Mac", "Coach iPad 1"
  paired_at timestamptz NOT NULL DEFAULT now(),
  paired_by uuid REFERENCES profiles(id),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  failed_count int NOT NULL DEFAULT 0,     -- 5-strike per-device gate
  locked_until timestamptz                  -- 15-min cooldown
);

-- 4. PIN-login audit table (separate from generic audit_events so
-- analytics queries on PIN attempts are cheap).
CREATE TABLE pin_login_attempts (
  id bigserial PRIMARY KEY,
  device_id uuid REFERENCES studio_devices(id) ON DELETE SET NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  source_ip inet NOT NULL,
  outcome text NOT NULL,    -- 'success' | 'wrong_pin' | 'device_locked' | 'untrusted_ip' | 'no_token' | 'revoked_token'
  matched_profile uuid REFERENCES profiles(id),
  user_agent text
);

CREATE INDEX ON pin_login_attempts (device_id, attempted_at DESC);
CREATE INDEX ON pin_login_attempts (matched_profile, attempted_at DESC) WHERE matched_profile IS NOT NULL;
```

`device_token` is generated server-side at pairing — the shell
stores the cleartext token in Keychain (Mac) / SecureStore (iPad)
and the server stores only the bcrypt hash. Every PIN-login request
sends the token; the server bcrypt-compares against
`device_token_hash`. Revoking a device sets `revoked_at` and the
token is rejected from then on.

`pin_login_attempts` is the source of truth for the per-device
lockout counter: count rows in the last 15 minutes for a device with
`outcome IN ('wrong_pin')` and trigger lockout at ≥ 5. This is more
flexible than maintaining a counter on `studio_devices` and gives us
free analytics ("how often does reception fat-finger their PIN?").

### Auth flow

**Setting a PIN (one-time, from any browser):**

1. Staffer logs into web CRM normally (email + password).
2. Goes to `/account` → "Set studio PIN".
3. Enters a 4-digit PIN, confirms it. Server checks global
   uniqueness — if taken, returns "that PIN is already in use,
   pick another." On success, hashed and written to
   `profiles.pin_hash` (UNIQUE constraint backstops a race).

**Pairing a studio device (one-time, by master):**

1. Master opens the Mac shell / iPad app for the first time. App
   detects no `device_token` in local secure storage.
2. App shows a "Pair this device" screen with a one-time code
   generated locally + the device's current public IP.
3. Master opens web CRM → `/admin/studio-devices` → "Pair new
   device", enters the code + a label + assigns to a location.
   The server checks the public IP shown matches the location's
   trusted IPs before pairing succeeds.
4. Server creates a `studio_devices` row with the bcrypt-hashed
   token, returns the cleartext token once, app stores it in
   secure storage.
5. Device is paired. PIN login enabled.

**PIN login (every shift / unlock):**

1. App POSTs to `/api/auth/pin-login` with: `device_token`, `pin`.
2. Server:
   - Looks up the device by bcrypt-matching the token, ensures
     `revoked_at IS NULL` and `locked_until IS NULL OR locked_until < now()`.
   - Checks the request IP against `location_trusted_ips` for the
     device's location. Reject if no match (logged as
     `outcome='untrusted_ip'` in `pin_login_attempts`).
   - PIN-matches across all active profiles globally (PIN
     uniqueness means at most one will match). Match → issue a
     standard Supabase session for that profile with a
     `pin_session: true` claim and `last_pin_activity_at: now()`.
   - No match → log `outcome='wrong_pin'`. Count attempts in the
     last 15 min; at ≥ 5 set `studio_devices.locked_until = now() + interval '15 minutes'`.
3. Device receives the session, persists it locally, behaves like
   a normal logged-in session — but with the 5-minute idle timer
   running. The returned session includes `home_screen_path` so
   the client knows where to navigate.

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

### Open questions

All Phase 0 decisions locked — see "Status & resume notes" at the
top. Remaining open items are scoped to Phases 1/2/3 and the
parked Phase 4.

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

### Auto-launch on boot

Tauri's `tauri-plugin-autostart` registers the Mac shell as a
launch daemon so it starts when the Mac boots, not just when the
user logs in. Reception staff arrive in the morning to a Mac that's
already showing the locked PIN screen — they don't have to click
anything before they can start working.

Implementation: `app.set_autostart(true)` on first launch after
pairing. The shell is its own thin process; if it crashes, macOS
relaunches it.

### Per-user landing URL

The Mac shell loads `profiles.home_screen_path` after PIN unlock —
the per-user setting from Phase 0. Default is `/dashboard`;
reception staff can edit it to `/schedule` from `/account` in the
web CRM. Different staffers on the same Mac see different landing
screens when they PIN in, which is the right behaviour for a
shared device.

No per-Mac config file or build variants needed — preference
follows the staffer, not the box.

### Auth (PIN gate provided by Phase 0)

Beneath the PIN gate, the Mac shell uses the same Supabase auth +
cookie session as the web CRM. The Tauri WKWebView persists cookies
across launches in its own data directory. PIN unlock either
creates the session (first use of the day) or just dismisses the
idle-lock overlay (mid-shift).

If a session expires and PIN re-auth also fails (e.g. studio
offline), the user sees the same email + password screen they'd see
in Safari. No separate Keychain integration for credentials.

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

### Offline support (locked: v2 offline-first)

In-class wifi is generally good but not always perfect, and a
missed attendance mark is unacceptable. v2 is the locked target.

**Implementation:**

- Every attendance tap writes to local SQLite (expo-sqlite) with
  a pending-sync flag set immediately. The roster UI reads from
  local state, so the user never waits on the network.
- A background sync engine drains the pending queue to the server
  whenever the device is online — POSTs each tap, marks the local
  row as synced on 200, leaves it pending on network error.
- The class-detail screen shows a "X marks pending" indicator
  while the queue is non-empty. Tapping it shows the per-mark
  state.
- On `End class`, if any marks are still pending, the finalise
  call is blocked until they sync. UX: "X marks still syncing,
  hold on" rather than a hard error.
- Conflict resolution: in practice this is one coach editing one
  class, so the conflict surface is tiny. If a conflict ever does
  occur (e.g. another staffer edits attendance for the same class
  from web while the iPad is offline), last-write-wins keyed by
  `marked_at` timestamp — the canonical row stores `marked_at`,
  `marked_by`, and the most recent wins. Rare enough that we
  don't surface a UI for it; audit log captures the changes.

**Sync state UI:**

- Header strip on the class screen: "Online" (green) / "Syncing X
  marks" (amber) / "Offline — X marks pending" (red).
- Auto-retry on reconnect with exponential backoff (1s, 2s, 5s,
  15s, 60s).

### Effort estimate

6–8 days for v2 offline-first. The simple "online-only" v1 path
would be 4–5 days but isn't on the table — v2 is the locked
target.

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
- **Phase 3 (Coach in-class v2 offline-first):** 6–8 days
- **Phase 4 (Kiosk):** scope separately, ~5–10 days depending on path

Total for Phases 0–3 (v2 in-class locked): **17–25 days** of focused
work, or four to six PRs over the course of three to four weeks.

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
- **PIN brute force from inside the studio** — anyone on studio
  wifi with a paired device can guess PINs at the rate-limit cap
  (5 attempts → 15-min cooldown per device). With 4-digit PINs
  and global uniqueness, expected break time against *any* staffer
  is ~10 days continuous (math in Phase 0 threat model). Acceptable
  given the network + pairing gates; revisit if it ever matters.
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
