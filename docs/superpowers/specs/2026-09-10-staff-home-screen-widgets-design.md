# Staff home-screen widgets: two tiles, one extension

**Date:** 2026-09-10
**Task id:** WIDGET.1
**Platform:** iOS only (iPhone home screen; iPad inherits the same widgets on the same binary)

## Decisions (Richard, 2026-09-10, brainstorming session)

Each of these was an explicit pick, not an inference:

| Question | Decision |
| --- | --- |
| Audience | **Staff.** Not members. |
| Which widgets | **Two:** Studio Controls (per location) and What Needs Me. |
| Button behaviour | **Everything direct**, door unlock included — no deep-link-only fallback. |
| Widget auth | **Dedicated widget token**, revocable per device. |
| Controls layout | **Configurable pad** — pick the studio, then pick up to four named devices. |
| Queue layout | **Counts by source** — three uncapped numbers, nothing named. |
| Freshness | **Timeline floor plus push-triggered reload.** |
| Sequencing | **Both widgets in one release.** |

The security concern about a one-tap door unlock on a home screen was raised at
the point of decision and Richard chose direct anyway; §6 records what that
means and the mitigations that ride along with it. The mitigations are not a
re-litigation of the decision.

## Why this is not a small change

A WidgetKit widget is SwiftUI running in a separate app-extension process. No
React Native runs in it, and **nothing about it can ever ship over OTA**. Every
line of widget Swift is a native change, which on this estate means:

- a `runtimeVersion` bump,
- an App Group and widget bundle identifier registered against **both** iOS
  bundle IDs (`ie.repset.app` and `com.un1tdublin.crm`),
- two EAS builds and two submissions under the two-build rule
  ([[repset-public-ios]]), and
- one App Review cycle.

That cost is fixed regardless of how much the widget does, which is why both
widgets ship together. There is no "add the second widget later over OTA" path.

## 1. The two widget kinds

One extension target registers two `Widget` kinds. Both take an
`AppIntentConfiguration`, so each placed instance is configured through the
long-press → Edit Widget sheet.

### Studio Controls

Configuration: **studio** (required), then **up to four devices** drawn from the
ones the signed-in staff member may control at that studio.

```
┌────────────────────────────────────┐
│  STILLORGAN                     ●  │
│  ┌──────┬──────┬──────┬──────┐     │
│  │  ⏯  │  ❄  │  ⚡  │  🔑  │     │
│  │Speak.│Gym fl│Sauna │Front │     │
│  └──────┴──────┴──────┴──────┘     │
└────────────────────────────────────┘
   medium: four buttons · small: two
```

**Sizes.** Medium renders four buttons; small renders the **first two** in
configured order, so the operator controls which survive the smaller tile by
ordering them in the configuration sheet. Large is not shipped in this release.

Every button names a specific device because the operator chose it. This is the
whole point of the configurable design: a studio has several Shelly relays,
several UniFi doors and several AC units, so a button labelled only "Plugs"
cannot know which relay was meant and would have to fall back to opening the
app — which would defeat the direct-action decision.

Two placed widgets cover Stillorgan and Hatch. Nothing about this widget reads
the app's active location.

### What Needs Me

Configuration: **studio** (required).

```
┌────────────────────────────────────┐
│  NEEDS YOU              STILLORGAN │
│  ┌────────┬────────┬────────┐      │
│  │   3    │   2    │   0    │      │
│  │APPROVAL│  MAIL  │ INBOX  │      │
│  └────────┴────────┴────────┘      │
└────────────────────────────────────┘
```

Three uncapped counts, nothing named. Tapping any column deep-links to that
surface in the app; tapping the tile background opens `/dashboard/today`.

**Sizes.** Medium renders the three-column breakdown above. Small renders the
**summed total only** — three columns do not survive that width legibly, and the
total is the one number that cannot be misread. Large is not shipped.

The studio picker is not optional polish. `assembleHomeQueue` is scoped to the
caller's active location — with no active location **the whole queue is empty,
not per-source** (`src/lib/home-queue.js` header). A widget has no notion of the
app's active location, so it must carry its own or it would render a confident
zero. Same picker as the controls widget, for consistency.

## 2. Getting a native target into a CNG app

`mobile/` has no committed `ios/` directory — native projects are generated at
prebuild. Three routes were considered:

1. **`@bacons/apple-targets`** (v5.0.0, published 2026-07-17, actively
   maintained). Widget Swift lives in `mobile/targets/widget/`; the plugin
   generates the Xcode target during prebuild. **Recommended.**
