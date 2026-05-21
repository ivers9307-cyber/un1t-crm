# Session State — May 21, 2026

One-screen "state of the world" so a fresh chat can orient in 30 seconds.

## Today's headline

Two features shipped end-to-end: the **ANT+ heart-rate bridge rebuild**
and **Phase 1 of the churn-risk radar**. Everything below is merged to
`main` and the database migrations are applied — nothing is in flight.

## Shipped + merged today

| Area | PRs | What landed |
|---|---|---|
| ANT+ HR bridge | un1t-crm #87, champ-bridge #1, champ-app #1 | Studio HR bridge now reads straps over **ANT+** (primary, connectionless — one USB stick covers a whole class) as well as BLE. Protocol-aware `device_key` (`ant:…` / `ble:…`) across all three repos. |
| HR bridge admin | un1t-crm #88/#89 | `/admin/bridges` — register a studio Pi + manage tokens from a form. |
| Churn radar | un1t-crm #90, #91 | At-risk member radar + Quarantine triage. See below. |

**Migrations applied to prod** (`iyvtbjjxdggiadzwwvdj`): `193`
(protocol-aware strap identifiers) and `194` (`churn_radar_actions`).
DB schema matches deployed code — verified.

## Churn radar — what's live (Phase 1)

`/churn-radar`, gated to owner + head_coach (`churn_radar` permission).

- Scores the **active member base** (~226 of 1,074 "paying" members
  have real class activity) on three data-backed signals: Gone quiet,
  Disengaging, No-show pattern → risk score + tier.
- Per-member actions: mark contacted, assign follow-up task, send
  win-back WhatsApp, snooze.
- **Quarantine tab**: the ~800 zero-activity "ghost member" records
  (member status in Glofox, no attendance/bookings ever) — bulk
  triage as stale (→ reclassified dormant) or keep. Kept out of the
  daily radar deliberately.
- Scoring logic: `src/lib/churn-radar.js` (pure, 22 unit tests).
  Data access: `src/lib/churn-radar-data.js`. API: `/api/churn-radar/*`.

## What's next

1. **Deploy the bridge to a Pi** — champ-bridge code is merged but has
   never run on hardware. Buy the parts (Garmin ANT+ USB-m stick,
   ~20 dual-band straps, USB extension, A2 microSD), provision per
   `champ-bridge/README.md` (note: `npm ci` builds a native USB module
   — the Pi needs `libusb-1.0-0-dev` + an ANT+ udev rule), register the
   bridge at `/admin/bridges`, run the smoke test in champ-bridge
   `CLAUDE.md`. `RealAnt`/`RealBle` are only validated on real hardware.

2. **Churn radar Phase 2 — Payment-trouble signal.** The fourth signal
   needs billing health, which Glofox sync doesn't carry today.
   Investigate what the Glofox member object exposes, add a
   `glofox_billing_status` column + sync it, then wire it as a signal.

3. **Churn radar Phase 3 — the other ~7,000 contacts.** Repeat the
   exercise for leads / trials / ClassPass / dormant. The framing
   flips to *re-activation* scoring — its own design pass.

## Operational notes

- The radar feeds off the **`glofox-attendance-refresh` cron** (04:00
  Dublin). That cron now paginates its member fetch with `range()` —
  Supabase caps a response at 1,000 rows, which had been silently
  truncating the base. Same `range()` pagination is used in the radar's
  member fetch; the action-log fetch is bounded to a 90-day window.
- A Supabase migration only takes effect when the SQL is **executed
  against the database** — merging the PR / deploying to Vercel does
  not do it. Apply the migration as part of shipping any PR that
  contains one (via the Supabase `apply_migration` tooling).

## Identifier model (orientation)

Straps use one self-describing `device_key`: `ant:<deviceNumber>` or
`ble:<MAC>`. Helpers (`makeDeviceKey` / `parseDeviceKey` /
`canonicaliseDeviceKey`) live in `src/lib/bridge-samples.js` and are
duplicated into champ-bridge (`device-key.js`) and champ-app
(`heart-rate-devices.js`).
