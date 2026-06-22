# InBody SP2 — Phase 2a (go-forward enrich) Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull the actual body-composition measurements for each captured InBody scan notification and land them in `inbody_scans`, matched to a contact — using the on-site Raspberry Pi (champ-bridge) as the whitelisted-IP fetcher.

**Architecture:** The Pi is a thin fetcher; the CRM is the brain. The webhook (Phase 1, shipped) already captures `{ usertoken=phone, datetimes }` into `inbody_webhook_events`. The Pi polls the CRM for unprocessed events, calls the InBody REST API (`/inbody/GetFullInBodyData`) from the gym's whitelisted public IP, and relays the raw response back to the CRM, which maps it to `inbody_scans`, matches the phone to a contact, and marks the event processed. The InBody API key lives only on the Pi. No new migration — `inbody_webhook_events` (mig 284) and `inbody_scans` (mig 272) already exist.

**Tech Stack:** Next.js App Router service-role API routes (un1t-crm); Node + undici systemd service (champ-bridge); vitest both sides.

**Key facts (from the API docs, 2026-06-22):**
- Base `https://apieur.lookinbody.com/inbody`, POST, headers `API-KEY` + `Account: stillorganun1t`.
- `POST /GetFullInBodyData` body `{ usertoken, datetimes }` → full measurement set (full field names).
- Date format `yyyyMMddHHmmSS`. Limit **500 calls/device/day** (resets 00:00 UTC; 401 over). IP whitelist enforced (401 from non-registered IP).
- `verifyBridgeToken()` returns `{ bridgeId, locationId, ... }` → resolves `inbody_scans.location_id`.
- Contact match: `normalisePhone9()` (last-9-digit) from `src/lib/person-links.js`; contacts carry `phone` + `wa_phone`.
- Response measurement field names are unknown (behind doc "View Example" toggles) → map defensively + always keep `raw`; confirm against first real response.

---

## Repo 1 — un1t-crm

### Task 1: `parseFullInBodyData` mapping lib
**Files:** Create `src/lib/inbody-scan.js`, `src/lib/inbody-scan.test.js`

- [ ] Write failing tests: defensive key lookup maps weight/PBF/SMM/BMI/BMR/BFM/score from both full-name and abbreviation forms; missing keys → null; non-object → all null.
- [ ] Implement `parseFullInBodyData(raw)` → `{ weight_kg, pbf_percent, smm_kg, bmi, bmr, body_fat_mass_kg, inbody_score }`. Build a normalized-key index (lowercase, alphanumeric only) of `raw`; `pickNum(idx, [...candidates])` returns first numeric hit (parseFloat; NaN→null). Candidates: weight←weight,wt; pbf←percentbodyfat,pbf,bodyfatpercentage; smm←skeletalmusclemass,smm; bmi←bmi,bodymassindex; bmr←basalmetabolicrate,bmr; bfm←bodyfatmass,bfm; score←inbodyscore,score.
- [ ] Run tests green. Commit.

### Task 2: `GET /api/bridge/inbody/pending`
**Files:** Create `src/app/api/bridge/inbody/pending/route.js`

- [ ] `export const runtime='nodejs'`. `verifyBridgeToken(request)` → 401 if null. Service-role select from `inbody_webhook_events` where `processed=false`, order `received_at asc`, limit 50. Return `{ pending: [{ event_id:id, usertoken:tel_hp, datetimes:test_datetime }] }`. (Single-location: Stillorgan is the only InBody account; events carry no location at capture, ingest stamps it. Note for 2c: filter by the bridge's account when multi-location.)
- [ ] Manual shape check; commit.

### Task 3: `POST /api/bridge/inbody/ingest`
**Files:** Create `src/app/api/bridge/inbody/ingest/route.js`

- [ ] `verifyBridgeToken` → 401. Body `{ results: [{ event_id, raw }] }` (cap 50). For each: re-load the event by id (authoritative `tel_hp`/`test_datetime`); skip if already `processed`. Compute `scanned_at = inbodyDatetimeToIso(test_datetime)`, `external_id = ${tel_hp}_${test_datetime}`. `parseFullInBodyData(raw)` → measurements. Match contact: `normalisePhone9(tel_hp)`, prefilter `contacts` by `phone.ilike.%tail%` / `wa_phone.ilike.%tail%`, exact-match on normalisePhone9, link only if exactly one. Upsert `inbody_scans` on `(source,external_id)` with `location_id = bridge.locationId`, `matched_phone = tel_hp`, `contact_id`, `raw`. Mark the event `processed=true, processed_at=now(), matched_contact_id, location_id`. Tolerate per-item failure (log, continue). Return `{ processed: n, linked: m }`.
- [ ] Commit.

### Task 4: CRM verify + PR
- [ ] `npm test`, route-guards (both new routes must be webhook/bridge-recognised via `verifyBridgeToken`), `npm run lint` (0 errors, no new warnings in new files). PR base=main, watch CI, squash-merge.

---

## Repo 2 — champ-bridge (the Pi)

### Task 5: InBody poller
**Files:** Create `src/inbody.js`, `src/inbody.test.js`; modify `src/config.js`, `src/api.js`, `src/index.js`, `.env.example`, `CLAUDE.md`/`README.md`

- [ ] `config.js`: add optional `inbodyApiKey` (`INBODY_API_KEY`), `inbodyAccount` (`INBODY_ACCOUNT`), `inbodyApiUrl` (`INBODY_API_URL`, default `https://apieur.lookinbody.com`), `inbodyPollMs` (`INBODY_POLL_MS`, default 300000), `inbodyDailyCap` (default 450 — safety under the 500 hard cap). InBody polling only runs when `inbodyApiKey` + `inbodyAccount` are set.
- [ ] `api.js`: add `getInbodyPending()` (GET `/api/bridge/inbody/pending`, bearer) and `postInbodyIngest(results)` (POST `/api/bridge/inbody/ingest`). Add a `getJson` sibling to `postJson`.
- [ ] `inbody.js`: `fetchFullInBodyData({apiUrl,apiKey,account,usertoken,datetimes})` (pure-ish undici POST, returns parsed body or null); `runInbodyCycle({api, fetcher, cap})` — get pending → for each (up to remaining daily cap) fetch → collect `{event_id, raw}` → ingest. Pure helper `withinDailyCap(count, sentToday, cap)` unit-tested; cap counter resets on UTC date change.
- [ ] `index.js`: if InBody configured, `setInterval(runInbodyCycle, inbodyPollMs)` + one kick on boot; log a one-line startup notice.
- [ ] `.env.example` + docs: document the 4 env vars + the `curl ifconfig.me` → whitelist step.
- [ ] `npm test` + `npm run lint` green. Commit.

### Task 6: bridge verify + PR
- [ ] champ-bridge `npm test` + `npm run lint`. PR base=main, watch CI (if any), merge.

---

## Out of scope (later)
- **2b backfill:** `/GetDateTimes` per member → `/GetFullInBodyData` per datetime, throttled + resumable under the 500/day cap.
- **2c polish:** `locations.settings.inbody` (account→location for multi-location; optional CRM-managed key), analytics, scan freshness on the dashboard. SP1 contact-page charts already render `inbody_scans`.
