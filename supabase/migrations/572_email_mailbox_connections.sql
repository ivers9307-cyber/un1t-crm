-- MAILBOX-CONNECT.2 — a mailbox can carry its own IMAP/SMTP login.
-- Spec: docs/superpowers/specs/2026-08-26-imap-mailbox-connector-design.md
-- Phase 2 (Schema). Extends mig 485, which created email_mailboxes.
--
-- WHY
-- Mig 485 gave a studio many inbound addresses, but every one of them still
-- had exactly ONE way in: the Postmark inbound webhook. That requires pointing
-- a domain's MX at Postmark, which requires OWNING the domain.
--
-- `un1t.com` is the franchisor's — verified 2026-08-26, Google Workspace MX,
-- no Microsoft tenant. We will never control its MX. So today:
--   • hatchstreet@un1t.com is invisible to the platform entirely;
--   • stillorgan@un1t.com sits in email_mailboxes as active + is_default, so
--     every campaign stamps a Reply-To the CRM cannot receive. That mail is
--     not lost — it is in the franchisor's Google mailbox — but the platform
--     CLAIMS to handle it and does not. mig 485 shipped that claim; this
--     migration is the first half of making it true.
--
-- SCOPE DECISION (Richard, 2026-08-26): build it as a SaaS capability, not a
-- one-off for un1t.com. Any operator connects any email account from
-- Settings → Locations → studio → Email by supplying its login. That is why
-- host/port/TLS live in columns rather than being Gmail-hardcoded: the
-- customer's provider is not ours to assume.
--
-- Owning the domain was never the requirement. HOLDING THE MAILBOX LOGIN is.
-- The estate already proves this — recon_mailboxes (mig 370) has held a
-- working Gmail app password for stillorgan@un1t.com since 2026-07-04.
--
-- WHY NOT recon_mailboxes / recon/imap-client.js
-- That is the receipt-hunt engine: a live feature that hardcodes
-- `[Gmail]/All Mail` and serves accounting, not ticketing. Coupling the two
-- risks the receipt hunt for no gain. Deliberately separate tables, and a
-- deliberately separate src/lib/mail/ — see the spec §3.1.
--
-- NOTHING READS THIS YET. Phases 3–6 land the client, the poller and the
-- settings UI. Applying this migration changes no behaviour: see the ingress
-- / egress section below, where every existing row keeps exactly the
-- behaviour it has today.

