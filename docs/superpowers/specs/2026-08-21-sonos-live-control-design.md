# Sonos Live Control — Design

**Date:** 2026-08-21
**Status:** Approved in conversation (Richard, 2026-08-21)
**Repo:** un1t-crm
**Builds on:** `docs/superpowers/specs/2026-08-20-sonos-control-integration-design.md` (shipped, PR #1484)

## Why

The shipped integration schedules music but offers no way to act on the room *now*. The only immediate control is "Run now", which clears `last_applied` so the **next cron tick** re-fires — up to 60 seconds of latency, and it can only re-apply the window's own volume and favourite. Everything else means editing a schedule.

A class is louder than expected, someone is on the phone at reception, a coach wants a different playlist for this session: none of those are schedule changes. They are one-off actions on a live room, and today the only tool for them is the Sonos app.

## What this is not

The Sonos app already does all of this instantly. Building it into the CRM earns its place because the household credentials live in the CRM rather than on staff phones, access is gated by an existing permission, and it puts the room's controls on the same surface as its schedule. If the only people who ever use it already have the Sonos app open, this is redundant — that was weighed and the build was chosen anyway (Richard, 2026-08-21).

## Scope

In: volume (absolute and relative), play, pause, skip forward/back, switch to a different saved favourite, and a live now-playing readout. Web **and** the CRM mobile app.

## Architecture

One action-dispatched route:

```
POST /api/sonos/control     { schedule_id, action, value? }
GET  /api/sonos/now-playing?schedule_id=...
```

Rejected alternatives:

- **RESTful sub-routes** (`/control/volume`, `/control/play`, …) — six times the boilerplate, six auth checks, six OpenAPI registrations, no benefit.
- **A generic pass-through proxy** to the Sonos API — flexible, but an unbounded action set cannot be meaningfully permission-gated. A closed action list is the security boundary.

### The action list

| `action` | `value` | Effect |
|---|---|---|
| `volume_up` / `volume_down` | optional integer step, default 5 | `setRelativeVolume` with `±step` |
| `set_volume` | integer 0–100 | `setVolume` |
| `play` | — | `play` |
| `pause` | — | `pause` |
| `skip_next` / `skip_previous` | — | `skipToNextTrack` / `skipToPreviousTrack` |
| `load_favorite` | favourite id (string) | `loadFavorite` with `playOnCompletion: true` |

Anything else is a 400. The list is closed on purpose — it is what makes one permission check sufficient for the whole route.

**The route is the contract for both surfaces, and mobile forces that.** Mobile cannot import `src/lib` — `shared/` is the seam, and the Sonos client lives in `src/lib/sonos/`. So mobile must go through an API route regardless; making web use the same one means zero duplicated logic.

**Targeting.** The body names a `schedule_id`, not a group or player. The route loads that schedule (scoped by the caller's active location), resolves `player_ids` → current group via the existing `resolveGroupIds`, and acts. This reuses the ephemeral-group handling already built and tested, and means the control strip belongs to a schedule card rather than floating free.

Multi-group schedules act on every distinct resolved group, matching the reconcile's own behaviour.

## Interaction with the schedule — deliberately none

Live control does **not** touch `last_applied`, `last_state`, or any schedule field. It writes nothing to the database.

That is not an oversight; it is what makes the two coexist. The schedule acts only at window boundaries and ignores everything in between, so a live change simply persists until the next boundary. Concretely:

- Turn the volume down at 14:00 → it stays down until the next window opens.
- Pause at 14:00 → the 22:31 close still fires, pausing an already-paused group, which returns 499 and is already handled as benign.
- Switch favourite at 14:00 → plays until the next window opens and loads its own.

No suppression, no reconciliation, no new state. The property falls out of the exactly-once model for free.

The existing suppression **override** remains the tool for "leave the room alone for a bounded period"; live control is for one-off actions.

**Live control works regardless of `enabled` or a live override.** Both of those govern whether the *cron* acts; neither says anything about whether a human may. A disabled schedule still names real speakers, and an operator who has just suppressed the schedule for a private event is exactly the person who then wants to set the volume by hand. Gating live control on either would be the surprising behaviour, not the safe one.

The one thing a disabled schedule changes is the UI's framing: the control strip stays usable, but it should say the schedule is off so nobody reads "playing" as "the schedule is running".

## Client additions

`src/lib/sonos/client.js` gains, all on the existing never-throw `apiCall` helper:

| Function | Call |
|---|---|
| `sonosPlay(token, groupId)` | `POST /groups/{id}/playback/play` |
| `sonosSkipNext(token, groupId)` | `POST /groups/{id}/playback/skipToNextTrack` |
| `sonosSkipPrevious(token, groupId)` | `POST /groups/{id}/playback/skipToPreviousTrack` |
| `sonosSetRelativeVolume(token, groupId, delta)` | `POST /groups/{id}/groupVolume/relative` `{volumeDelta}` |
| `sonosGetGroupVolume(token, groupId)` | `GET /groups/{id}/groupVolume` → `{volume, muted, fixed}` |
| `sonosGetMetadata(token, groupId)` | `GET /groups/{id}/playbackMetadata` |

`sonosSetGroupVolume`, `sonosLoadFavorite` and `sonosPause` already exist.

### `setRelativeVolume` vs `setVolume` is not interchangeable

Sonos documents the split explicitly: use `setRelativeVolume` when the intent is "louder/quieter" (a button press), `setVolume` when the intent is a specific target (a slider release). `volumeDelta` is an integer −100…100 and Sonos clamps the result into 0–100 itself.

Using absolute volume for +/− buttons makes two people pressing "+" fight each other — each sends `current+5` read from their own stale view. Relative volume is commutative and does not.

### `fixed: true` means volume is not controllable

`getVolume` returns a `fixed` flag for groups wired to a fixed-level output. The UI must disable the volume control and say why, rather than sending commands that silently do nothing.

## Now-playing readout

`GET /api/sonos/now-playing` returns, for the schedule's primary group: `playbackState`, `volume`, `muted`, `fixed`, and the current track (`name`, `artist.name`, `album.name`, `imageUrl`) plus `container.name` / `container.service.name`.

Playback state comes from the existing `GET /households/{id}/groups` response — no extra call. Volume and metadata are two additional GETs.

Polled every **10 seconds** while a control strip is open, versus the existing 60s household poll. Two GETs per 10s is 12/min against a 1,000/min quota — a rounding error. Polling stops when the strip is closed or the tab is hidden.

All metadata fields are nullable per Sonos; the UI degrades to "Playing" with no track detail rather than rendering blanks.

## Rate limiting

Sonos spike-arrests above 100 requests/second and quotas at 1,000/minute. A dragged volume slider can approach the spike limit on its own.

- The slider commits **on release**, not on every input event.
- +/− buttons debounce to at most one request per 250ms, coalescing the delta.
- A 429 surfaces its `Retry-After` to the user as "too fast, try again in a moment" rather than a generic failure.

## Permission

**`device_control`, unchanged.** No new key, no role-default changes (Richard, 2026-08-21).

Worth stating plainly because it is narrower in intent than in effect: `device_control` currently defaults **true for master, owner and manager**, false for head coach and staff. "Owner and above" therefore also includes managers today. Tightening that means either a narrower key or a role-default change, both explicitly declined for now — recorded here so the gap is visible rather than assumed.

The consequence for mobile: the surface is for owner-level users, not coaches on the floor.

## Mobile

This is the part with real ceremony, and it is why this is not a one-afternoon change.

- **`check:mobile-parity` currently records `device_control` in `WEB_ONLY_OK`** with the reason "desktop setup surface, no mobile counterpart planned". That entry must be replaced with a genuine mobile counterpart, or the checker fails. The reason string and its comment both need rewriting — again.
- **Mobile `/api/*` wrappers must build headers via `authHeaders()`/`api()`.** A hand-rolled `Bearer` drops `x-impersonate-target` and breaks "View as user", which reads as a scoping leak.
- **A push to `main` touching a bundle path publishes an OTA to production phones** at 10%, with a 48-hour ramp-or-rollback obligation. Adding a screen under `mobile/` means deciding whether it ships and registering the path in the trigger or in `NON_BUNDLE`; `check:ota-paths` forces the choice.
- Mobile consumes the same two routes. No Sonos logic crosses into `mobile/`.

## Error handling

Every action returns the same envelope as the rest of the integration: `{ success, error? }`, plus the post-action state where cheaply available.

- `404` from Sonos means the group changed between resolve and act — re-resolve and report "the speakers regrouped, try again" rather than retrying blindly in-request.
- `499 ERROR_PLAYBACK_NO_CONTENT` on play means nothing is queued. That is a real user-facing condition ("nothing loaded — pick a favourite"), not an error to swallow, and it is the one case where the *schedule's* favourite is the obvious remedy.
- Token failure returns the existing tagged reasons (`not_connected`, `refresh_failed`) so the UI can prompt a re-link exactly as the config page does.
- A failed action must not leave the UI showing the optimistic state. Controls revert on failure.

## Testing

- **Pure:** the action dispatch table (action → client call + argument shape), including rejection of an unknown action.
- **Client:** each new call against mocked `global.fetch`, matching the existing `client.test.js` pattern — URL, method, body, and the never-throw contract.
- **Route:** authorisation (401/403), location scoping (a `schedule_id` from another location must 404, not act), and the `fixed: true` volume refusal.
- **Explicitly asserted:** that a live action writes **nothing** to `sonos_schedules`. This is the property that keeps live control and the schedule from fighting, and it should fail loudly if someone later "helpfully" stamps `last_applied`.

## Suggested build order

The web and mobile halves are separable and should be two plans, not one. Web (client additions, both routes, the control strip) is self-contained and shippable on its own; mobile adds no Sonos logic but carries the parity, OTA and `authHeaders()` ceremony described above. Building web first also means the route contract is proven by a real consumer before a second one depends on it.

## Out of scope

Grouping and ungrouping speakers, per-player (rather than per-group) volume, queue manipulation beyond skip, seek, play-mode (shuffle/repeat) toggles, and audio-clip announcements. None need schema changes to add later.
