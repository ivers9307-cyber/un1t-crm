# WIDGET.3 — the widget picks its own studio

**Status:** design, awaiting Richard's review. Decided 2026-09-11: **option B**,
chosen over "home-studio default only" (A) and "both widgets follow" (C).
**Depends on:** #1679 (WIDGET.2) — `studio` is Optional on both configuration
intents, which is what makes "no studio chosen" a legal, ordinary state.

## The decision

| Widget | Default when nothing is chosen | Follows you on arrival |
|---|---|---|
| What Needs Me | home studio | **yes** |
| Studio Controls | home studio | **no** |

Studio Controls does not follow, and that is a property of the data, not a
scoping cop-out: its configuration stores up to four **device ids**, and a
device belongs to exactly one studio. Hatch Street's "Gym Floor Lighting" has
no counterpart at Stillorgan, so a tile that silently repointed would render
four buttons that address nothing. Making it follow requires choosing devices
*per studio* (option C), which adds more configuration than this removes.

The point of the change is that **a freshly placed widget works immediately**.
Today it renders a set-up message until someone picks a studio by hand.

## What already exists (do not re-derive)

- **The resolution rule is already written and shipped** —
  `mobile/lib/control-location.js#resolveControlLocation` (HOME-LOC.3):
  `?loc= override ?? physical (when at_studio) ?? activeLocation`, carrying a
  `source` of `manual | detected`. Every control screen uses it. This spec
  mirrors that tiering rather than inventing a second one.
- **Background arrival detection is live.** `mobile/lib/geofence.js` registers
  regions with `identifier: r.location_id` and defines its TaskManager task at
  bundle-global scope via the custom entry `mobile/index.js` (Android headless
  launches never mount router routes). iOS carries
  `UIBackgroundModes: ['remote-notification', 'location']`. Both studios are
  enabled with a 100m radius. 🔴 **`notifyOnExit: false`** — the OS tells us
  about arrivals only.
- **The App Group bridge exists.** `mobile/lib/widget-bridge.js` wraps
  `ExtensionStorage`, currently holding one key, `repset_widget_studios`
  (a JSON string), plus `reloadWidgets()` →
  `WidgetCenter.reloadAllTimelines()`.
- **The widget reads credentials and nothing else.**
  `WidgetAPI.storedStudios()`; `StudioQuery` lists exactly those studios.
- 🔴 **The app is never told which studio is "home".** `/api/mobile/me` sends
  each location's `features`, `permissions`, `roleTemplate` and `staffBar`,
  plus `activeLocation` — but not `is_default`, which `src/lib/staff-access.js`
  already computes. Live data: 12 of 13 Stillorgan assignments and 1 of 5 at
  Hatch carry it.

## Design

### 1. Server — expose the home studio (no migration, deploys on its own)

Add `isDefault` to each entry in `/api/mobile/me`'s `locations` array, from the
assignment row `staff-access.js` already reads. Nothing else changes; this can
ship ahead of any build and is inert until an app knows to read it.

### 2. App — maintain a small context blob in the App Group

New key `repset_widget_context`, written by `widget-bridge.js` alongside the
credentials:

```
{ homeStudioId: string|null, currentStudioId: string|null, resolvedAt: number }
```

- `homeStudioId` — the `isDefault` assignment, else `activeLocation.id`.
- `currentStudioId` — the detected studio, **only when a credential for it is
  stored on this device**. Never name a studio the widget cannot call; a
  button that resolves to a credential-less studio is the "looked real, did
  nothing" class this extension exists to avoid.
- Written at three points, and no others:
  1. **App-wide foreground resolve** — one effect owned by the staff layout
     (`mobile/app/(staff)/_layout.jsx`) reading the same
     `usePhysicalLocation()` the control screens use. Deliberately ONE owner:
     six screens already call that hook, and six writers would race each other
     to a single key.
  2. **Credential mint / revoke** — `settings/widgets.jsx` already calls
     `reloadWidgets()` there; the context has to move with the credential set,
     since `currentStudioId` is bound to it.
  3. **The geofence Enter task** — the only path that works with the app
     closed, and therefore the whole feature.
  Each write is followed by `reloadWidgets()`.
- The resolver itself is a pure function in `mobile/lib/widget-context.js`, so
  it is unit-testable: there is no RN component test runner in this repo, which
  is exactly why decisions live in `mobile/lib` and screens stay thin.

🔴 **The one assumption that must be verified on a device, not reasoned about:**
whether `ExtensionStorage` (an Expo native module) is reachable from the
headless geofence task. If it is not, arrival updates degrade to "the next time
the app is opened", which is still useful but is a different promise — so the
device pass must confirm which of the two we shipped before anyone describes it.

**Carve-outs the write must honour**, because `syncGeofences` already does and
for the same reasons: a paired **kiosk** never writes a current studio (it sits
permanently inside a region and holds whichever session it last had), and
**impersonation** never does (a master viewing-as is a lens, not a location).

### 3. Widget — resolve, and say how it resolved

`WidgetAPI.widgetContext()` reads the new key. Both providers resolve in tiers:

- **What Needs Me:** `configuration.studio?.id ?? currentStudioId ?? homeStudioId`
- **Studio Controls:** `configuration.studio?.id ?? homeStudioId`

The entry carries the resolved id **and** its source (`configured | detected |
home`), and the header renders it — "STILLORGAN · HERE" when detected, the plain
name otherwise. 🔴 `control-location.js`'s own rule applies verbatim: **the
label and the command must derive from the same resolved value**, never
re-resolved independently, or the tile can name one studio while its button
fires at another. That divergence is the Hatch-coach incident this whole
location stack was built after.

Studio Controls needs no device-mismatch handling: the device pickers are
studio-scoped, so a widget with no configured studio also has no configured
devices, and falls through to its existing "No devices chosen yet" state with a
studio name and header already in place.

## Failure modes, stated plainly

- **Arrival-only.** After you leave a studio the widget keeps showing it until
  you arrive somewhere else or open the app. Adding exit monitoring would change
  the shared attendance task's registration and is deliberately out of scope.
- **Detection needs configuration.** A studio without
  `settings.geofence.enabled` and coords never detects, silently — the tile
  falls back to home, which is the correct quiet behaviour.
- **"Always" location is a personal choice.** Staff who declined get the home
  studio and nothing worse.
- **Follow-me is bounded by credentials.** Arriving at a studio this phone has
  never minted for leaves the tile on home.

## Verification

1. **Unit:** `mobile/lib/widget-context.js` resolver — tiering, the
   credential-bound `currentStudioId`, kiosk and impersonation carve-outs.
2. **Swift:** typecheck all widget sources against the real SDK.
3. 🔴 **Metadata:** after building, unzip the IPA and confirm
   `widgets.appex/Metadata.appintents/extract.actionsdata` still reports
   `"isOptional": true` for `studio`. WIDGET.2 shipped precisely because
   nothing checked this.
4. **Device pass, and it is the point of this feature:** place both widgets with
   nothing configured (both should show the home studio), then walk into the
   other studio's geofence with the app closed. What Needs Me should repoint and
   say HERE; Studio Controls should not move. Confirm whether the background
   write worked or whether it took a foreground launch (see the assumption
   above).

## Out of scope

Studio Controls following (option C, per-studio device sets); reverting on
departure; any new permission or token — the existing per-location widget
credential is unchanged.

## Sequencing

The server field ships whenever. Everything else is native and rides a build:
fold it into the 2.4.1 WIDGET.2 release only if that build has not yet gone to
review, otherwise 2.4.2. Both records rebuild either way (two-build rule).
