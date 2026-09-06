# Host marketing as its own consent domain — HOST-CONSENT.1

**Date:** 2026-09-06 · **Owner decision:** Richard, 6 Sep 2026 · **Status:** design, awaiting review

## Decision

A signup or booking with a third-party host grants **two independent consents**: one to the host's list and one to UN1T's marketing. The form says so. From then on the two flags live and die independently: a UN1T unsubscribe never touches the host consent, and a host unsubscribe never touches UN1T's. Each host's marketing email sends on its **own Postmark message stream**, so Postmark's suppression list for UN1T marketing, or for another host, can no longer refuse a host's mail.

## Why

Today one person is one contact row with one marketing flag, sent on one Postmark stream. Three shared gates decide whether a host can email someone:

1. **CRM gate.** `isEmailable` in `src/lib/host-contact-list.js` reads the UN1T-wide `contacts.email_marketing`. Unsubscribe from a Stillorgan campaign and the host loses you.
2. **Postmark gate.** Host marketing rides `broadcast`, the same stream as UN1T marketing. Postmark suppression lists are per stream, so every UN1T unsubscribe click, spam complaint, and every manual suppression that PMSUPP.1 pushes for a UN1T opt-out also refuses the host's mail. Four of the 124 recipients of the 4 Sep Pride Training Club send failed exactly this way; Postmark never created a message for them.
3. **Reverse flow.** `/h/[slug]` signup and hosted-event registration call `applyFormMarketingConsent`, which grants UN1T consent on the shared contact. A Postmark unsubscribe click on a host email suppresses the address at Postmark for UN1T too.

Measured 6 Sep against the only live host (179 contacts): 47 are on Postmark's `broadcast` suppression list, 42 of those are also opted out of UN1T in the CRM, 5 are blocked by Postmark alone, and the host's own address is on the list. None of the 47 ever unsubscribed from the host: the Recipient-origin entries cluster on UN1T campaign dates, not on the host's 31 Jul and 4 Sep sends.

## Scope

**In:** host-scoped consent on `host_contacts`; grant and revoke paths; the send gate; a dedicated Postmark stream per host; routing host-stream Bounce, SpamComplaint and SubscriptionChange webhooks to host tables; one-click `List-Unsubscribe` on real host sends (missing today, test sends have it); consent copy on both forms; backfill.

