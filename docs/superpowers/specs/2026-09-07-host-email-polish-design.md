# Host email polish — HOST-EMAILS.2

**Date:** 2026-09-07 · **Owner decision:** Richard, 7 Sep 2026 ("Do 1,2,4,5,6,8,9"; sanitizer option 1) · **Status:** implemented on branch `host-email-polish` (plan `docs/superpowers/plans/2026-09-07-host-email-polish.md`) · **Builds on:** HOST-CONSENT.1 (#1632), HOST-METRICS.1 (#1633), HOST-SCHEDULE.1 (#1635), HOST-RESEND.1 (#1638)

## Decision

Seven follow-ups from the 6 Sep host audit and the three later specs, shipped as one PR with one migration. Numbering follows the list Richard chose from.

| # | Item | One line |
|---|---|---|
| 1 | Contacts page reason | "No" becomes "No · Unsubscribed from your list" (or the real reason) |
| 2 | Paused campaign | A campaign the queue has halted says so on the list and the report, with the reason |
| 4 | Delete and duplicate | Drafts and scheduled emails can be deleted; any email can be duplicated into a new draft |
| 5 | Designer readiness | A designed draft waits for the designer instead of silently opening as text and losing the design on save |
| 6 | Reminder to non-openers | "Send a reminder to N who didn't open" creates a reminder draft with a live audience |
| 8 | Styles survive, preview is honest | `<style>` blocks and the viewport meta are kept (CSS scrubbed); "Preview as sent" renders through the real send path |
| 9 | Link breakdown | Per-link clicks and unique clickers on the report |

**Recommended addition, item 10 (Richard said ignore; new evidence today):** the unsubscribe page writes on GET. At 10:38 today, 30 seconds after delivery, a university mail scanner followed every link in the resend for three `@tcd.ie` recipients, including the unsubscribe link, and all three were removed from Colm's list and suppressed on the `colm-events` stream. None of them chose that. Section 10 below specifies the fix and the repair; it is in this spec so it can be pulled if Richard still wants it left out.

## 1. Contacts page: why someone can't be emailed

`fetchHostContactRows` (`src/lib/host-contact-list.js`) already computes `emailable` with `isEmailable`. It gains `emailable_reason` from `emailabilityReason` (null when emailable; otherwise `no_email | mailbox_blocked | host_unsubscribed | no_host_consent`). The portal page `src/app/host/(portal)/contacts/page.js` renders the chip as today and, for a non-emailable row, a muted line under it with the plain copy from `failureCopy` in `src/lib/host-campaign-outcome.js` (the same words the report uses: "Unsubscribed from your list", "Not consented to your list", "Mailbox rejected earlier mail", "No email address"). The CSV export (`src/app/api/host/contacts/export/route.js`) gains a "Reason" column with the same copy, blank when emailable.

## 2. Paused campaigns are visible

Today `processHostCampaignChunk` returns `halted` when the sender is unverified or a marketing campaign's host has no stream, logs at error level, and leaves the campaign at `sending` forever; the portal shows "Sending".

- One predicate, `hostSendBlockReason(host, campaign)` in `src/lib/host-campaign-launch.js`, returns `'sender_not_verified' | 'no_stream' | null`. `launchHostCampaign` and the schedule route's early gates use it instead of their inline copies (no behaviour change; the copy strings stay in `LAUNCH_MESSAGES`).
- `GET /api/host/emails` loads the host's sender columns once and, for every campaign with `status = 'sending'`, adds `paused_reason` from the predicate (null when not blocked). `GET /api/host/emails/[id]/recipients` does the same for its campaign.
- List row: the chip stays "Sending"; the subline reads "Paused. Sending is not enabled yet. Ask UN1T." / "Paused. Marketing sending is not set up yet. Ask UN1T." (copy from `SCHEDULE_ERROR_COPY`, which already has both). Report: the amber "Still sending" line becomes "Paused. <same copy> Ask UN1T." when `paused_reason` is set.
- The queue itself is unchanged: when UN1T fixes the host, the next sweep resumes.

## 3. (Not in scope: daily cap axis. Kept out at Richard's request.)

## 4. Delete and duplicate

- `DELETE /api/host/emails/[id]` (host session, `.eq('host_id')`): CAS delete where `status in ('draft','scheduled')`, returning the id. Zero rows → 409 "Sent emails can't be deleted. They are the record of what went out." A scheduled email deleted this way simply never fires (the sweeper picks by status). Mig 594 adds a `before delete` trigger `host_campaigns_block_sent_delete` mirroring the CRM's mig 523, so no future code path can remove a sent campaign and its send rows.
- `POST /api/host/emails/[id]/duplicate` (any status the host owns): inserts a new draft with `subject = 'Copy of ' + subject` (truncated to 200), `body_html`, `design_json`, `audience_kind`, `audience_event_id`, `audience_campaign_id`, `email_type` copied; `scheduled_for`, `schedule_error`, counts and timestamps not copied. Returns the new row (`HOST_CAMPAIGN_LIST_COLUMNS`).
- Composer rows (`HostEmails.jsx`): every row gets "Duplicate"; draft and scheduled rows also get "Delete" (`window.confirm`, red text style like Cancel). Sending rows get neither. Deleting the draft that is open in the composer resets the composer. After duplicate: reload and notice "Draft created: Copy of …".

## 5. The designer never loses a design

Today `editDraft` opens a designed draft in text mode when the Unlayer script has not loaded yet, and saving from text mode writes `design_json: null`, which destroys the design.

- A draft with `design_json` always opens in design mode. If the designer is not ready, the composer stores the design in `pendingDesignRef`, shows "Loading the designer…" over the editor area, and the init effect loads the pending design the moment the editor is initialised (Unlayer queues `loadDesign` calls made after `init`).
- Text mode for a designed draft is reached only through an explicit link under the notice, "Edit as text instead", behind `window.confirm('This drops the saved design and keeps only the HTML.')`. That path sets `designDropped`, so the save writes `design_json: null` on purpose.
- If the script errors, the notice reads "The designer could not load. Reload the page, or edit as text (this drops the design)." with the same link. Nothing falls to text mode silently any more.
- `PATCH` stays full-overwrite; the composer is what changed.

## 6. Reminder to people who did not open

Mirrors the CRM's child-campaign model (PR #1299) but manual, from the report page, because hosts read their own results.

- Mig 594: `audience_kind` check gains `'non_openers'`; new nullable `audience_campaign_id uuid references host_campaigns(id) on delete set null`.
- `resolveHostRecipients` gains `nonOpenersOf: <campaignId>`: the parent's `host_campaign_sends` rows with `status = 'sent'`, `opened_at is null`, `clicked_at is null`, `bounced_at is null`, `complained_at is null`, `unsubscribed_at is null`, mapped to contact ids and then filtered through the normal marketing emailability (consent, suppression, mailbox). Resolved at send time, so anyone who opens between creating the draft and sending it drops out.
- `POST /api/host/emails/[id]/reminder-draft` (parent must be the host's and `sent`): creates a draft copy of the parent (as duplicate does) with `subject = 'Reminder: ' + subject`, `audience_kind = 'non_openers'`, `audience_campaign_id = parent.id`. Returns the new row. It does not send.
- Report page: for a sent campaign a second header button, "Send a reminder to N who didn't open" (N from the resolver; button hidden when N is 0 or the count fails). Confirm copy when the parent was sent under 24 hours ago adds "Opens keep arriving for a day or two. A reminder this soon reaches people who may simply not have got to it yet." On success the page navigates to `/host/emails` with the notice "Reminder draft created. Edit it, test it, then send or schedule."
- Composer: a draft whose `audience_kind` is `non_openers` shows the audience as a fixed line, "People who didn't open '<parent subject>'", instead of the audience select. Changing the audience means duplicating into a normal draft. The send confirm reads "Send this email to people who didn't open '<parent subject>'?" and the recipient count comes back from the send as today. The list row's subline shows the same audience label.
- Not enforced: one reminder per parent, or a minimum wait. The count and the confirm copy are the guard.

## 8. Styles survive; the preview tells the truth

- `sanitizeCampaignHtml` (`src/lib/host-campaign-email.js`) keeps `<style>` blocks, scrubbing their CSS with the CRM's existing `scrubCss` in `src/lib/email-html.js` (exported for this; it already drops `@import`, `expression()` and remote `url()` references, which are the two things CSS can do to a reader). It also keeps `<meta name="viewport" …>`. Everything else on the strip list stays stripped: `script`, `iframe`, `object`, `embed`, `form`, `link`, other `meta`, `svg`, `math`, `on*` handlers, unsafe URL schemes. The fixed-point loop is unchanged.
- The shell path (a body that is not a full document) leaves `<style>` where it sits; mail clients honour it in the body.
- **As built (after three security review rounds).** The sanitizer's invariant is: every deletion happens inside one outer fixed point (strip active content, then drop any placeholder stranded inside an open tag by a quote-aware scan, repeat until nothing changes, at most 20 rounds), and restoration only inserts (a `<style>` around a `scrubCss` result, which contains no `<` or `>`, or the one canonical viewport meta). A document that does not converge, or that ends with more than one viewport placeholder or any surviving nonce token, is dropped to an empty body with a warning (fail closed). Placeholders carry a per-call random nonce. Also stripped: `base` (re-bases every relative URL) and `plaintext`/`textarea`/`noscript`/`noembed`/`xmp`/`template` (any of which would swallow the injected footer); `poster`/`formaction`/`background` are scheme-checked like `href`/`src`; inline `style=` values are scrubbed. Known fidelity limit inherited from the CRM's scrubber: `scrubCss` removes `>` from CSS, so a child combinator (`.a > .b`) becomes a descendant selector. A `<style>` that lands inside an open tag, a quoted attribute or a comment is dropped rather than restored.
- `POST /api/host/emails/preview` (host session; `{ subject, body_html }`, same size caps as create): renders through `renderHostCampaignHtml` with the sample merge values and the inert unsubscribe token the test send uses, returns `{ html }`. Nothing is stored.
- Composer: a "Preview as sent" button beside Save (design mode exports first). It opens a modal with a sandboxed iframe (`sandbox` with no permissions, `srcdoc`) and a Mobile (375px) / Desktop (700px) toggle. This is the first time a host sees what recipients get without sending a test.

## 9. Link breakdown

- Mig 594: `host_campaign_clicks (id, host_id fk, campaign_id fk cascade, send_id fk host_campaign_sends cascade, contact_id fk set null, url text, clicked_at timestamptz, postmark_message_id text, created_at)`, indexes on `(campaign_id, url)` and `(send_id)`, and a unique index on `(send_id, url, clicked_at)` so the webhook and the backfill are idempotent. RLS enabled, no policies (service role only, like its siblings).
- Webhook `Click` (`processHostCampaignEvent`): after the existing stamps, insert one row from `body.OriginalLink` and `body.ReceivedAt` (`ignoreDuplicates`). A failed insert is logged and never fails the event.
- Backfill: `foldMessageEvents` returns `clicks: [{ url, at }]` from `LinkClicked` events (`Details.Link`); the live run inserts them the same way. I run the backfill by hand once more after merge for the three historic campaigns (the token path from 7 Sep).
- `GET /api/host/emails/[id]/recipients` returns `links: [{ url, clicks, people, is_unsubscribe }]` aggregated from the table, sorted by clicks, unsubscribe link last (matched by the `/unsubscribe/host/` path).
- Report: a "Links" section under the tiles: URL (truncated with the full URL on hover), clicks, people. The unsubscribe link is labelled "Unsubscribe link". Known limit, stated on the page in one line: security scanners open every link within seconds of delivery, so counts include them.

## 10. Unsubscribe page: confirm step (recommended addition)

- `GET /unsubscribe/host/[token]` verifies the token and renders a page with the host name and a single "Unsubscribe" button; it writes nothing. The button is a form that POSTs to `/api/unsubscribe/host/[token]` (the existing RFC 8058 one-click route, which already revokes and suppresses) with a `redirect=1` field; the route then redirects to `/unsubscribe/host/[token]?done=1`, which renders the "You're unsubscribed" page, again without writing. Mail providers' one-click POSTs keep working unchanged.
- Repair: the three `@tcd.ie` contacts removed today at 10:38 are restored: delete their `host_email_suppressions` rows, `grantHostConsent` with source `scanner_reversal` (added to `consent-sources.js`), and remove the three `colm-events` Postmark suppressions (by hand, same token path). Done only if Richard confirms.

## Error handling

Every write destructures `error`. New routes answer `{ success, data | error }` with 401/404/409/500 as the siblings do. The webhook click insert is best effort; the preview route never stores; delete and duplicate are CAS or single inserts.

## Testing

Unit, beside each file: contact rows carry a reason; `hostSendBlockReason` truth table and the list/recipients `paused_reason`; delete CAS and 409, duplicate copies the right columns and truncates the subject; `resolveHostRecipients` non-openers branch (excludes opened, clicked, bounced, unsubscribed, and re-applies emailability); reminder-draft route; sanitizer keeps a scrubbed `<style>` and the viewport meta and still strips the rest (regression fixtures from the Canva export); preview route; click insert on webhook and fold in backfill; links aggregation; composer pure helpers (audience label for non_openers, row actions per status). Render tests only where the file already has them (report: links section, paused line).

Live after merge: open the 4 Sep report as Colm and check the Links section; preview a Canva paste on mobile width; create a reminder draft and send it to a test audience.

## Rollout

1. Apply mig 594 via Supabase MCP.
2. Merge the PR.
3. Run the click backfill by hand for the three historic campaigns.
4. If section 10 is in: restore the three contacts.
