# Session State — May 17, 2026

One-screen "state of the world" so a fresh chat can orient in 30 seconds.
For depth, see [CLAUDE.md](./CLAUDE.md) — Done log entries #161–172 and the new lesson at the top of "Lessons learned".

## Today's headline

Shipped the **end-to-end push notification system** (NOTIF.1–10) and caught **one silent production bug** in the pre-onboarding audit: supabase-js builder `.catch()` was a no-op for ~4 days, 728 Postmark Open + Click webhook events stranded. Fix shipped in HOTFIX #172.

## What just deployed (last hour)

- **HOTFIX**: `try { await db.rpc(...) } catch {}` across 7 sites in `postmark-webhook-processor.js`, `sequences/scheduler.js`, `sequences/steps.js`. Three files committed in the latest push.

## Manual recovery — DO IF NOT YET DONE

Run in Supabase SQL editor once Vercel finishes deploying (check `/api/cron/health-check` returns 200, or just wait 3 min):

```sql
-- 1. Re-arm the 728 stuck Postmark webhooks under the fix
UPDATE postmark_webhook_queue
SET attempts = 0, error = NULL
WHERE processed_at IS NULL AND attempts >= 5;

-- 2. Watch them drain (should fall to 0 in ~8 min)
SELECT COUNT(*) FROM postmark_webhook_queue WHERE processed_at IS NULL;

-- 3. After drain, refresh open/click rollups on recent campaigns
SELECT recalculate_campaign_stats(id) FROM campaigns
WHERE created_at > NOW() - INTERVAL '14 days';
```

## What's in flight, not done

- **TestFlight 0.1.1 (5)** sitting in Apple review. Click "Remove from Review" on the ASC build page → internal testers can install → device tokens get registered → the no-token gap closes naturally. Until then, **most staff can't receive pushes** because they don't have the app.
- Once testers install, the Bookings tab + Tasks-under-More + push-tap deep-link + back-buttons-everywhere all become testable end-to-end.

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

**Empty.** All earlier backlog items shipped this session. Next-shaped concerns:
- Watch the `push_reminder_sends` ledger grow as TestFlight rolls out. If it stays flat after staff install, something's filtering too aggressively.
- Per-user notification overrides on `permissions.mobile.notify_<category>` already exist via StaffForm — confirm at least one user has flipped one before assuming the path works.
- Per-location notification config defaults to `60min + 24h` for both categories. Stillorgan currently has `notify_roles=[owner,manager,head_coach,staff]` (operator-set). Other locations are on built-in defaults.
- Cron route `pipeline-classify` is still a low-traffic surface — only 4 active locations, runs nightly. Was missing a heartbeat seed + had a wrong call signature; both fixed in #169 audit follow-up.
