# Host Email Marketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hosts email their own contacts (event participants + mailing-list signups, marketing-consented only) from a UN1T-allocated sending subdomain — three PRs: list, identity+signup+unsubscribe, compose+send.

**Architecture:** `host_contacts` membership + send-time consent; per-host suppression; Postmark Domains API for `<label>.mail.un1tdublin.com`; campaign fan-out mirrors the existing `campaign-sender.js` claim/tick pattern on a cron; `sendEmail` already supports `stream:'broadcast'`.

**Tech Stack:** Next.js 16, Supabase (service-role), Postmark (`src/lib/postmark.js` — `sendEmail({...stream:'broadcast'})`), Zod, Vitest. Spec: `docs/superpowers/specs/2026-07-10-host-email-marketing-design.md`. Next migration number: **400**.

Branches: PR-A `host-email-marketing` (current), PR-B `host-email-identity`, PR-C `host-email-send` — each fresh off origin/main after the prior merges.

---

## PR-A — HOST-EMAIL.1: host contact list

### Task A1: migration 400
`400_host_contacts.sql`: `host_contacts` (`id uuid pk default gen_random_uuid()`, `host_id uuid NOT NULL REFERENCES event_hosts(id) ON DELETE CASCADE`, `contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE`, `source text NOT NULL CHECK (source IN ('event','mailing_list'))`, `source_event_id uuid REFERENCES race_events(id) ON DELETE SET NULL`, `created_at timestamptz NOT NULL DEFAULT now()`, `UNIQUE(host_id, contact_id)`); `host_email_suppressions` (same shape minus source cols, `UNIQUE(host_id, contact_id)`); `event_hosts` ADD `sender_domain text`, `sender_email text`, `sender_name text`, `sender_domain_verified boolean NOT NULL DEFAULT false`, `postmark_domain_id bigint`, `email_daily_send_cap int NOT NULL DEFAULT 2`, `slug text UNIQUE`; indexes on `host_contacts(host_id)`, `host_email_suppressions(host_id)`. RLS on, no policy, comments. Apply via MCP (`iyvtbjjxdggiadzwwvdj`) + advisors. Backfill slugs: `UPDATE event_hosts SET slug = <derived>` in the migration is NOT possible generically — instead leave NULL and derive lazily in code (PR-B provisions it); note this.

### Task A2: membership lib + hooks (TDD)
`src/lib/host-contact-list.js`: pure `hostTagFor(host)` → `host:<slug||normalized-name>`; async `addEventAttendeesToHostList(db, raceEventId)` — load the race (`id, host_id`); if no host_id return; load confirmed registrations' team members with `contact_id` set (paginated); upsert `host_contacts` rows (`onConflict: 'host_id,contact_id'`, `ignoreDuplicates: true`, source 'event', source_event_id). Fire-and-forget callers (own try/catch + logError): hook after the confirm writes at `src/lib/race-payments.js:103` and `:334` and the operator manual-add at `src/app/api/events/[id]/teams/route.js:232` (READ each; call with the race_event_id in scope). TDD the pure part + upsert-shape with a fakeDb (mirror `host-events.test.js` fakes). Backfill: `POST /api/admin/backfill-host-contacts` guarded `getCurrentUser` + master/owner only, loops all host events calling the helper (one-off; register in route-guards conventions).

### Task A3: portal Contacts page
`GET /api/host/contacts` (`getCurrentHost`; paginated join `host_contacts` → `contacts (first_name/last name fields — READ contacts usage in HostDetail/attendee code for real column names, likely `name`/`email`/consent flags)`; returns rows + an `emailable` boolean computed with the same predicate PR-C will use — put the predicate in `src/lib/host-contact-list.js` as pure `isEmailable(contact, suppressed)` so C reuses it: consent flag true AND email present AND NOT bounced/complained/unsubscribed (READ the exact flag names used by the existing broadcast/audience send path — `src/lib/audience*.js` / campaign-sender — and mirror) AND NOT suppressed). Page `/host/contacts` (dark, server component + table like the roster page) + a nav link on the host dashboard. CSV export route `GET /api/host/contacts/export` reusing `csvCell` + BOM pattern.

