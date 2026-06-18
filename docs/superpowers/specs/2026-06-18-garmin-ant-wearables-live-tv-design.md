# Garmin / ANT+ wearables on the live TV — design spec

- **Date:** 2026-06-18
- **Status:** Draft for review
- **Slice:** L1 of "support members' own wearables on the HR platform." **Garmin / ANT+ only.** Whoop/BLE, Apple Watch, and post-class cloud sync are explicitly separate, later slices (see Non-goals).
- **Primary repo for the change:** `champ-app` (member-facing). `un1t-crm` + `champ-bridge` are unchanged for the happy path.

## Goal

Let a member who owns a Garmin watch (or any ANT+ heart-rate-broadcasting watch) appear on the in-studio TV leaderboard as their **named tile** — the same experience as a studio chest strap — by registering the watch **once** in the member app. No chest strap required, no new hardware.

## Why this is a small slice

The HR platform was architected for this from the start. The live pipeline, the device registry, and the member registration UX already exist and are largely proven:

- **Bridge ingestion (proven on real hardware).** `champ-bridge` reads any ANT+ HR sensor as a protocol-aware `device_key` (`ant:<deviceNumber>`). A **Garmin watch** in Broadcast-HR mode is already confirmed landing as `ant:45075` within ~5s (champ-bridge PR #2, 2026-06-17). So the "does a watch even get seen" question is **already answered yes** on real hardware.
- **Device registry.** `contact_devices` already supports `device_type ∈ {chest_strap, watch}` and `manufacturer` already includes `garmin` (`src/lib/contact-devices.js`). `validateDeviceInput` already canonicalises an `ant:`/`ble:` `device_key`. No schema change.
- **Member registration UX.** champ-app `account/devices` (`DevicesManager.jsx` + `ScanForStraps.jsx`) already shows the member what the bridge currently sees (`scan_straps_for_contact` RPC), already **auto-detects manufacturer including "garmin"** from the broadcast name, and lets the member tap to claim it.
- **Routing.** The bridge's `resolveStrapsForBatch` → `contact_devices` lookup → `findOrCreateAutoSession` already routes a registered device to the member's session, and a **live class is now a primary auto-create trigger** (HR-CLASS-ALLOC.1, mig 287), with the session class-stamped and booked/presence-tagged (HR-CLASS-ALLOC.2, mig 288/289).
- **Coach fallback.** `/live` → `/api/live/[locationId]/pair` → `strap_assignments` already lets a coach pair a broadcasting device to a member for one class, for members who haven't registered.

The only thing missing is the **member-app onboarding**: telling the member how to turn broadcast on, and recording their watch as a watch rather than a chest strap.

## In scope

1. A member can register a Garmin / ANT+ watch in champ-app, labelled as a watch.
2. Clear in-app instructions for enabling Broadcast Heart Rate before registering and before each class.
3. Once registered, the watch auto-routes to the member's named tile on `/tv/<location>` every class with no further app action.
4. Real-hardware acceptance of the full register → named-tile path.

## Out of scope (deliberately, this slice)

- **Whoop / BLE** — separate slice; needs the Pi's BLE radio enabled (systemd capability fix), a Whoop BLE-address-rotation spike (decides whether register-once even works), and BLE connection-ceiling handling.
- **Apple Watch** — no third-party broadcast/API; needs a watchOS broadcaster app or a native HealthKit iOS app. Parked.
- **Post-class cloud data / progress** (Whoop API, Garmin Health API, HealthKit) — the separate "H" slices.
- **Zone / calorie / max-HR maths** — a watch session reuses the exact same model as a chest-strap session. No change.
- **Coach `/live` view + TV leaderboard rendering** — a registered watch already flows through the existing roster panel + leaderboard as an ordinary session. No change.

## Current state (grounded references)

| Concern | Where | State |
|---|---|---|
| ANT+ HR ingestion | `champ-bridge/src/ant.js` | ✅ live; Garmin watch confirmed as `ant:45075` (PR #2) |
| Device registry schema | `contact_devices`, `src/lib/contact-devices.js` | ✅ has `device_type:'watch'` + `manufacturer:'garmin'`; no change |
| Scan-to-claim UX | champ-app `ScanForStraps.jsx` | ✅ shows bridge-seen devices, detects garmin, tap-to-claim |
| Add-device insert | champ-app `DevicesManager.jsx:204` | ⚠️ **hardcodes `device_type:'chest_strap'`** — the one value to make conditional |
| Sample routing → session | `src/lib/bridge-samples.js` `resolveStrapsForBatch` | ✅ routes any registered `device_key`; live class auto-creates session |
| Coach per-class pairing | `/api/live/[locationId]/pair` | ✅ existing fallback |
| register → session → TV tile | end-to-end | ⚠️ **not yet physically verified** (bridge-sees-strap is confirmed; the pair/register → session → leaderboard-tile link is the open validation) |

## The change (champ-app `account/devices`)

### 1. Device-kind step in the add flow
The add-device flow asks **"What are you adding?"** before scanning:
- **Chest strap** (existing default behaviour)
- **Watch / wearable** (Garmin, Coros, Suunto, Wahoo RIVAL, …)

The choice sets `device_type` on the insert (`'watch'` vs `'chest_strap'`) instead of the current hardcoded `'chest_strap'` at `DevicesManager.jsx:204`. `manufacturer` comes from the scan's existing `detectManufacturer()` (→ `garmin`, else `unknown`). This is a **one-value change to an existing browser-client insert** — `contact_devices` already supports it and RLS already grants customer-self insert. No migration, no API route.

### 2. Broadcast-mode onboarding (the bulk of the work)
Before the scan, show a short per-kind instruction card. For the watch path, Garmin-first copy:
- Enable **Broadcast Heart Rate** (Garmin: *Settings → Sensors & Accessories → Wrist Heart Rate → Broadcast During Activity* / *Broadcast Now*).
- Wear it snugly so it has a **pulse lock** — a watch with no pulse lock broadcasts nothing.
- **You must re-enable broadcast each class** on most watches, and it uses extra battery.

A generic ANT+ fallback card covers non-Garmin watches. Copy is static per-manufacturer content in champ-app (start with Garmin + generic; expand later).

> **Why the caveats are load-bearing (confirmed gotcha):** a Garmin broadcasts ANT+ HR *only* with a live pulse lock and Broadcast mode on. Off-wrist / screen-asleep / not-broadcasting looks identical to "not detected" — so the instructions must make the member's recurring action explicit, or support tickets follow.

### 3. Register-once, broadcast-each-class
After registering, the bridge auto-routes the watch into the member's named tile every future class with **zero further app action**. The only recurring step is the member flipping broadcast on at the watch — a watch limitation, not ours. The registered-device card shows a one-line reminder ("Enable Broadcast HR on your watch before class").

### 4. Device-card labelling
The member's device list shows the watch with its kind + manufacturer (e.g. "Garmin watch") and its `ant:<number>`, so it's distinguishable from a chest strap.

## Data flow (unchanged — for reference)

```
Garmin watch (Broadcast HR on, pulse lock)
   → ANT+ → champ-bridge → POST /api/bridge/samples  (device_key ant:<n>)
   → resolveStrapsForBatch → contact_devices match (device_type='watch')
   → findOrCreateAutoSession (class-stamped, booked/presence-tagged)
   → hr_samples → /api/public/live → named tile on /tv/<location>
```

## Edge cases

- **In class but not registered** → the strap surfaces in the coach `/live` Available-straps list (coach can pair it for the class), and during a live class it already auto-creates a presence/walk-in session labelled by device id (HR-CLASS-ALLOC.2). Registering later makes the tile named + automatic.
- **Dual-band watch broadcasting ANT+ *and* BLE** → two `device_key`s; the member registers the ANT+ one; the other drops as unregistered (existing protocol-namespacing). BLE is off this round anyway.
- **ANT+ device-number stability** → ANT+ device numbers are stable per device (unlike rotating BLE MACs), so register-once holds. Confirmed: `ant:45075` persists.
- **Broadcast off / off-wrist** → sends nothing; covered by instructions; nothing to build.

## Testing

- **Unit (pure):** device-kind → `device_type` + `manufacturer` mapping, and instruction-card selection per manufacturer.
- **Existing rails:** `scan_straps_for_contact` + claim path unchanged — no new coverage needed.
- **Real-hardware acceptance (the validation that matters):** Garmin in Broadcast mode → appears in the champ-app scan → register as **Watch** → join a live class → **named tile on `/tv/<location>`**. The ingestion half is already proven (`ant:45075`); this verifies the register → named-tile half, which is the currently-untested link in the chain.

## Rollout

- Member-facing in champ-app; **no migration**, no un1t-crm change for the happy path. Ships behind the existing `account/devices` page.
- Announce to members who own Garmins/sports watches once the real-hardware acceptance passes.

## Open questions

1. **Instruction copy / branding** — who writes the member-facing wording? *Default: I draft Garmin + generic ANT+ copy; Richard edits.*
2. **Pre-class reminder** — in-app reminder only for v1, or a push/email nudge to "enable broadcast before class"? *Default: in-app only for v1; revisit if members forget.*
3. **Which watch brands to name explicitly** in the picker beyond Garmin (Coros/Suunto/Wahoo) vs a single generic "Watch / wearable" with Garmin instructions? *Default: one "Watch / wearable" kind, Garmin-led instructions + generic ANT+ note.*
