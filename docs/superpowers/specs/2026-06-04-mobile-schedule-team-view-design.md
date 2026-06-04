# Mobile Schedule — "Me" / "Team" view toggle

**Date:** 2026-06-04 · **Surface:** Expo iOS app (`mobile/`) · **Status:** design approved, ready for plan

## Goal

Add a two-segment **`Me` | `Team`** control at the top of the mobile Schedule tab. **Me** is today's behaviour (the signed-in user's own shifts). **Team** shows the studio's roster for the selected day — everyone rostered at the active location, with names — so a coach can see who else is on.

## Context — current behaviour

`mobile/app/(tabs)/schedule.jsx` is a week-based screen:

- Loads the visible week's shifts + the user's time-off via `getMyShifts({ locationId, profileId, startDate, endDate })` and `getMyTimeOff(...)` (`mobile/lib/schedule-api.js`), re-fetching on week change, on tab focus, and on pull-to-refresh.
- iPhone: a `WeekStrip` (7 day pills with a count dot) + a single selected-day list of `ShiftRow`s. iPad: a 7-column `WeekGridView` of `ShiftCard`s.
- Per shift: tap to open `AdjustSheet` (time override, self or — for managers — anyone), long-press to request a swap. A time-off banner shows on days the user has approved/pending leave.

`getMyShifts` calls **`GET /api/schedule/shifts?location_id&profile_id&start_date&end_date`**. That route (`src/app/api/schedule/shifts/route.js`) is **service-role** and delegates to `fetchApiShiftRows` (`src/lib/roster-read.js`), whose select **already embeds** `profiles!profile_id ( id, full_name, email, avatar_url, role )` on every row. Authorisation is `assertLocationAccess(user, locationId)` — **any member of the location** may call it. Passing `profile_id` filters to one person; **omitting it returns the whole location's roster for the date range, names included.**

## Approach — reuse the existing route (no backend change)

| | Approach | Verdict |
|---|---|---|
| **A** | **Reuse `/api/schedule/shifts` without `profile_id`** | ✅ **Chosen** |
| B | New `/api/mobile/schedule/team` slim route (name/role/times only) | Extra route, duplicates `roster-read` logic |
| C | Reuse route + a `?slim=1` param to drop `email` | Still backend work for marginal gain |

