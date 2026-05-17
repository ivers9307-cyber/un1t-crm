# Session State — May 17, 2026

One-screen "state of the world" so a fresh chat can orient in 30 seconds.
For depth, see [CLAUDE.md](./CLAUDE.md) — Done log entries #161–173 and the new lesson at the top of "Lessons learned".

## Today's headline

HOTFIX #172 (supabase-js builder `.catch()` bug) **verified live in production** — recovery had already run before this session: the 728 stranded Postmark Open + Click events drained cleanly at 18:00 UTC under the new code path, zero errors, all 15 cron heartbeats fresh. Now picking up the smallest open backlog item — extending `hasAnyMobileFeature` to honour cross-platform `dashboard_*` keys so master at a partial-features location doesn't see the wrong empty-state on mobile Home.

## What's in flight, not done

- **TestFlight 0.1.1 (5)** sitting in Apple review. Click "Remove from Review" on the ASC build page → internal testers can install → device tokens get registered → the no-token gap closes naturally. Until then, **most staff can't receive pushes** because they don't have the app.
- Once testers install, the Bookings tab + Tasks-under-More + push-tap deep-link + back-buttons-everywhere all become testable end-to-end.

## Recovery — confirmed done (May 17, 21:00 UTC)

| Check | Result |
|---|---|
| `postmark_webhook_queue` stuck rows (attempts >= 5) | 0 |
| `postmark_webhook_queue` total unprocessed | 0 |
| Rows with errors anywhere | 0 |
| Cron heartbeats stale | 0 of 15 |
| Most recent processed rows (10) | all `attempts=0`, `outcome=ok` (Open + Delivery flowing clean) |
| `recalculate_campaign_stats` re-run on May-13 "15 mins?" campaign | No counter shift — rollups were already current after the drain |

**Side note:** the "15 mins?" campaign shows 964 delivered / 2,970 sent — 32%. Not a `.catch` artifact (Delivery events were unaffected by that bug). Owner plans to analyse this from a fresh marketing push later this week.

## Now picking up

**`hasAnyMobileFeature` cross-platform dashboard gate** — the only open Permissions backlog item. Bug: `hasAnyMobileFeature(profile, activeLocation)` in `mobile/lib/permissions.js` only iterates `MOBILE_PERMISSION_KEYS` (the `.mobile.*` namespaced keys). It does NOT consider the cross-platform `dashboard_personal` / `dashboard_studio` / `dashboard_business` keys, which live at the top level of the per-location permissions blob. Failure scenario: a master at a location where every `.mobile.*` key is off but `dashboard_personal` is on sees the "Mobile features off — ask an admin" empty-state on Home, instead of the personal dashboard they're entitled to. Fix: also walk `CROSS_PLATFORM_DASHBOARD_KEYS` through `canDashboard` and OR the result. Small, low-risk, one helper + one test.

## Live state of the world

| Resource | Count |
|---|---|
| Active locations | 4 (Stillorgan / Hatch Street / CCF Autos / Test Studio) |
| Active staff | 13 |
| Contacts | 8,151 |
| Open deals | 8,153 |
| Open tasks | 0 (operator hasn't started using the tab yet) |
| Cron heartbeats | 15/15 healthy |
| Stillorgan staff with device tokens | 1 of 11 (Richard, master) |
| Last applied migration | 173_seed_sweep_stale_push_tokens_heartbeat |

## Notification system — what was built

End-to-end:
- **Backend cron** (`/api/cron/send-push-reminders`, every 5 min) scans tasks + bookings, fires 60-min and 24-hour reminders. Per-location lead times + booking notify-roles configurable. Per-user lead-time overrides for both tasks and bookings (stored on `profile_locations.permissions.mobile.lead_time_overrides`).
- **Mobile screens**: `(tabs)/bookings.jsx` for today/tomorrow operator view + `app/tasks/*` for assigned-to-me list and detail. Push-tap deep-links via `NotificationRouter` in `mobile/app/_layout.jsx`. Back chevrons work cross-navigator via shared `BackHeaderLeft` component (also fixed on Contracts + Invoices in the audit).
- **Web admin**: `/settings/notifications` (registry of every push category + per-location config strip), `/settings/notifications/health` (per-staff traffic-light delivery status + per-row "Test push" button), `NotificationConfigCard` on the per-location settings page, `LeadTimeOverrideRow` (×2 — tasks + bookings) in StaffForm.
- **Email fallback**: `notifyUsers()` wrapper at `src/lib/notify.js` adds Postmark fallback when a recipient has 0 device tokens, for categories that opt in via `fallbackEmail: true` in the registry. Currently: time_off, invoice_approved, invoice_declined, shift_adjusted. Five routes migrated (time-off decision + new request, invoice approve + decline, shift adjusted). Contracts intentionally NOT migrated — it has its own templated email path.

## Recent lessons (top 4, summarised — full versions in CLAUDE.md)

1. **supabase-js builders are thenables, not Promises.** No `.catch` method on `db.rpc(...)` / `db.from(...)`. Use `try { await ... } catch {}`. Just bit us for 4 days silently.
2. **`stampHeartbeat` is UPDATE-only.** New crons need a row pre-seeded in `cron_heartbeats` or the heartbeat silently never lands. Migration template at the bottom of `_audit_hotfix_ship.sh` history.
3. **Mobile permissions live on `profile_locations.permissions.mobile`**, NOT `profiles.permissions.mobile`. Discovered during the audit — only 2 of 13 profiles have anything under `profiles.permissions.mobile`, all 16 profile_locations rows have it.
4. **iOS auto-back-button only renders WITHIN one navigator.** Pushing from `(tabs)/X` to `app/X/[id]` is a cross-navigator nav; iOS doesn't see a previous screen so no chevron. Use the shared `BackHeaderLeft` component.

## Backlog status

**Near-empty.** Surviving items:
- ~~Extend `MOBILE_PERMISSION_KEYS` iteration in `hasAnyMobileFeature` to also evaluate cross-platform `dashboard_*` keys~~ — **in progress this session**.
- New sequence trigger: `segment_added` / `segment_removed` so saved segments can drive sequence enrolment.
- React Server Components audit pass #2 — components touched after the first audit may have re-introduced `'use client'` unnecessarily.
- Next.js 14 → 16 upgrade (focused PR, two majors — async params, async `headers()`/`cookies()`, `next/image` defaults). Closes outstanding `npm audit` advisories.
- Multi-brand middleware factoring (third brand becomes a config row, not new code).

Next-shaped concerns to watch as TestFlight rolls out:
- `push_reminder_sends` ledger growth — if it stays flat after staff install, something's filtering too aggressively.
- Per-user notification overrides — confirm at least one user has flipped one before assuming the path works.
- The May-13 campaign's 32% delivery rate, to be analysed against the next fresh push.
