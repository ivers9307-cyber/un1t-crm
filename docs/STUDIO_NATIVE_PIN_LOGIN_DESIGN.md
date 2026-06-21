# Studio Native PIN Login — token pairing + PIN tap-in in the CF Studio app

**Date:** 2026-06-21
**Status:** Design approved, implementation pending
**Extends:** [STUDIO_DEVICES_DESIGN.md](STUDIO_DEVICES_DESIGN.md) Phase 0 (PIN auth shipped web-only)

## Problem

Phase 0 shipped studio-device PIN auth (#138–#140), but **only on the
web kiosk** at `/studio-login`. An operator issues a device token in
`/admin/studio-devices`, opens `/studio-login` in the iPad browser,
pastes the token, and taps in with a 4-digit PIN — the server mints a
signed `studio_session` **cookie** that `getCurrentUser()` reads on
every server render.

The native CF Studio iOS app (`mobile/`) never got this. Its login
screen (`mobile/app/(auth)/login.jsx`) is plain Supabase
email/password. So when Richard issued a token expecting to enter it in
the native app, **there was nowhere to put it** — the token + PIN flow
and the native app are two unconnected surfaces.

This design builds the token-pairing + PIN tap-in flow **into the
native app**, so a shared front-desk iPad behaves as a true multi-user
kiosk: tap in your PIN → get exactly your access → hand off to the next
staffer.

## Goal

On a paired iPad, any staffer taps in their PIN and gets the full CF
Studio app scoped to *their* login (role + permissions + locations).
Inactivity or a "Return to PIN" button hands the device back to the PIN
pad; the next person taps in and the whole app dynamically becomes
theirs. No shared password, no email typing at the desk.

## Core architectural decision

**Each PIN mints a _real_ Supabase session for that staffer.**

The web kiosk works off a server-read cookie because the web app is
server-rendered. The native app is the opposite shape — most screens
(schedule, pipeline, contacts, …) read **straight from Supabase** under
the signed-in user's RLS-scoped session. A server-read cookie can't
authorize those client-side reads. So the PIN must produce a genuine
Supabase session, after which the *entire existing app works unchanged*
and "dynamically reflects who's logged in" for free.

Rejected alternative — a strict server-enforced kiosk using only the
`studio_session` token sent as a header — because it would require
re-routing every direct-Supabase screen through `/api/*`. Large, risky,
no benefit for this use case.

### Pairing state and session state are independent

The single idea that makes hand-off seamless:

- **Pairing state** (a device token in SecureStore) decides whether the
  app shows the **PIN pad** vs. the normal **email/password** login.
- **Session state** (a live Supabase session) decides whether we show
  the **app** vs. the **PIN pad**.

So a paired device with no active session shows the PIN pad — never the
email/password screen. That's what lets us fully sign out between
staffers without the desk ever seeing a login form.

| Paired? | Session? | Idle? | Shows |
|---------|----------|-------|-------|
| no      | —        | —     | email/password login (today's behaviour) |
| yes     | no       | —     | **PIN pad** |
| yes     | yes      | no    | the app, scoped to the signed-in user |
| yes     | yes      | yes (≥5 min) | **PIN pad** (after auto sign-out) |

## Locked decisions

- ✅ **Real Supabase session per PIN** (not a token-header kiosk).
- ✅ **Full sign-out on idle / Return to PIN**, not a screen-lock over a
  live session — so a resting device holds no valid session. The next
  PIN mints a fresh one.
- ✅ **Reuse the existing `/api/auth/pin-login` route** (extend it), not
  a new route. Web cookie path stays untouched.
- ✅ **Token entry is paste-only** for v1. QR scan deferred.
- ✅ **Face ID disabled in studio-device mode** — biometrics are
  one-person; a shared desk uses PIN. The idle-detection *logic* from
  the Face ID app-lock is reused; the unlock *action* becomes the PIN.
- ✅ **Cache each user's menu locally** (profile + permissions),
  encrypted, keyed per user, stale-while-revalidate. **No customer data
  and no session tokens cached** — a resting device holds nothing
  sensitive.
- ✅ Email/password login is kept as the path for **unpaired / personal**
  devices and as the "Forget this device" fallback. Pairing is additive.

## Design

### 1. Device pairing (one-time)

The native login screen gains a **"Set up as studio device"** affordance.
Tapping it reveals a token field (paste the token from
`/admin/studio-devices`) and an optional device label.

On submit the app length-checks the token (≥16 chars) and stores the
**cleartext token in `expo-secure-store`** (the native equivalent of the
web flow's localStorage), plus an optional device label, and marks the
app **paired**. From then on the app boots to the PIN pad.

This mirrors the web flow exactly: `StudioLogin.savePairing` does **no**
server round-trip at pairing — the token is validated on the **first PIN
tap-in** (`/api/auth/pin-login` rejects an unknown/revoked token with a
clear error). In practice the operator pairs then immediately tests a
PIN, so a bad token surfaces at once.

> *Optional nicety (deferred):* a token-only validation endpoint (or a
> `validate_only` mode on pin-login that skips the PIN) would give
> instant "token accepted" feedback at pairing instead of at first PIN.
> Small, but not required for v1 — left out to keep parity with web.

The cleartext token lives **only** in SecureStore on the device — same
posture as the web flow, hardened by iOS Keychain backing.

### 2. PIN → real session (the one backend change)

The native PIN pad auto-submits at 4 digits to the **existing**
`POST /api/auth/pin-login`, sending `{ device_token, pin, mint_session: true }`.

Today the route validates device + PIN + trusted IP + lockout, then
mints a `studio_session` cookie. We extend it: **when `mint_session` is
set**, after the same validation it ALSO mints a real Supabase session
for the matched profile and returns, in the JSON body:

```jsonc
{
  "success": true,
  "access_token":  "…",   // for the native app
  "refresh_token": "…",
  "profile":     { … },   // safe profile (same shape as /api/mobile/me)
  "locations":   [ … ],
  "activeLocation": { … },
  "permissions": { … }
}
```

The web kiosk path is unchanged — it ignores the body and reads the
`Set-Cookie`; native ignores the cookie and reads the body. One route,
both callers, DRY.

**Session-minting mechanism (server-side, no email sent):**

1. Resolve the matched profile's canonical auth email:
   `admin.auth.admin.getUserById(profile.id)` → `email`. (Use the auth
   email, not `profiles.email`, to be robust to drift.)
2. `admin.auth.admin.generateLink({ type: 'magiclink', email })` →
   `data.properties.hashed_token`. `generateLink` generates without
   sending an email.
3. Exchange it for a session on a throwaway anon client (no
   persistence): `verifyOtp({ token_hash, type: 'magiclink' })` →
   `data.session` with `access_token` + `refresh_token`.
4. Return those tokens in the response body.

> ⚠️ **Verify-early caveat.** `generateLink` + `verifyOtp` both exist in
> the pinned `@supabase/supabase-js ^2.45.0` (confirmed in
> `node_modules/@supabase/auth-js`). The exact server-side
> generate→verify→session round-trip is the one piece to smoke-test
> first during implementation (per the "verify against the live system,
> not the docs" lesson). If it misbehaves, the fallback is a dedicated
> Supabase admin session-mint, but generate+verify is the standard path.

**Speed — superseded by the per-user menu cache (§4).** An earlier draft
folded the full profile + permissions + locations into this response to
save a round-trip. Building that cleanly would mean either duplicating
the `/api/mobile/me` locations+permissions loader (a documented drift
hazard — the codebase has been bitten repeatedly by two loaders going
out of sync) or refactoring `getCurrentUser()` (the highest-blast-radius
function in the app). The per-user menu cache (§4) delivers the same
instant tap-in for the common case (returning staff) without either
risk, so **pin-login returns tokens only** plus the existing
`profile { id, full_name, home_screen_path }`; the app does its normal
`setSession` → `onAuthStateChange` → `/api/mobile/me` flow, with the
cache painting the menu before `/me` returns.

### 3. App boot & routing

`mobile/app/index.jsx` / the auth gate is extended to branch on pairing:

- **Unpaired** → existing behaviour (`(auth)/login` email+password).
- **Paired, no live session** → PIN pad screen.
- **Paired, live session, not idle** → `(tabs)` app as today.

The PIN pad + idle lock render **above** the normal routing (like the
Face ID lock overlay), so a session going null (on idle sign-out) drops
straight back to the PIN pad without ever flashing the email login.

### 4. Per-user menu cache (stale-while-revalidate)

To make a returning staffer's options paint instantly:

- On every successful `/api/mobile/me` (or pin-login response), write
  that user's `{ profile, locations, permissions }` to an **encrypted
  per-user cache** in SecureStore, keyed by `profile.id`.
- pin-login returns *who* the staffer is. The instant we know the id, if
  a cache entry exists for them we hydrate the auth context from it so
  their correct home screen + tab set render immediately, then let the
  live response/`/me` revalidate and overwrite.
- The cache holds **only** the menu-shaping blob — **never** customer
  data, **never** session tokens. Per-screen data (schedule, contacts,
  …) still loads against the live session with its existing skeletons;
  caching speeds up *the menu appearing*, not the data behind it.
- Speed-up applies on a staffer's **2nd+ tap-in** (cache hit by id).
  First-ever tap-in for a new staffer has nothing cached → normal load.

### 5. Hand-off: idle lock, Return to PIN, user-switching

Reuse the idle-detection from the Face ID app-lock
(`mobile/lib/biometric-lock-logic.js`, pure + already tested); swap the
unlock action.

- **5 min idle, OR tapping "Return to PIN"** → full sign-out: clear the
  Supabase session (SecureStore), unregister *this* user's push token
  (reuse the existing `unregisterCurrentDevicePush()` in `signOut`),
  drop to the PIN pad. Device now holds no valid session.
- **Next PIN mints a fresh session.** `supabase.auth.setSession(...)` →
  `onAuthStateChange` (already wired in `auth-context.jsx`) refetches
  `/me` and swaps profile + locations + permissions. **That is the
  user-switching** — Becky tapping in after Richard makes the whole app
  hers, for free, because the context is already driven by the session.
- Studio-device mode keeps Face ID **off** (one-person biometric on a
  shared desk is wrong); PIN is the only unlock.

Push-token hygiene on swap is critical and already half-solved: the
existing `signOut` unregisters the current device push token *before*
clearing the session, so the previous staffer stops receiving
lead/WhatsApp notifications (customer PII) the moment they hand off. We
ride that path on every idle/Return-to-PIN sign-out.

### 6. Active location

The device's home location comes back in the pin-login response (the
`studio_devices` row carries its location) as `activeLocation`; we cache
it and default each session's active location there (via the
`x-active-location` mechanism the app already uses). A multi-location
staffer can still switch in More; the default just saves a tap at the
desk.

### 7. Unpair

A **"Forget this studio device"** action (in More, behind a confirm)
clears the device token + per-user caches → the iPad reverts to normal
email/password login. Also the path for converting a kiosk back to a
personal device.

### 8. Security posture

Carried from Phase 0, all already enforced by `/api/auth/pin-login`:

- **Trusted-IP gate** — pin-login only succeeds from the studio wifi.
- **Per-device lockout** — `pin_login_attempts`, 5 tries → cooldown.
- **Token never logged**; stored only in SecureStore (Keychain-backed).
- **Clean hand-off** — full sign-out clears session + push registration
  so no residual prior-user access or notifications.

Honest tradeoffs on a shared device:

- Between PIN entries the session is a normal Supabase login (~1h JWT).
  The full-sign-out-on-idle is what keeps a *resting* device clean.
- The per-user menu cache stores role/permission shape (not secrets) at
  rest, encrypted, scoped per user id, and is wiped on unpair. It is
  only ever shown after the PIN resolves to that same user.

## Files touched (estimate)

**Backend (web repo, 1 route):**
- `src/app/api/auth/pin-login/route.js` — add the `mint_session` branch:
  session mint + profile/permissions payload. Web path untouched.
- Possibly a small `src/lib/studio-session-mint.js` helper for the
  generate→verify→session flow (keeps the route thin + unit-testable).

**Mobile (`mobile/`):**
- `mobile/app/(auth)/login.jsx` — add "Set up as studio device" pairing
  affordance.
- New PIN pad screen + a studio-lock overlay (reuse `LockScreen.jsx` /
  `biometric-lock.jsx` patterns).
- `mobile/lib/auth-context.jsx` — pairing-aware boot, PIN sign-in
  (setSession from response), studio sign-out (Return to PIN), cache
  hydrate/write.
- `mobile/app/index.jsx` / auth gate — branch on pairing state.
- New `mobile/lib/studio-device.js` — SecureStore pairing token + home
  location + per-user menu cache (pure-ish, unit-testable read/write).
- More tab — "Forget this studio device".

## Shipping

This requires a **native EAS build + TestFlight/App Store submission**,
**not** an OTA — it adds SecureStore-backed pairing, new boot routing,
and a new lock surface (native surface area, not just JS logic). Flag
the build step in the implementation plan; bump `runtimeVersion`.

## Out of scope / deferred

- **QR-scan token entry** (paste-only for v1).
- **Session-token caching** for sub-second repeat tap-ins (chosen
  against — keeps the device clean at rest).
- **Per-screen business-data caching** (PII at rest on a shared device).
- **Mac shell** native PIN — Phase 2 of the parent doc; same backend
  extension will serve it later.

## Test plan

- **Unit:** `studio-device.js` pairing/cache read-write; the session-mint
  helper (mock the admin client); the `mint_session` branch of pin-login
  (mock Supabase, assert tokens + profile in body, assert web cookie
  path unchanged when flag absent).
- **Manual (device/TestFlight):**
  1. Issue a token, pair the iPad (paste), confirm boot → PIN pad.
  2. Tap in PIN A → land in app as user A with A's tabs/permissions.
  3. Return to PIN → tap in PIN B → app is now user B (different access).
  4. Idle 5 min → auto sign-out → PIN pad; confirm no email-login flash.
  5. Confirm a returning user's menu paints instantly (cache hit);
     first-ever login does a normal load.
  6. Confirm push notifications stop for the previous user on hand-off.
  7. "Forget this device" → reverts to email/password login.
  8. Wrong-IP and lockout still reject (Phase 0 gates intact).