-- ── 1. Credentials ──────────────────────────────────────────────────
-- SEPARATE TABLE FROM email_mailboxes, on purpose. Two reasons, and the
-- second is the load-bearing one:
--   • not every mailbox has a login (a Postmark-MX mailbox never will), so
--     these columns would be NULL on most rows; and
--   • a secret must be structurally impossible to leak through a careless
--     SELECT on the mailbox. mig 485's email_mailboxes is readable by every
--     authenticated user at the location and is published to realtime. A
--     `secret_ciphertext` column ON THAT TABLE would ride out over the
--     websocket to every staff member's browser. It is not enough to
--     remember not to select it — the row must not contain it.
--
-- SECURITY POSTURE (spec §6). The estate's precedent for secrets is plaintext
-- in a service-role-only table: xero_connections (mig 029, carrying an
-- explicit "TODO: layer pgcrypto-based encryption later") and recon_mailboxes,
-- which copied it. THAT PRECEDENT DOES NOT TRANSFER. Those hold OUR tokens for
-- OUR accounts. This holds CUSTOMERS' mailbox passwords, and an IMAP app
-- password is total mailbox authority — read everything, send as them. A
-- DB-level leak that costs us a Xero re-auth would cost a customer their
-- entire correspondence. So the values here are AES-256-GCM ciphertext sealed
-- by src/lib/mail/secret-box.js, whose key lives in a Vercel env var
-- (MAILBOX_SECRET_KEY) and NOT in Supabase Vault — the key must not live in
-- the database it protects.
CREATE TABLE IF NOT EXISTS public.email_mailbox_credentials (
  -- PK *is* the FK: one login per mailbox, no id column, no ambiguity about
  -- which credential is current. Also see the index note at the end of this
  -- section — this is what covers the foreign key.
  mailbox_id        uuid PRIMARY KEY REFERENCES public.email_mailboxes(id) ON DELETE CASCADE,

  provider          text NOT NULL DEFAULT 'custom'
                      CHECK (provider IN ('gmail','microsoft','custom')),
  auth_type         text NOT NULL DEFAULT 'password'
                      CHECK (auth_type IN ('password','oauth')),

  username          text NOT NULL,

  -- Password mode. Ciphertext only, format 'v1:<b64 iv>:<b64 tag>:<b64 ct>'.
  secret_ciphertext text,

  -- OAuth mode. Nullable from day one — see the auth_type comment below.
  oauth_access_token_ciphertext   text,
  oauth_refresh_token_ciphertext  text,
  oauth_expires_at  timestamptz,

  imap_host         text NOT NULL,
  imap_port         int  NOT NULL DEFAULT 993,
  imap_secure       boolean NOT NULL DEFAULT true,

  smtp_host         text,
  smtp_port         int  DEFAULT 465,
  smtp_secure       boolean NOT NULL DEFAULT true,

  sent_folder       text,

  -- ON DELETE SET NULL, matching mig 485's granted_by. The bare form (NO
  -- ACTION) would make a profiles delete RAISE rather than proceed, so
  -- offboarding whoever first connected a mailbox would fail on a foreign key
  -- pointing at a provenance stamp nothing depends on. recon_mailboxes.created_by
  -- (mig 370) still carries that latent bug; this table deliberately does not.
  created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_mailbox_credentials IS
  'MAILBOX-CONNECT.2: the IMAP/SMTP login for one email_mailboxes row, so a studio can receive mail on a domain we do not own the MX for. Service-role-only: routes are the security boundary (CLAUDE.md), gated by guardMailboxAdmin — master or owner-at-location, the same gate as mailbox grants. NEVER selected by any GET; the UI shows connection STATE, never the value.';

COMMENT ON COLUMN public.email_mailbox_credentials.mailbox_id IS
  'MAILBOX-CONNECT.2: PK and FK both. One login per mailbox. ON DELETE CASCADE because a credential without its mailbox is not correspondence worth keeping — unlike email_tickets.mailbox_id, which is SET NULL precisely so deleting a mailbox never deletes mail. Note the removal path in practice is deactivation (email_mailboxes.active=false), not DELETE.';

-- 🔴 auth_type AND THE oauth_* COLUMNS ARE A DELIBERATE SEAM, NOT DEAD WEIGHT.
-- Someone WILL open this table, see three permanently-NULL oauth columns and
-- an auth_type that only ever holds 'password', and propose dropping them.
-- Do not. The reasoning (spec §2.1):
--
--   • Asking a customer to paste a mailbox password into our app is a real
--     objection, and Google has been steadily narrowing password-based
--     access. OAuth is where this feature ends up.
--   • It is not something we can simply choose to do this month. Gmail over
--     IMAP with XOAUTH2 needs the https://mail.google.com/ scope, which is
--     RESTRICTED — as are gmail.readonly and gmail.modify. There is no
--     unrestricted way to read a Gmail mailbox. Restricted scopes in
--     production, for users outside our own Workspace, require Google OAuth
--     app verification PLUS an annual third-party CASA Tier 2 security
--     assessment: real money, weeks-to-months of calendar time. Leaving the
--     app in Testing is not a workaround — refresh tokens expire after 7 days.
--   • Counterintuitively Microsoft is the CHEAP one (multi-tenant app
--     registration + ordinary consent, no CASA), which inverts the usual
--     build order if the business ever funds it.
--
-- DECISION (Richard, 2026-08-26): ship password auth, BUILD THE SEAM, defer
-- the provider work. One column now beats a migration plus a credential
-- backfill later, and the backfill is the expensive half — it would have to
-- re-read secrets. src/lib/mail/auth-strategy.js already branches on this
-- column and returns { user, pass } or { user, accessToken }; imapflow and
-- nodemailer both accept either shape verbatim, so every call site is already
-- identical in both modes. Adding a provider later is a resolver change plus
-- a consent screen, not surgery.
COMMENT ON COLUMN public.email_mailbox_credentials.auth_type IS
  'MAILBOX-CONNECT.2: password | oauth. The OAuth seam (spec §2.1) — OAuth is DEFERRED, not rejected, because Gmail IMAP needs a restricted scope gated behind Google verification + annual CASA Tier 2. Only ever ''password'' today. Do NOT drop this column or the oauth_* columns: they exist so adding a provider is a resolver change in src/lib/mail/auth-strategy.js rather than a migration plus a credential backfill.';

