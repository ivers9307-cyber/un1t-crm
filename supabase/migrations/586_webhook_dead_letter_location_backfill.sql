-- MAIL-FOLLOWUPS.1 — one-off backfill: stamp location_id onto inbound-email
-- dead-letter rows whose recipient resolves to an ACTIVE mailbox TODAY.
--
-- WHY. MAIL-DEADLETTER.1 (#1608) made the morgue org-scoped: an owner sees a
-- row only where they are owner at the row's location_id, and the LIST route
-- bounds its query with `.in('location_id', …)`, which excludes NULL rows
-- outright — so a NULL-location row is visible to master alone. The common
-- NULL case is `no_matching_mailbox`: the mail arrived BEFORE the studio had
-- configured its mailbox, so at capture there was nothing to stamp (the
-- capture path already stamps every row whose recipient resolves — no_sender,
-- dedupe_release_failed — via bestEffortInboundLocation; no_matching_mailbox
-- is NULL by construction, because the same resolver found nothing). Once
-- the operator configures the mailbox the row still says NULL, the owner
-- never sees it, and only master can replay it. This resolves those rows
-- against the mailboxes that exist NOW, the way the replay route's
-- resolveDeadLetterLocation does per row.
--
-- WHAT IT MIRRORS. recipientEmails() in src/lib/email-inbox.js walks
-- ToFull[].Email, then CcFull[].Email, then the display `To` header, then
-- OriginalRecipient, normalising lower(trim()), and resolveMailboxByRecipient
-- picks the FIRST recipient in that order that matches an ACTIVE mailbox
-- (email_mailboxes_address_uidx is UNIQUE on lower(address), so a match is
-- one row). The display-`To` parse is deliberately omitted here: Postmark
-- always populates ToFull, so a row whose ONLY recipient hint is the display
-- string is one this backfill leaves NULL — the fail-open default, never a
-- guess.
--
-- SCOPE. provider = 'postmark_inbound' only (the only provider whose payload
-- carries a recipient; the Zoom rows that make up the live NULL set today have
-- none and stay NULL). pending/failed only — resolved/discarded rows are
-- history, and the visibility model already answers them from the row's own
-- location_id. Idempotent: `location_id IS NULL` is the guard, so re-running
-- touches nothing already stamped. Mostly future-proofing: at the time of
-- writing the live table holds ~2 NULL-location rows, both Zoom, so this
-- UPDATE affects 0 rows today.

WITH recipient AS (
  SELECT
    d.id AS dead_letter_id,
    lower(trim(r.email)) AS email,
    r.ord
  FROM public.webhook_dead_letter d
  CROSS JOIN LATERAL (
    -- ToFull[*].Email first …
    SELECT t.elem->>'Email' AS email, 1000 + t.ord AS ord
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(d.payload->'ToFull') = 'array' THEN d.payload->'ToFull' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS t(elem, ord)
    UNION ALL
    -- … then CcFull[*].Email …
    SELECT c.elem->>'Email', 2000 + c.ord
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(d.payload->'CcFull') = 'array' THEN d.payload->'CcFull' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS c(elem, ord)
    UNION ALL
    -- … then OriginalRecipient (a bare string).
    SELECT d.payload->>'OriginalRecipient', 3000
  ) AS r
  WHERE d.provider = 'postmark_inbound'
    AND d.location_id IS NULL
    AND d.status IN ('pending', 'failed')
    AND jsonb_typeof(d.payload) = 'object'
    AND r.email IS NOT NULL
    AND trim(r.email) <> ''
),
resolved AS (
  SELECT DISTINCT ON (rc.dead_letter_id)
    rc.dead_letter_id,
    m.location_id
  FROM recipient rc
  JOIN public.email_mailboxes m
    ON lower(m.address) = rc.email
   AND m.active = true
  WHERE m.location_id IS NOT NULL
  ORDER BY rc.dead_letter_id, rc.ord
)
UPDATE public.webhook_dead_letter d
SET location_id = resolved.location_id
FROM resolved
WHERE d.id = resolved.dead_letter_id
  AND d.location_id IS NULL;
