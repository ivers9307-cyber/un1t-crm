-- MAIL-SEARCH.1 — full-text search for the Mail surface.
-- Extends mig 394 (email_inbox_messages).
--
-- ══ WHY A GENERATED COLUMN AND NOT A QUERY-TIME to_tsvector ═════════
-- A to_tsvector() computed per row per query cannot use an index, so every
-- search would be a sequential scan over every message body in the estate.
-- STORED + GIN makes it an index lookup. The column is derived, never written
-- by the application, and cannot drift from its source.
--
-- 🔴 THE 2-ARGUMENT FORM IS LOAD-BEARING. `to_tsvector(text)` (one arg) reads
-- default_text_search_config at run time and is therefore NOT IMMUTABLE, and
-- Postgres refuses a non-immutable expression in a generated column with a
-- confusing "generation expression is not immutable". `to_tsvector('english',
-- text)` pins the config, is immutable, and is the only form that works here.
--
-- 🔴 html_body IS DELIBERATELY EXCLUDED. It is markup — tags, inline CSS,
-- tracking-pixel URLs, base64 — and indexing it would fill the vector with
-- lexemes no operator will ever type while making every row's index entry many
-- times larger. text_body carries the words a human wrote.
--
-- Adding a STORED generated column REWRITES the table. Today that is 43 rows /
-- 448 kB, i.e. instant. It will not always be; if this ever has to be redone at
-- scale, do it as add-nullable → backfill in batches → swap.

ALTER TABLE public.email_inbox_messages
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(subject, '') || ' ' ||
      coalesce(from_email, '') || ' ' ||
      coalesce(text_body, '')
    )
  ) STORED;

COMMENT ON COLUMN public.email_inbox_messages.search_tsv IS
  'MAIL-SEARCH.1: full-text index over subject + from_email + text_body, for the Mail surface search box. GENERATED, so nothing writes it and it cannot drift. html_body is excluded on purpose — it is markup, and indexing it buries real words under tags and inline CSS. 🔴 The two-argument to_tsvector is required: the one-argument form is not IMMUTABLE and Postgres will refuse it in a generated column. Searching is scoped by the LIST ROUTE, never by this column — see src/app/api/email/mail/_search.js.';

-- GIN is the right index for a tsvector that is read far more than written.
CREATE INDEX IF NOT EXISTS email_inbox_messages_search_tsv_gin
  ON public.email_inbox_messages USING gin (search_tsv);

-- The search resolves messages to their conversation and the route then filters
-- those ids through its own scope query, so this supporting index is on the
-- join column, scoped by location to match how it is always read.
CREATE INDEX IF NOT EXISTS email_inbox_messages_location_ticket_idx
  ON public.email_inbox_messages (location_id, ticket_id)
  WHERE ticket_id IS NOT NULL;