COMMENT ON COLUMN public.email_mailbox_credentials.provider IS
  'MAILBOX-CONNECT.2: drives the settings-UI preset (host/port/TLS defaults, sent_folder, and the app-password instructions — the #1 support burden of any mailbox connector). NOT an auth switch; auth_type is. ''microsoft'' is unsupported at launch and stated plainly in the UI — Exchange Online has no basic-auth IMAP, so it needs the OAuth work above.';

COMMENT ON COLUMN public.email_mailbox_credentials.secret_ciphertext IS
  'MAILBOX-CONNECT.2: the app password, AES-256-GCM sealed by src/lib/mail/secret-box.js as ''v1:<b64 iv>:<b64 tag>:<b64 ciphertext>''. NEVER plaintext, NEVER returned by a GET, NEVER logged, and never included in an error message. The ''v1:'' prefix exists so the key can be rotated. A missing or malformed MAILBOX_SECRET_KEY makes open() THROW — it must never fall back to reading the column as plaintext.';

COMMENT ON COLUMN public.email_mailbox_credentials.oauth_access_token_ciphertext IS
  'MAILBOX-CONNECT.2: unused until OAuth ships (see auth_type). Same seal format as secret_ciphertext. Deliberately nullable — a password-mode row leaves all three oauth_* columns NULL.';
COMMENT ON COLUMN public.email_mailbox_credentials.oauth_refresh_token_ciphertext IS
  'MAILBOX-CONNECT.2: unused until OAuth ships (see auth_type). Same seal format as secret_ciphertext. Deliberately nullable.';
COMMENT ON COLUMN public.email_mailbox_credentials.oauth_expires_at IS
  'MAILBOX-CONNECT.2: unused until OAuth ships (see auth_type). When it does, auth-strategy.js refuses an expired token with reason ''oauth_expired'' rather than handing imapflow a token it knows is dead.';

COMMENT ON COLUMN public.email_mailbox_credentials.username IS
  'MAILBOX-CONNECT.2: the IMAP/SMTP login. USUALLY equal to email_mailboxes.address but not structurally — some hosts authenticate on a separate account name, and a shared mailbox may be reached with a delegate''s login. Kept as its own column rather than derived, so a working connection never depends on the two being the same string.';

-- NO XOR CHECK between the password and oauth columns, on purpose. A DB
-- constraint here would refuse a partial credential write with a message no
-- operator can act on. src/lib/mail/auth-strategy.js is the enforcement point
-- instead: it returns { ok:false, reason:'not_configured' }, which the health
-- surface renders as a connection state the operator can actually fix. Judge
-- credentials where they are USED, not where they are stored.

COMMENT ON COLUMN public.email_mailbox_credentials.imap_secure IS
  'MAILBOX-CONNECT.2: implicit TLS on connect (port 993). false means STARTTLS on a plaintext port (143) — the flag is about HOW TLS starts, never about whether it is used.';
COMMENT ON COLUMN public.email_mailbox_credentials.smtp_secure IS
  'MAILBOX-CONNECT.2: the trap this column exists to make visible. 465 = implicit TLS = secure true; 587 = STARTTLS = secure FALSE. Pairing 587 with secure=true is the single most common mis-configuration in every SMTP connector, and it fails as an opaque connect timeout rather than a TLS error. The provider presets set the pair together for exactly this reason.';
COMMENT ON COLUMN public.email_mailbox_credentials.smtp_host IS
  'MAILBOX-CONNECT.2: nullable because receive-without-send is a valid, supported state — see email_mailboxes.egress. NULL here means replies keep leaving via Postmark.';

COMMENT ON COLUMN public.email_mailbox_credentials.sent_folder IS
  'MAILBOX-CONNECT.2: provider-specific name of the Sent folder (Gmail: ''[Gmail]/Sent Mail''). Read by Phase 8, which polls Sent so a reply someone sends from Gmail appears in the CRM instead of leaving the ticket looking unanswered — the one divergence in spec §5 that is customer-facing rather than cosmetic. NULL until then; a NULL is not a fault.';

