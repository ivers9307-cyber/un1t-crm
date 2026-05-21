# Session State — May 21, 2026

One-screen "state of the world" so a fresh chat can orient in 30 seconds.
This session: the **ANT+ heart-rate bridge rebuild** — making the
in-class HR system read straps over ANT+ as well as Bluetooth.

## Today's headline

The studio HR effort (the Myzone replacement) was revisited. The
bridge was BLE-only, which can't handle a 15-20 person class — BLE
caps at ~7 concurrent connections. Decision: **ANT+ as the primary
protocol** (connectionless — one USB stick reads the whole room),
**BLE kept as a fallback** for BLE-only straps.

Rebuilt across all three repos around one protocol-aware identifier,
the **`device_key`**: `ant:12345` or `ble:AA:BB:CC:DD:EE:FF`. Protocol
is encoded in the key, so it can't drift and ANT+/BLE ids can't
collide — which is also why the dual-protocol bridge needs no
cross-protocol de-dup.

## ⚠️ CRITICAL — do this first on resume

**Migration 193 is NOT applied to prod.** PR #87 (which contains
`193_protocol_aware_strap_identifiers.sql`) is already merged and
deployed, but the prod Supabase project (`iyvtbjjxdggiadzwwvdj`) is
still at `192_contact_membership_plan`. The deployed code expects
`strap_assignments.strap_identifier` and the rebuilt
`scan_straps_for_contact()` signature; the schema still has the old
`strap_mac` column and old function.

Real-world impact is low *right now* (no bridge is live and the HR
coach surface is barely used), but it is a latent break: the moment
anyone uses `/live` pairing or a bridge connects, it errors.

**Action:** apply `supabase/migrations/193_protocol_aware_strap_identifiers.sql`
to project `iyvtbjjxdggiadzwwvdj`. It is safe — the strap tables are
empty/near-empty (HR never deployed) and the backfill is idempotent.

## The four PRs

| Repo | PR | Branch | Status |
|---|---|---|---|
| un1t-crm | [#87](https://github.com/ivers9307-cyber/un1t-crm/pull/87) | `ant-plus-hr-ingest` | **MERGED** — protocol-aware ingest + migration 193 |
| un1t-crm | [#88](https://github.com/ivers9307-cyber/un1t-crm/pull/88) | `ant-plus-bridge-admin` | OPEN — `/admin/bridges` registration page |
| champ-bridge | [#1](https://github.com/ivers9307-cyber/champ-bridge/pull/1) | `ant-plus-dual-protocol` | OPEN — dual-protocol Pi service |
| champ-app | [#1](https://github.com/ivers9307-cyber/champ-app/pull/1) | `ant-plus-device-ui` | OPEN — protocol-aware device registration |

The stale `ant-plus-hr-ingest` branch on the remote has one orphaned
commit on it (the admin page, before #87 merged) — superseded by #88,
safe to delete.

## Resume checklist (in order)

1. **Apply migration 193 to prod** (see CRITICAL above).
2. **Merge the three open PRs** — un1t-crm #88, champ-bridge #1,
   champ-app #1. Merge order doesn't strictly matter, but get them in
   close together so the deployed pieces agree on the `device_key`
   wire format. champ-app #1's strap scanner expects the migration-193
   `scan_straps_for_contact` signature.
3. **Buy the Pi parts** — ANT+ USB-m stick (Garmin ANT+ USB-m, a
   `GarminStick3`; CYCPLUS clone is a fine fallback), ~20 dual-band
   straps (Polar Verity Sense armband recommended, or Garmin HRM-Dual
   / Polar H9), a USB extension cable, A2 microSD, power supply.
4. **Deploy the bridge to a Pi** — full runbook is in
   `champ-bridge/README.md`. Key new bits vs the old BLE-only setup:
   `npm ci` now builds a native USB module so the Pi needs
   `libusb-1.0-0-dev`, plus a udev rule for the ANT+ stick (vendor
   `0fcf`). Both documented in the README.
5. **Register the bridge** via the CRM — once #88 is deployed, this is
   a form at **Admin → HR Bridges** (`/admin/bridges`): name +
   location + hardware_id → one-time token → paste into the Pi's
   `.env`. Before #88 deploys it's a raw `POST /api/admin/bridges`.
6. **Smoke test** — champ-bridge `CLAUDE.md` has the "When hardware
   lands" checklist. The `RealAnt`/`RealBle` adapters are lazy-imported
   and only ever validated on real hardware — the test suites cover
   the fake adapters + pure helpers.

## What `device_key` touches (orientation for a fresh session)

- **champ-bridge** — `src/device-key.js` (the helper, duplicated into
  the other two repos), `ant.js` (new ANT+ adapter, `ant-plus-next`
  library), `ble.js` (refactored), `strap-source.js` (merges both).
- **un1t-crm** — `bridge-samples.js` has the helpers + ingest;
  `strap_assignments.strap_mac` renamed to `strap_identifier`;
  `contact_devices.identifier` / `heart_rate_sessions.device_identifier`
  now store device keys; `scan_straps_for_contact()` returns
  `device_key` + `protocol`.
- **champ-app** — `heart-rate-devices.js` (helpers + validation),
  `DevicesManager.jsx` + `ScanForStraps.jsx` (protocol selector +
  badges).

`heart_rate_sessions.source` stays `'ble_bridge'` for any bridge
sample regardless of protocol — that value just means "the studio
bridge"; renaming it was deliberately out of scope.

## Live state of the world

| Resource | Count |
|---|---|
| Active locations | 4 (Stillorgan / Hatch Street / CCF Autos / Test Studio) |
| Open PRs | 3 (un1t-crm #88, champ-bridge #1, champ-app #1) |
| Last applied prod migration | **192** — 193 is committed in merged PR #87 but NOT applied |
| Migration 193 in repo | `supabase/migrations/193_protocol_aware_strap_identifiers.sql` |

## Verification done this session

- champ-bridge — 32 tests + eslint green.
- un1t-crm — 52 tests across the HR suites + eslint clean; #88's
  admin page eslint clean.
- champ-app — eslint clean; vitest crashes this sandbox (a bus error,
  environment fault, not the code), so the new module was verified by
  running its logic directly under Node (13/13 checks) — identical
  logic to the un1t-crm suite that passed.

## Carried-over / separate threads

- **Churn-risk radar** — the original feature this HR work was a
  prerequisite for. The `circle-back-churn-radar` reminder fired
  2026-05-21. Still to be built (scoring lib, owners-and-head-coaches
  permission, API, radar page, win-back actions). Independent of the
  ANT+ work — pick up once the HR pipeline is producing data.