### Task A4: ship PR-A
Full CI mirror + build; adversarial review lens: cross-host leakage (contacts page/exports only ever `.eq('host_id', session.host.id)`); hooks never affect payment/registration responses. Push, PR, CI green, merge.

---

## PR-B — HOST-EMAIL.2: sender identity + signup + per-host unsubscribe

### Task B1: Postmark domain provisioning
`src/lib/postmark-domains.js`: thin fetch wrappers on the Postmark **Account API** (`X-Postmark-Account-Token` — note: NOT the server token; env `POSTMARK_ACCOUNT_TOKEN`, throw with clear message if unset): `createDomain(name)`, `getDomain(id)`, `verifyDomainDkim(id)`/`verifyDomainReturnPath(id)`. Routes `POST /api/hosts/[id]/email-domain` (ADMIN + loadHostForOrg; body `{label?}` → sanitize `[a-z0-9-]`, default from host name; domain = `<label>.mail.un1tdublin.com`; create via API; store `postmark_domain_id`, `sender_domain`, `sender_email = hello@<domain>`, derive+store `slug` if null; return the DKIM/Return-Path records from the API response for display) and `POST /api/hosts/[id]/email-domain/verify` (calls both verifies; if both verified set `sender_domain_verified=true`; return current record state). HostDetail "Email sending" card: provision form (label + sender name), the DNS records list (mono, copy buttons), Verify button, verified flag chip, sender-name editing (PATCH via existing host update or the domain route). Admin can toggle `sender_domain_verified` off (kill switch) — small PATCH.

