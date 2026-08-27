-- INBOX-SURFACE.A — the schema for the inbox/ticketing head-to-head trial.
-- Extends mig 485 (email_mailboxes), mig 394 (email_inbox_messages) and
-- mig 572 (email_mailbox_credentials / email_mailbox_ingress).
--
-- ══ WHY THIS EXISTS: A TRIAL, NOT A MIGRATION ═══════════════════════
-- Richard is running two surfaces side by side over the same pipeline and will
-- pick one:
--   • accounts@hatchstreetfitness.com stays on the TICKETING surface that
--     ships today (/communications/tickets);
--   • hatchstreet@un1t.com runs on a new INBOX surface.
-- One column decides which UI a mailbox appears in. Nothing else about the
-- ingest path changes: the same webhook route files the same rows, and the
-- same poller reads the same folders.
--
-- ══ APPLYING THIS CHANGES NOTHING ═══════════════════════════════════
-- Every column added here is either NULLable with no default or NOT NULL with
-- a default equal to today's behaviour, so every existing row keeps behaving
-- exactly as it does now:
--   • email_mailboxes.surface defaults to 'tickets' — the surface every
--     mailbox in prod is already on;
--   • email_inbox_messages.seen_at is NULL — "unread", which is what the
--     ticketing surface has always implicitly assumed;
--   • email_mailbox_ingress.last_seen_sync_at is NULL — "never synced", which
--     the poller reads as "due", and the poller only ever runs that sync for a
--     surface='inbox' mailbox, of which there are none until an operator makes
--     one;
--   • email_mailbox_credentials.archive_folder is NULL — and NULL is not a
--     fault, exactly as it is not a fault on sent_folder (mig 572).
-- NOT NULL + DEFAULT is a metadata-only add on modern Postgres, so none of
-- these rewrites a table.
--
-- ══ 🔴 ARCHIVE IS NOT A NEW COLUMN, AND MUST NOT BECOME ONE ═════════
-- "Archived" in the inbox surface is `email_tickets.status = 'closed'`,
-- presented under a different word. One lifecycle, two vocabularies. A second
-- lifecycle column would drift from the first within a month — the two would
-- disagree about the same thread and no query could say which was right — and
-- the whole point of the trial is that the two surfaces sit over ONE pipeline,
-- so that whichever wins, nothing has to be migrated back.
--
-- ══ WHAT IS DELIBERATELY NOT HERE ═══════════════════════════════════
--   • No index on seen_at. The obvious one is a partial index for an unread
--     count, but the query that would use it does not exist yet (the inbox
--     surface's list route is Phase B) and an index chosen before its query is
--     an index the planner ignores plus write cost on the hottest table in the
--     email subsystem. Add it WITH the query, measured.
--   • No DROP of anything. Forward-only, per CLAUDE.md.
--   • No RLS change. Adding a column to a table that already has policies
--     changes nothing about who may read it, and none of these four tables
--     gains or loses a population here.

-- ── 1. Which surface a mailbox appears in ───────────────────────────
-- 🔴 EACH MAILBOX APPEARS IN EXACTLY ONE SURFACE. The tickets list excludes
-- 'inbox' mailboxes and the inbox excludes 'tickets' ones. If both showed
-- everything there would be no trial, only two skins over one queue, and the
-- comparison would answer nothing.
--
-- text + CHECK rather than an enum, matching ingress/egress in mig 572. An
-- enum needs its own DDL to grow a value and cannot be altered inside a
-- transaction on older Postgres; a CHECK is dropped and recreated in two
-- statements, which is what mig 572 does and what a third surface would do.
ALTER TABLE public.email_mailboxes
  ADD COLUMN IF NOT EXISTS surface text NOT NULL DEFAULT 'tickets';

-- 🔴 THE CONSTRAINT IS NAMED, AND THE NAME IS LOAD-BEARING.
-- mailboxConstraintMessage() (src/lib/email-mailbox-admin.js) turns a write
-- error into operator-facing copy by REGEX-MATCHING THE CONSTRAINT NAME out of
-- Postgres's message — that is how `email_mailboxes_address_shape` becomes
-- "that is not a valid email address". An auto-generated name gives it nothing
-- to match, so a bad write would surface to an owner as a raw Postgres string
-- under a 500. DROP-then-ADD so a re-run is idempotent (ADD CONSTRAINT has no
-- IF NOT EXISTS).
ALTER TABLE public.email_mailboxes
  DROP CONSTRAINT IF EXISTS email_mailboxes_surface_check;
ALTER TABLE public.email_mailboxes
  ADD CONSTRAINT email_mailboxes_surface_check CHECK (surface IN ('tickets','inbox'));

COMMENT ON COLUMN public.email_mailboxes.surface IS
  'INBOX-SURFACE.A: which UI this account appears in — ''tickets'' (today''s /communications/tickets) or ''inbox'' (the trial surface). 🔴 EXACTLY ONE, NEVER BOTH: the tickets list route must exclude ''inbox'' mailboxes and the inbox must exclude ''tickets'' ones, or the head-to-head trial is two skins over one queue and answers nothing. Defaults to ''tickets'' so applying this changes nothing for any existing row. It is a PRESENTATION choice, not an ingest one — the same webhook route and the same IMAP poller serve both. Also the gate on the only IMAP WRITES this codebase performs (src/lib/mail/imap-writeback.js refuses \Seen and Archive on any mailbox that is not ''inbox'').';

-- ── 2. Read state, mirrored from IMAP ───────────────────────────────
-- 🔴 THE CRM IS NOT THE SOURCE OF TRUTH FOR THIS COLUMN. THE MAILBOX IS.
--
-- A connected mailbox is a mailbox a human still opens: head office reads
-- hatchstreet@un1t.com in Gmail. If mail read there still looks unread here,
-- Richard triages the same message twice and the trial measures the wrong
-- thing — it would be comparing "an inbox" against "an inbox plus duplicated
-- work", which is not the comparison anybody asked for.
--
-- So the poller MIRRORS the IMAP \Seen flag onto this column (syncSeenFlags in
-- src/lib/mail/imap-poll.js) in BOTH directions: read in Gmail becomes read
-- here, and marked-unread in Gmail becomes unread here. A surface that writes
-- this column on its own without also setting \Seen over IMAP will be
-- converged back to the mailbox's answer at the next sync — that is the
-- intended behaviour, not a bug, and it is why markSeen() exists as a paired
-- write rather than the inbox writing this column alone.
--
-- NULL = unread. Deliberately a timestamp and not a boolean: "when did this
-- stop being new" is a question a triage surface asks (sort, "unread for 3
-- days", a first-response measure) and a boolean can never be widened into.
ALTER TABLE public.email_inbox_messages
  ADD COLUMN IF NOT EXISTS seen_at timestamptz;

COMMENT ON COLUMN public.email_inbox_messages.seen_at IS
  'INBOX-SURFACE.A: mirrors the IMAP \Seen flag. NULL = unread. 🔴 THE MAILBOX IS THE SOURCE OF TRUTH, NOT THE CRM — head office reads this account in Gmail, and mail read there must read as read here or the operator triages twice. syncSeenFlags() (src/lib/mail/imap-poll.js) converges this column onto \Seen in both directions, over a bounded recent-UID window on a cadence, for surface=''inbox'' mailboxes only. A surface that sets this without also setting \Seen over IMAP (markSeen(), src/lib/mail/imap-writeback.js) will be converged back at the next sync. Timestamp rather than boolean so "unread for three days" and first-response measures stay reachable.';

-- ── 3. The cadence stamp for that mirror ────────────────────────────
-- 🔴 THIS COLUMN IS A COST CONTROL, AND IT IS THE REASON THE MIRROR IS NOT A
-- SECOND FULL-MAILBOX SCAN.
--
-- The poller's ordinary fetch asks only for UIDs ABOVE the watermark, which is
-- what keeps a tick O(new mail) instead of O(mailbox). Read state, though,
-- changes on messages BELOW the watermark — a member's email from last Tuesday
-- gets opened in Gmail today — so a naive mirror re-reads the whole mailbox
-- every five minutes, on every connected account, forever. That is the exact
-- shape of the query the rest of this subsystem is built to avoid.
--
-- Two bounds instead, and this column is the second one:
--   1. a fixed recent-UID WINDOW (SEEN_SYNC_WINDOW), so the work is O(1) in
--      mailbox size rather than O(mailbox);
--   2. a CADENCE — the mirror runs at most once every SEEN_SYNC_MIN_INTERVAL_MS
--      rather than on every tick.
--
-- It lives on the ingress row rather than anywhere new because that row is
-- ALREADY upserted once per tick per lane: the stamp rides that same write, so
-- the cadence costs zero additional queries. NULL means "never synced", which
-- the poller reads as due — the correct answer for a mailbox that has just
-- been switched to the inbox surface.
ALTER TABLE public.email_mailbox_ingress
  ADD COLUMN IF NOT EXISTS last_seen_sync_at timestamptz;

COMMENT ON COLUMN public.email_mailbox_ingress.last_seen_sync_at IS
  'INBOX-SURFACE.A: when the \Seen mirror (syncSeenFlags, src/lib/mail/imap-poll.js) last ran for this lane. 🔴 A COST CONTROL, not bookkeeping: read state changes on messages BELOW the watermark, so an unbounded mirror is a full-mailbox scan every five minutes on every connected account. The mirror is bounded twice — a fixed recent-UID window AND this cadence. Stamped only on a tick that actually ran the mirror, and it rides the cursor upsert the poller already does, so the cadence costs no extra query. NULL = never synced = due.';

-- ── 4. Where "Archive" moves a message to ───────────────────────────
-- Mirrors sent_folder (mig 572) exactly, for the same reason: the path is
-- PROVIDER-SPECIFIC and cannot be a constant in the code. Gmail advertises
-- '[Gmail]/All Mail' as \All; Outlook has 'Archive' as \Archive; a self-hosted
-- Dovecot may have 'INBOX.Archive' or nothing at all.
--
-- 🔴 NULL IS NOT A FAULT, and it is the ordinary state. The write helper
-- resolves the destination from the server's own SPECIAL-USE advertisement
-- (RFC 6154) when this is NULL, and refuses with an operator-readable verdict
-- when the server advertises none. This column is the override for the third
-- case — a server that advertises nothing but does have a folder the operator
-- knows the name of.
--
-- 🔴 AND IT IS AN ARCHIVE, NEVER A TRASH. Do not point this at a Trash or
-- Deleted Items folder and do not add a delete path beside it. Archive is
-- recoverable — Gmail keeps the message in All Mail — and delete is not; no
-- trial justifies handing a CRM the ability to destroy a customer's mail.
ALTER TABLE public.email_mailbox_credentials
  ADD COLUMN IF NOT EXISTS archive_folder text;

COMMENT ON COLUMN public.email_mailbox_credentials.archive_folder IS
  'INBOX-SURFACE.A: provider-specific path the inbox surface''s Archive action MOVEs a message to (Gmail: ''[Gmail]/All Mail''; Outlook: ''Archive''). NULL is NOT a fault and is the ordinary state — archiveMessage() (src/lib/mail/imap-writeback.js) then resolves the destination from the server''s own SPECIAL-USE advertisement (RFC 6154, \Archive then \All) and refuses with an operator-readable verdict if the server advertises neither. This column is the override for a server that advertises nothing. 🔴 AN ARCHIVE, NEVER A TRASH: archive is recoverable, delete is not, and deleting a customer''s mail is out of scope for this connector permanently.';