COMMENT ON COLUMN public.email_mailbox_credentials.updated_at IS
  'MAILBOX-CONNECT.2: stamped by the route on every write, NOT by a trigger — matching email_mailboxes and recon_mailboxes, which do the same. There is an update_updated_at() function from mig 001, but this family of tables has never used it and a trigger on only some of them would be worse than none.';

-- FK INDEXES — READ BEFORE "FIXING" THIS.
-- Postgres can only use an index for a foreign key's referential action when
-- the FK column LEADS it. mailbox_id is the PRIMARY KEY here, so the pk index
-- already leads with it: email_mailbox_credentials needs NO separate index on
-- mailbox_id, and adding one would be pure duplication. (Same for
-- email_mailbox_ingress below, where mailbox_id leads the composite PK.)
-- Said explicitly because mig 497 had to come back and add exactly such an
-- index on email_ticket_attachments.mailbox_id after get_advisors flagged it,
-- and the next person reading that story should not "fix" a case that is
-- already covered.
--
-- created_by is the FK that is NOT covered by anything above, so it gets its
-- own index — the same reason mig 485 added idx_email_mailbox_access_granted_by.
CREATE INDEX IF NOT EXISTS idx_email_mailbox_credentials_created_by
  ON public.email_mailbox_credentials (created_by);

COMMENT ON INDEX public.idx_email_mailbox_credentials_created_by IS
  'MAILBOX-CONNECT.2: covers email_mailbox_credentials_created_by_fkey. Without it a profiles delete would seq-scan this table under a lock. Flagged by get_advisors(type=performance) as unindexed_foreign_keys otherwise — the mig 497 class.';

-- ── 2. Ingress cursor ───────────────────────────────────────────────
-- SEPARATE TABLE FROM CREDENTIALS, on purpose: different write frequency and
-- different sensitivity. This row is rewritten every 5 minutes by the poller;
-- credentials are written when an operator connects a mailbox and then
-- essentially never. Putting a hot counter in the same row as a secret means
-- every cursor bump rewrites the ciphertext into a new heap tuple and into
-- WAL, and it means the poller's UPDATE path has the secret in scope for no
-- reason.
CREATE TABLE IF NOT EXISTS public.email_mailbox_ingress (
  mailbox_id  uuid NOT NULL REFERENCES public.email_mailboxes(id) ON DELETE CASCADE,
  folder      text NOT NULL,

  uidvalidity bigint,
  last_uid    bigint,

  last_run_at timestamptz,
  last_ok_at  timestamptz,
  last_error  text,
  consecutive_failures int NOT NULL DEFAULT 0,
  paused_until timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (mailbox_id, folder)
);

COMMENT ON TABLE public.email_mailbox_ingress IS
  'MAILBOX-CONNECT.2: the IMAP poll cursor for one folder of one mailbox. Service-role-only — written exclusively by the */5 poller cron. Separate from email_mailbox_credentials because it is a hot row next to a cold secret.';

-- 🔴 folder IS IN THE PRIMARY KEY DELIBERATELY.
-- A receive-only release polls INBOX and nothing else, so a single-column PK
-- on mailbox_id would work today and be wrong tomorrow. Phase 8 (spec §5)
-- polls the Sent folder on its OWN cursor so that a reply a coach sends from
-- Gmail appears in the CRM — without it the ticket sits "needs reply" forever
-- and a member gets answered twice, which is a worse failure than any of the
-- plumbing faults this design is otherwise careful about. Composite PK now
-- means Phase 8 inserts a second row and needs NO migration at all.
--
-- No CHECK on the vocabulary, and that is the point: constraining it to
-- ('inbox','sent') would put a migration back in front of the next
-- provider-specific folder, which is exactly what this PK shape exists to
-- avoid. The writer owns the vocabulary.
COMMENT ON COLUMN public.email_mailbox_ingress.folder IS
  'MAILBOX-CONNECT.2: which folder this cursor tracks — ''inbox'' today, ''sent'' when Phase 8 lands, and it is IN THE PRIMARY KEY so that lands with no migration. Deliberately unconstrained by a CHECK so a provider-specific folder needs no DDL either. Not the IMAP path itself (that is provider-specific, e.g. Gmail''s ''[Gmail]/Sent Mail'' — see email_mailbox_credentials.sent_folder); this is the CRM''s own name for the lane.';

