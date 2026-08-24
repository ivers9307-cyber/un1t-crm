# Sonos "Live now" per-group controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live status + controls for every Sonos group in the connected household, on web and mobile, without requiring a schedule or favourites.

**Architecture:** `runLiveAction` and the two live routes accept `{ scheduleId }` OR `{ groupId }` (exactly one); the group path reads no DB row and answers `regrouped` when the id has gone stale. Web gets a "Live now" section of `SonosLiveControl` strips per group with an `onRegrouped` → household refetch; mobile renders group cards on `/sonos` above the schedule cards. Spec: `docs/superpowers/specs/2026-08-24-sonos-live-groups-design.md`.

**Repo rules that bite:** service-role routes authorise in app code (`device_control`); detail-route refusals are 404; supabase builders resolve `{data,error}`; mobile imports `shared/` as a bare package and calls `/api/*` only through `api()`; `check:mobile-lint` is ERROR-level `--max-warnings 0`; merging publishes an OTA at 100%. Ticket prefix `SONOSGRP.N`. Run everything from the worktree root; never `git stash`. zsh: quote paths with `(staff)`/`[id]`.

**Tasks** (each: implement → spec review → quality review, per subagent-driven-development):

### Task 1: `runLiveAction` dual target (`src/lib/sonos/live.js` + `live.test.js`)
Signature `runLiveAction(db, locationId, target, action, value, deps)`; `target.scheduleId` path identical to today (uuid validation stays in the routes); `target.groupId` path skips the DB read entirely, and after `mapGroups` sets `groupIds = groups.some(g => g.id === target.groupId) ? [target.groupId] : []`, answering `{ ok:false, code:'regrouped' }` when empty. Exactly-one enforced defensively (`invalid` otherwise). `logWarn` payloads carry `groupId` instead of `scheduleId` on the group path. Tests: group happy path; stale id → `regrouped`; fake db throws on `.from` for the group path; neither/both → `invalid`; all existing schedule-path tests updated to the `{ scheduleId }` argument shape and otherwise unchanged.

### Task 2: dual addressing in the routes (`src/app/api/sonos/control/route.js`, `now-playing/route.js`, `src/lib/openapi.js`)
Control `Body`: `schedule_id` optional, `group_id` optional (`z.string().min(1).max(128)`), `.refine` exactly-one; uuid check applies only to `schedule_id`. Now-playing: read both query params, enforce exactly-one (400), group path finds the group in the fetched list (absent → `{success:true, live:false, reason:'regrouped'}`) and reuses the existing volume/metadata reads. `OUTCOME.regrouped` copy reworded to "refresh and try again" (deliberate, decided at Task-1 review; the spec records it). OpenAPI entries for both routes describe the dual addressing.

### Task 3: web Live now (`src/components/automations/SonosLiveControl.jsx`, `SonosScheduleClient.jsx`)
`SonosLiveControl({ scheduleId?, groupId?, favorites, editable, onRegrouped? })` — URL/body from whichever id is present; `REASON_COPY.regrouped`; fire `onRegrouped` when a poll or action reports `regrouped`. Page: `LiveNowSection` rendered when `connected && reachable && groups.length`, one strip per group headed by name + speaker count, `editable`, `onRegrouped` → the existing household refetch. Per-schedule cards untouched.

### Task 4: mobile + docs + gate (`mobile/lib/sonos-api.js` + test, `mobile/components/SonosControlCard.jsx`, `mobile/app/(staff)/sonos/index.jsx`, `docs/CHANGELOG.md`, spec status)
Wire layer takes `{ scheduleId } | { groupId }` targets (update both consumers + tests, incl. exactly-one wire-shape pins). Card accepts `schedule` or `group` with `onStale` fired on `regrouped`; screen keeps `groups` in state, renders Live now above schedule cards, shrinks the no-schedules note to a footnote, `onStale` → `load()`. Changelog row (next free number; check the top row), spec → implemented. Full CI mirror + `npm run build`.
