# Host campaign send metrics — HOST-METRICS.1

**Date:** 2026-09-06 · **Owner decision:** Richard, 6 Sep 2026 (scope option 1: detail page with a per-recipient table) · **Status:** design, awaiting review · **Builds on:** HOST-CONSENT.1 (#1632, merged)

## Decision

A host can open any sent email and see what happened to it: how many were sent, delivered, opened, clicked, bounced, unsubscribed and failed, and a table of every recipient with their outcome and, for failures, the reason. The list row shows the headline numbers. The three historical sends are backfilled from Postmark before the July data ages out on 14 September.

## Why

Today a sent host email shows only "120/124 sent". Nothing per recipient is stored beyond a queue status, no Postmark message id is kept, and until HOST-CONSENT.1 every Postmark event for host mail was dropped. Now host events reach `processHostCampaignEvent` (identified by the `host_campaign_id` / `contact_id` metadata the queue stamps) and are acknowledged but parked. This spec lands where they go and what the host sees.

## Scope

**In:** per-send outcome columns on `host_campaign_sends`; the message id captured at send; failure reasons at the three failure sites; Delivery / Open / Click / Bounce / SpamComplaint / SubscriptionChange applied to the send row; a stats function; headline counts on the list; a campaign detail page with a filterable recipient table; a one-off Postmark backfill for existing campaigns, runnable from Settings → Hosts.

**Out:** link-level click breakdown (option 3); denormalised counters on `host_campaigns` (stats are derived from send rows, which is always consistent and needs no backfill maintenance); CSV export of the recipient table; a host-facing "campaign halted" state (separate follow-up from the audit); resend to non-openers.

## Design

### 1. Data (mig 590)

```sql
alter table host_campaign_sends
  add column postmark_message_id text,
  add column delivered_at    timestamptz,
  add column opened_at       timestamptz,
  add column open_count      integer not null default 0,
  add column clicked_at      timestamptz,
  add column click_count     integer not null default 0,
  add column bounced_at      timestamptz,
  add column bounce_type     text check (bounce_type is null or bounce_type in ('hard','soft','transient')),
  add column complained_at   timestamptz,
  add column unsubscribed_at timestamptz,
  add column failed_reason   text;
create index idx_host_campaign_sends_message on host_campaign_sends (postmark_message_id) where postmark_message_id is not null;
```

`status` stays the QUEUE state (`pending | claimed | sent | failed`). The displayed **outcome** is derived, in this order of precedence: `failed` → `bounced` → `complained` → `unsubscribed` → `clicked` → `opened` → `delivered` → `sent` → `queued`. Deriving it means a late-arriving Delivery after an Open can never regress a row (the POSTMARK-RACE.2 lesson on `email_sends.status`). The stats function is a cumulative funnel; the derived outcome is exclusive. UI filters use the funnel predicates so tiles and lists agree (mig 591 guards bounced/complained/unsubscribed on status='sent' so they reconcile with failed).

`failed_reason` vocabulary (free text column, values fixed in code): `no_host_consent`, `host_unsubscribed`, `mailbox_blocked` (bounced / complained / repeat-bounce stamp), `no_email`, `no_administrative_consent`, `send_error` (Postmark rejected the call; the message is logged, not stored), `stale_claim` (the sweeper's 15-minute reaper).

Two SQL functions, `security invoker`, executable by `service_role` only (revoke from `authenticated` and `anon` so the advisor stays clean):

- `host_campaign_stats(p_host_id uuid)` → one row per campaign of that host: `campaign_id, queued, sent, delivered, opened, clicked, bounced, complained, unsubscribed, failed`, counted from `host_campaign_sends` with the same precedence as the outcome (a bounced row counts as bounced, not delivered). Used by the list.
- `bump_host_send_counter(p_send_id uuid, p_field text)` → atomic `open_count` / `click_count` increment, field allowlisted (mirrors `increment_campaign_metric`, mig 157).

### 2. Capture at send

- `host-campaign-queue.js`: the `sent` update also writes `postmark_message_id: result.messageId`. Consent-revoked rows are marked `failed` with a reason from a new `emailabilityReason(contact, suppressed, opts)` in `host-contact-list.js`, which `isEmailable` becomes a thin wrapper over (returns `null` when mailable, else one of the reasons above). A thrown send writes `failed_reason: 'send_error'`. The sweeper writes `'stale_claim'`.
- `resolveHostRecipients` is unchanged: rows that never qualify at enqueue time are simply not enqueued, so they never appear in the table. The detail page's "queued" count is therefore the number the host was told at send time.
- Test sends are not campaign rows. Their events carry `test_send: '1'` and no `contact_id`, so the webhook branch acknowledges them without a lookup.

### 3. Webhook events → send row

In `processHostCampaignEvent`, resolve the row once by `(campaign_id, contact_id)` from the metadata (unique pair; works even for an event that beats the message-id write, so no race handling is needed). If no row matches, acknowledge and log at info: a test send, or a deleted campaign. Then, all guarded so a replayed event is a no-op:

| Event | Send row | Also |
|---|---|---|
| Delivery | `delivered_at` if null | |
| Open | `opened_at` if null; `open_count` bump | |
| Click | `clicked_at` if null; `click_count` bump; `opened_at` if null (a click implies an open; mirrors the CRM) | |
| Bounce | `bounced_at`, `bounce_type` | hard → `contacts.email_status='bounced'` (unchanged) |
| SpamComplaint | `complained_at` | `email_status='complained'` + host revoke (unchanged) |
| SubscriptionChange (SuppressSending) | `unsubscribed_at` | host revoke (unchanged) |
| SubscriptionChange (reactivation) | nothing | `email_status` reset (unchanged) |

Postmark's Open event carries `FirstOpen`; we ignore it and use our own null guard, because the backfill (section 6) writes rows Postmark will never re-send events for. The message id is also stamped onto the row if the column is still null (the backfill path).

### 4. Read APIs (host session, tenancy by `host_id` as everywhere)

- `GET /api/host/emails` (list) gains `stats` per campaign from `host_campaign_stats`. One RPC call, no N+1.
- `GET /api/host/emails/[id]/recipients` → `{ campaign: {…, stats}, recipients: [{ contact_id, name, email, outcome, sent_at, delivered_at, opened_at, open_count, clicked_at, click_count, bounced_at, bounce_type, unsubscribed_at, failed_reason }] }`. Range-paginated server-side under the 1k cap and returned whole (a host campaign is a few hundred rows). 404 for another host's campaign, as the sibling routes do. Names come from `contacts` via the existing `contacts!contact_id` embed.

### 5. Portal UI

- **List row** (`HostEmails.jsx`): for a sent campaign, "124 sent · 118 delivered · 41 opened · 9 clicked" and, when non-zero, "4 failed" in the amber chip style; the whole row links to the detail page. Drafts unchanged.
- **Detail page** `src/app/host/(portal)/emails/[id]/page.js` (server component, `getCurrentHost`, 404 on a foreign id) rendering a client component `HostEmailReport.jsx`:
  - Header: subject, sent date, audience label, Utility chip when relevant.
  - Seven stat tiles in the existing dashboard tile style: Sent, Delivered, Opened, Clicked, Bounced, Unsubscribed, Failed. Open and click rates shown as percentages of delivered.
  - Recipient table: name, email, outcome chip, time of the outcome. Outcome filter chips above it (All / Opened / Clicked / Not opened / Bounced / Unsubscribed / Failed). Failure reasons render as plain copy, operator-tone, no em-dashes: "Not consented to your list", "Unsubscribed from your list", "Mailbox rejected earlier mail", "No email address", "Mail server rejected the send", "Send timed out".
  - Mobile: tiles wrap to two columns; the table becomes stacked rows under 640px (the audit flagged the existing tables for scrolling horizontally).
  - Empty states: a campaign still `sending` shows the tiles with live numbers and "Still sending"; a campaign with zero delivered after an hour shows a note to check with UN1T.
- No new nav item; the page is reached from the list.

### 6. Backfill (one-off, kept as a repair tool)

`POST /api/admin/backfill-host-campaign-events` (master/owner, org-scoped to the caller's hosts, dry-run unless `?dry=0`), plus a "Backfill Postmark events" button with a result summary on Settings → Hosts → host → the Email sending card. It:

1. Pages `GET https://api.postmarkapp.com/messages/outbound?tag=host-campaign&count=500&offset=N&fromdate=&todate=` for the last 45 days (Postmark's retention), reading each message's `Metadata.host_campaign_id` / `contact_id` / `MessageID`.
2. For each matching send row with a null `postmark_message_id`, stamps it.
3. Calls `GET /messages/outbound/{MessageID}/details` and folds `MessageEvents` into the row with the same guarded writes as section 3 (Delivered → `delivered_at`, Opened → `opened_at` + count, LinkClicked → `clicked_at` + count, Bounced → `bounced_at`/type, SubscriptionChanged → `unsubscribed_at`).
4. Sequential with a short pause; ~380 detail calls take under a minute. Returns `{ scanned, stamped, updated, skipped, errors }`.

Idempotent by construction (every write is guarded), so running it twice is safe. The Postmark client helpers move out of `postmark-suppressions.js` into a small `postmark-messages.js` (token via `resolvePostmarkToken`, same header builder). **Deadline:** the 31 July sends leave Postmark's retention around 14 September; the backfill runs the day this merges.

### 7. Error handling

Every write destructures `error`. In the webhook branch a failed row write returns `{ ok: false, error }` so the queue retries it (bounded, dead-lettered), the same contract as HOST-CONSENT.1. The backfill collects per-message errors and continues. The recipients route returns the standard `{ success, data | error }`.

### 8. Testing

Unit: `emailabilityReason` truth table and `isEmailable` parity; queue writes the message id and each failure reason; webhook branch per event type with replay (guards hold, counters bump once per event); the outcome precedence function; the stats function via a fixture in the recipients route test (mocked RPC); backfill folding of a `MessageEvents` sample (fixture JSON from the real 6 Sep test send) with a stub HTTP client. Regression: a Delivery arriving after an Open does not touch `opened_at`; a test-send event with no `contact_id` writes nothing. Portal: the report component renders tiles and applies a filter (jsdom is fine here, it is not measuring layout).

Live: after deploy, the backfill on Pride Training Club; then Colm's next send, checking the detail page against Postmark's numbers the next morning.

### 9. Rollout

1. Apply mig 590 via Supabase MCP.
2. Merge the code PR.
3. Run the backfill from Settings → Hosts (dry first, then live) and compare `updated` with Postmark's 372 messages.

## Open follow-ups (not blocking)

- Halted campaigns surface only in logs (audit finding); the detail page could show "Paused: sender not verified / no stream".
- Resend to non-openers, the way CRM campaigns can.
- Link-level click breakdown.