COMMENT ON COLUMN public.email_mailbox_ingress.uidvalidity IS
  'MAILBOX-CONNECT.2: the IMAP UIDVALIDITY the last_uid watermark belongs to. If the server changes it, every UID we hold is meaningless. The poller then RE-ANCHORS to the current highest UID and ingests nothing — it must never re-ingest the mailbox, which would file the customer''s whole inbox as new tickets.';
COMMENT ON COLUMN public.email_mailbox_ingress.last_uid IS
  'MAILBOX-CONNECT.2: highest UID successfully handed to the inbound route. Advanced ONLY on a 2xx from that route (spec §3.3) — a 5xx leaves it, and the next tick retries, which is precisely Postmark''s own behaviour, so the route sees the retry pattern it was hardened against. NULL means never anchored; the first successful connect sets it to the mailbox''s current highest UID and ingests nothing (cold start, spec §3.5 — new mail only, no backfill, ever).';
COMMENT ON COLUMN public.email_mailbox_ingress.last_run_at IS
  'MAILBOX-CONNECT.2: last poll ATTEMPT (contrast last_ok_at, the last success). Also the fair-ordering key for the multi-tenant loop — one customer''s broken mailbox must never delay another''s.';
COMMENT ON COLUMN public.email_mailbox_ingress.last_ok_at IS
  'MAILBOX-CONNECT.2: last successful poll. Feeds the per-mailbox Email (inbound) health row, which is what retires the standing audit finding that a mailbox merely ASSERTS receiving works. A connector that cannot say whether it is working is the exact failure this codebase already has on record.';
COMMENT ON COLUMN public.email_mailbox_ingress.last_error IS
  'MAILBOX-CONNECT.2: last failure, operator-facing. Auth failure after a password revoke is the #1 real-world failure mode and must be surfaced DISTINCTLY from a transport failure — a revoked password is an operator action, not an outage. Never store the credential or any part of it here.';
COMMENT ON COLUMN public.email_mailbox_ingress.consecutive_failures IS
  'MAILBOX-CONNECT.2: drives exponential backoff and eventual auto-pause. Reset to 0 on any success.';
COMMENT ON COLUMN public.email_mailbox_ingress.paused_until IS
  'MAILBOX-CONNECT.2: set by backoff/auto-pause; the poller skips the row until it passes. A pause MUST be loud in the UI — pausing quietly is how a mailbox stops receiving for a week and nobody knows. NULL = active.';

-- No index beyond the PK. This table has one row per polled folder per
-- connected mailbox — bounded by the number of mailboxes an operator connects,
-- which is single digits per location — so the fair-ordering scan over
-- last_run_at is a handful of rows and an index on it would be maintenance
-- cost for a plan the planner would not choose anyway. Revisit if a tenant
-- ever connects mailboxes in the hundreds (spec Phase 11.1 caps this).

-- ── 3. Which transport each mailbox uses ────────────────────────────
-- TWO COLUMNS, NOT ONE. Receive-via-IMAP WITHOUT send-as-SMTP is a real and
-- expected state, not a transitional one: it is exactly what the R1 release
-- ships (spec §8) — mail arrives over IMAP while replies still leave through
-- Postmark. A single "mode" column would make that state unrepresentable and
-- force the two halves to ship together.
--
-- APPLYING THIS CHANGES NO BEHAVIOUR. Every existing row defaults to
-- 'postmark' on both columns, which is precisely what every mailbox does
-- today. Nothing flips until an operator connects a login in Phase 6. NOT
-- NULL + DEFAULT is a metadata-only add on modern Postgres — no table
-- rewrite, no lock worth worrying about.
ALTER TABLE public.email_mailboxes
  ADD COLUMN IF NOT EXISTS ingress text NOT NULL DEFAULT 'postmark',
  ADD COLUMN IF NOT EXISTS egress  text NOT NULL DEFAULT 'postmark';

