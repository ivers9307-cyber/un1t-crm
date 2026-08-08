-- 501 — EMAIL-FORWARD.1: an attachment row that POINTS AT ANOTHER ROW'S BYTES.
--
-- ══ THE PROBLEM ═════════════════════════════════════════════════════
-- Forwarding a member's email usually means forwarding its files, and those
-- bytes are ALREADY in the email-attachments bucket at their canonical key
-- (`<location_id>/<message_id>/<index>.<ext>`). Copying them to a second key
-- so the forwarded message can have "its own" object would be paying twice —
-- twice the storage, twice the 5 GB mailbox quota — for a byte-identical file
-- that will always be pruned at the same moment as the original, because the
-- forward lives on the SAME ticket as the message it quotes.
--
-- So the forward's rows share the object. That is cheap and obvious. What is
-- neither is the consequence: TWO ROWS NOW ADDRESS ONE OBJECT, and three
-- things in this schema previously assumed one row = one object.
--
--   1. THE QUOTA. recalc_email_storage_usage() sums size_bytes over every row
--      with a storage_path. Left alone it would count a forwarded 4 MB invoice
--      as 8 MB, and a mailbox that forwards a lot would read as full for bytes
--      it does not hold. (The WRITE path never charged them — see
--      fileForwardedAttachments in src/lib/email-forward-server.js, which
--      deliberately does not call add_email_storage_bytes — so before this
--      migration the counter and the recalc would have DISAGREED, which is
--      worse than either being wrong: the repair tool would have "fixed" the
--      right number into the wrong one.)
--   2. THE PRUNE. It marks a batch of rows `storage_path = NULL,
--      skipped_reason = 'pruned'` and then removes those objects. Remove an
--      object a surviving row still points at and that row is a chip that
--      downloads a 404 — silently, months later, with nothing on any screen
--      explaining it.
--   3. THE DECREMENT. Pruning a row that never owned its bytes would give the
--      mailbox back space it was never charged for.
--
-- ══ THE ANSWER: ONE NULLABLE SELF-REFERENCE ═════════════════════════
-- `forwarded_from_id` is NULL on every row that OWNS its bytes (every inbound
-- attachment, every file staff uploaded to a reply or a new email — i.e. every
-- row that exists today) and set on a row that merely points at another's.
-- One column answers all three questions:
--
--   • quota   — the recalc below adds `AND a.forwarded_from_id IS NULL`, so
--               shared bytes are counted exactly once, by their owner.
--   • prune   — candidates are filtered to owners, and after a batch is marked
--               every row pointing INTO that batch is marked too (see
--               pruneMailboxAttachments). The forward's chip then reads
--               "Removed to free space", which is true: the bytes are gone.
--   • billing — a reference row is never charged and never refunded.
--
-- ON DELETE SET NULL, not CASCADE, and that is the self-healing choice. If the
-- owning row disappears (its message deleted — nothing in the app does this,
-- but the FK to email_inbox_messages is ON DELETE CASCADE) the object itself
-- survives, because only the prune ever removes objects. The forward's row
-- then becomes an ordinary owner: it still addresses real bytes, the recalc
-- starts counting them again, and the prune can reclaim them. CASCADE would
-- have deleted the forward's row and erased the record of a file that
-- genuinely went out.
--
-- NOT a UNIQUE constraint on storage_path, deliberately: one message may
-- legitimately be forwarded twice, to two different people, and each forward
-- is its own row against the same object.
--
-- THE GRAPH IS ALWAYS EXACTLY ONE LEVEL DEEP. Forwarding a forward is
-- ordinary — the accountant's answer goes on to the bank — and the row being
-- forwarded is then itself a reference. The writer
-- (collectForwardAttachments) therefore points the new row at
-- `row.forwarded_from_id || row.id`: at the OWNER, never at the reference in
-- front of it. That is what keeps the prune's SINGLE-PASS cascade complete by
-- construction; a chain owner → fwd1 → fwd2 would have left fwd2 addressing
-- bytes that were already gone. Not expressible as a CHECK (it is a statement
-- about the row this one points at), so it is stated here, in the writer, and
-- in a test.
--
-- Forward-only, and PURELY ADDITIVE: every existing row keeps NULL, which is
-- exactly "I own my bytes" — the behaviour every one of them already had.

