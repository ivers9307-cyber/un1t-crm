# Host scheduled send — HOST-SCHEDULE.1

**Date:** 2026-09-07 · **Owner decision:** Richard, 7 Sep 2026 (host portal only) · **Status:** design, awaiting review · **Builds on:** HOST-CONSENT.1 (#1632), HOST-METRICS.1 (#1633)

## Decision

A host can schedule an email for a Dublin date and time instead of sending it now. It fires within two minutes of that time through the existing send machinery. Until it fires the host can cancel it back to a draft or edit and reschedule. Every send gate (verified sender, host stream, daily cap, consent, suppression) is evaluated when it fires, not when it is scheduled. If a gate refuses at fire time the email goes back to a draft with a visible reason instead of vanishing.

## Why

The host audit listed scheduling as a missing state. Colm writes on his own time and wants sends to land at a chosen hour. CRM campaigns already have a `scheduled` status and the host sweeper already runs every two minutes, so this is a small extension, not a new system.

## Scope

**In:** `scheduled` status and `scheduled_for` on `host_campaigns`; a schedule action beside Send on the draft row with a Dublin date-time picker; cancel and reschedule; the sweeper launches due campaigns; gate failures at fire time return the email to draft with a reason shown on the list row; the send-now path shares one launch function with the scheduled path.

**Out:** recurring sends; staff scheduling on a host's behalf from the CRM side (impersonation still works because it uses the same portal, but nothing is added for it); timezone selection (Dublin only); send-time optimisation.

## Design

### 1. Data (mig 592)

```sql
alter table host_campaigns drop constraint if exists host_campaigns_status_check;
alter table host_campaigns add constraint host_campaigns_status_check
  check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed'));
alter table host_campaigns
  add column if not exists scheduled_for timestamptz,
  add column if not exists schedule_error text;
create index if not exists idx_host_campaigns_due
  on host_campaigns (scheduled_for) where status = 'scheduled';
```

`scheduled_for` is UTC; the portal converts to and from Europe/Dublin. `schedule_error` is set only when a fire-time gate refused; it is cleared on the next successful schedule or send. Vocabulary (fixed in code): `sender_not_verified`, `no_stream`, `daily_cap`, `no_recipients`, `launch_failed`.

### 2. One launch function

`launchHostCampaign(db, { campaignId, hostId, trigger })` in a new `src/lib/host-campaign-launch.js`, extracted from the send route without behaviour change: loads campaign + host, runs the gates in the existing order (sender verified → stream for marketing → daily cap → recipients resolved → CAS to `sending` stamping `recipient_count` → chunked enqueue into `host_campaign_sends` → QStash kick). Returns `{ ok: true, recipientCount }` or `{ ok: false, reason, status }` with the same reasons and HTTP statuses the route uses today. `trigger` is `'send_now'` or `'schedule'` and only affects the CAS: send-now flips `draft → sending`, the sweeper flips `scheduled → sending`.

`POST /api/host/emails/[id]/send` becomes a thin wrapper: session, ownership 404, then `launchHostCampaign` and map the result to the existing responses. The daily cap keeps counting `created_at` today as it does now; fixing that axis is a separate follow-up.

### 3. Schedule, cancel, reschedule

- `POST /api/host/emails/[id]/schedule` body `{ scheduled_for }` (ISO). Session + ownership 404. Validation: parses as a date; at least 15 minutes in the future; at most 90 days ahead. Gates run at schedule time too, for early feedback only (sender verified, stream present for marketing); the cap and recipients are not checked here because they can change. CAS `draft → scheduled` (a campaign already scheduled or sent 409s). Clears `schedule_error`. Returns the campaign row.
- `POST /api/host/emails/[id]/unschedule`: CAS `scheduled → draft`, `scheduled_for = null`. 409 if it already fired.
- Reschedule: a scheduled row's "Change time" reopens the same panel prefilled and posts to `/schedule` again, which is allowed from `scheduled` as well as `draft` (CAS on either, keeping `scheduled`). Editing the body of a scheduled campaign first cancels it ("Edit" on a scheduled row unschedules with a confirm, then opens the composer as a draft), so the existing `PATCH` stays CAS'd on `draft` and a mid-edit fire cannot happen.

### 4. Firing

The sweeper `GET /api/cron/send-host-campaigns` (every two minutes) gains a step before its existing `sending` loop: select up to 10 campaigns `where status = 'scheduled' and scheduled_for <= now()` ordered by `scheduled_for`, and for each call `launchHostCampaign(..., trigger: 'schedule')`. On `ok` it proceeds to the same tick as any sending campaign. On a refusal it CAS-updates `scheduled → draft` with `scheduled_for = null` and `schedule_error = reason`, logs at error level, and continues. The QStash worker is untouched: once a campaign is `sending` the two consumers behave exactly as today.

Two sweeps cannot double-launch: the CAS on `scheduled → sending` inside the launch is the lock, the same pattern that protects send-now against a double click.

### 5. Portal UI

- Draft row actions (where Edit / Test / Send live today, `HostEmails.jsx`): a "Schedule" button beside "Send" opens a small inline panel under that row with a date input and a time select in 15-minute steps, Dublin time, defaulting to the next quarter hour at least 15 minutes out. "Confirm" posts; the row then shows the resolved time back ("Scheduled for Tue 9 Sep, 09:00").
- Scheduled row: a `Scheduled` chip (sky), subline "Scheduled for Tue 9 Sep, 09:00", actions "Change time" (reopens the panel prefilled), "Edit" (confirms, cancels the schedule, opens the composer as a draft) and "Cancel" (`window.confirm`, then unschedule).
- A draft with `schedule_error` shows an amber chip "Not sent" and a subline with the reason in plain words: "Sending is not enabled yet", "Marketing sending is not set up yet", "Daily send limit was reached", "Nobody on the list could be emailed", "Could not start the send". No em-dashes.
- The report page shows the scheduled time next to the sent time once it has fired (`sent_at` is set by the queue as today).

### 6. Error handling

Every write destructures `error`. A launch refusal never throws out of the sweeper; the campaign is returned to draft and the heartbeat still stamps. A `launch_failed` (a thrown enqueue) leaves the campaign as `draft` with the reason; the host can schedule again.

### 7. Testing

Unit: `launchHostCampaign` gates and CAS by trigger (both flips, both 409 shapes); the send route still answers the same statuses (existing route tests keep passing against the wrapper); schedule route validation (past, too soon, too far, non-date, foreign campaign 404, CAS conflict 409, clears error); unschedule CAS; sweeper picks due campaigns only, launches in `scheduled_for` order, returns a refused one to draft with the reason and still processes `sending` campaigns; composer helpers (`nextQuarterHour`, `toDublinLabel`, `scheduleErrorCopy`) plus a jsdom render test for the schedule panel and the list-row states.

Live: schedule a test campaign for 15 minutes ahead on Colm's portal, watch the sweeper log launch it, confirm the report page fills.

### 8. Rollout

1. Apply mig 592 via Supabase MCP.
2. Merge the PR; no operator steps. The sweeper is already scheduled.