ALTER TABLE public.email_mailboxes
  DROP CONSTRAINT IF EXISTS email_mailboxes_ingress_check;
ALTER TABLE public.email_mailboxes
  ADD CONSTRAINT email_mailboxes_ingress_check CHECK (ingress IN ('postmark','imap'));

ALTER TABLE public.email_mailboxes
  DROP CONSTRAINT IF EXISTS email_mailboxes_egress_check;
ALTER TABLE public.email_mailboxes
  ADD CONSTRAINT email_mailboxes_egress_check CHECK (egress IN ('postmark','smtp'));

COMMENT ON COLUMN public.email_mailboxes.ingress IS
  'MAILBOX-CONNECT.2: how mail REACHES this mailbox. ''postmark'' = the inbound webhook (needs our MX); ''imap'' = the */5 poller reads the account directly (needs only its login). Independent of egress on purpose — receive-over-IMAP while still replying via Postmark is the R1 release, not a broken half-state.';

COMMENT ON COLUMN public.email_mailboxes.egress IS
  'MAILBOX-CONNECT.2: how replies LEAVE this mailbox. ''postmark'' = the existing send path; ''smtp'' = the connected account''s own SMTP, because Postmark cannot DKIM-sign a domain we do not control and sending unaligned mail from the franchisor''s domain is spoofing it, not a workaround. 🔴 On the SMTP path the unverified-From fallback in plannedFroms must NOT apply: the provider always sends as the authenticated account, so a silent fallback would change the address the customer sees. Knock-on: SMTP sends get no Postmark delivery/bounce events, so the UI must say WHY the status is empty rather than looking like a pending event.';

-- ── 4. RLS ──────────────────────────────────────────────────────────
-- Service-role-only, mirroring recon_mailboxes (mig 370). Routes are the
-- security boundary, per CLAUDE.md: every /api route uses createServerClient()
-- (service role, RLS-bypassing), so RLS here is the backstop that keeps
-- `authenticated` and `anon` out entirely — not the access control. The real
-- gate is guardMailboxAdmin (master or owner-at-location), the same gate as
-- mailbox grants: whoever may grant access to a mailbox is exactly whoever may
-- connect one.
--
-- 🔴 A SINGLE PERMISSIVE `FOR ALL TO service_role`. NEVER `AS RESTRICTIVE
-- FOR ALL`. RLS is (OR of permissive) AND (AND of restrictive), and FOR ALL
-- INCLUDES SELECT — so the natural-looking restrictive deny-everything folds
-- the table's own reads away and fails SILENTLY: reads return an empty set,
-- not an error, and realtime never fires. That pattern reached 16 tables and
-- killed the Email/IG/Unified inbox listeners under a 60s poll that hid it.
-- Migs 483 and 485 cleaned it up; `npm run check:rls-restrictive` now gates
-- it. mig 485 needed per-command restrictive denies because email_mailboxes
-- has a permissive SELECT for authenticated to protect. These two tables have
-- NO authenticated policy at all — with RLS enabled and no policy, the default
-- is deny, which is already the strongest posture available. Adding a
-- restrictive on top would buy nothing and risk the bug.
--
-- One permissive policy per (table, command) — the FOR ALL here is the ONLY
-- policy on each table, so nothing overlaps it on SELECT and
-- multiple_permissive_policies cannot trip.
ALTER TABLE public.email_mailbox_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_mailbox_ingress     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_mailbox_credentials_service_all ON public.email_mailbox_credentials;
CREATE POLICY email_mailbox_credentials_service_all ON public.email_mailbox_credentials
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS email_mailbox_ingress_service_all ON public.email_mailbox_ingress;
CREATE POLICY email_mailbox_ingress_service_all ON public.email_mailbox_ingress
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- NEITHER TABLE JOINS supabase_realtime, unlike email_mailboxes (mig 485).
-- Realtime authorises each postgres_changes row through the SUBSCRIBER's
-- SELECT policy, and there is no authenticated SELECT policy here by design —
-- so a subscription would deliver nothing anyway. More to the point, a
-- credential row must never be on a websocket. Connection STATE reaches the
-- UI through the mailbox routes, which return state and never the secret.
