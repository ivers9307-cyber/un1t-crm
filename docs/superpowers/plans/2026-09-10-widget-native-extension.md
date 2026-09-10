# WIDGET.1 Phase 2 — Native Widget Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the iOS WidgetKit extension — two widget kinds (**Studio Controls**, **What Needs Me**), their `AppIntentConfiguration`s, the App Group bridge that lets the RN app hand the extension a per-device token, and the two-build native release — on top of the Phase 1 backend (`docs/superpowers/plans/2026-09-10-widget-backend-foundation.md`, merged in PR #1673).

**Tech stack:** Expo SDK 57 / React Native 0.86, CNG (no committed `ios/`), `@bacons/apple-targets` 5.0.0, Swift 5 / SwiftUI / WidgetKit / AppIntents (iOS 17+), EAS Build.

---

## Spike findings — what Task 15 of Phase 1 verified, and how

This document **is** the output of Phase 1's Task 15 spike. Both open
questions came back answered, from primary sources, not memory:

### 1. The config-plugin API (`@bacons/apple-targets`)

```
$ npm view @bacons/apple-targets version time.modified repository.url
version = '5.0.0'
time.modified = '2026-07-17T19:36:08.255Z'
repository.url = 'git+https://github.com/evanbacon/expo-apple-targets.git'
```

50 published versions, MIT, single maintainer (`evanbacon`), last publish ~8
weeks before this spike. **Not abandoned** — this is the standard, widely-used
plugin for CNG apps that need a WidgetKit/Live Activity/App Clip extension;
there is no serious competing package. Its own README states the floor:
"requires at least CocoaPods 1.16.2 (ruby 3.2.0), Xcode 16 (macOS 15
Sequoia), and Expo SDK +53" — this app is SDK 57, comfortably inside that.

Fetched from `https://raw.githubusercontent.com/EvanBacon/expo-apple-targets/main/packages/apple-targets/README.md`. Confirmed, concretely:

- **Config file shape:** every target is a directory under `targets/`
  containing `expo-target.config.js` (object or function export). Recognised
  keys: `type` (`widget`, `share`, `action`, `watch`, … 40+), `name`
  (defaults to the directory name), `displayName`, **`deploymentTarget`
  (defaults to `18.0`)**, `bundleIdentifier`, `icon`, `colors`, `images`,
  `frameworks`, `entitlements`, `exportJs`.
- **App Group declaration:** on the **main app config**, not the target —
  `ios.entitlements['com.apple.security.application-groups']` in
  `app.config.js`. "App Groups automatically mirror from main config unless
  overridden in target" — a target's own `expo-target.config.js` does not
  need to repeat it.
- **Deployment target:** the `deploymentTarget` key in
  `expo-target.config.js`, per target. Defaults to `18.0`, which already
  clears the iOS 17 floor interactive widget buttons need — this plan still
  sets it explicitly to `'17.0'` (Task 3) to keep the widget installable on
  the oldest devices that support `Button(intent:)`, rather than silently
  inheriting whatever the package's next major version defaults to.
- **Swift source location:** directly inside `targets/<name>/` — no `ios/`
  subpath, no separate Xcode-side edit. "Target source files live outside
  `/ios` and remain unmodified during prebuild operations."
- **Bundle identifier / env var:** not driven by an env var *inside* the
  target config — driven **indirectly**, because `expo-target.config.js` can
  be a **function** that receives the resolved Expo config and computes its
  own `bundleIdentifier` from it (`bundleIdentifier: config.ios.bundleIdentifier + '.widgets'` — see Task 3). Since `mobile/app.config.js` is
  itself a function of `process.env.LEGACY_APP` (`bundleIdentifier:
  process.env.LEGACY_APP === '1' ? 'com.un1tdublin.crm' : 'ie.repset.app'`,
  read directly), and `expo prebuild`/`eas build` re-evaluate the **whole**
  config tree — including every `expo-target.config.js` — on each invocation,
  the widget's bundle id **follows the same env switch for free**: building
  with `LEGACY_APP=1` produces `com.un1tdublin.crm.widgets`; without it,
  `ie.repset.app.widgets`. No new env var is needed for the widget target.
- **`expo prebuild`:** generates/updates the Xcode target, links the
  `targets/<name>/` sources into it, writes `Info.plist` if absent, and
  writes a **generated** entitlements file per target
  (`ios/.targets/<productName>/generated.entitlements`) from the config's
  `entitlements` key — "Update config — never hand-edit generated files."
  Nothing under `targets/` needs anything hand-committed beyond the
  `expo-target.config.js` + Swift sources themselves; `ios/` stays
  uncommitted, exactly like the rest of this CNG app.

**Data-sharing API, found in the same README, which removes a whole task
this plan would otherwise have needed:** the package ships
`ExtensionStorage` for the JS side —

```js
import { ExtensionStorage } from "@bacons/apple-targets"
const storage = new ExtensionStorage("group.xxx")
storage.set("myKey", "myValue")
ExtensionStorage.reloadWidget()       // wraps WidgetCenter.shared.reloadAllTimelines()
```

— and the matching `UserDefaults(suiteName:)` read on the Swift side. This
**is** the App Group bridging module and the `WidgetCenter` reload call the
spec asked for; Task 4 wraps it rather than hand-rolling a native module.

### 2. The credentials question

Two sources agree, and one of them is this repo's own incident history:

- **Expo's own docs** (`docs.expo.dev/build-reference/ios-capabilities/`):
  capability sync is bidirectional and automatic on `eas build`. "If a
  supported entitlement is present in the entitlements file, then running
  `eas build` will enable it on Apple Developer Console." And the reverse:
  "If a capability is enabled for your app remotely, but not present in the
  native entitlements file, then running `eas build` will automatically
  disable it." The docs list App Groups as an ordinary supported capability
  — **no special-cased behaviour** versus HealthKit or Push Notifications.
  Sync can be turned off with `EXPO_NO_CAPABILITY_SYNC=1 eas build`, which
  this plan does **not** use (the point of the sync is that it's the thing
  that turns the App Group entitlement on for real). The docs document this
  specifically for `eas build`; they do not spell out `eas credentials` in
  the same words, so that half is not independently confirmed from Expo's
  docs.
- **This repo's own runbook**, `mobile/docs/store-release-one-app.md`, rule
  2: *"Run every `eas credentials` / `eas build` / `eas submit` from a
  checkout whose `mobile/app.config.js` contains the HealthKit plugin
  (post-P2 `main` qualifies). EAS capability-sync reads the app config of
  the CWD — running from a pre-merge tree UN-TICKS HealthKit on the App ID
  and has already reverted the portal capability twice."* This is a
  **verified incident**, not a doc claim — it happened twice, and it fixes
  the ambiguity the Expo doc leaves: all three commands are driven by
  whatever `mobile/app.config.js` resolves to **in the current working
  directory at invocation time**, and a checkout that is behind (a different
  worktree, an unmerged branch, a rebase in progress) is what causes a
  regression — **not** the act of switching bundle identifiers.

