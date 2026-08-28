-- MAIL-SEARCH.1 — full-text search for the Mail surface.
-- Extends mig 394 (email_inbox_messages).
--
-- ══ WHY A GENERATED COLUMN AND NOT A QUERY-TIME to_tsvector ═════════
-- Not about index usage — an EXPRESSION INDEX is index-backed whenever the
-- predicate repeats the expression verbatim, so a query-time to_tsvector()
-- call CAN use an index. The real reason is PostgREST: the client library's
-- .textSearch() (used by src/app/api/email/mail/_search.js) can only target a
-- REAL COLUMN by name. An expression index has no column to name it by, so
-- search over an expression would have to go through an RPC or a view
-- instead of the ordinary REST filter path every other list route already
-- uses. STORED + GIN keeps search on that same path. The column is derived,
-- never written by the application, and cannot drift from its source.
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
-- ══ 🔴 THE BODY IS BOUNDED, AND THE BOUND MUST STAY INSIDE THE EXPRESSION ═══
-- tsvector has a hard 1,048,575-byte ceiling. Past it, to_tsvector raises
-- "ERROR: string is too long for tsvector" — and because this column is
-- GENERATED, that error fires when the SOURCE ROW IS WRITTEN, not when
-- someone later searches. Search does not "miss" an oversized message; the
-- message CANNOT BE STORED at all.
--
-- The Postmark inbound webhook writes text_body UNCAPPED
-- (src/app/api/webhooks/postmark-inbound/[token]/route.js:868), so this is
-- reachable: a ~1MB machine-generated email would fail the webhook write,
-- retry, and dead-letter — on a mail connector whose whole premise is not
-- losing mail. (The IMAP poller already caps bodies at 300,000 chars —
-- src/lib/mail/imap-poll.js:862 — so this specific failure mode is
-- Postmark-only today, not IMAP.)
--
-- left(coalesce(text_body,''), 100000) bounds the indexed body to 100,000
-- CHARACTERS, which is at most 400,000 bytes even at the worst-case 4
-- bytes/char for UTF-8 — comfortably under the 1,048,575-byte ceiling with
-- headroom left for subject and from_email in the same vector.
--
-- This is the trade GENERATED makes. A TRIGGER-maintained column could clamp
-- the value or catch the error and fall back; a GENERATION EXPRESSION cannot —
-- its failure IS the source row's write failing, with no app-side escape
-- hatch downstream of it. So the bound has to live inside the expression
-- itself. Removing this bound later is another full table rewrite (the same
-- shape as adding the column was) — raise it deliberately, with a migration,
-- not by deleting the left() and finding out at the next oversized email.
--
-- ══ 🔴 SENDER SEARCH: RAW ADDRESS PLUS A SPLIT FORM ══════════════════
-- Postgres's default parser classifies `richard@example.com` as a SINGLE
-- `email` token and does not split it on '@' or '.', so searching a member's
-- NAME would never match their address — "richard" alone would not find
-- richard@example.com. The expression carries from_email TWICE: once raw (so
-- the full address still matches exactly) and once with '@' replaced by a
-- space (so the local part and the domain tokenize separately and a name
-- search can hit it).
--
-- ══ KNOWN LIMITATIONS OF THE HARD-CODED 'english' CONFIG ═════════════
-- Changing the config later is the same full rewrite this migration already
-- is, plus a GIN rebuild — so the caveats belong here now, not discovered
-- later at search time:
--   • NO unaccent. The extension is not installed on this project, so
--     "Siobhan" will never match "Siobhán". This is a stated, known
--     limitation — do NOT enable an extension inside this migration to close
--     it; that is a separate decision with its own review.
--   • English stopwords swallow real terms. websearch_to_tsquery('english',
--     'will') returns an EMPTY tsquery, so a member named Will is unfindable
--     by first name alone. Stemming also produces false positives on
--     surnames — "Downes" stems to `down`, which then also matches messages
--     that merely contain the unrelated word "down".
--
-- ══ OPERATIONAL NOTES ════════════════════════════════════════════════
--   • The QUERY SIDE MUST PIN THE SAME 'english' CONFIG. A bare
--     websearch_to_tsquery(term) with no config argument reads
--     default_text_search_config AT RUNTIME and will silently degrade (or
--     stop matching this column's fixed config) if that server setting ever
--     changes. Always call websearch_to_tsquery('english', term).
--   • email_inbox_messages IS IN THE supabase_realtime PUBLICATION, so every
--     insert now carries this tsvector through logical decoding out to every
--     subscriber — including ones that never read search_tsv. That is
--     accepted row-size overhead, not a bug to fix here.
--   • Adding a STORED generated column REWRITES the table. Today that is 43
--     rows / 448 kB, i.e. instant. It will not always be; if this ever has to
--     be redone at scale, do it as add-nullable → backfill in batches → swap.
--     The GIN index below is built by a plain CREATE INDEX — not
--     CONCURRENTLY — and holds a write lock on the table for the duration;
--     that is unavoidable inside apply_migration's single transaction, which
--     is one more reason any future rework should be add-nullable → backfill
--     → swap rather than an in-place ALTER.

ALTER TABLE public.email_inbox_messages
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(subject, '') || ' ' ||
      coalesce(from_email, '') || ' ' ||
      replace(coalesce(from_email, ''), '@', ' ') || ' ' ||
      left(coalesce(text_body, ''), 100000)
    )
  ) STORED;