**A** is chosen on YAGNI: the route already returns exactly what Team needs (`full_name`, `role`, `avatar_url` per shift), it is service-role so the `profiles` embed is legal (the authenticated mobile client could **not** embed `profiles` itself — see the "Lessons learned" note added with PR #371; this is the canonical "route another user's name through a service-role `/api/*` endpoint" escape hatch), and `assertLocationAccess` already authorises any location member. **Net change is mobile-only: no new route, no migration, no new permission.**

**Privacy note:** the payload also carries each colleague's `email` and `avatar_url`. The Team UI displays **name, shift, time, role, and avatar — never email**. `email` is already returned to any location member by this shared route today (the web roster uses it), so reusing it introduces **no new exposure**. Tightening the shared route's payload (web + mobile) is explicitly out of scope here.

## Permissions

**No new permission key.** Team visibility = "anyone with the mobile Schedule tab" (user-approved), which matches the web RBAC ("View full roster ✓" for staff). The Schedule screen is already gated by the `schedule` mobile permission at the nav layer, so the `Me`/`Team` toggle is simply always present on the screen. **No `shared/permissions.js` change, no `check:mobile-parity` impact.**

## UI design

**Toggle.** A two-segment control **`Me` | `Team`** pinned at the top of the screen, above the week navigation row. Default **Me**. Styled with the existing `un1t-*` tokens (selected segment = `bg-un1t-text` / `text-un1t-bg`, like the `WeekStrip` selected pill). The week navigation, `WeekStrip`, and selected-day model are shared by both modes — the toggle only changes *whose* shifts populate the day.

**Me mode** — unchanged. Own shifts for the selected day, tap-to-adjust, long-press-to-swap, time-off banner. **Zero regression** (the existing render path is reused verbatim when `view === 'me'`).

**Team mode** — for the **selected day**, a read-only list of everyone rostered at the active location. Each row (`TeamShiftRow`, new presentational component):

- Avatar from `profiles.avatar_url`, **initials-circle fallback** when null.
- **Name** (bold). The signed-in user's own row gets a subtle **"You"** chip.
- Subline: shift template name · time range (reusing `effShiftStart`/`effShiftEnd` + `timeRange`).
- A small role chip (`profiles.role`, e.g. *Coach* / *Manager*).
- Sorted by **effective start time, then name**. No tap/long-press actions (read-only).

The `WeekStrip` count dots in Team mode reflect **people rostered per day**, so the user can scan coverage across the week and tap any day. iPad: the existing `WeekGridView`/`ShiftCard` is reused with the person's name shown on each card in team mode (read-only).

## Decisions (approved)

1. **Team includes you**, marked with a "You" chip — you see where you fit in the day.
2. **Read-only in v1** even for managers. Cross-staff adjust stays a web / Me-mode action. *(Manager tap-to-adjust in Team = future.)*
3. **No time-off in Team.** Team shows who is *working*. Whole-team leave would need a separate all-staff time-off query — *deferred*. `getMyTimeOff` is therefore only called in Me mode.

## Data flow

- **`mobile/lib/schedule-api.js`** — add `getTeamShifts({ locationId, startDate, endDate })` = `getMyShifts` minus `profileId` (hits the same route without the self-filter).
- **`mobile/lib/schedule-team.js`** (new, pure, unit-tested) —
  - `effShiftStart(s)` / `effShiftEnd(s)` → **moved here** from `schedule.jsx` (the `override → row → template` resolution) so the sort helper and the screen share one definition; `schedule.jsx` imports them back. Avoids two drifting copies of the effective-time logic.
  - `teamRosterForDay(shifts, iso, selfProfileId)` → the rows whose `shift_date === iso`, sorted by `effShiftStart` then `profiles.full_name`, each annotated `{ ...row, isSelf }`.
  - `initials(fullName)` → up-to-2-letter initials for the avatar fallback.
- **`mobile/app/(tabs)/schedule.jsx`** — a `view` state (`'me' | 'team'`, default `'me'`). `fetchWeek` branches: Me → `getMyShifts` + `getMyTimeOff`; Team → `getTeamShifts` only. Toggling `view` re-fetches (same week/`useFocusEffect`/pull-to-refresh wiring). The `shiftsByDate` index is unchanged. The selected-day render branches: Me → `ShiftRow` (with actions) + time-off banner; Team → `TeamShiftRow` list (read-only). iPad grid passes the assignee name into `ShiftCard` when `view === 'team'`.

The whole-week team payload for one studio is small (~10–20 staff × 7 days), so no pagination concern (well under the 1k PostgREST cap).

## Edge / empty / error states

- Team + nobody rostered on the selected day → "No one's rostered on {day}." (mirrors the Me-mode "No shifts today." empty state).
- Errors reuse the existing red banner (`shiftsRes.error`).
- Switching `view` while a fetch is in flight: the existing `loading`/`fetchWeek` guards cover it; show the spinner on the first load of each mode, keep prior data on silent focus refetches.

## Testing

- **`mobile/lib/schedule-team.test.js`** (vitest — `mobile/lib/**` is in the config `include`): `teamRosterForDay` sort order (start time then name), self-marking (`isSelf`), date filtering, empty day; `initials` for one/two/multi-word names + null.
- CI mirror before push: `npm test && npm run lint && npm run check:mobile-parity` (parity unaffected — no permission change).
- `cd mobile && npx expo export --platform ios` — bundle compiles (new imports resolve).
- On-device: toggle Me↔Team, switch days, pull-to-refresh, impersonation (Team should reflect the effective user's active location), empty day.

## Files

| File | Change |
|---|---|
| `mobile/lib/schedule-team.js` | **new** — pure `teamRosterForDay` + `initials` |
| `mobile/lib/schedule-team.test.js` | **new** — unit tests |
| `mobile/lib/schedule-api.js` | add `getTeamShifts` |
| `mobile/app/(tabs)/schedule.jsx` | `view` state + segmented control + fetch branch + `TeamShiftRow` + iPad-grid name + empty state |

No web, schema, permission, or API-route changes.

## Out of scope / future

- Manager tap-to-adjust a colleague's shift from Team mode.
- Showing who's **off** (whole-team approved/pending leave) in Team mode.
- Tightening the shared `/api/schedule/shifts` payload to drop `email` (affects web too — separate hardening task).