**Answer: one worktree.** Both `ie.repset.app` (profile `production`) and
`com.un1tdublin.crm` (profile `production-legacy`) must be built from the
**same** checkout, on the **same** commit, in the **same** session — run one,
then the other, without pulling, rebasing, or switching worktrees in between.
Capability sync operates per bundle identifier (each build's entitlements
file syncs only the App ID matching that build's own `bundleIdentifier`), so
running both from one up-to-date worktree makes both App IDs converge on the
*same* correct capability set — App Group included. Using **two separate
worktrees** would not remove this risk and could reintroduce exactly the
class of bug that bit HealthKit twice, if the two worktrees are ever not
byte-identical on `mobile/app.config.js` and `mobile/targets/` at the moment
each build runs. Task 14 states this as a hard precondition, not a
suggestion.

**Not verified, named plainly:** the exact interactive-widget-button system
time budget Apple enforces for an `AppIntent.perform()` invoked from a
widget is not published by Apple in a fetchable form, and this spike did not
attempt to find one — Step 3 (below) explicitly could not be attempted
either, for the same reason (needs Phase 1 deployed + a real device). Task
15 records the measurement as owed. The exact current-SDK signatures for
`AppEntity`, `EntityQuery`, `WidgetConfigurationIntent` and
`AppIntentTimelineProvider` were not re-verified against Apple's live
developer documentation in this spike (out of scope — only the two questions
above were) — Tasks 6-12 use the well-established WidgetKit/AppIntents
surface as of iOS 17-18, but Task 6 Step 1 tells the implementer to confirm
current signatures in Xcode before writing code, rather than trusting this
document as gospel on Apple's own API.

### 3. The door round trip — OWED, not attempted

**Prerequisite measurement, not a task an agent can run.** `POST
/api/studio-management/unlock` end-to-end from a phone on cellular, timing
from tap to the door's audible click. This needs Phase 1 **deployed** to
production (it is merged, not yet necessarily live at time of writing — check
`crm.repset.ie/api/openapi.json` for the route before assuming so) and a real
device on a real network; a spike session with no phone and no deployed
backend cannot produce this number. **Owner: Richard.** Blocks the decision
in Task 10 (does the door `AppIntent` return on acceptance or on completion)
— that decision is written as conditional on this measurement, not resolved
by this plan.

---

## File Structure

**New files**

| File | Responsibility |
| --- | --- |
| `mobile/targets/widgets/expo-target.config.js` | The widget extension's target config — App Group mirrors automatically, `deploymentTarget: '17.0'`, bundle id follows `LEGACY_APP` via the main config |
| `mobile/targets/widgets/Info.plist` | Extension `NSExtension` point identifier (`com.apple.widgetkit-extension`) |
| `mobile/targets/widgets/RepsetWidgets.swift` | `@main` `WidgetBundle` — registers both widget kinds |
| `mobile/targets/widgets/WidgetAPI.swift` | Shared URLSession helper: reads the App-Group-stored token, calls the four data/action routes |
| `mobile/targets/widgets/StudioEntity.swift` | `AppEntity` + `EntityQuery` for the studio picker (reads locally-stored studios, no network) |
| `mobile/targets/widgets/DeviceEntity.swift` | `AppEntity` + `EntityQuery` for the per-kind device pickers (calls `GET /api/widget/devices`) |
| `mobile/targets/widgets/StudioControlsIntents.swift` | `StudioControlsConfigurationIntent` + the four per-device-kind action `AppIntent`s (door, ac, plug, speaker) |
| `mobile/targets/widgets/StudioControlsWidget.swift` | Timeline provider + SwiftUI views (medium: 4 buttons, small: first 2) |
| `mobile/targets/widgets/WhatNeedsMeIntents.swift` | `WhatNeedsMeConfigurationIntent` (studio picker only) |
| `mobile/targets/widgets/WhatNeedsMeWidget.swift` | Timeline provider + SwiftUI views (medium: 3 counts, small: total) |
| `mobile/lib/widget-bridge.js` | Wraps `@bacons/apple-targets`'s `ExtensionStorage` — store/list/remove a studio's widget credential, trigger a reload |
| `mobile/lib/widget-bridge.test.js` | Tests for the above |
| `mobile/lib/widget-tokens-api.js` | Mobile wrapper for `GET/POST /api/widget/tokens`, `DELETE /api/widget/tokens/[id]`, `GET /api/widget/devices` |
| `mobile/app/(staff)/settings/widgets.jsx` | Mint/list/revoke screen — the only place a widget token is created |
| `src/app/api/sonos/control/route.test.js` (extend) | New cases for `player_id` |

**Modified files**

| File | Change |
| --- | --- |
| `scripts/check-ota-trigger-paths.mjs` | `NON_BUNDLE.targets` entry |
| `tests/ota-trigger-paths.test.js` | Fires/does-not-fire case for `mobile/targets/**` |
| `mobile/app.config.js` | `@bacons/apple-targets` plugin, App Group entitlement, `version` → `2.4.0`, `runtimeVersion` → `2.4.0` |
| `mobile/package.json` | `@bacons/apple-targets` dependency |
| `mobile/app/_layout.jsx` | Call `reloadWidgets()` from the existing notification-received path |
| `src/app/api/sonos/control/route.js` | Accept `player_id` as a third addressing mode (widget path) |
| `mobile/.eas/workflows/release.yml` | `build_ios_legacy` / `submit_ios_legacy` jobs |
| `docs/CHANGELOG.md` | One row |

---

## Task 1: Classify `mobile/targets/` as non-bundle — with the directory

**This must land before any Swift file does.** `check:ota-paths` classifies
every top-level entry under `mobile/`; an unclassified one fails both the local
gate and the inline check in `eas-update.yml` that **aborts an OTA publish**.

🔴 **Corrected during execution — this cannot be forward-declared.** The first
draft of this task said to add the `NON_BUNDLE` entry alone, leaving the
directory for Task 3. That fails: the same checker also reports a `NON_BUNDLE`
key with **no matching directory** as **STALE** and errors on it
(`scripts/check-ota-trigger-paths.mjs:261` — `stale` is every key not in
`trackedMobileEntries()`). Entry-without-directory and directory-without-entry
are both errors, so the classification and a tracked file under
`mobile/targets/` have to land in the **same commit**. A `README.md` is the
right tracked file: it makes the directory real, and it records this constraint
for whoever hits it next.

**Files:**
- Create: `mobile/targets/README.md`
- Modify: `scripts/check-ota-trigger-paths.mjs`
- Modify: `tests/ota-trigger-paths.test.js`

- [ ] **Step 1: Prove the gap is real before fixing it**

The classification is inert until the directory exists, so there is no normal
red test here. Prove it directly:

```bash
mkdir -p mobile/targets && touch mobile/targets/.gitkeep
npm run check:ota-paths
```
Expected: **FAIL**, naming `mobile/targets` as UNCLASSIFIED.

- [ ] **Step 2: Add the `NON_BUNDLE` entry**

In the `NON_BUNDLE` object in `scripts/check-ota-trigger-paths.mjs`:

```js
  targets: 'WIDGET.1 — Swift sources for the iOS widget extension (@bacons/apple-targets), generated into the Xcode project at prebuild. The extension is a SEPARATE binary target from the RN app and never runs the Metro bundle, so a Swift-only change must publish no OTA — it cannot take effect without a new native build regardless.',
```

- [ ] **Step 3: Replace the placeholder with the real README**

Delete `mobile/targets/.gitkeep` and write `mobile/targets/README.md`
explaining: what lives in the directory, that nothing in it enters the Metro
bundle, and that the README itself keeps the directory tracked because the
checker treats an entry with no directory as stale.

Run: `npm run check:ota-paths` → **clean**.

- [ ] **Step 4: Add the trigger-table case**

In `tests/ota-trigger-paths.test.js`, add to the `DOES_NOT_FIRE` table:

```js
    'the widget extension Swift sources (native-only, cannot OTA regardless)': [
      'mobile/targets/widgets/StudioControlsWidget.swift',
      'mobile/targets/widgets/expo-target.config.js',
      'mobile/targets/README.md',
    ],
```

This asserts the workflow's `paths:` filter does not fire for those files — a
different property from the classification, worth pinning separately.

- [ ] **Step 5: Prove the new case can fail**

Temporarily add a genuine bundle path (`'mobile/lib/foo.js'`) to that array and
confirm the test FAILS, then remove it. A table entry that passes regardless of
its contents is not a test.

- [ ] **Step 6: Verify and commit**

```bash
npm run check:ota-paths
npx vitest run tests/ota-trigger-paths.test.js
npx eslint scripts/check-ota-trigger-paths.mjs tests/ota-trigger-paths.test.js
git add scripts/check-ota-trigger-paths.mjs tests/ota-trigger-paths.test.js mobile/targets/README.md
git commit -m "WIDGET.1 — classify mobile/targets/ as non-bundle (with the directory)"
```

**Status: DONE** — landed as `21121b81` on `widget-phase2-ota-paths`.

---

## Task 2: Install and wire `@bacons/apple-targets`

**Files:**
- Modify: `mobile/package.json`
- Modify: `mobile/app.config.js`

- [ ] **Step 1: Add the dependency**

```bash
cd mobile
npm install @bacons/apple-targets@5.0.0
cd ..
npm install --package-lock-only --prefix mobile
```

Expected: `mobile/package.json` gains `"@bacons/apple-targets": "^5.0.0"` (or
whatever npm resolves; pin the exact `5.0.0` if you want the same
reproducibility the rest of `mobile/package.json` uses for Expo-owned
packages) and `mobile/package-lock.json` updates in the same commit — CLAUDE.md's
"Before pushing" rule: `eas build` runs a plain `npm ci`, which refuses a
mismatched lock.

- [ ] **Step 2: Declare the App Group entitlement**

In `mobile/app.config.js`, inside the `ios: { … }` block (after
`infoPlist`), add:

```js
    // WIDGET.1 — the App Group both the app and the widget extension read
    // and write through. ONE group id for both bundle identifiers: the
    // group is a shared-container namespace per Apple Developer Team, not
    // per app, and the two bundle ids (ie.repset.app / com.un1tdublin.crm)
    // never run side-by-side on the same device (LEGACY_APP is a build-time
    // switch, not a coexistence mode) — a device only ever has one of the
    // two installed, so there is nothing for the two to leak into each
    // other. The widget's own expo-target.config.js (mobile/targets/widgets/)
    // does not repeat this: @bacons/apple-targets mirrors an app-level App
    // Group onto every target automatically.
    entitlements: {
      'com.apple.security.application-groups': ['group.ie.repset.widgets'],
    },
```

- [ ] **Step 3: Register the plugin**

In the `plugins: [ … ]` array, add (after `expo-build-properties`, at the
end — plugin ORDER matters elsewhere in this file for Info.plist mod
composition, but `@bacons/apple-targets` only touches the Xcode project
structure and target linking, not `UIBackgroundModes`, so it does not need
to sit before/after `withUnionedBackgroundModes`):

```js
    // WIDGET.1 — generates the WidgetKit extension Xcode target from
    // mobile/targets/widgets/ at prebuild. NATIVE module (a whole extra
    // Xcode target + App Group entitlement) → new EAS Build, NOT an OTA.
    '@bacons/apple-targets',
```

- [ ] **Step 4: Bump `version` and `runtimeVersion`**

Change `version: '2.3.1'` to `version: '2.4.0'`, and add a dated comment to
the existing version-history comment block (immediately above the `version`
line) following the file's own convention:

```js
  // 2.4.0 (WIDGET.1) — adds the iOS home-screen widget extension (Studio
  // Controls, What Needs Me): a new Xcode target via @bacons/apple-targets,
  // an App Group entitlement, and the AppIntents that let a widget button
  // fire a door/AC/plug/speaker command or a studio-picker config without
  // opening the app. NATIVE change (new target, new entitlement) → new EAS
  // Build + store release, NOT an OTA; runtimeVersion bumps to 2.4.0 in
  // lockstep — see the runtimeVersion log below. Two-build rule applies
  // (Task 14): both ie.repset.app and com.un1tdublin.crm ship this in the
  // same release.
```

Change `runtimeVersion: '2.3.0'` to `runtimeVersion: '2.4.0'`, and append the
matching entry to that block's own history comment, mirroring the 2.3.0
entry's shape:

```js
  //
  // 2.4.0 — WIDGET.1 adds a WidgetKit extension target (@bacons/apple-targets)
  // and an App Group entitlement — a new native surface, so a fresh OTA lane
  // is mandatory: 2.3.x installs freeze (NOT crash) until users install the
  // 2.4.0 binary. Merge only as part of the 2.4.0 store release (Task 14).
```

- [ ] **Step 5: Confirm the OTA gate is still clean**

Run: `npm run check:ota-paths`
Expected: `OTA trigger paths: clean` — `mobile/app.config.js` is already in
the trigger allowlist (it always has been, for `runtimeVersion`), so this
step is a regression check, not a new classification.

- [ ] **Step 6: Commit**

```bash
git add mobile/package.json mobile/package-lock.json mobile/app.config.js
git commit -m "WIDGET.1 — install @bacons/apple-targets, App Group entitlement, bump to 2.4.0"
```

---

## Task 3: Scaffold the widget extension target

**No automated test exists for this — there is no Swift test runner in this
repo, and jsdom cannot see native layout (see the LESSONS entry this plan's
exit gate is built around).** Each step below is verified by running the
real tool and reading its real output, not by a green suite. Before writing
any `AppIntent`/`WidgetConfigurationIntent`/`AppEntity` conformance in this
or later tasks, **open Xcode's Quick Help (or developer.apple.com) for the
current SDK** — Apple has revised this surface across iOS 17/18, and this
plan's Swift is written against the well-established shape as of that
window, not re-verified against whatever SDK ships on the machine that
implements this.

**Files:**
- Create: `mobile/targets/widgets/expo-target.config.js`
- Create: `mobile/targets/widgets/Info.plist`

- [ ] **Step 1: Write the target config**

```js
// mobile/targets/widgets/expo-target.config.js
// WIDGET.1 — the WidgetKit extension target. Function form so the bundle
// identifier and the App Group both follow the SAME env-driven main config
// mobile/app.config.js already resolves (LEGACY_APP=1 switches the whole
// app between ie.repset.app and com.un1tdublin.crm; this target's id
// follows without any new env var — see the Task 15 spike notes in
// docs/superpowers/plans/2026-09-10-widget-native-extension.md).
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'widget',
  name: 'widgets',
  displayName: 'Repset Widgets',
  // Interactive widget buttons (Button(intent:)) need iOS 17+. Pinned
  // explicitly rather than left at the package's own 18.0 default so this
  // widget stays installable on iOS 17 devices — do not remove this line
  // to "match the default", the default is a moving target across package
  // versions and this repo's floor is a deliberate choice, not an accident.
  deploymentTarget: '17.0',
  // No entitlements key here: @bacons/apple-targets mirrors the app-level
  // App Group (mobile/app.config.js ios.entitlements) onto every target
  // automatically. Do not duplicate it here — see the Task 15 spike notes.
  frameworks: ['SwiftUI', 'WidgetKit', 'AppIntents'],
})
```

- [ ] **Step 2: Write the extension Info.plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Repset Widgets</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
```

- [ ] **Step 3: Confirm the OTA gate sees the new directory and is still clean**

Run: `npm run check:ota-paths`
Expected: `OTA trigger paths: clean` — `targets` now exists under `mobile/`
and is classified in `NON_BUNDLE` (Task 1), so it reports as one of the
non-bundle entries, not as unclassified.

- [ ] **Step 4: Prebuild and inspect the generated project**

Run: `cd mobile && npx expo prebuild -p ios --clean`

Expected: exits 0. Read the output for a line naming the `widgets` target
being created (`@bacons/apple-targets`'s prebuild logging names each target
it links). Then:

```bash
ls mobile/ios/.targets/widgets/ 2>/dev/null
grep -c "com.apple.security.application-groups" mobile/ios/.targets/widgets/generated.entitlements
```

Expected: the generated entitlements file exists and contains the App Group
key (count ≥ 1). **Do not commit anything under `mobile/ios/`** — it is
CNG-generated and gitignored, exactly like the rest of this repo's native
projects; if `git status` shows anything under `mobile/ios/`, the
`.gitignore` is missing an entry and that is a separate problem to fix
before continuing, not something to add to this commit.

- [ ] **Step 5: Commit**

```bash
git add mobile/targets/widgets/expo-target.config.js mobile/targets/widgets/Info.plist
git commit -m "WIDGET.1 — scaffold the widgets Xcode target (@bacons/apple-targets)"
```

---

## Task 4: The App Group bridging module

This is the one piece of Phase 2 that is pure JS and genuinely unit-testable
— it is a thin wrapper, but its key-naming and JSON shape are exactly the
contract the Swift side (Task 7's `WidgetAPI.swift`) reads, so getting it
wrong here is invisible until a device test.

**Files:**
- Create: `mobile/lib/widget-bridge.js`
- Create: `mobile/lib/widget-bridge.test.js`

- [ ] **Step 1: Write the failing test**

```js
// mobile/lib/widget-bridge.test.js
// WIDGET.1 — the App Group bridge. Mocked the same way push-register.test.js
// mocks expo-device/expo-notifications, so this stays node-runnable
// alongside the rest of mobile/lib's pure tests (no RN component runner
// exists here — this is deliberately pure logic, not a rendered screen).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = vi.hoisted(() => ({ data: {} }))

vi.mock('@bacons/apple-targets', () => ({
  ExtensionStorage: class {
    constructor(groupId) { this.groupId = groupId }
    set(key, value) { store.data[key] = value }
    get(key) { return store.data[key] ?? null }
    remove(key) { delete store.data[key] }
    static reloadWidget = vi.fn()
  },
}))

import { ExtensionStorage } from '@bacons/apple-targets'
import {
  APP_GROUP,
  storeWidgetCredential,
  listStoredStudios,
  removeWidgetCredential,
  reloadWidgets,
} from './widget-bridge'

beforeEach(() => {
  store.data = {}
  vi.clearAllMocks()
})

describe('storeWidgetCredential / listStoredStudios', () => {
  it('stores a credential keyed by location id, and lists it back', () => {
    storeWidgetCredential({
      locationId: 'loc-1', locationName: 'Stillorgan', tokenId: 't1', token: 'rwt_abc',
    })
    const studios = listStoredStudios()
    expect(studios).toEqual([
      { locationId: 'loc-1', locationName: 'Stillorgan', tokenId: 't1', token: 'rwt_abc' },
    ])
  })

  it('overwrites the same location rather than duplicating it', () => {
    storeWidgetCredential({ locationId: 'loc-1', locationName: 'Stillorgan', tokenId: 't1', token: 'rwt_old' })
    storeWidgetCredential({ locationId: 'loc-1', locationName: 'Stillorgan', tokenId: 't2', token: 'rwt_new' })
    const studios = listStoredStudios()
    expect(studios).toHaveLength(1)
    expect(studios[0].token).toBe('rwt_new')
  })

  it('holds more than one studio at once', () => {
    storeWidgetCredential({ locationId: 'loc-1', locationName: 'Stillorgan', tokenId: 't1', token: 'rwt_a' })
    storeWidgetCredential({ locationId: 'loc-2', locationName: 'Hatch Street', tokenId: 't2', token: 'rwt_b' })
    expect(listStoredStudios().map((s) => s.locationId).sort()).toEqual(['loc-1', 'loc-2'])
  })

  it('returns an empty list with nothing stored', () => {
    expect(listStoredStudios()).toEqual([])
  })

  it('survives a corrupt stored value rather than throwing', () => {
    store.data.repset_widget_studios = '{not json'
    expect(listStoredStudios()).toEqual([])
  })
})

describe('removeWidgetCredential', () => {
  it('drops one studio and leaves the rest', () => {
    storeWidgetCredential({ locationId: 'loc-1', locationName: 'A', tokenId: 't1', token: 'rwt_a' })
    storeWidgetCredential({ locationId: 'loc-2', locationName: 'B', tokenId: 't2', token: 'rwt_b' })
    removeWidgetCredential('loc-1')
    expect(listStoredStudios().map((s) => s.locationId)).toEqual(['loc-2'])
  })

  it('is a no-op for a location that was never stored', () => {
    storeWidgetCredential({ locationId: 'loc-1', locationName: 'A', tokenId: 't1', token: 'rwt_a' })
    removeWidgetCredential('loc-nope')
    expect(listStoredStudios()).toHaveLength(1)
  })
})

describe('reloadWidgets', () => {
  it('reloads all timelines via ExtensionStorage', () => {
    reloadWidgets()
    expect(ExtensionStorage.reloadWidget).toHaveBeenCalledWith()
  })

  it('never throws when the native module is unavailable (e.g. Expo Go)', () => {
    ExtensionStorage.reloadWidget.mockImplementationOnce(() => { throw new Error('no native module') })
    expect(() => reloadWidgets()).not.toThrow()
  })
})

describe('APP_GROUP', () => {
  it('matches the entitlement declared in app.config.js', () => {
    // Hand-checked against mobile/app.config.js ios.entitlements — there is
    // no runtime way to read the OTHER side of this pairing from a test, so
    // this assertion is a tripwire: change one without the other and this
    // still passes, which is exactly why the app.config.js comment on the
    // entitlement points back at this constant by name.
    expect(APP_GROUP).toBe('group.ie.repset.widgets')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run mobile/lib/widget-bridge.test.js`
Expected: FAIL — `Failed to resolve import "./widget-bridge"`.

- [ ] **Step 3: Write the implementation**

```js
// mobile/lib/widget-bridge.js
// WIDGET.1 — the App Group bridge between the RN app and the widget
// extension. Wraps @bacons/apple-targets's ExtensionStorage rather than
// hand-rolling a native module — the package already ships exactly this
// (NSUserDefaults(suiteName:) under the hood on both sides), documented at
// https://github.com/EvanBacon/expo-apple-targets (packages/apple-targets/README.md).
//
// A device may hold widgets for MORE than one studio (a staff member who
// works two locations), so the store is a small array keyed by location_id
// under ONE key, not one key per studio — the widget's studio-picker
// AppIntent (StudioEntity.swift) reads this same array to populate its
// choices, entirely offline: picking a studio in the widget's config sheet
// never makes a network call, only minting a NEW credential does.
//
// MUST stay in the App Group the widget extension actually reads —
// mobile/app.config.js's ios.entitlements declares the same string, and
// mobile/targets/widgets/expo-target.config.js inherits it automatically
// (see the Task 15 spike notes). If you ever rename this, rename the
// entitlement in app.config.js in the SAME commit.

import { ExtensionStorage } from '@bacons/apple-targets'

export const APP_GROUP = 'group.ie.repset.widgets'
const STUDIOS_KEY = 'repset_widget_studios'

const storage = new ExtensionStorage(APP_GROUP)

/**
 * @typedef {object} StoredStudioCredential
 * @property {string} locationId
 * @property {string} locationName   - for the config-sheet label; never re-fetched by the extension
 * @property {string} tokenId        - the widget_tokens.id, for display/troubleshooting only
 * @property {string} token          - the plaintext rwt_ token, the ONLY copy outside the server's hash
 */

/** @returns {StoredStudioCredential[]} */
export function listStoredStudios() {
  const raw = storage.get(STUDIOS_KEY)
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** @param {StoredStudioCredential} cred */
export function storeWidgetCredential(cred) {
  const rest = listStoredStudios().filter((s) => s.locationId !== cred.locationId)
  storage.set(STUDIOS_KEY, JSON.stringify([...rest, cred]))
}

/** @param {string} locationId */
export function removeWidgetCredential(locationId) {
  const rest = listStoredStudios().filter((s) => s.locationId !== locationId)
  storage.set(STUDIOS_KEY, JSON.stringify(rest))
}

/**
 * Ask every placed widget to refresh its timeline now. Called from:
 *   - the mint/revoke screen (Task 5), right after a credential changes,
 *   - the push-received handler (Task 13), as a best-effort nudge.
 * ExtensionStorage.reloadWidget() throws in an environment with no native
 * module (Expo Go, a stale dev client pre-prebuild) — this must never take
 * down whatever called it for that reason.
 */
export function reloadWidgets() {
  try {
    ExtensionStorage.reloadWidget()
  } catch {
    // best-effort — see the comment above.
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run mobile/lib/widget-bridge.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/widget-bridge.js mobile/lib/widget-bridge.test.js
git commit -m "WIDGET.1 — App Group bridge (ExtensionStorage wrapper)"
```

---

## Task 5: Mint the token from the app

**Files:**
- Create: `mobile/lib/widget-tokens-api.js`
- Create: `mobile/app/(staff)/settings/widgets.jsx`

- [ ] **Step 1: Write the API wrapper**

Mirrors `mobile/lib/studio-mgmt-api.js`'s shape exactly — thin, one function
per route, `api()` does the auth headers.

```js
// mobile/lib/widget-tokens-api.js
// WIDGET.1 — mobile-side wrapper for the widget-credential routes. These
// are SESSION-only routes (src/app/api/widget/tokens/*) — the widget
// extension itself never calls them; only this screen, while the staff
// member is signed into the app, does.

import { api } from './api'

export function listWidgetTokens() {
  return api('/api/widget/tokens')
}

export function mintWidgetToken(locationId, deviceLabel) {
  return api('/api/widget/tokens', {
    method: 'POST',
    locationId,
    body: deviceLabel ? { device_label: deviceLabel } : {},
  })
}

export function revokeWidgetToken(tokenId) {
  return api(`/api/widget/tokens/${tokenId}`, { method: 'DELETE' })
}

export function listWidgetDevices(locationId) {
  return api('/api/widget/devices', { locationId })
}
```

- [ ] **Step 2: Write the screen**

```jsx
// mobile/app/(staff)/settings/widgets.jsx
// WIDGET.1 — the ONLY place a widget credential is minted. Mints a
// per-device token scoped to the CURRENTLY resolved studio, stores it in
// the App Group (mobile/lib/widget-bridge.js) so the widget extension can
// read it, and asks any placed widget to refresh immediately rather than
// waiting for the next timeline tick.
//
// A staff member who works multiple studios mints once per studio they
// want a widget for — the widget's own config sheet (native, Task 8) then
// picks among whatever is stored here.

import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as Device from 'expo-device'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { resolveControlLocation, pickerLocations } from '../../../lib/control-location'
import { usePhysicalLocation } from '../../../lib/use-physical-location'
import { mintWidgetToken, revokeWidgetToken } from '../../../lib/widget-tokens-api'
import { storeWidgetCredential, removeWidgetCredential, listStoredStudios, reloadWidgets } from '../../../lib/widget-bridge'
import LocationPill from '../../../components/LocationPill'

export default function WidgetsSettingsScreen() {
  const { profile, activeLocation, locations } = useAuth()
  const phys = usePhysicalLocation()
  const { location: controlLocation, source } = resolveControlLocation({
    overrideId: null, physical: phys, activeLocation, locations,
  })
  const locationId = controlLocation?.id
  const allowed = canMobile(profile, 'studio_management', controlLocation)
    || canMobile(profile, 'device_control', controlLocation)
  const pickable = pickerLocations(profile, locations, 'studio_management')

  const [stored, setStored] = useState(() => listStoredStudios())
  const [minting, setMinting] = useState(false)

  const refresh = useCallback(() => setStored(listStoredStudios()), [])

  const alreadyMinted = stored.some((s) => s.locationId === locationId)

  async function mint() {
    if (!locationId || minting) return
    setMinting(true)
    const label = Device.deviceName || 'iPhone'
    const res = await mintWidgetToken(locationId, label)
    setMinting(false)
    if (!res.success) {
      Alert.alert('Could not create widget', res.error || 'Unknown error')
      return
    }
    storeWidgetCredential({
      locationId,
      locationName: controlLocation?.name || 'Studio',
      tokenId: res.data.id,
      token: res.data.token,
    })
    reloadWidgets()
    refresh()
  }

  async function revoke(studio) {
    Alert.alert('Remove this widget?', `${studio.locationName} widgets on this phone will stop working immediately.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          await revokeWidgetToken(studio.tokenId)
          removeWidgetCredential(studio.locationId)
          reloadWidgets()
          refresh()
        },
      },
    ])
  }

  if (!allowed) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <Text className="text-sm text-un1t-subtle text-center">
          Home-screen widgets aren&apos;t enabled for your role at this studio.
        </Text>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      <LocationPill location={controlLocation} source={source} pickable={pickable} className="mb-4" />
      <Text className="text-sm text-un1t-subtle mb-4">
        Add a widget for a studio, then long-press your home screen to place it.
      </Text>

      <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mb-4">
        <View className="flex-row items-center mb-3">
          <Ionicons name="apps-outline" size={18} color="#A855F7" />
          <Text className="text-xs font-bold text-un1t-text uppercase tracking-wider ml-2">This studio</Text>
        </View>
        {alreadyMinted ? (
          <Text className="text-sm text-un1t-subtle">
            {controlLocation?.name} is already set up for widgets on this phone.
          </Text>
        ) : (
          <Pressable
            onPress={mint}
            disabled={minting || !locationId}
            className="bg-un1t-accent rounded-xl px-4 py-3 items-center active:opacity-80"
          >
            {minting
              ? <ActivityIndicator color="#fff" />
              : <Text className="text-sm font-semibold text-white">Add widget for {controlLocation?.name || 'this studio'}</Text>}
          </Pressable>
        )}
      </View>

      {stored.length > 0 && (
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
          <View className="flex-row items-center mb-3">
            <Ionicons name="phone-portrait-outline" size={18} color="#A855F7" />
            <Text className="text-xs font-bold text-un1t-text uppercase tracking-wider ml-2">On this phone</Text>
          </View>
          {stored.map((s, i) => (
            <View
              key={s.locationId}
              className={`flex-row items-center justify-between py-3 ${i < stored.length - 1 ? 'border-b border-un1t-border' : ''}`}
            >
              <Text className="text-base text-un1t-text">{s.locationName}</Text>
              <Pressable onPress={() => revoke(s)}>
                <Text className="text-sm text-red-600">Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  )
}
```

- [ ] **Step 3: Wire the route into navigation**

Run: `grep -rn "settings/notifications\|(staff)/settings" mobile/app/(staff) --include=*.jsx -l | head -5`
Follow whatever pattern the existing settings screens under
`app/(staff)/settings/` use to appear in a menu (expo-router file-based
routing means the file alone makes `/  (staff)/settings/widgets` navigable;
find wherever the settings **list** is rendered and add an entry, matching
its existing row shape exactly — read that file before editing it).

- [ ] **Step 4: Run the mobile lint and the affected tests**

Run: `npx vitest run mobile/lib/widget-tokens-api.test.js 2>/dev/null; echo "(no test file for this thin wrapper — it has no branching logic; widget-bridge.test.js covers the storage half)"`
Run: `npm run check:mobile-lint`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/widget-tokens-api.js "mobile/app/(staff)/settings/widgets.jsx"
git commit -m "WIDGET.1 — mint/list/revoke widgets from the app"
```

---

## Task 6: `POST /api/sonos/control` accepts a `player_id` (widget path)

**Discovered during this spike, not assumed:** `GET /api/widget/devices`
offers **speaker** entries by **player id** (Task 11b of Phase 1, and
correctly so — player ids are permanent, group ids are not). But `POST
/api/sonos/control` (the only route that fires a Sonos action) currently
accepts only `schedule_id` or `group_id` in its body — nothing that resolves
a bare player id to a group. Every existing caller (the web Sonos panel, the
mobile Sonos card) goes through a schedule, which already carries
`player_ids` and resolves them server-side via `resolveGroupIds()`
(`src/lib/sonos/groups.js`) at call time.

The widget has no schedule — it has exactly one player id, chosen at
configuration time. Without this task, firing the widget's speaker button
would need **two** requests from the `AppIntent` (fetch the household to
resolve the current group, then post the action) inside the same tight
system budget the door button is already a risk for (Step 3, owed). Adding
`player_id` as a third addressing mode keeps every widget button — door, AC,
plug, speaker — a single request, and reuses the exact resolution helper
`runLiveAction` already imports, so there is no second implementation of
"which group is this player in right now" to drift.

**Files:**
- Modify: `src/app/api/sonos/control/route.js`
- Modify: `src/app/api/sonos/control/route.test.js`
- Modify: `src/lib/sonos/live.js`
- Modify: `src/lib/sonos/live.test.js`

- [ ] **Step 1: Read the current three-argument shape**

Run: `sed -n '1,40p' src/lib/sonos/live.js`
`runLiveAction(db, locationId, { scheduleId } | { groupId }, action, value)`
is the function whose second-to-last positional argument this task extends
to a third variant, `{ playerId }`.

- [ ] **Step 2: Write the failing test for `live.js`**

Append to `src/lib/sonos/live.test.js` (read its existing `makeGroupsRes` /
mock-`getSonosConfig` idiom first — do not introduce a second mocking style):

```js
describe('runLiveAction with a bare player id (WIDGET.1)', () => {
  it('resolves the group the player is currently in and applies the action there', async () => {
    // Reuses the same household-groups fixture the schedule-based tests use;
    // the player id below must exist in that fixture's players list.
    const db = makeDb()
    mockHousehold({ players: [{ id: 'RINCON_PLAYER1', name: 'Studio A' }], groups: [{ id: 'RINCON_PLAYER1:1', playerIds: ['RINCON_PLAYER1'] }] })

    const out = await runLiveAction(db, 'loc-1', { playerId: 'RINCON_PLAYER1' }, 'play')

    expect(out.ok).toBe(true)
    expect(out.groups).toEqual(['RINCON_PLAYER1:1'])
  })

  it('answers not_found for a player id that is not in the current household', async () => {
    const db = makeDb()
    mockHousehold({ players: [{ id: 'RINCON_OTHER', name: 'Studio B' }], groups: [{ id: 'RINCON_OTHER:1', playerIds: ['RINCON_OTHER'] }] })

    const out = await runLiveAction(db, 'loc-1', { playerId: 'RINCON_GONE' }, 'play')

    expect(out.ok).toBe(false)
    expect(out.code).toBe('not_found')
  })
})
```

Adjust `mockHousehold`/`makeDb` to whatever the file's real test helpers are
actually named — `grep -n "function makeDb\|function mockHousehold\|function makeGroupsRes" src/lib/sonos/live.test.js` first, since inventing helper
names that don't match the file makes this step fail for the wrong reason.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/lib/sonos/live.test.js`
Expected: FAIL — `{ playerId }` is not a case `runLiveAction` currently
handles (either a thrown type error or a `db_error`/`invalid` result,
depending on how the destructuring falls through today).

- [ ] **Step 4: Implement**

In `src/lib/sonos/live.js`, wherever the function destructures its `target`
argument into `scheduleId`/`groupId` (read the surrounding lines first —
this is a targeted addition, not a rewrite), add the third branch:

```js
  // WIDGET.1 — a bare player id, resolved to whatever group it is CURRENTLY
  // in. Schedule-based and group-id addressing both existed before the
  // widget did; this is the third mode, used ONLY by the widget's per-device
  // AppIntents (a widget configures a PLAYER, never a group — group ids are
  // ephemeral, see src/lib/sonos/groups.js:28).
  if (target.playerId) {
    const groupsRes = await sonosGetGroups(tok.token, tok.householdId)
    if (!groupsRes.ok) return { ok: false, code: 'unreachable' }
    const { groups } = mapGroups(groupsRes.body)
    const groupIds = resolveGroupIds(groups, [target.playerId])
    if (groupIds.length === 0) return { ok: false, code: 'not_found' }
    return applyToGroups(groupIds, action, value) // however the existing scheduleId/groupId branches converge — call the SAME shared tail, do not duplicate it
  }
```

Read the function's existing control flow before writing this — the
"shared tail" comment above is describing intent (reuse whatever the
existing two branches already converge on to actually issue the Sonos call
and shape the return value), not naming a real function that may or may not
exist under that name.

- [ ] **Step 5: Extend the route's schema**

In `src/app/api/sonos/control/route.js`:

```js
const Body = z.object({
  schedule_id: z.string().optional(),
  group_id: z.string().min(1).max(128).optional(),
  // WIDGET.1 — a Sonos PLAYER id (permanent), never a group id (ephemeral).
  // The widget is the only caller of this field: it stores a player id at
  // configuration time and this is what lets it still work after the
  // studio's speakers get regrouped.
  player_id: z.string().min(1).max(128).optional(),
  action: z.enum(ACTIONS),
  value: z.union([z.number(), z.string()]).optional(),
}).refine(
  (b) => [b.schedule_id, b.group_id, b.player_id].filter(Boolean).length === 1,
  { message: 'Exactly one of schedule_id, group_id or player_id' }
)
```

And in the handler, extend the three-way dispatch (mirroring the existing
`scheduleId ? { scheduleId } : { groupId }`):

```js
    const { schedule_id: scheduleId, group_id: groupId, player_id: playerId, action, value } = parsed.data
    const target = scheduleId ? { scheduleId } : groupId ? { groupId } : { playerId }
```

- [ ] **Step 6: Add the route-level failing test, then run everything**

Append to `src/app/api/sonos/control/route.test.js`:

```js
it('accepts player_id as the sole addressing mode', async () => {
  runLiveAction.mockResolvedValue({ ok: true, groups: ['g1'] })
  const res = await POST(new Request('https://x.test', {
    method: 'POST',
    body: JSON.stringify({ player_id: 'RINCON_1', action: 'play' }),
  }))
  expect(res.status).toBe(200)
  expect(runLiveAction).toHaveBeenCalledWith(expect.anything(), expect.anything(), { playerId: 'RINCON_1' }, 'play', undefined)
})

it('refuses two addressing modes at once, player_id included', async () => {
  const res = await POST(new Request('https://x.test', {
    method: 'POST',
    body: JSON.stringify({ group_id: 'g1', player_id: 'RINCON_1', action: 'play' }),
  }))
  expect(res.status).toBe(400)
})
```

Run: `npx vitest run src/lib/sonos/live.test.js src/app/api/sonos/control/route.test.js`
Expected: PASS.

- [ ] **Step 7: Full CI mirror**

```bash
npm test && npm run lint && npm run check:route-guards && npm run check:location-scoping && npm run check:guardrails
```

Expected: all exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/lib/sonos/live.js src/lib/sonos/live.test.js src/app/api/sonos/control/route.js src/app/api/sonos/control/route.test.js
git commit -m "WIDGET.1 — sonos/control: accept a bare player_id (widget speaker button)"
```

---

## Task 7: `WidgetAPI.swift` — the extension's one network surface

Every AppIntent and timeline provider in this plan calls through this one
file. It is the Swift mirror of `mobile/lib/api.js`: it does not decide
anything, it reads a stored token and calls a route.

**Files:**
- Create: `mobile/targets/widgets/WidgetAPI.swift`

- [ ] **Step 1: Confirm the API base URL**

The extension cannot read `Constants.expoConfig?.extra?.apiBaseUrl` — that's
an Expo/JS-runtime API, and the extension is a separate native process with
no JS runtime. Hardcode the same production value `mobile/app.config.js`
falls back to (`https://crm.repset.ie`) as a Swift constant. This means a
staging API base override (`EXPO_PUBLIC_API_BASE_URL`) does **not** reach the
widget — acceptable, since this repo's mobile app is only ever pointed at
production or a Vercel preview during development, never a long-lived
staging widget deployment.

- [ ] **Step 2: Write the file**

```swift
// mobile/targets/widgets/WidgetAPI.swift
// WIDGET.1 — the extension's ONLY network surface. Every AppIntent and
// TimelineProvider in this target calls through here. It reads a token from
// the App Group (written by mobile/lib/widget-bridge.js — see that file's
// header for the storage key contract) and calls exactly one route; it
// makes no authorization decisions of its own, mirroring mobile/lib/api.js
// on the RN side and the "extension renders and calls, never decides"
// exit-gate rule this whole plan is built around.

import Foundation

let APP_GROUP = "group.ie.repset.widgets"
let API_BASE = "https://crm.repset.ie"
let STUDIOS_KEY = "repset_widget_studios"

struct StoredStudio: Codable, Identifiable {
    var id: String { locationId }
    let locationId: String
    let locationName: String
    let tokenId: String
    let token: String

    enum CodingKeys: String, CodingKey {
        case locationId, locationName, tokenId, token
    }
}

enum WidgetAPIError: Error {
    case noCredential
    case transport(String)
    case server(status: Int, message: String)
}

enum WidgetAPI {
    /// Every studio this device has minted a widget credential for.
    /// Mirrors mobile/lib/widget-bridge.js's listStoredStudios() — same
    /// key, same JSON shape. Reading this never makes a network call.
    static func storedStudios() -> [StoredStudio] {
        guard let defaults = UserDefaults(suiteName: APP_GROUP),
              let raw = defaults.string(forKey: STUDIOS_KEY),
              let data = raw.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([StoredStudio].self, from: data)) ?? []
    }

    static func token(forLocation locationId: String) -> String? {
        storedStudios().first { $0.locationId == locationId }?.token
    }

    /// GET or POST `path` against the studio's own widget credential.
    /// `body` is JSON-encoded when present; nil for a GET.
    static func call(
        path: String,
        locationId: String,
        method: String = "GET",
        body: [String: Any]? = nil
    ) async throws -> [String: Any] {
        guard let token = token(forLocation: locationId) else {
            throw WidgetAPIError.noCredential
        }
        guard let url = URL(string: API_BASE + path) else {
            throw WidgetAPIError.transport("bad URL: \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw WidgetAPIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw WidgetAPIError.transport("no HTTP response")
        }
        let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? nil
        guard (200...299).contains(http.statusCode) else {
            let message = (json?["error"] as? String) ?? "HTTP \(http.statusCode)"
            throw WidgetAPIError.server(status: http.statusCode, message: message)
        }
        return json ?? [:]
    }
}
```

- [ ] **Step 3: Prebuild and confirm the file links**

Run: `cd mobile && npx expo prebuild -p ios --clean`
Expected: exits 0; `mobile/targets/widgets/WidgetAPI.swift` appears under the
`widgets` group when the generated workspace
(`mobile/ios/mobile.xcworkspace`) is opened in Xcode. This plan does not
require opening Xcode to proceed — a clean `prebuild` exit plus the file's
presence in `mobile/targets/widgets/` is the checkable signal at this stage
— but the FIRST real compile happens in Task 11/12 once there is a widget
that references this file, and that compile is where a syntax error would
actually surface.

- [ ] **Step 4: Commit**

```bash
git add mobile/targets/widgets/WidgetAPI.swift
git commit -m "WIDGET.1 — WidgetAPI.swift: the extension's one network surface"
```

---

## Task 8: The studio picker (`StudioEntity`)

Backs BOTH widget kinds' configuration — Studio Controls' device picker
depends on which studio is chosen here first, and What Needs Me's
configuration is *only* this.

**Files:**
- Create: `mobile/targets/widgets/StudioEntity.swift`

- [ ] **Step 1: Write the file**

```swift
// mobile/targets/widgets/StudioEntity.swift
// WIDGET.1 — the studio picker. Reads ONLY the App-Group-stored list of
// studios this device already minted a widget credential for
// (WidgetAPI.storedStudios()) — no network call, so the config sheet opens
// instantly and works with the extension's process alone. A studio that
// has not been minted from the app (Task 5) simply cannot appear here —
// that IS the mint flow's job.

import AppIntents

struct StudioEntity: AppEntity {
    let id: String          // locationId
    let name: String        // locationName, for display

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Studio"
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }

    static var defaultQuery = StudioQuery()
}

struct StudioQuery: EntityQuery {
    func entities(for identifiers: [StudioEntity.ID]) async throws -> [StudioEntity] {
        WidgetAPI.storedStudios()
            .filter { identifiers.contains($0.locationId) }
            .map { StudioEntity(id: $0.locationId, name: $0.locationName) }
    }

    func suggestedEntities() async throws -> [StudioEntity] {
        WidgetAPI.storedStudios().map { StudioEntity(id: $0.locationId, name: $0.locationName) }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add mobile/targets/widgets/StudioEntity.swift
git commit -m "WIDGET.1 — StudioEntity: the offline studio picker"
```

---

## Task 9: The device picker (`DeviceEntity`)

Studio Controls' up-to-four-buttons configuration. Unlike the studio picker,
this one DOES call the network — `GET /api/widget/devices` — because the
device list is live studio state (which AC units exist, which Shelly plugs
are provisioned), not something the RN app pre-stages.

**Files:**
- Create: `mobile/targets/widgets/DeviceEntity.swift`

- [ ] **Step 1: Write the file**

```swift
// mobile/targets/widgets/DeviceEntity.swift
// WIDGET.1 — the per-button device picker for Studio Controls. Calls
// GET /api/widget/devices (Phase 1, src/app/api/widget/devices/route.js)
// using the SELECTED studio's stored credential — this query is a
// DynamicOptionsProvider, not a plain EntityQuery, because its result
// depends on which StudioEntity the config sheet already has selected.
//
// `kind` round-trips as part of the entity id (`"<kind>:<id>"`) because the
// action AppIntents (Task 10) need to know which of the four routes to call
// for a given selected device, and AppIntents persist only what an
// AppEntity's `id` carries — not the whole struct.

import AppIntents

struct DeviceEntity: AppEntity {
    let id: String        // "<kind>:<id>", e.g. "door:d1", "speaker:RINCON_1"
    let label: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Device"
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(label)") }

    static var defaultQuery = DeviceQuery()

    var kind: String { String(id.split(separator: ":", maxSplits: 1).first ?? "") }
    var rawId: String { String(id.split(separator: ":", maxSplits: 1).last ?? "") }
}

struct DeviceQuery: EntityQuery {
    func entities(for identifiers: [DeviceEntity.ID]) async throws -> [DeviceEntity] {
        // Re-derive labels from the live list rather than trusting whatever
        // Siri/Shortcuts cached — a renamed or removed device must not
        // silently keep its stale label in the config sheet.
        let all = try await Self.fetchAll()
        return all.filter { identifiers.contains($0.id) }
    }

    /// Called by the config sheet's picker. There is no per-studio parameter
    /// hook that reaches an EntityQuery directly in every AppIntents SDK
    /// revision — confirm against the current Xcode AppIntents docs whether
    /// this needs to become a DynamicOptionsProvider on the intent's
    /// @Parameter instead (dependent on the chosen StudioEntity) rather than
    /// a bare suggestedEntities() with no studio context. This file assumes
    /// the intent-level dependent-parameter form; write it there if that is
    /// what the current SDK wants, and delete the naive form below.
    func suggestedEntities() async throws -> [DeviceEntity] {
        try await Self.fetchAll()
    }

    static func fetchAll(locationId: String? = nil) async throws -> [DeviceEntity] {
        let studio = locationId ?? WidgetAPI.storedStudios().first?.locationId
        guard let studio else { return [] }
        let json = try await WidgetAPI.call(path: "/api/widget/devices", locationId: studio)
        guard let data = json["data"] as? [String: Any],
              let devices = data["devices"] as? [[String: Any]] else { return [] }
        return devices.compactMap { d in
            guard let kind = d["kind"] as? String,
                  let rawId = d["id"] as? String,
                  let label = d["label"] as? String else { return nil }
            return DeviceEntity(id: "\(kind):\(rawId)", label: label)
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add mobile/targets/widgets/DeviceEntity.swift
git commit -m "WIDGET.1 — DeviceEntity: the live device picker (GET /api/widget/devices)"
```

---

## Task 10: The two configuration intents and the four action intents

**Files:**
- Create: `mobile/targets/widgets/StudioControlsIntents.swift`
- Create: `mobile/targets/widgets/WhatNeedsMeIntents.swift`

- [ ] **Step 1: Write the Studio Controls configuration + action intents**

```swift
// mobile/targets/widgets/StudioControlsIntents.swift
// WIDGET.1 — Studio Controls' configuration (studio + up to 4 named
// devices, in order) and its four per-device-kind action AppIntents.
//
// Four SEPARATE optional parameters (device1..device4), not one array —
// WidgetKit's array-of-AppEntity configuration UI does not preserve a
// stable, staff-controlled ORDER the way four named slots do, and the spec
// requires "the first two in configured order" for the small size. Slot
// order IS the order.
//
// door.unlocked audit rows (Task 9 of Phase 1) already carry via:'widget'
// and the widget_token_id — that is the compensating control for every one
// of the four intents below firing directly, with no local confirmation
// beyond the door's own two-tap arm.

import AppIntents
import WidgetKit

struct StudioControlsConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Studio Controls"
    static var description = IntentDescription("Choose a studio and up to four devices.")

    @Parameter(title: "Studio")
    var studio: StudioEntity

    @Parameter(title: "Button 1")
    var device1: DeviceEntity?
    @Parameter(title: "Button 2")
    var device2: DeviceEntity?
    @Parameter(title: "Button 3")
    var device3: DeviceEntity?
    @Parameter(title: "Button 4")
    var device4: DeviceEntity?

    var devicesInOrder: [DeviceEntity] { [device1, device2, device3, device4].compactMap { $0 } }
}

/// Shared arm-window bookkeeping for the door's two-tap. Keyed per device id
/// so two different door buttons (unlikely, but the config allows it) never
/// share one arm state. Mirrors mobile/app/(staff)/doors/index.jsx's 3-second
/// window exactly (STUDIO-HUB.1) — same window, same UX, different runtime.
enum ArmState {
    private static func key(_ deviceId: String) -> String { "armed_until_\(deviceId)" }

    static func arm(_ deviceId: String) {
        UserDefaults(suiteName: APP_GROUP)?.set(Date().addingTimeInterval(3).timeIntervalSince1970, forKey: key(deviceId))
    }
    static func isArmed(_ deviceId: String) -> Bool {
        guard let until = UserDefaults(suiteName: APP_GROUP)?.double(forKey: key(deviceId)), until > 0 else { return false }
        return Date().timeIntervalSince1970 < until
    }
    static func disarm(_ deviceId: String) {
        UserDefaults(suiteName: APP_GROUP)?.removeObject(forKey: key(deviceId))
    }
}

struct UnlockDoorIntent: AppIntent {
    static var title: LocalizedStringResource = "Unlock Door"
    static var isDiscoverable: Bool = false // fired only from a widget button, never Siri/Shortcuts search

    @Parameter(title: "Studio") var locationId: String
    @Parameter(title: "Door ID") var doorId: String
    @Parameter(title: "Door Name") var doorName: String

    init() {}
    init(locationId: String, doorId: String, doorName: String) {
        self.locationId = locationId; self.doorId = doorId; self.doorName = doorName
    }

    func perform() async throws -> some IntentResult {
        // Two-stage arm→fire, same 3s window as doors/index.jsx. The FIRST
        // tap only arms; the SECOND tap (within the window) fires. This is a
        // UI affordance only — server-side re-authorisation on every call is
        // the actual gate (studio_management + the per-user door allowlist,
        // src/app/api/studio-management/unlock/route.js).
        guard ArmState.isArmed(doorId) else {
            ArmState.arm(doorId)
            WidgetCenter.shared.reloadAllTimelines()
            return .result()
        }
        ArmState.disarm(doorId)
        _ = try? await WidgetAPI.call(
            path: "/api/studio-management/unlock",
            locationId: locationId,
            method: "POST",
            body: ["door_id": doorId, "door_name": doorName]
        )
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
        // NOTE (Step 3, owed): if the measured p95 for this call is anywhere
        // near an AppIntent's system time budget, this must stop `await`ing
        // the call before returning — fire it and return .result() on
        // ACCEPTANCE, reading the outcome back only on the widget's next
        // timeline tick. That rewrite is gated on Task 15's device
        // measurement, not on anything decidable from this spike.
    }
}

struct ToggleAcIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle AC"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Studio") var locationId: String
    @Parameter(title: "Device ID") var deviceId: String
    @Parameter(title: "Turning On") var turningOn: Bool

    init() {}
    init(locationId: String, deviceId: String, turningOn: Bool) {
        self.locationId = locationId; self.deviceId = deviceId; self.turningOn = turningOn
    }

    func perform() async throws -> some IntentResult {
        let path = turningOn
            ? "/api/studio-management/ac/devices/\(deviceId)/turn-on"
            : "/api/studio-management/ac/devices/\(deviceId)/turn-off"
        _ = try? await WidgetAPI.call(path: path, locationId: locationId, method: "POST")
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

struct TogglePlugIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle Plug"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Studio") var locationId: String
    @Parameter(title: "Device ID") var deviceId: String
    @Parameter(title: "Turning On") var turningOn: Bool

    init() {}
    init(locationId: String, deviceId: String, turningOn: Bool) {
        self.locationId = locationId; self.deviceId = deviceId; self.turningOn = turningOn
    }

    func perform() async throws -> some IntentResult {
        _ = try? await WidgetAPI.call(
            path: "/api/shelly/devices/\(deviceId)/toggle",
            locationId: locationId,
            method: "POST",
            body: ["state": turningOn ? "on" : "off"]
        )
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

struct ToggleSpeakerIntent: AppIntent {
    static var title: LocalizedStringResource = "Play/Pause Speaker"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Studio") var locationId: String
    @Parameter(title: "Player ID") var playerId: String
    @Parameter(title: "Action") var action: String // "play" | "pause" — the widget button toggles by its OWN last-known state, not a live query

    init() {}
    init(locationId: String, playerId: String, action: String) {
        self.locationId = locationId; self.playerId = playerId; self.action = action
    }

    func perform() async throws -> some IntentResult {
        _ = try? await WidgetAPI.call(
            path: "/api/sonos/control",
            locationId: locationId,
            method: "POST",
            body: ["player_id": playerId, "action": action]
        )
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
```

- [ ] **Step 2: Write the What Needs Me configuration intent**

```swift
// mobile/targets/widgets/WhatNeedsMeIntents.swift
// WIDGET.1 — What Needs Me's configuration is JUST the studio picker; there
// is nothing else to configure, since it always shows all three sources.

import AppIntents

struct WhatNeedsMeConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "What Needs Me"
    static var description = IntentDescription("Pick a studio to see what needs attention.")

    @Parameter(title: "Studio")
    var studio: StudioEntity
}
```

- [ ] **Step 3: Commit**

```bash
git add mobile/targets/widgets/StudioControlsIntents.swift mobile/targets/widgets/WhatNeedsMeIntents.swift
git commit -m "WIDGET.1 — configuration + action AppIntents for both widget kinds"
```

---

## Task 11: The Studio Controls widget view + timeline

**Files:**
- Create: `mobile/targets/widgets/StudioControlsWidget.swift`

- [ ] **Step 1: Write the timeline provider and views**

```swift
// mobile/targets/widgets/StudioControlsWidget.swift
// WIDGET.1 — Studio Controls: medium shows all 4 configured buttons, small
// shows the first 2 IN CONFIGURED ORDER (StudioControlsConfigurationIntent's
// devicesInOrder). The timeline carries a SINGLE entry with a far-future
// reload policy (.never) — the widget's content is "which buttons are
// configured", which only changes when the user re-edits the widget (an
// automatic WidgetKit reload on config change, not a timer), and each
// button's own action already reloads the timeline itself after firing
// (WidgetCenter.shared.reloadAllTimelines() at the end of each AppIntent in
// StudioControlsIntents.swift) — a periodic reload here would just be
// wasted network calls for content that never goes stale on its own.

import WidgetKit
import SwiftUI

struct StudioControlsEntry: TimelineEntry {
    let date: Date
    let studioId: String
    let devices: [DeviceEntity]
}

struct StudioControlsProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> StudioControlsEntry {
        StudioControlsEntry(date: Date(), studioId: "", devices: [])
    }

    func snapshot(for configuration: StudioControlsConfigurationIntent, in context: Context) async -> StudioControlsEntry {
        StudioControlsEntry(date: Date(), studioId: configuration.studio.id, devices: configuration.devicesInOrder)
    }

    func timeline(for configuration: StudioControlsConfigurationIntent, in context: Context) async -> Timeline<StudioControlsEntry> {
        let entry = StudioControlsEntry(date: Date(), studioId: configuration.studio.id, devices: configuration.devicesInOrder)
        return Timeline(entries: [entry], policy: .never)
    }
}

struct StudioControlsButton: View {
    let device: DeviceEntity
    let locationId: String

    var body: some View {
        switch device.kind {
        case "door":
            Button(intent: UnlockDoorIntent(locationId: locationId, doorId: device.rawId, doorName: device.label)) {
                Label(device.label, systemImage: "lock.fill")
            }
        case "ac":
            Button(intent: ToggleAcIntent(locationId: locationId, deviceId: device.rawId, turningOn: true)) {
                Label(device.label, systemImage: "snowflake")
            }
        case "plug":
            Button(intent: TogglePlugIntent(locationId: locationId, deviceId: device.rawId, turningOn: true)) {
                Label(device.label, systemImage: "poweroutlet.type.b.fill")
            }
        case "speaker":
            Button(intent: ToggleSpeakerIntent(locationId: locationId, playerId: device.rawId, action: "play")) {
                Label(device.label, systemImage: "speaker.wave.2.fill")
            }
        default:
            Label(device.label, systemImage: "questionmark.circle")
        }
    }
}

struct StudioControlsWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: StudioControlsEntry

    var visibleDevices: [DeviceEntity] {
        family == .systemSmall ? Array(entry.devices.prefix(2)) : entry.devices
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(visibleDevices, id: \.id) { device in
                StudioControlsButton(device: device, locationId: entry.studioId)
            }
        }
        .padding()
    }
}

struct StudioControlsWidget: Widget {
    let kind: String = "StudioControls"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: StudioControlsConfigurationIntent.self, provider: StudioControlsProvider()) { entry in
            StudioControlsWidgetView(entry: entry)
        }
        .configurationDisplayName("Studio Controls")
        .description("Fire your studio's music, plugs, AC and door.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
```

- [ ] **Step 2: Prebuild**

Run: `cd mobile && npx expo prebuild -p ios --clean`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add mobile/targets/widgets/StudioControlsWidget.swift
git commit -m "WIDGET.1 — Studio Controls widget view + timeline"
```

---

## Task 12: The What Needs Me widget view + timeline

**Files:**
- Create: `mobile/targets/widgets/WhatNeedsMeWidget.swift`

- [ ] **Step 1: Write the timeline provider and views**

```swift
// mobile/targets/widgets/WhatNeedsMeWidget.swift
// WIDGET.1 — What Needs Me: medium shows the three bySource counts
// (approvals/mail/inbox), small shows ONLY the summed total — never the
// per-source breakdown, per spec. Reads GET /api/home-queue/count, the
// SAME endpoint the sidebar badge polls (Phase 1, src/lib/home-queue.js
// getHomeQueueCounts). A 15-30 min timeline floor: refreshed sooner by the
// push handler (Task 13) when a real change is likely, but never left to
// go stale indefinitely if push delivery is ever missed.

import WidgetKit
import SwiftUI

struct WhatNeedsMeEntry: TimelineEntry {
    let date: Date
    let approvals: Int
    let mail: Int
    let inbox: Int
    var total: Int { approvals + mail + inbox }
    let failed: Bool
}

struct WhatNeedsMeProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> WhatNeedsMeEntry {
        WhatNeedsMeEntry(date: Date(), approvals: 0, mail: 0, inbox: 0, failed: false)
    }

    func snapshot(for configuration: WhatNeedsMeConfigurationIntent, in context: Context) async -> WhatNeedsMeEntry {
        await fetch(locationId: configuration.studio.id)
    }

    func timeline(for configuration: WhatNeedsMeConfigurationIntent, in context: Context) async -> Timeline<WhatNeedsMeEntry> {
        let entry = await fetch(locationId: configuration.studio.id)
        // WIDGET.1 — the 15-30 min floor. 20 minutes is the fixed point
        // chosen inside that range: frequent enough that a studio checking
        // once an hour never sees hour-old numbers, infrequent enough that a
        // studio with the widget on 4 staff phones does not turn into 4
        // requests every few minutes against a route that already serves
        // the sidebar poller.
        let next = Calendar.current.date(byAdding: .minute, value: 20, to: Date())!
        return Timeline(entries: [entry], policy: .after(next))
    }

    private func fetch(locationId: String) async -> WhatNeedsMeEntry {
        do {
            let json = try await WidgetAPI.call(path: "/api/home-queue/count", locationId: locationId)
            guard let data = json["data"] as? [String: Any],
                  let bySource = data["bySource"] as? [String: Any] else {
                return WhatNeedsMeEntry(date: Date(), approvals: 0, mail: 0, inbox: 0, failed: true)
            }
            return WhatNeedsMeEntry(
                date: Date(),
                approvals: bySource["approvals"] as? Int ?? 0,
                mail: bySource["mail"] as? Int ?? 0,
                inbox: bySource["inbox"] as? Int ?? 0,
                failed: false
            )
        } catch {
            return WhatNeedsMeEntry(date: Date(), approvals: 0, mail: 0, inbox: 0, failed: true)
        }
    }
}

struct WhatNeedsMeWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: WhatNeedsMeEntry

    var body: some View {
        if entry.failed {
            Text("Couldn't check").font(.caption).foregroundStyle(.secondary)
        } else if family == .systemSmall {
            VStack {
                Text("\(entry.total)").font(.system(size: 34, weight: .bold))
                Text("needs you").font(.caption).foregroundStyle(.secondary)
            }
        } else {
            HStack(spacing: 16) {
                statColumn("Approvals", entry.approvals)
                statColumn("Mail", entry.mail)
                statColumn("Inbox", entry.inbox)
            }
        }
    }

    private func statColumn(_ label: String, _ count: Int) -> some View {
        VStack {
            Text("\(count)").font(.title2).fontWeight(.bold)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }
}

struct WhatNeedsMeWidget: Widget {
    let kind: String = "WhatNeedsMe"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: WhatNeedsMeConfigurationIntent.self, provider: WhatNeedsMeProvider()) { entry in
            WhatNeedsMeWidgetView(entry: entry)
        }
        .configurationDisplayName("What Needs Me")
        .description("Approvals, mail and inbox counts for one studio.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
```

- [ ] **Step 2: Write the `@main` bundle**

```swift
// mobile/targets/widgets/RepsetWidgets.swift
// WIDGET.1 — one extension, two widget kinds. A single WidgetBundle is the
// standard WidgetKit shape for "more than one widget from one extension" —
// there is no reason for these to be two separate Xcode targets, since they
// share WidgetAPI.swift, StudioEntity.swift and the same App Group.

import WidgetKit
import SwiftUI

@main
struct RepsetWidgets: WidgetBundle {
    var body: some Widget {
        StudioControlsWidget()
        WhatNeedsMeWidget()
    }
}
```

- [ ] **Step 3: Prebuild**

Run: `cd mobile && npx expo prebuild -p ios --clean`
Expected: exits 0. This is the point at which every file from Tasks 7-12
first compiles together — if there is a real Swift error, this is where it
surfaces (`expo prebuild` runs `pod install` but does not itself compile
Swift; the first real compile is an Xcode build, which needs a Mac with
Xcode open on `mobile/ios/mobile.xcworkspace`, scheme `widgets` — do that
now, before Task 13, rather than discovering a build error during the
device-check pass in Task 16).

- [ ] **Step 4: Commit**

```bash
git add mobile/targets/widgets/WhatNeedsMeWidget.swift mobile/targets/widgets/RepsetWidgets.swift
git commit -m "WIDGET.1 — What Needs Me widget view + timeline; @main WidgetBundle"
```

---

## Task 13: Reload widgets from the push handler

**Files:**
- Modify: `mobile/app/_layout.jsx`
- Modify: `mobile/lib/widget-bridge.test.js` (already covers `reloadWidgets()` itself — this task only wires the call site)

- [ ] **Step 1: Add a foreground/background received listener**

In `mobile/app/_layout.jsx`, the app already has `UIBackgroundModes:
['remote-notification', 'location']` (app.config.js) so a remote push can
wake the JS runtime even when backgrounded. Add a new listener alongside
the existing `NotificationRouter` component (do not fold this into
`NotificationRouter`'s `addNotificationResponseReceivedListener` — that one
fires only on a TAP; this must fire on RECEIPT, tapped or not, foregrounded
or not):

```jsx
// WIDGET.1 — any push landing is a reasonable proxy for "something a
// widget shows might have changed" (a new approval, a new mail thread, a
// door-adjacent notice). reloadWidgets() is cheap and idempotent — it just
// asks WidgetKit to re-run each placed widget's timeline() on its own
// schedule, not synchronously — so gating this to specific payload types
// is an optimisation for later, not a correctness requirement now.
function WidgetReloadOnPush() {
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(() => {
      reloadWidgets()
    })
    return () => sub.remove()
  }, [])
  return null
}
```

Import `reloadWidgets` from `../lib/widget-bridge` at the top of the file,
and mount `<WidgetReloadOnPush />` alongside the existing
`<NotificationRouter />` mount (find that mount point — likely inside the
root component's returned tree — and add the new component as a sibling,
matching how `NotificationRouter` itself is mounted with no visible output).

- [ ] **Step 2: Run the mobile lint**

Run: `npm run check:mobile-lint`
Expected: exits 0.

- [ ] **Step 3: Confirm the OTA gate is unaffected**

Run: `npm run check:ota-paths`
Expected: clean — `mobile/app/_layout.jsx` is already inside the existing
`mobile/app/**` trigger pattern; this change does not alter classification,
it is a normal bundle-entering edit.

- [ ] **Step 4: Commit**

```bash
git add "mobile/app/_layout.jsx"
git commit -m "WIDGET.1 — reload widget timelines on push receipt"
```

---

## Task 14: Two-build release wiring

**Files:**
- Modify: `mobile/.eas/workflows/release.yml`

**Finding from this spike:** `release.yml` as it stands today runs
`build_ios` / `submit_ios` on profile `production` **only** —
`production-legacy` has no job in this workflow at all. The two-build rule
is currently a **manual** CLI step, not something the Release workflow
enforces. This task closes that gap so a future native change cannot
"forget" the legacy build the way HealthKit's capability was forgotten by a
stale checkout.

- [ ] **Step 1: Add the legacy iOS jobs**

In `mobile/.eas/workflows/release.yml`, after the existing `submit_ios` job:

```yaml
  build_ios_legacy:
    name: Build iOS (legacy, com.un1tdublin.crm)
    type: build
    params:
      platform: ios
      profile: production-legacy

  submit_ios_legacy:
    name: Submit to App Store Connect (legacy)
    needs: [build_ios_legacy]
    type: submit
    params:
      platform: ios
      profile: production-legacy
      build_id: ${{ needs.build_ios_legacy.outputs.build_id }}
```

Also update the file's own header comment (the numbered list near the top)
to say four iOS-relevant jobs now run, not two, and add a line to the
pre-flight checklist: *"Both `build_ios` and `build_ios_legacy` must run
from the SAME commit — see the Task 15 spike notes in
docs/superpowers/plans/2026-09-10-widget-native-extension.md for why a
capability (App Group, HealthKit) silently reverts if they don't."*

- [ ] **Step 2: There is no automated way to verify EAS Workflow YAML from this repo**

`eas.json`'s `build.production-legacy` profile already exists (`"extends":
"production", "env": {"LEGACY_APP": "1"}`) and `submit.production-legacy`
already carries the legacy `ascAppId` — this task only adds the *workflow*
jobs that invoke them together. Validate by reading the diff against the
existing `build_ios`/`submit_ios` jobs' shape (they should be structurally
identical apart from `profile` and the job names) rather than by running
anything; EAS Workflows are validated server-side when triggered, and
triggering one is a real build (cost + time), which this plan does not do
speculatively.

- [ ] **Step 3: Commit**

```bash
git add mobile/.eas/workflows/release.yml
git commit -m "WIDGET.1 — release.yml: add the legacy iOS build+submit jobs"
```

---

## Task 15: The two-build submission

Not automatable — this is the actual release, run by a person with access to
the Apple/EAS credentials, once every task above has landed and been
reviewed. Recorded here as the exact checklist rather than left to memory.

- [ ] **Step 1: Confirm the worktree is clean and current**

```bash
git status --porcelain
git fetch origin
git log --oneline -1 HEAD
git log --oneline -1 origin/feat/staff-home-screen-widgets  # or origin/main, whichever this has merged into by then
```

Expected: no uncommitted changes, and the local commit matches the remote —
per the Task 15 (Phase 1) spike findings, running the two builds from a
worktree that is BEHIND is exactly the mechanism that reverted HealthKit's
capability twice.

- [ ] **Step 2: Bump the version**

```bash
cd mobile
npm run version:patch --no-push   # or leave the default — it does not push regardless; see the script's own header
```

Confirm the resulting commit only touched `mobile/app.config.js`'s `version`
line (this was already bumped to `2.4.0` alongside `runtimeVersion` in Task
2 — if `version:patch` would move it past `2.4.0`, skip this step; Task 2's
manual bump already covers this release).

- [ ] **Step 3: Trigger the Release workflow**

At `https://expo.dev/accounts/<account>/projects/un1t-crm-mobile/workflows`,
run `Release` (`mobile/.eas/workflows/release.yml`, extended in Task 14).
This now runs `build_ios` + `submit_ios` (public app, `ie.repset.app`) and
`build_ios_legacy` + `submit_ios_legacy` (`com.un1tdublin.crm`) — all four
from the SAME triggering commit, satisfying Task 15 (Phase 1)'s single-
worktree finding by construction (a workflow run pins one commit for every
job in it).

- [ ] **Step 4: Verify both App IDs picked up the App Group capability**

Once both builds report success, check
`https://developer.apple.com/account/resources/identifiers/list` for both
`ie.repset.app` and `com.un1tdublin.crm` — **App Groups** should show
enabled on both, and (this is the actual regression check from the
HealthKit incident) **HealthKit** and **HealthKit Background Delivery**
should STILL show enabled on both. If either is un-ticked, the checkout used
for that build was stale — do not attempt to fix it by re-ticking manually
in the portal; re-run that build from a confirmed-current worktree, since a
manual portal edit will be reverted by the next `eas build` that reads a
correct config anyway, and the goal is a config-driven state that stays
correct, not a one-off patch.

- [ ] **Step 5: Android**

Per `docs/architecture/MOBILE.md`, Android submit is not automated for this
Play Console org. Download the `.aab` from the `build_android` job (still
only building `production` today — Android has no legacy-bundle split, since
`android.package` never forked; see `mobile/app.config.js`'s `android`
block comment) and upload manually to Play Console → Internal testing.

---

## Task 16: Device-check list (the exit gate)

There is no Swift test runner in this repo, and jsdom cannot see native
layout — the LESSONS entry both invariants trace to is exactly why every
task above pushed every DECISION behind an already-JS-tested API route and
left the extension nothing to do but render a value or fire a call. This
list is what actually proves the extension does that correctly. Each line
needs a real device (a Simulator does not receive real push, and does not
reliably exercise WidgetKit timeline background refresh) and a real Phase 1
deployment.

- [ ] Add a Studio Controls widget (small AND medium) to the home screen;
      confirm the config sheet shows the studios minted in Task 5's screen,
      and that picking one populates the device picker via a real
      `GET /api/widget/devices` call (airplane-mode test: the picker should
      show nothing/an error, not stale or invented devices).
- [ ] Medium shows all 4 configured buttons in the order they were
      configured; small shows only the first 2, same order.
- [ ] Tap the door button once — it visibly arms (per Task 10's `ArmState`,
      surfaced in the view; if Task 11's view doesn't yet render an armed
      state distinctly, that is a gap this checklist exists to catch. Add
      one before shipping if so).
- [ ] Tap again within 3 seconds — the door actually unlocks (audible click
      at the studio, or confirm via the UniFi Access portal's event log).
- [ ] Arm it and let 3+ seconds pass without a second tap — confirm the NEXT
      tap arms again rather than firing (the window genuinely closed).
- [ ] Tap the AC, plug and speaker buttons — confirm each fires against the
      real device (AC unit clicks on, plug's relay switches, Sonos player
      starts playing) and that `docs/CHANGELOG.md`-adjacent, i.e. the
      `audit_events`/`activities` rows Phase 1 already writes, show up with
      `via: 'widget'` and the correct `widget_token_id`.
- [ ] Revoke that widget's token from the staff detail page's
      `WidgetTokensCard` (Phase 1, Task 13) OR from the mobile screen built
      in Task 5 — confirm the NEXT button tap fails silently in the widget
      (no crash, no misleading "success") rather than continuing to fire.
- [ ] Force-quit the app entirely, then tap a Studio Controls button —
      confirm it still fires. The extension is a separate process; this is
      the test that proves it does not depend on the RN app running.
- [ ] Add a What Needs Me widget (small AND medium); confirm medium shows
      three separate counts and small shows only the summed total, never a
      breakdown.
- [ ] Leave the widget alone for 20-30 minutes with the app closed; confirm
      the count refreshes on its own (the 15-30 min floor).
- [ ] Trigger a real push to the device (any category) and confirm the
      widget's count updates sooner than the floor would have — this is the
      one check that specifically exercises Task 13's
      `addNotificationReceivedListener` path working while backgrounded, not
      just foregrounded.
- [ ] Repeat the full pass on BOTH binaries — `ie.repset.app` (TestFlight,
      public build) and `com.un1tdublin.crm` (the legacy build) — a widget
      that works on one binary and silently fails on the other is exactly
      the class of gap the two-build rule exists to prevent, and nothing
      above distinguishes the two automatically.
- [ ] **OWED — Step 3 of the Phase 1 spike, not attempted here:** measure
      `POST /api/studio-management/unlock`'s real end-to-end latency from
      this same device, on cellular, and compare it against whatever the
      device testing above revealed about the door AppIntent's actual
      responsiveness. If the unlock ever visibly hangs or times out from the
      widget (distinct from the app, which has no such budget), revisit
      Task 10's `UnlockDoorIntent` per its own inline note — return on
      acceptance, not completion. **Owner: Richard.**

---

## Self-review

**Spec coverage.** Config-plugin verification → Spike findings §1. Credentials
question → Spike findings §2. Door latency → Spike findings §3 + Task 16's
final line, explicitly owed. `mobile/targets/` OTA classification → Task 1,
landed first as required. Config plugin setup → Tasks 2-3. App Group
bridging module → Task 4. Minting from the app → Task 5. Two
`AppIntentConfiguration`s → Task 10 (`StudioControlsConfigurationIntent`,
`WhatNeedsMeConfigurationIntent`), backed by Tasks 8-9's entities. Studio
Controls sizes (medium 4 / small first-2-in-order) → Task 11. What Needs Me
sizes (medium 3 counts / small total-only) → Task 12. Two-tap door arm,
mirroring `doors/index.jsx` → Task 10's `ArmState` + `UnlockDoorIntent`,
verified on-device in Task 16. `WidgetCenter.reloadAllTimelines()` from the
push handler + 15-30 min floor → Task 13 (push) and Task 12 (floor, pinned
at 20 minutes). `runtimeVersion` bump to 2.4.0 + two-build submission →
Task 2 (bump) and Tasks 14-15 (release wiring + the actual submission).
Device-check exit gate → Task 16.

**A gap this spike found, not assumed:** the Sonos speaker button could not
be a single-request action under the existing Phase 1 contract (`POST
/api/sonos/control` had no player-id addressing mode) — Task 6 closes it
with a small, fully-tested backend addition, kept consistent with the
existing `schedule_id`/`group_id` pattern and the `resolveGroupIds()`
invariant Phase 1's Task 11b already established. Doing this now, rather
than discovering it while wiring `ToggleSpeakerIntent` in Task 10, is the
whole point of a spike that reads the real routes before writing Swift
against them.

**Known soft spots, flagged rather than papered over.** The exact current
AppIntents/WidgetKit SDK signatures (Tasks 6-12's Swift) were not
independently re-verified against Apple's live developer documentation in
this spike — only `@bacons/apple-targets`'s config shape and EAS's
capability-sync behaviour were in scope for verification, per the assigned
task. Task 3's opening note and Task 9's `DeviceQuery` comment both say so
explicitly at the point where it matters, rather than presenting invented
Apple API with false confidence. The AppIntent system time budget for a
widget button (the fact Step 3 was meant to measure) remains genuinely
unknown until Task 16's final, owed line is done on a real device against a
deployed Phase 1 — `UnlockDoorIntent`'s `perform()` is written to await
completion, with an inline note naming exactly what changes if that turns
out to be wrong.