2. A bespoke config plugin built on `expo/config-plugins`. The repo already
   hand-writes plugins inline (`withUnionedBackgroundModes` in
   `mobile/app.config.js`), so the pattern is familiar — but generating a whole
   extension target, its entitlements and its build phases is a different order
   of work from a plist mod, and it is exactly the code that breaks on an Expo
   SDK bump.
3. Eject to bare and commit `ios/`. Rejected: it would forfeit CNG for the whole
   app to serve one extension.

Route 1 is the recommendation and Richard delegated the call. The residual risk
is a third-party plugin sitting in the build path of **both** iOS apps. If it
proves unreliable, route 2 is the fallback and the Swift written for route 1
transfers unchanged — only the target generation differs.

## 3. Auth: a dedicated widget token

The extension is a separate process and must not share the Supabase session.
Sharing it read-write would recreate the **two-clients-racing-the-refresh-token**
trap that already burned the one-app merge: both clients default to the same
SecureStore key, and rotation from one signs the other out.

Instead:

```
app  ──mints──▶ widget_tokens row ──writes──▶ App Group
                                                  │
widget ──Bearer <widget token>──▶ /api/…  ◀───────┘
```

**New table `widget_tokens`:**

| Column | Notes |
| --- | --- |
| `id` | uuid pk |
| `profile_id` | fk → profiles |
| `location_id` | the studio this token may act at |
| `token_hash` | hash, never the token itself |
| `device_label` | e.g. "Richard's iPhone" |
| `created_at`, `last_used_at` | `last_used_at` makes a stale token visible |
| `revoked_at` | null = live |

The app mints on first widget configuration and rewrites on sign-in. The token
lives in the App Group container, shared by both processes.

**`withAuth` gains an opt-in**, rather than a parallel `/api/widget/*`
namespace: a route declares `allowWidgetToken: true` and the wrapper will accept
either a session/JWT or a widget token. One authz implementation, and the
allowlist is visible at each route that enabled it. A parallel namespace would
be a second security boundary that could drift from the first — and on this
codebase routes are *the* tested security boundary.

Whatever the credential, the wrapper resolves the profile and re-checks
`canMobile(profile, perm, location)` server-side. The extension's opinion about
what it may do is never trusted.

**Revocation** lands in the CRM staff detail page: kill one phone's widget
without signing that person out of anything, and without touching the Supabase
refresh lane.

## 4. Endpoints

Existing routes, each gaining `allowWidgetToken: true`:

| Route | Used by |
| --- | --- |
| `POST /api/sonos/control` | speaker play/pause/volume |
| `POST /api/shelly/devices/{id}/toggle` | relay on/off |
| `POST /api/studio-management/ac/devices/{id}/turn-on`\|`turn-off` | AC unit |
| `POST /api/studio-management/unlock` | door unlock |
| `GET /api/home-queue/count` | the queue widget |

**One extension** to an existing route: `/api/home-queue/count` currently
returns a single summed `count`. `getHomeQueueCount` already computes the three
per-source numbers before summing them, so exposing the breakdown is additive
and costs no extra queries:

```jsonc
{ "success": true, "data": {
    "count": 5,
    "bySource": { "approvals": 3, "mail": 2, "inbox": 0 },
    "degraded": []          // sources that could not be checked
} }
```

Its existing 500-on-tickets-lookup-failure posture stays exactly as it is. The
widget mirrors `usePolledCount`: a non-ok response keeps the last good numbers
rather than rendering a confidently wrong all-clear.

**One genuinely new route:** `GET /api/widget/devices?locationId=` returns the
Sonos groups, Shelly relays, AC units and doors the caller may control at that
studio, each as `{ kind, id, label }`. This is what populates the configuration
picker. It composes the same per-surface permission gates the individual list
routes use — it does not invent a new one.

## 5. Refresh

Three layers, in order of who wins:

1. **Optimistic redraw** — the instant an AppIntent's `perform()` returns, the
   widget redraws with the new state. No round trip.
2. **Push-triggered reload** — the app calls
   `WidgetCenter.shared.reloadAllTimelines()` when a relevant push arrives, so a
   new approval reaches the tile in seconds. This touches the existing
   `expo-notifications` handler.
3. **Timeline floor** — 15–30 minutes, so a device with pushes muted still
   converges. WidgetKit throttles against a daily budget; the floor is a
   backstop, never the primary path.

## 6. The door button

The decision is one-tap-direct. Riding along with it:

- **Two-stage arm → fire**, mirroring the door screen the app already ships
  (`mobile/app/(staff)/doors/index.jsx`, STUDIO-HUB.1, which matches the web and
  UniFi mobile UX). The first tap arms and the button relabels; the second
  fires; it disarms itself after ~3 seconds. This is consistency with an
  established pattern, not a new invention.