**Out (separate specs):** delivery/open/click metrics for host campaigns (HOST-METRICS.1 — this spec lands the stream and the event-identification helper it needs); a host-facing view of who is unsubscribed and why; API automation of stream + webhook creation per host; lifting the stale Customer-origin suppressions on `broadcast` (data task, Richard's call).

## Design

### 1. Data (mig 587)

```sql
alter table host_contacts
  add column marketing_consent boolean not null default false,
  add column marketing_consented_at timestamptz,
  add column marketing_consent_source text
    check (marketing_consent_source in ('mailing_list_form','event_form','backfill_2026_09','host_resubscribe'));

alter table consent_log add column host_id uuid references event_hosts(id) on delete cascade;
alter table event_hosts add column postmark_stream_id text;          -- section 5
alter table race_registrations add column marketing_consent boolean; -- section 2, null = pre-587 row
-- channel 'host_email_marketing' rows carry host_id; all existing rows stay host_id null.

-- Backfill: every existing membership was created by a signup or a confirmed
-- booking, both of which showed marketing copy. Rows already in
-- host_email_suppressions are the people who left the host's list: they keep
-- consent=false so the gate reads the same as today for them.
update host_contacts hc set marketing_consent = true,
  marketing_consented_at = hc.created_at, marketing_consent_source = 'backfill_2026_09'
where not exists (select 1 from host_email_suppressions s
                  where s.host_id = hc.host_id and s.contact_id = hc.contact_id);
```

`host_email_suppressions` stays the revocation record (unchanged). Consent true + no suppression row = mailable by this host, subject to mailbox facts.

### 2. Grant paths

| Path | Host consent | UN1T consent (unchanged) |
|---|---|---|
| `POST /api/public/host-list/[slug]/subscribe` | `true`, source `mailing_list_form`, `consent_log` row channel `host_email_marketing` with `host_id` | `applyFormMarketingConsent` as today |
| Hosted-event registration, `marketing_consent !== false` | `true`, source `event_form`, logged as above. The register route persists the checkbox on a new `race_registrations.marketing_consent boolean` (mig 587; today the value is applied and discarded), and `addEventAttendeesToHostList` reads it when the registration is confirmed, so consent lands with the membership row and unpaid bookings never become host contacts | as today |
| Hosted-event registration, checkbox unticked | membership row still created, consent stays `false` (utility mail to attendees is unaffected: it gates on `email_administrative`) | as today (`consent=false`) |
| Internal events (`host_id` null) | no change; no host row | as today |

Re-signup at `/h/[slug]` by a contact in `host_email_suppressions` is a **host resubscribe**: delete the suppression row, set consent true with source `host_resubscribe`, log it, and lift only a `ManualSuppression` for that address on the host stream via `unsuppressAtPostmark(email, { stream: host.postmark_stream_id })`. Mirrors PMSUPP.1's rule that only our own suppressions are ever lifted.

### 3. Revoke paths

- **Host unsubscribe page** `/unsubscribe/host/[token]` (exists): writes `host_email_suppressions` as today, plus a `consent_log` opt-out row with `host_id`, plus best-effort `suppressAtPostmark(email, { stream: host.postmark_stream_id })`. Never touches `contacts.email_marketing`.
- **New `POST /api/unsubscribe/host/[token]`**: the one-click target. Same body as the page's write path, idempotent, rate-limited like `/api/unsubscribe/[token]`. Required because `toListUnsubscribeUrl` rewrites `/unsubscribe/` to `/api/unsubscribe/` and that path 404s today.
- **Postmark `SubscriptionChange` with `SuppressSending=true` on the host stream**: write `host_email_suppressions` for `(metadata.host_id, metadata.contact_id)` and log it. Never writes `contacts.email_marketing`.
- **UN1T unsubscribe / preference centre / drift check**: no code change; they never wrote host tables and still do not. A regression test pins that a UN1T opt-out leaves `host_contacts.marketing_consent` untouched, and that a host opt-out leaves `contacts.email_marketing` untouched.

### 4. Send gate

`isEmailable(contact, hostMembership, { emailType })` in `src/lib/host-contact-list.js`:

- marketing: `email` present, `email_suppressed_at` null, `email_status` not bounced/complained, **`hostMembership.marketing_consent === true`**, no `host_email_suppressions` row. It no longer reads `contacts.email_marketing`.
- utility: unchanged (`email_administrative`, bounce/complaint facts).

The three callers stay in step by construction: `resolveHostRecipients` (send), `/api/host/emails/audiences` (composer counts) and `fetchHostContactRows` (Contacts page badge) all pass the membership row, which they already load. `fetchHostContactRows` adds the new columns to its select.

Shared on purpose: hard bounces and spam complaints (`email_status`) and the repeat-bounce stamp (`email_suppressed_at`). They describe the mailbox, not the relationship.

### 5. Postmark stream — one per host

Richard created the first stream on 6 Sep as `colm-event` (type Broadcasts) for Pride Training Club, so the stream is **per host**, not shared. Each host's suppression list is then isolated from UN1T's and from every other host's. Postmark allows 10 streams per server by default, which covers the foreseeable host count; the limit is raised on request.

- `event_hosts.postmark_stream_id text` (mig 587, nullable). Set by an admin on Settings → Hosts → host, in the existing "Email sending" card, after creating the stream in Postmark. Exposed to the portal only as a boolean "marketing sending ready" flag, never the raw id.
- Creating the stream and its webhook stays a manual Postmark step per host, documented on the card: Message Streams → Create → Broadcasts, unsubscribe handling Custom; then on that stream add a webhook to `https://crm.un1tdublin.com/api/webhooks/postmark` with Delivery, Bounce, SpamComplaint, Open, Click and SubscriptionChange, carrying the `x-webhook-token` header the route verifies. No API automation in this slice.
- `host-campaign-queue.js` sends marketing with `stream: host.postmark_stream_id` and **passes `unsubscribeUrl`**. `sendEmail` attaches the `List-Unsubscribe` / `List-Unsubscribe-Post` headers when the caller marks the send as marketing (a new `marketing: true` option, which the CRM broadcast path also sets), instead of keying on the literal stream name. Utility stays on `outbound`.
- Fail closed: the send route refuses a marketing send with a clear 409 ("Marketing sending is not set up for this host yet") when `postmark_stream_id` is null. A Postmark error for a missing stream marks each send failed as today, so a mis-typed id cannot half-send silently, and the failure reason is kept for the metrics work.
- The consent drift check and `marketing-consent.js` resubscribe lift keep targeting `broadcast` only. Per-host stream reconciliation is a follow-up if drift ever appears there.
- The host unsubscribe and resubscribe paths in sections 2 and 3 pass `{ stream: host.postmark_stream_id }` and skip the Postmark call when it is null.

### 6. Webhook processor

Add `isHostCampaignEvent(body)` to `src/lib/postmark-webhook-processor.js`: true when `body.Metadata.host_campaign_id` is present (every host send stamps it today, together with `host_id` and `contact_id`). Stream ids are per host, so the metadata is the identifier, not the stream name. For those events:

- **Bounce (hard)** → `contacts.email_status = 'bounced'` by `metadata.contact_id` (shared fact, as CRM sends already do).
- **SpamComplaint** → `email_status = 'complained'` and a `host_email_suppressions` row.
- **SubscriptionChange** → section 3.
- **Delivery / Open / Click** → return early with a log line until HOST-METRICS.1 lands. They are no longer dropped as "unmarked" noise.

Host events are matched by metadata, not by `email_sends.postmark_message_id`, because host sends deliberately write no `email_sends` row.

### 7. Consent copy

Both surfaces derive names from data; the hard-coded "UN1T Dublin" goes.

- `/h/[slug]` footer: "By joining you agree to receive emails from {host.name} about their events, and from {org.name} about events and promotions. You can leave either list at any time."
- `RaceSignupWidget` marketing checkbox, hosted events only (`race.host_id` set, host is third party): same sentence. Internal events keep their current label.

The host-editable copy fields from mig 460 (headline, blurb, button, success) are untouched; the consent sentence is deliberately not host-editable.

### 8. Error handling

- Consent writes to `host_contacts` and `consent_log` are part of the primary request; a failure returns the same opaque `{success:true}` on the public form (enumeration rule) but is logged with `logError`, not swallowed.
- Postmark suppress/unsuppress calls are fire-and-forget in their own try/catch, as in PMSUPP.1.
- Webhook branches use the same guarded no-op update shape the processor already uses, so a replayed event is idempotent.

### 9. Testing

Unit: `isEmailable` truth table (consent false, suppressed, bounced, UN1T-opted-out-but-host-consented → mailable); backfill SQL against a fixture with suppression rows; `isHostCampaignEvent`; processor branches for Bounce, SpamComplaint, SubscriptionChange on the host stream write host tables and never `contacts.email_marketing`; queue passes `host.postmark_stream_id` and `unsubscribeUrl`, and 409s when it is null; `sendEmail` attaches one-click headers for marketing sends on any stream; `POST /api/unsubscribe/host/[token]` idempotent + rate-limited; subscribe route grants both consents and logs the host one with `host_id`; register route grants host consent only for hosted events.

Regression pins (the point of the change): UN1T opt-out leaves host consent; host opt-out leaves `email_marketing`; internal events byte-identical.

Live: after deploy, one test send and one real marketing send from the host portal; confirm in Postmark the message is on `colm-event`, carries `List-Unsubscribe`, and that a Gmail one-click unsubscribe lands as a `host_email_suppressions` row within a minute.

### 10. Rollout order

1. Stream `colm-event` exists (verified 6 Sep, empty suppression list). Richard still has to add its webhook (section 5).
2. Apply mig 587 via Supabase MCP (forward-only).
3. Merge the code PR (one PR: gate, grant/revoke, stream column + admin field, headers, processor, copy, tests).
4. Set `postmark_stream_id = 'colm-event'` on the Pride Training Club host row from Settings → Hosts.
5. Live verification above. Until step 4 is done the send route fails closed with the 409, so merging before the stream is attached is safe.

## Open follow-ups (not blocking)

- HOST-METRICS.1: per-send tracking rows and campaign counts; the 45-day Postmark retention window for the 31 Jul sends closes about 14 Sep.
- Lift the six stale Customer-origin `broadcast` suppressions whose CRM consent is true.
- Contacts page: show the reason behind "No" (host unsubscribed / bounced / complained).