ALTER TABLE public.email_ticket_attachments
  ADD COLUMN IF NOT EXISTS forwarded_from_id uuid
    REFERENCES public.email_ticket_attachments(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.email_ticket_attachments.forwarded_from_id IS
  'EMAIL-FORWARD.1: NULL = this row OWNS its bytes (every inbound attachment and every staff upload). Non-NULL = this row is a FORWARD of another row and shares its object at the same storage_path, so it is never charged to the mailbox quota, never counted by recalc_email_storage_usage, and never a prune candidate in its own right — but IS marked pruned alongside the owner it points at, because the bytes really do go. ON DELETE SET NULL so that losing the owner promotes this row to an ordinary owner rather than erasing the record of a file that went out.';

-- The prune's cascade step asks "which rows point INTO this batch of ids", so
-- the lookup column needs its own index. Partial, because the overwhelming
-- majority of rows are NULL and never participate.
CREATE INDEX IF NOT EXISTS idx_email_attach_forwarded_from
  ON public.email_ticket_attachments (forwarded_from_id)
  WHERE forwarded_from_id IS NOT NULL;

-- ── recalc: count shared bytes ONCE, by their owner ──────────────────
-- Byte-identical to mig 496's function but for the two `forwarded_from_id IS
-- NULL` clauses. Restated in full rather than patched because CREATE OR
-- REPLACE takes the whole body, and a reader of this file has to be able to
-- see what the counter now means without opening 496.
CREATE OR REPLACE FUNCTION public.recalc_email_storage_usage(p_location_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_location_id IS NULL THEN
    RAISE EXCEPTION 'recalc_email_storage_usage: p_location_id is required';
  END IF;

  -- Existing counters first, so a bucket whose every attachment has been
  -- pruned is driven to 0 rather than left at its old figure.
  UPDATE public.email_storage_usage u
     SET bytes_used = coalesce((
           SELECT sum(a.size_bytes)::bigint
             FROM public.email_ticket_attachments a
            WHERE a.location_id = p_location_id
              AND a.storage_path IS NOT NULL
              -- EMAIL-FORWARD.1: a forwarded row shares the owner's object.
              -- Counting it would bill one file twice.
              AND a.forwarded_from_id IS NULL
              AND a.mailbox_id IS NOT DISTINCT FROM u.mailbox_id
         ), 0),
         updated_at = now()
   WHERE u.location_id = p_location_id;

  -- Then any bucket that holds bytes but has no counter row yet.
  INSERT INTO public.email_storage_usage (location_id, mailbox_id, bytes_used, updated_at)
  SELECT p_location_id, a.mailbox_id, sum(a.size_bytes)::bigint, now()
    FROM public.email_ticket_attachments a
   WHERE a.location_id = p_location_id
     AND a.storage_path IS NOT NULL
     AND a.forwarded_from_id IS NULL
   GROUP BY a.mailbox_id
  ON CONFLICT (location_id, mailbox_id) DO UPDATE
    SET bytes_used = excluded.bytes_used,
        updated_at = now();
END
$$;

COMMENT ON FUNCTION public.recalc_email_storage_usage(uuid) IS
  'EMAIL-ATTACH.1 / EMAIL-FORWARD.1: re-derive every storage counter at one location from email_ticket_attachments, counting each object ONCE — rows with forwarded_from_id set share an owner''s bytes and are excluded. Operator-invoked repair for counter drift; never called on the write path (it is the SUM the counter exists to avoid).';

-- CREATE OR REPLACE preserves the ACL, but restate it so this file is a
-- complete statement of who may run the function (mig 496 posture).
REVOKE ALL ON FUNCTION public.recalc_email_storage_usage(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recalc_email_storage_usage(uuid) TO service_role;

-- ── 2. WHICH message a forward forwarded ─────────────────────────────
--
-- A forward is an ordinary OUTBOUND message on the same ticket (see the route
-- for why it is not a ticket of its own), which means the thread would render
-- it identically to a reply: an accent bubble reading "Sent to
-- accountant@…". True, but it loses the one fact an operator most needs when
-- they come back to the ticket a week later — WHAT was passed on. "We
-- forwarded something to the accountant" and "we forwarded the member's bank
-- details to the accountant" are different events.
--
-- Recording it as a column rather than inferring it from the "Fwd: " subject
-- keeps the fact structural: a subject prefix is operator-editable text that
-- happens to correlate today, and a thread that decides how to render a
-- message by pattern-matching its subject is one renamed subject away from
-- lying.
--
-- NULL on every message that is not a forward, which is every message written
-- before this migration. ON DELETE SET NULL: losing the quoted message must
-- not delete the record of the forward that went out.
ALTER TABLE public.email_inbox_messages
  ADD COLUMN IF NOT EXISTS forwarded_message_id uuid
    REFERENCES public.email_inbox_messages(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.email_inbox_messages.forwarded_message_id IS
  'EMAIL-FORWARD.1: for an outbound message that is a FORWARD, the message on the same ticket whose content it quotes. NULL for replies, notes, composed mail and everything inbound. Set so the thread can say what was passed on rather than inferring it from a "Fwd: " subject prefix, which is editable text. The forward''s own recipients live in to_emails/cc_emails/bcc_emails as usual; the quoted message''s bcc_emails is NEVER reproduced in the forwarded body (see src/lib/email-forward.js).';

CREATE INDEX IF NOT EXISTS idx_email_msg_forwarded_message
  ON public.email_inbox_messages (forwarded_message_id)
  WHERE forwarded_message_id IS NOT NULL;

-- NO RLS CHANGES. Both tables already carry a per-command write denial and a
-- single location-scoped SELECT policy (migs 482/483/485); a new column
-- inherits both. Adding a policy here would trip
-- multiple_permissive_policies, and a RESTRICTIVE FOR ALL would kill SELECT
-- outright — the mig 485 class this repo now lints for.
