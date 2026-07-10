# Host email marketing — design (HOST-EMAIL.1–.3)

**Date:** 2026-07-10
**Status:** draft — awaiting Richard's review
**Vision (Richard):** hosts email their own contacts from a dedicated sending domain + sender profile. A host's list = people who took part in *that host's* events + people who joined *that host's* mailing list — and ONLY those people. Those contacts also land in the main CRM (event tag as today; host tag for list signups). Explicitly: hosts can only email their own list, only from their allocated domain/sender.

## Decisions (locked with Richard, 2026-07-10)

1. **Sending domain:** UN1T-allocated per-host subdomain, e.g. `hello@acme.mail.un1tdublin.com` — provisioned via the Postmark Domains API; the DKIM/Return-Path records live in UN1T's own `un1tdublin.com` DNS zone (a ~2-minute operator step per host; UN1T can revoke). Host-owned custom domains = later follow-up.
2. **Send approval:** none — hosts send freely, bounded by **caps** (see Abuse controls). Revisit per-host if abused.
3. **Unsubscribe:** **per-host suppression** — unsubscribing from a host's email stops that host only; UN1T marketing + other hosts unaffected. Global UN1T marketing opt-out AND hard bounces/complaints are honored on top.
4. **Consent basis:** **marketing-consented contacts only** — attendees who ticked the existing CONSENT.4 checkbox at checkout, plus mailing-list signups (explicit opt-in). Enforced at send time via the CRM's existing consent flags.

## Verified grounding

- Event checkout already captures `marketing_consent` (CONSENT.4 soft opt-in, `register/route.js:67` + `RaceSignupWidget.jsx:195-199`) and attendees already link to CRM `contacts` via `findOrCreateRaceContact`.
- Two tag systems (memory: tag BOTH): `contacts.tags` text[] AND `contact_tags` table (segment tags + sequence triggers).
- Send infra: `sendTransactionalEmail`/`sendEmail` (Postmark) + `email_sends` ledger + `/unsubscribe/[token]`; comms invariants: send-time consent, claim-before-send, long fan-outs on cron never the request thread, 1k-row pagination.
- Postmark TRAP (memory): the inbound stream is the invoices webhook — marketing sends need a **BROADCAST message stream** (new or existing broadcast stream on the current server; NOT the inbound/transactional plumbing).
- Host tenancy: `getCurrentHost()` + `host_id` → 404 pattern throughout the portal.

## Architecture — three PRs

### PR-A — HOST-EMAIL.1: the host contact list (data + flows)

**Migration:**
- `host_contacts` — `id, host_id FK event_hosts CASCADE, contact_id FK contacts CASCADE, source text CHECK ('event','mailing_list'), source_event_id uuid NULL, created_at`, `UNIQUE(host_id, contact_id)`. RLS on/no policy (service-role).
- `host_email_suppressions` — `id, host_id FK CASCADE, contact_id FK CASCADE, created_at`, `UNIQUE(host_id, contact_id)` (per-host unsubscribe).
- `event_hosts` + sender columns: `sender_domain text` (e.g. `acme.mail.un1tdublin.com`), `sender_email text` (e.g. `hello@acme...`), `sender_name text`, `sender_domain_verified boolean default false`, `postmark_domain_id bigint NULL`, `email_daily_send_cap int default 2` (campaigns/day).

**Flows:**
- **Ongoing (event source):** when a registration is confirmed on a host event, upsert `host_contacts` rows (source='event', source_event_id) for every team member with a linked `contact_id` **regardless of consent** (the list is membership; consent is enforced at send time). Hook where registrations flip to confirmed (payment completion + operator manual-add) — one shared helper `addEventAttendeesToHostList(db, raceEventId)` called fire-and-forget.
- **Backfill:** one-off script/route for existing host events' confirmed registrations.
- **CRM tagging:** unchanged for events (the event tag flows as today). For mailing-list signups (PR-B) the contact gets the **host tag** (`host:<slug>` or the host name) in BOTH `contacts.tags` and `contact_tags`.
- **Portal UI:** a **Contacts** page in the host portal (`/host/contacts`): list (name, email, source, joined date, emailable? = consent+suppression state), count summary, CSV export (reuse csvCell/BOM pattern; membership column excluded as before). Read-only.

### PR-B — HOST-EMAIL.2: sender identity + mailing-list signup + per-host unsubscribe