COMMENT ON COLUMN public.email_inbox_messages.search_tsv IS
  'MAIL-SEARCH.1: full-text index over subject + from_email (raw AND @-split) + text_body (bounded to its first 100,000 chars). GENERATED, so nothing writes it and it cannot drift. html_body is excluded on purpose — it is markup, and indexing it buries real words under tags and inline CSS. 🔴 text_body is wrapped in left(…,100000) because tsvector has a 1,048,575-byte ceiling and this is a GENERATED column: exceeding it fails the INSERT/UPDATE that wrote the row, not just a later search (the Postmark webhook writes text_body uncapped). from_email appears twice — raw for exact-address matches, and with ''@'' replaced by a space because the default parser treats an address as one token and a name search would otherwise never match it. 🔴 The two-argument to_tsvector is required: the one-argument form is not IMMUTABLE and Postgres will refuse it in a generated column. The query side must pin websearch_to_tsquery(''english'', …) to match this column''s fixed config. Known gaps: no unaccent (not installed on this project) and English stopwords swallow short common names (e.g. "Will"). Searching is scoped by the LIST ROUTE, never by this column — see src/app/api/email/mail/_search.js.';

-- GIN is the right index for a tsvector that is read far more than written.
-- Named idx_email_msg_search_gin to match this table's existing neighbours
-- (idx_email_msg_location, mig 394; idx_email_msg_ticket, mig 482).
CREATE INDEX IF NOT EXISTS idx_email_msg_search_gin
  ON public.email_inbox_messages USING gin (search_tsv);

-- ══ WHAT IS DELIBERATELY NOT HERE: A (location_id, ticket_id) INDEX ═══
-- An earlier draft of this migration added one. Removed, because it was
-- speculative rather than earned by a real query plan:
--   • ticket_id here is PROJECTED, not joined — it comes off the heap tuple
--     after a bitmap heap scan, not through an index lookup, so a composite
--     index carrying it buys the query plan nothing extra.
--   • location_id has a cardinality of TWO on this table. The planner will
--     not choose a BitmapAnd against a two-value column; it is nowhere near
--     selective enough to be worth combining with anything.
--   • It is already largely covered by the two existing indexes on this
--     table: idx_email_msg_location (location_id, mig 394) and
--     idx_email_msg_ticket (ticket_id, created_at, mig 482).
--   • It contradicts mig 575's own stated rule: don't add an index before
--     its query exists, measured. This one had no query driving it either.
