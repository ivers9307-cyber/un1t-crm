-- MAIL-SEARCH.4 — the sender split in mig 576 only half-worked.
-- Supersedes the generated expression added by mig 576 (same column, same index).
--
-- ══ WHAT WAS WRONG ══════════════════════════════════════════════════
-- Mig 576 indexed `from_email` twice: raw, and with `@` replaced by a space,
-- so that searching a member's NAME would match their address. The reasoning
-- was right and the implementation was half a fix, because Postgres's default
-- parser does not break on `.` either — it classifies a dotted local part as a
-- single `file`/`host` token.
--
-- Verified on this database (PG 17.6). For `john.smith@acmegym.com` the mig 576
-- expression produces exactly:
--
--     'acmegym.com':3  'john.smith':2  'john.smith@acmegym.com':1
--
-- so an operator searching `smith` matches NOTHING. So does `john`. So does
-- `acmegym`. Every one of those is false, which is precisely the gap the double
-- indexing existed to close — and `first.last@` is the ordinary shape of a
-- corporate address, not an edge case.
--
-- ══ THE FIX ═════════════════════════════════════════════════════════
-- `translate(from_email, '@._-+', '     ')` — map every separator that appears
-- in an address to a space, not just `@`. The same three probes then match.
-- `translate` is IMMUTABLE (checked in pg_proc), so it is legal in a generated
-- column; `to_tsvector` stays the 2-argument form for the reason mig 576 gives
-- at length.
--
-- The RAW address is still indexed alongside it, so pasting a full address in
-- still matches it exactly. Both forms, as before.
--
-- ══ WHY THIS IS A DROP AND RE-ADD ═══════════════════════════════════
-- Postgres has no way to ALTER the expression of a generated column, so
-- changing it means dropping and re-adding — which also drops the dependent
-- GIN index, recreated below.
--
-- 🔴 This is still forward-only. `search_tsv` is DERIVED, holds no data of its
-- own, and is repopulated in full by the re-add; nothing has ever written to it
-- and no deployed code reads it yet (mig 576 was applied minutes ago, ahead of
-- a branch that has not merged). Dropping it loses nothing and cannot be
-- observed. That would NOT be true of a column carrying real values, and this
-- migration is not a licence to drop one.
--
-- Cost today: 43 rows / 448 kB, so the rewrite and the index build are instant.
-- At scale this is the expensive shape mig 576 warned about — which is the
-- argument for getting the expression right while the table is still empty,
-- rather than discovering the gap after a year of mail.

ALTER TABLE public.email_inbox_messages
  DROP COLUMN IF EXISTS search_tsv;

ALTER TABLE public.email_inbox_messages
  ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(subject, '') || ' ' ||
      -- Raw, so a pasted full address still matches exactly…
      coalesce(from_email, '') || ' ' ||
      -- …and separator-split, so a name or a company matches too.
      translate(coalesce(from_email, ''), '@._-+', '     ') || ' ' ||
      -- 🔴 BOUNDED. tsvector has a 1,048,575-BYTE ceiling and this column is
      -- GENERATED, so exceeding it fails the INSERT that wrote the ROW, not a
      -- later search. The Postmark webhook writes text_body uncapped. See mig
      -- 576 for the full reasoning; the bound is in characters and the ceiling
      -- is in bytes, so 100k chars leaves ~10x headroom even for 4-byte UTF-8.
      left(coalesce(text_body, ''), 100000)
    )
  ) STORED;

COMMENT ON COLUMN public.email_inbox_messages.search_tsv IS
  'MAIL-SEARCH.4 (was MAIL-SEARCH.1, mig 576): full-text index over subject + from_email (raw AND separator-split) + text_body (first 100,000 chars). GENERATED, so nothing writes it and it cannot drift. html_body is excluded — it is markup, and indexing it buries real words under tags and inline CSS. 🔴 from_email is split with translate(…, ''@._-+'', ''     ''), NOT just on ''@'': Postgres''s parser does not break on ''.'' either, so mig 576''s @-only split still produced ''john.smith'' as one lexeme and a search for ''smith'' matched nothing — verified on this database. 🔴 text_body is bounded because the tsvector ceiling is enforced at INSERT time on a generated column, and the Postmark webhook writes it uncapped. 🔴 The two-argument to_tsvector is required: the one-argument form is not IMMUTABLE. The query side must pin websearch_to_tsquery(''english'', …). Known gaps: no unaccent (not installed), and English stopwords swallow short common names (a member named "Will" is unfindable — the surface echoes the typed query back rather than claiming the mail is not there). Searching is scoped by the LIST ROUTE, never by this column — see src/app/api/email/mail/_search.js.';

CREATE INDEX IF NOT EXISTS idx_email_msg_search_gin
  ON public.email_inbox_messages USING gin (search_tsv);
