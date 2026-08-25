# Sonos "Live now" — controls per group, schedule optional

**Date:** 2026-08-24 · **Status:** implemented (SONOSGRP.1-4) · **Ticket prefix:** SONOSGRP
**Context:** Hatch Street connected its Sonos household (24 Aug) but has no schedules and no favourites. Both surfaces hang the live strip off a schedule row, so Hatch gets no live status or controls at all — even though `GET /api/sonos/household` already returns every current group with its `playbackState`.

## What

Live status + transport + volume for every speaker **group** in the connected household, on both surfaces, with or without schedules or favourites. Favourite chips continue to hide themselves when the list is empty. Schedules, the exactly-once engine, and permissions (`device_control` everywhere) are untouched.

## API — dual addressing

`GET /api/sonos/now-playing` and `POST /api/sonos/control` accept **exactly one** of `schedule_id` | `group_id`.

- `schedule_id`: unchanged — uuid-validated, row loaded scoped to the active location, groups resolved via `player_ids`.
- `group_id`: a Sonos group id (`RINCON_…:N` — an opaque string, NOT a uuid; validate non-empty string ≤ 128 chars). No DB row is read. After the fresh `getGroups` fetch, the target is `[group_id]` if that id is present in the household's current groups; otherwise the existing **`regrouped`** outcome ("The speakers regrouped — refresh and try again" — reworded from this spec's draft at review, deliberately). `regrouped` is the honest code — group ids are ephemeral by design — and NOT `no_group`, whose copy talks about a schedule's speakers.
- Neither or both ids → 400 `Invalid request` (control: Zod refine; now-playing: explicit check).
- Location safety is structural: the token comes from the active location's own connection (`withFreshToken`), so another household's group id is simply absent from the groups fetch → `regrouped`. No cross-location read or write exists.

### `src/lib/sonos/live.js`

`runLiveAction(db, locationId, target, action, value, deps)` where `target` is `{ scheduleId }` **or** `{ groupId }` (exactly one; the routes guarantee this, and the function returns `{ ok:false, code:'invalid' }` otherwise as defence in depth).

- Schedule path: byte-for-byte today's behaviour.
- Group path: **no `sonos_schedules` read at all** (pinned by test: the fake db throws on `.from`). Token → groups fetch → membership check → the same fixed-volume guard, dispatch loop, and outcome mapping as today, over `[groupId]`.

### `now-playing` group path

Same dual addressing. Group absent from the fetch → `{ success: true, live: false, reason: 'regrouped' }`. The happy path reuses the existing single-group read (playbackState from the groups body, volume + metadata GETs).

## Web — `/automations/sonos`

New **Live now** section, rendered whenever `household.connected && household.reachable && household.groups?.length` — always, not only when schedules are empty (the full-household view helps Stillorgan too). One `SonosLiveControl` per group, headed by the group's `name` and speaker count (`playerIds.length`).

`SonosLiveControl` gains a `groupId` prop as the alternative to `scheduleId` (exactly one): it builds the query/body from whichever is present. New optional `onRegrouped` callback — fired when a control or the poll answers with `code`/`reason` `regrouped` — which the page uses to refetch the household so the section heals to the new grouping. `REASON_COPY` gains `regrouped: 'The speakers regrouped — refreshing the groups…'`.

Per-schedule strips stay exactly as they are. The strips in Live now pass `editable={true}` (the section only renders when reachable; page access is already `device_control`).

## Mobile — `/sonos`

The screen already fetches the household; it now keeps `groups` in state and renders a **Live now** list — one card per group — above the schedule cards. When there are no schedules, the "No studio music is set up…" copy shrinks to a one-line footnote *below* the live cards instead of being the whole screen (it still points at Marketing → Automations → Studio music). When there are no groups either (household unreachable / not connected), today's states are unchanged.

`mobile/components/SonosControlCard.jsx` accepts `schedule` **or** `group` (exactly one): title `schedule?.name || group?.name || 'Studio music'`, with the group card sub-titled by speaker count. `mobile/lib/sonos-api.js`: `getSonosNowPlaying(target, locationId)` and `sendSonosAction(target, action, value, locationId)` where `target` is `{ scheduleId }` or `{ groupId }` — call-site and test updates included (the wire layer has exactly two consumers, both ours). A `regrouped` failure on a group card calls an `onStale` prop; the screen responds by re-running `load()`.

Merging publishes an OTA at 100% to the 2.3.0 lane (bundle paths). No native change.

## Tests

- `live.test.js`: group-target happy path (single-group dispatch, correct call args); group absent → `regrouped`; **no DB read on the group path** (fake db throws on `.from`); neither/both targets → `invalid`; existing schedule-path tests unchanged.
- Route-level Zod exactly-one is covered by the control route's `Body` refine (tested through `live.test.js`'s `invalid` only indirectly — the route has no test file today, consistent with the other sonos routes).
- `mobile/lib/sonos-api.test.js`: both target shapes produce the right URL/body; exactly-one enforced by the wrapper (throws or returns invalid? — the wrapper passes through; the server rejects; wrapper stays dumb, tests pin the wire shape only).
- Gates: full CI mirror + build, `check:mobile-*`, `check:ota-paths`.

## Out of scope

- Grouping/ungrouping speakers from the CRM (Sonos app does it).
- Catalogue search (rejected 24 Aug — the Control API has no such surface).
- Schedules for Hatch (separate, when Richard wants them).
