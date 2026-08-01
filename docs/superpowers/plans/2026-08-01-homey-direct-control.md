# Homey Direct Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** CRM (Vercel) drives Homey Pro devices directly over the remote Web API — per-minute reconcile cron + instant toggle; the Pi bridge routes die.

**Architecture:** see `docs/superpowers/specs/2026-08-01-homey-direct-control-design.md` (approved). Pure logic in `src/lib/homey/`, thin cron route, toggle fire-and-forget, bridge tapo routes deleted, mig 471 heartbeat row.

**Tech Stack:** Next.js 16 route handlers, supabase-js service client, vitest. No new deps (`fetch` + `AbortSignal.timeout`).

**Branch/worktree:** `feat/homey-direct` at `~/code/un1t-crm-homey`.

**Porting sources** (reviewed + merged in champ-bridge today — read via git so the strip PR can't race you):
- `git -C ~/code/champ-bridge show 4511353:src/homey.js` (mappers; adapt `id` → `sidecar_device_id`)
- `git -C ~/code/champ-bridge show 4511353:src/homey.test.js` (test matrix incl. filter-precedence + never-guess pins)
- `git -C ~/code/champ-bridge show 4511353:src/tapo-logic.js` (diff semantics reference for planCommands)
- In-repo: `src/app/api/bridge/tapo/state/route.js` (reportDeviceStates logic — port verbatim in behaviour, then the route is deleted in Task 5), `src/app/api/bridge/tapo/directives/route.js` (Dublin-day occurrence bounds + the tomorrow's-occurrences warning comment — MUST move with the code), `src/app/api/cron/class-climate/route.js` (cron skeleton), `supabase/migrations/470_equipment_cron_heartbeats.sql` (heartbeat-row migration pattern).

House rules that bite here: supabase builders are thenables (try/catch, never `.catch`); every `.insert/.update` awaited; `dublinTodayStr()` never `toISOString().slice`; cron needs CRON_SECRET guard + `stampHeartbeat` + vercel.json + heartbeat row in ONE migration; openapi.js must drop deleted routes; tests under `TZ=Europe/Dublin` AND a US TZ where dates are involved (the engine's own tests already cover the engine).

---

### Task 1: `src/lib/homey/devices.js` — pure mappers + planCommands (+ tests)

**Files:** Create `src/lib/homey/devices.js`, `src/lib/homey/devices.test.js`.

- `mapHomeyDevices(raw)` / `mapHomeyStates(raw)`: port from champ-bridge `src/homey.js` with the row key renamed `id` → `sidecar_device_id` (CRM vocabulary; still `homey:<device-id>` values). Same filter (capabilities array authoritative, empty array excludes, capabilitiesObj fallback), same socket→plug, same strictly-boolean state, same `reachable = available !== false`, same junk tolerance.
- `planCommands(deviceRows, stateRows, nowMs, today, occurrences)`: `deviceRows` are `tapo_devices` rows (already filtered `enabled=true` by the caller, but re-guard `d.enabled !== false`); build a Map from `stateRows` by `sidecar_device_id`; desired = `desiredState(d, nowMs, today, occurrences)` from `@/lib/tapo/desired-state`; emit `{ sidecar_device_id, on: desired === 'on' }` only when desired is `'on'|'off'`, the actual exists, `reachable !== false`, and `actual.state !== desired`.
- TDD. Port the champ-bridge test matrix (8 mapper cases) + planCommands cases: command emitted on mismatch; no command when in-state / unreachable / unknown-to-Homey / desired null (`schedule_mode:'none'`, no override); override-wins case (reuse an override fixture per `desired-state.test.js` shapes to prove pass-through, not to re-test the engine).
- Run `npx vitest run src/lib/homey/devices.test.js` red → implement → green. Commit `HOMEYD.1`.

### Task 2: `src/lib/homey/client.js` — config + HTTP (+ config tests)

**Files:** Create `src/lib/homey/client.js`, `src/lib/homey/client.test.js`.

- `homeyConfigError(env)` pure (exported, tested — port the champ-bridge validator): null unless configured; requires all of `HOMEY_API_URL` (parseable, http(s), **bare origin** — `pathname !== '/' || search || hash` → error naming the web-app-URL mis-paste), `HOMEY_API_KEY` (non-blank after trim), `HOMEY_LOCATION_ID` (validate with `uuidLike` from `@/lib/schemas`). Distinguish "not configured at all" (all three unset → dormant) from "half configured" (some set → return an error string; the cron logs it loudly instead of silently skipping forever).
- `getHomeyConfig(env = process.env)` → `{ url (origin via new URL().origin), apiKey (trimmed), locationId } | null` when fully unset | `{ error }` when misconfigured.
- `homeyGetDevices(cfg)` → GET `${cfg.url}/api/manager/devices/device`; `homeySetOnoff(cfg, sidecarDeviceId, on)` → strip `homey:` prefix, encodeURIComponent, PUT `{ value: on }`. Both: `fetch` with `Authorization: Bearer`, `AbortSignal.timeout(8000)`, never throw, return `{ ok, statusCode, body }` (json parse guarded).
- Tests: config matrix (unset→null; partial→error; path/query URL→error; whitespace key→error; good→origin-normalised object; uuid check). HTTP fns: not unit-tested (thin I/O, house pattern) — but keep them export-isolated so reconcile tests inject fakes.
- Commit `HOMEYD.2`.

### Task 3: `src/lib/homey/reconcile.js` (+ tests)

**Files:** Create `src/lib/homey/reconcile.js`, `src/lib/homey/reconcile.test.js`.

- `reportDeviceStates(db, locationId, rows)`: port the state route's select→branch loop **behaviour-identically** (comments included: why not upsert; 23505 benign race → update fallback; failed lookup must not fall through to insert; `last_seen_at` only when `reachable !== false`; unknown → insert `enabled:false, schedule_mode:'none', kind, name: name_hint||null`). Honest `{updated, discovered, failed}`.
- `runHomeyReconcile(db, deps = {})`: `const cfg = deps.getConfig?.() ?? getHomeyConfig()`; `null` → `{ skipped: true, reason: 'unconfigured' }`; `cfg.error` → log via `logWarn('homey-reconcile', ...)` + `{ skipped: true, reason: 'misconfigured' }`. Else: `getDevices(cfg)` (injectable, default `homeyGetDevices`); failure → `logWarn` with statusCode (401 = key) + `{ ok: true, homeyDown: true }`. Map devices+states; load enabled `tapo_devices` for `cfg.locationId` and today's occurrences with the directives route's exact Dublin-day bounds + warning comment; `planCommands`; fire `setOnoff` per command sequentially (count `commanded`/`commandFailures`, log failures with statusCode); `reportDeviceStates` with the full snapshot; return all counters.
- Tests with injected deps + minimal fake db (chainable stub returning fixture rows — model on whatever existing lib test fakes supabase queries the lightest; keep the fake tiny): unconfigured skip; misconfigured skip logs; homey-down returns without touching db; happy path commands only the mismatched device and reports all; command failure doesn't block the report.
- Commit `HOMEYD.3`.

### Task 4: cron route + vercel.json + mig 471 + instant toggle

**Files:** Create `src/app/api/cron/homey-reconcile/route.js`, `supabase/migrations/471_homey_reconcile_heartbeat.sql`; modify `vercel.json`, `src/app/api/tapo/devices/[id]/toggle/route.js`.

- Cron route: clone the `class-climate` skeleton (CRON_SECRET guard, `runtime nodejs`, `dynamic force-dynamic`, `maxDuration 60`), call `runHomeyReconcile(db)`, `stampHeartbeat('homey-reconcile')` in try/catch, return `{ success: true, ...out }`.
- vercel.json: add `{ "path": "/api/cron/homey-reconcile", "schedule": "* * * * *" }` (keep array formatting/ordering conventions).
- Mig 471: heartbeat row per mig 470's pattern; `stale_after` generous vs the 1-min cadence (match how the most-frequent existing cron sets it — read a couple of heartbeat migs and copy the tightest-cadence precedent). Do NOT apply — the controller applies via Supabase MCP before merge.
- Toggle route: after the successful override update + response payload is prepared, fire-and-forget block: `try { const cfg = getHomeyConfig(); if (cfg && !cfg.error) homeySetOnoff(cfg, device.sidecar_device_id, desiredOn).catch(() => {}) } catch {}` — wait, `homeySetOnoff` never rejects by contract; still wrap per house pattern and do NOT await it before responding (or await with its own try/catch — follow the route's existing style; it must never change the response). Read the route first: it knows the new override state — derive `desiredOn` from what it wrote.
- Run `npm test`, `npm run lint`, `npm run check:route-guards` (new cron must pass the CRON_SECRET pattern). Commit `HOMEYD.4`.

### Task 5: delete bridge routes + openapi + CHANGELOG + full CI

**Files:** Delete `src/app/api/bridge/tapo/directives/route.js`, `src/app/api/bridge/tapo/state/route.js` (git rm the `bridge/tapo` dir); modify `src/lib/openapi.js` (remove both registrations, lines ~1193-1215 — verify by grep), `docs/CHANGELOG.md` (one entry, next number, cite mig 471 + this spec + champ-bridge strip).
- Grep: `grep -rn "bridge/tapo" src/` → nothing. `grep -n "tapo" src/lib/openapi.js` → only the staff `/api/tapo/*` entries.
- Full CI mirror (all six) + `npm run build` (route deletions + new imports make this mandatory). Commit `HOMEYD.5`.

### Task 6: final whole-branch review → push → PR

Final reviewer over `git diff origin/main..HEAD`; controller applies mig 471 via MCP + advisors; push; `gh pr create --base main` reporting URL. PR body: what/why (Richard's Pi-independence call), env vars to set, exit gate.

---

**Parallel (different repo, independent):** champ-bridge strip PR — remove `src/tapo.js`, `src/tapo-logic.js`, `src/homey.js` + their three test files, the tapo/homey config entries + `homeyConfigError` + validation call, the index.js tapo block (imports, timer, SIGTERM line), README "Device control via Homey Pro" section + exit-gate subsection, any tapo/homey lines in `.env.example`; suite + lint green; PR "Strip device control — Pi is HR/InBody only (CRM drives Homey directly)".
