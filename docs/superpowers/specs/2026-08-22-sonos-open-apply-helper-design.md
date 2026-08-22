# Sonos open-apply helper — design

**Date:** 2026-08-22 · **Status:** implemented (SONOSAPPLY.1-4) · **Ticket prefix:** SONOSAPPLY

## Problem

Two callers open a Sonos window — the reconcile cron
(`src/lib/sonos/reconcile.js`) and "Run now"
(`src/app/api/sonos/schedules/[id]/run-now/route.js`). Each carries its own
copy of the same sequence:

1. for every resolved group: `setVolume`, then `loadFavorite` (volume first,
   or the opening seconds play at the previous window's level; a failed
   volume skips that group's favourite);
2. if any group failed, stamp nothing (an unapplied window retries next tick;
   stamping would cost the whole window);
3. otherwise write `last_applied: { window_on_at, action: 'open', at }` and
   `last_state` in one UPDATE.

The duplication is where the stranded-close bug lived (SONOSLIVE.6): run-now
had its own idea of what to do with `last_applied`. The rule that
`window_on_at` must stay a raw number is currently enforced by two copies of a
comment. One home for the sequence means one place for the rule and one test
to pin it.

## Design

### `src/lib/sonos/apply.js`

One export:

```js
applyOpen(db, {
  token,      // access token (string)
  schedule,   // the sonos_schedules row ({ id, location_id, ... })
  plan,       // planAction's open result: { action:'open', windowOnAt, volume, favoriteId }
  groups,     // mapGroups(...).groups — used for last_state.playback_state
  groupIds,   // resolveGroupIds(groups, schedule.player_ids) — already non-empty
  nowMs,      // the caller's clock (reconcile injects it; run-now uses Date.now())
  deps,       // optional: { setVolume, loadFavorite } — default to the client functions
})
→ { ok: true }
| { ok: false, reason: 'sonos' }           // ≥1 group failed; nothing stamped
| { ok: false, reason: 'stamp', error }    // every group succeeded; the UPDATE failed
```

The three outcomes stay distinct because the two callers already treat them
differently and the helper must not decide for them:

- reconcile: `sonos` → `failed++`; `stamp` → `failed++` (unchanged)
- run-now: `sonos` → 502 "That did not work"; `stamp` → `success: true` with
  `warning: 'applied, but the record did not save'`, because the music IS
  playing (unchanged)

Logging stays in the helper (`logWarn`, module `sonos-apply`), with a
superset of the payloads both callers emit today (`scheduleId` is added to
every line), so nothing an operator greps for disappears.

The stamp UPDATE filters on `.eq('id', schedule.id)` only. Run-now today also
adds `.eq('location_id', locationId)`; that guard is redundant — run-now
selected the row by `id` + `location_id` moments earlier and the helper
receives that row — and keeping it would mean threading a location id through
the helper for one caller. Authorisation stays at the route boundary.

### What stays with the callers

- **Close** (pause + the 499 `ERROR_PLAYBACK_NO_CONTENT` = success rule)
  stays in the reconcile. Run-now never closes; there is nothing to share.
- **Token, groups read, `resolveGroupIds`** stay in each caller. Run-now's
  HTTP responses depend on which of those steps failed; the reconcile logs
  and counts per location. The helper starts where both callers have a token,
  a group list and a non-empty `groupIds`.
- **`planAction`** stays in each caller. Run-now calls it with
  `last_applied: null` (re-apply regardless), the reconcile with the real
  row; the helper just takes the resulting plan.

### Injection

`deps.setVolume` / `deps.loadFavorite` default to `sonosSetGroupVolume` /
`sonosLoadFavorite`. `runSonosReconcile` passes its own already-injected
`setVolume`/`loadFavorite` straight through, so the existing reconcile tests
keep exercising the helper end to end via fakes. Run-now passes nothing.

## Tests

`src/lib/sonos/apply.test.js`:

- all groups succeed → exactly one UPDATE, `last_applied.window_on_at` is a
  **number** equal to `plan.windowOnAt`, `action: 'open'`, `at` is the ISO of
  `nowMs`; `last_state.group_id` is the first group and `playback_state` is
  that group's state; returns `{ ok: true }`
- one of two groups fails `setVolume` → that group's `loadFavorite` is not
  called, the other group is still attempted, no UPDATE, returns `sonos`
- `loadFavorite` fails → no UPDATE, returns `sonos`
- call order per group: `setVolume` before `loadFavorite`
- UPDATE returns an error → returns `{ ok: false, reason: 'stamp', error }`
- a `null` `favoriteId` is passed through to `loadFavorite` unchanged (the
  planner's documented choice, not the helper's to second-guess)

Existing `reconcile.test.js` and the run-now behaviour stay green unchanged.
Run-now has no route test today; the helper test covers the body it now
delegates to.

## Out of scope

Per-group `last_applied` (the known multi-group partial-failure re-open) —
needs a schema change, recorded in memory as accepted.

- The close stamp in the reconcile still hand-rolls the `last_state`/`updated_at` shape; a `stampLastApplied` shared by open and close would pin the raw-number rule on both writers. One guarded writer and one unguarded one is accepted for now.