- **Sender provisioning (staff, HostDetail):** an "Email sending" card — admin enters the desired subdomain label (default = host slug) + sender name → `POST /api/hosts/[id]/email-domain` calls Postmark **Domains API** (create domain `acme.mail.un1tdublin.com`) → shows the DKIM/Return-Path DNS records to add to the un1tdublin.com zone → a **Verify** button re-checks via Postmark → sets `sender_domain_verified`. Hosts cannot send until verified. (ADMIN_ROLES + org-gated; Postmark API errors surfaced, never raw.)
- **Mailing-list signup (public):** `GET /h/[host-slug]` → a small hosted signup page (dark, host-branded: name + hero if set): name + email + explicit consent copy → `POST /api/public/host-list/[host-slug]/subscribe` → find-or-create contact (marketing consent TRUE — explicit opt-in; set both consent fields per repo model), upsert `host_contacts` (source='mailing_list'), tag with the host tag in BOTH systems. Rate-limited by IP (mirror the register route's limiter). Also an embeddable link block on the host's public event pages ("Join <host>'s mailing list →") — small footer link on `/event/[slug]` when the event has a host with a verified list page.
- **Per-host unsubscribe:** signed token (contact_id + host_id, HMAC — reuse the existing unsubscribe token helper pattern) → `GET /unsubscribe/host/[token]` page → inserts `host_email_suppressions` + confirmation copy ("You'll no longer receive emails from Acme Events. Your other preferences are unchanged."). Every host email footer MUST carry this link (enforced in the send path, not the composer).
- `event_hosts.slug` — add if absent (unique, derived from name) for the public page URL.

### PR-C — HOST-EMAIL.3: compose + send

- **Data:** `host_campaigns` — `id, host_id FK, subject, body_html, status CHECK ('draft','sending','sent','failed'), recipient_count, sent_count, created_at, sent_at`. RLS on/no policy.
- **Portal UI:** "Email your contacts" (`/host/emails`): list past campaigns (status, counts, date) + **New email**: subject + a simple body editor (paragraph text; server renders into a clean host-branded shell: host `sender_name` header, optional accent, body, MANDATORY footer = host name + per-host unsubscribe link). Preview → **Send** (confirm with recipient count).
- **Send path (`POST /api/host/emails` create draft → `POST /api/host/emails/[id]/send`):**
  1. Gate: `getCurrentHost()`; host must have `sender_domain_verified` (else 409 with guidance).
  2. **Caps:** campaigns sent today >= `email_daily_send_cap` → 429-style 409 ("Daily send limit reached").
  3. Recipient resolution AT SEND TIME (never stored): `host_contacts` for the host JOIN `contacts` WHERE `email_marketing` consent allows AND email present AND NOT bounced/complained/unsubscribed (reuse the exact flag set `applyAudienceFilter`/broadcast sends use) AND NOT in `host_email_suppressions`. Paginated.
  4. CAS the campaign `draft→sending` (0 rows → 409 double-send guard), stamp `recipient_count`, then **enqueue** — the fan-out runs on the existing cron pattern (a `host_campaign_sends` queue table with claim-before-send per recipient, drained by a new cron `/api/cron/send-host-campaigns` + heartbeat row, batched ≤N per tick), NOT the request thread. Each send goes through the Postmark **broadcast stream** with `From: <sender_name> <sender_email>`, `Reply-To: event_hosts.email`, ledgered in `email_sends` (tag `host-campaign`).
  5. Completion flips `sending→sent` with `sent_count`; partial failures logged, never retried into duplicates (claim rows are the idempotency).
- **Tenancy:** every route `getCurrentHost` + own `host_id`; a host can only ever resolve their own campaigns/contacts. 404 pattern.

## Abuse / safety controls
- Verified sender domain required; UN1T can un-verify (kill switch per host).
- Daily campaign cap per host (`email_daily_send_cap`, admin-editable on HostDetail).
- Consent + per-host suppression + global opt-out + bounce/complaint flags enforced at send time.
- Mandatory footer + unsubscribe injected server-side (host cannot omit it).
- All sends ledgered in `email_sends`; org fee report untouched.
- Postmark bounces/complaints on the broadcast stream must feed the existing webhook flags (verify the current Postmark webhook covers the broadcast stream; if not, add the stream to it).

## Out of scope (v1)
Host-owned custom domains; rich template editor (Unlayer); scheduled/recurring sends; segmentation beyond "all my emailable contacts"; per-event audience filters; analytics beyond sent counts (opens/clicks later via existing email_sends webhooks); import of external lists (explicitly NOT allowed — the list is participation+signup only, which is the consent story).

## Testing + reviews
Pure helpers TDD'd (recipient resolution predicate, footer injection, token). Characterization on the register-confirm hook (no behavior change to checkout). Adversarial review per PR: (A) cross-host list leakage; (B) domain provisioning IDOR + public signup abuse (rate limit, consent writes); (C) THE send path — cross-host sends, consent bypass, suppression bypass, cap bypass, double-send, footer stripping. Full CI mirror + build per PR; migrations via MCP + advisors.