- **Server-side re-check** of `studio_management` at that location on every
  call — the widget's configuration is a hint, never an authorisation.
- **An audit row per unlock, attributed to the widget token**, so "opened via
  widget from Richard's iPhone at 06:12" is legible after the fact.
- **Per-device revocation** (§3) is the answer to a lost phone.

**Latency risk to design against:** an AppIntent's `perform()` runs under a short
system budget, and `/api/studio-management/unlock` fans out to UniFi Access. The
intent should return as soon as the request is accepted and reflect failure in
the next redraw, rather than blocking on the full hardware round trip and
risking the system killing it mid-unlock.

## 7. The extension renders; it never decides

Every decision — which devices you may control, how counts are assembled,
whether a permission holds, what a source's true uncapped number is — stays
behind the API, where the existing JS test suite already covers it. Swift does
layout, HTTP and nothing else.

This is not stylistic. There is **no Swift test runner** in this repo and **no
RN component test runner** either (the standing rule from the phone Mail reader
work is that decisions belong in `mobile/lib/` precisely because that is where
they can be tested). Logic placed in the widget extension would be untestable by
construction, and it would be a second copy of rules that already exist.

## 8. Release mechanics — the traps this hits

- **`runtimeVersion` → 2.4.0.** Native, never OTA-able. Bump it in lockstep, per
  the log in `mobile/app.config.js`.
- **Two-build rule.** Widget bundle IDs (`ie.repset.app.widgets`,
  `com.un1tdublin.crm.widgets`) and App Groups (`group.ie.repset.app`,
  `group.com.un1tdublin.crm`) must exist for **both** records, built and
  submitted from `production` and `production-legacy`. Skipping the legacy build
  silently strands that installed base off the OTA lane.
- **EAS capability-sync reads the app config of the CWD.** Running
  `eas credentials` or `eas build` from a checkout whose entitlements do not
  match will un-tick capabilities on the App ID — this reverted a HealthKit tick
  twice during the one-app merge. Run both from the tree whose entitlements
  match the build.
- **`check:ota-paths` will fail** the moment `mobile/targets/` appears: the
  workflow's allowlist classifies every top-level entry under `mobile/` as
  bundle or non-bundle, and an unclassified path fails the check *and* the
  inline gate that aborts the publish. `mobile/targets/**` must be registered as
  **non-bundle** in `scripts/check-ota-trigger-paths.mjs`. Widget Swift never
  enters the Metro bundle, so an OTA publish on a widget-only change would be a
  no-op republish at 100% — precisely the failure the allowlist exists to stop.
- **`npx expo export` before the build**, per the standing pre-flight rule for
  anything touching the native runtime.
- **Widget target takes its own iOS 17.0 deployment target.** Interactive
  widgets require it; the app's own target is untouched, and devices below 17
  simply do not see the widgets in the gallery.

## 9. Testing

| Layer | How |
| --- | --- |
| `allowWidgetToken` opt-in | Web tests: valid token, revoked token, wrong location, expired, session-JWT still works on the same route |
| `bySource` breakdown | Web test against the existing `getHomeQueueCount` fixtures; assert the sum still equals `count` |
| `/api/widget/devices` | Web test per permission combination — a user without `device_control` at a studio gets no Sonos or Shelly entries |
| Revocation | Web test: revoked token 401s, and the staff member's app session still works |
| Widget rendering | **Device only.** Layout cannot be verified in jsdom — a green suite once shipped a toggle that did nothing. |

**Device checks owed before this is called done** (neither test suite can reach
them): widget appears in the gallery on iOS 17+; configuration sheet lists the
right devices per studio; each button actuates the right hardware; door arm→fire
behaves and audits; counts match the app; push reload lands within seconds; both
studios side by side stay independent; revoking a token kills the widget without
signing the app out.

## 10. Out of scope

Android widgets (a separate Glance/RemoteViews implementation), member-facing
widgets, Live Activities, Lock Screen accessory families, and iOS 18 Control
Center controls. Each is materially cheaper once this extension exists, and none
is required to make these two widgets useful.

## Open risks

1. **`@bacons/apple-targets` in the build path of both apps** (§2). Fallback is
   a bespoke plugin; the Swift transfers unchanged.
2. **AppIntent latency against UniFi Access** (§6). Mitigated by returning on
   acceptance rather than completion, but it needs a real measurement on a
   device before the door button is trusted.
3. **App Review on an unlisted record.** The legacy app still takes binary
   updates through review; the widget adds an App Group entitlement to both
   records, which is a credentials change on a path that has bitten before.