### Task B2: public signup page + API
`GET /h/[slug]` public page (OUTSIDE auth-gated segments; add `/h/` to proxy.js allowlist + AppShell publicPaths + the un1t-hosts brand allowedPaths — READ how `/event/` is allowlisted and mirror in all three): dark host-branded (name, hero if any) name+email form with explicit consent copy ("Get emails about <host>'s events. Unsubscribe anytime."). `POST /api/public/host-list/[slug]/subscribe`: rate-limit by IP (mirror the register route's limiter helper), find host by slug (404 if none/unverified-ok — signup allowed pre-verification), find-or-create contact (mirror `findOrCreateRaceContact` usage; set marketing consent TRUE via the exact consent fields the register route sets), upsert `host_contacts` (source 'mailing_list'), tag the contact with `hostTagFor(host)` in BOTH `contacts.tags` (array append if missing) and `contact_tags` (READ how the import/segment tag write works and mirror). Return `{success:true}` always on duplicate (no enumeration).

### Task B3: per-host unsubscribe
`src/lib/host-unsubscribe.js`: HMAC token `sign({hostId, contactId})`/`verify(token)` using `SUPABASE_SERVICE_ROLE_KEY` as secret (mirror `signCheckinToken`'s pattern — READ `src/lib/checkin-token.js` or wherever it lives). Page `GET /unsubscribe/host/[token]` (public; allowlist like B2): verify → insert `host_email_suppressions` (upsert ignore-dup) → confirmation copy naming the host, "other preferences unchanged". TDD the token round-trip + tamper rejection.

### Task B4: ship PR-B
CI + build; adversarial lenses: provisioning IDOR (ADMIN+org), signup abuse (rate limit; consent writes correct; no cross-host tag/contact pollution), token forgery. Push, PR, merge.

---

## PR-C — HOST-EMAIL.3: compose + send

### Task C1: migration 401
`401_host_campaigns.sql`: `host_campaigns` (`id, host_id FK CASCADE, subject text NOT NULL, body_html text NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK ('draft','sending','sent','failed')`, `recipient_count int`, `sent_count int NOT NULL DEFAULT 0`, `created_at`, `sent_at`); `host_campaign_sends` queue (`id, campaign_id FK CASCADE, contact_id FK CASCADE, email text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK ('pending','claimed','sent','failed')`, `claimed_at`, `sent_at`, `UNIQUE(campaign_id, contact_id)`); `cron_heartbeats` row `send-host-campaigns` in the SAME migration. RLS on/no policy. MCP + advisors.

### Task C2: render + recipient libs (TDD)
`src/lib/host-campaign-email.js`: pure `renderHostCampaignHtml({ host, subject, bodyHtml, unsubscribeUrl })` — clean shell (host sender_name header, optional accent, body, MANDATORY footer with host name + the per-host unsubscribe link; escape everything except bodyHtml which is host-authored — sanitize it: strip `<script/style/iframe/on*=` attributes via a small allowlist sanitizer, TDD'd). Recipient resolution: `resolveHostRecipients(db, hostId)` — `host_contacts` join `contacts`, filter with `isEmailable` (from PR-A) minus `host_email_suppressions`, paginated; returns `[{contact_id, email}]` deduped by email.

### Task C3: routes + cron
`GET/POST /api/host/emails` (list; create draft `{subject, body}` Zod-validated), `POST /api/host/emails/[id]/send`: gates — `getCurrentHost`, own campaign 404, `sender_domain_verified` else 409, daily cap: count today's `host_campaigns` with status IN ('sending','sent') `>= email_daily_send_cap` → 409. Resolve recipients; 0 → 409 'No emailable contacts.'. CAS `draft→sending` (`.eq('status','draft').select('id')`, 0 rows → 409), stamp `recipient_count`, bulk-insert `host_campaign_sends` (chunked ≤500/insert). Cron `GET /api/cron/send-host-campaigns` (CRON_SECRET + `stampHeartbeat('send-host-campaigns')` on success + vercel.json entry, every minute or `*/2`): claim a batch (≤50) of pending sends via CAS update `pending→claimed` `.select()`, for each render (fresh per-contact unsubscribe token) + `sendEmail({ to, from: '"<sender_name>" <sender_email>', replyTo: host.email, subject, htmlBody, stream: 'broadcast', tag: 'host-campaign' })` — READ `sendEmail`'s exact signature/params (from/replyTo support) and adapt; mark `sent`/`failed` per row + increment campaign `sent_count`; when no pending remain flip campaign `sending→sent` + `sent_at`. Ledger via the existing email_sends write if `sendEmail` does it (READ; if it requires locationId, pass the host's anchor/event location or null-safe alternative — verify column nullability first via information_schema; if not workable, log sends only in host_campaign_sends and note it).

### Task C4: portal UI + ship
`/host/emails` page: campaign list (status/counts/date), New email form (subject + textarea body with basic paragraph handling), preview (server-rendered via a preview endpoint or client approximation), Send with confirm showing recipient count. Dark theme, typed buttons. CI + build; **adversarial review (strongest of the three)**: cross-host sends impossible (campaign+contacts scoping), consent/suppression/cap bypasses, double-send (CAS + queue idempotency), footer/unsubscribe stripping (server-side injection), sanitizer XSS, cron auth. Push, PR, merge.

---

## Self-Review (at write time)
- **Spec coverage:** A=list/hooks/backfill/portal+export; B=domains/signup/tagging/unsubscribe; C=campaigns/caps/consent/cron/UI. Abuse controls: caps (C3), kill switch (B1), server footer (C2), consent+suppression (A3 predicate reused in C2), ledger (C3). Broadcast-stream bounce webhook check — added to C4 review scope. ✓
- **Placeholders:** READ-and-mirror notes are live-schema verifications (consent flag names, sendEmail signature, tag-write shape, limiter, token helper) — bounded, not deferred logic. ✓
- **Type consistency:** `hostTagFor(host)`, `isEmailable(contact, suppressed)`, `addEventAttendeesToHostList(db, raceEventId)` (A2↔A3↔C2); `renderHostCampaignHtml`/`resolveHostRecipients` (C2↔C3); migration numbers 400/401. ✓
