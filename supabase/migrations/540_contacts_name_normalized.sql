-- 540 — normalised contact name, for safe Instagram auto-linking (IG-LINK.2).
--
-- Why: IG-LINK auto-links a thread when the Instagram display name matches
-- EXACTLY ONE contact. The first cut narrowed candidates with
-- `name ILIKE '<display name>'` — raw string equality — while the
-- "exactly one" test ran on JS-normalised names. Those disagree: "Sean
-- Byrne" and "Seán Byrne" are one normalised name but two raw strings, so
-- SQL returned a single row and the ambiguity guard saw a false unique and
-- auto-linked. Against prod that split 39 duplicate-name groups (31 by
-- accent, 8 by punctuation) — precisely the twins the guard exists to catch.
--
-- Fix: normalise on the SQL side too, so the database is the single
-- authority on "which contacts share this name" and the count is taken over
-- the true set. Mirrors normalizeName() in src/lib/instagram-contact-link.js:
-- fold accents, lowercase, punctuation to spaces, collapse and trim.
-- The translate() list covers exactly the characters JS NFKD decomposes
-- (accented Latin letters); anything else — ø, ł, đ, non-Latin scripts — is
-- stripped by both sides alike, and any residual disagreement can only make
-- the lookup return NOTHING (no auto-link, manual path), never a false unique.
--
-- Generated + indexed rather than trigger-maintained: every function used is
-- IMMUTABLE, so Postgres keeps it correct with no code path to forget.
alter table contacts
  add column if not exists name_normalized text
  generated always as (
    btrim(
      regexp_replace(
        translate(
          lower(coalesce(name, '')),
          'áàâäãåéèêëíìîïóòôöõúùûüýñçšžćčń',
          'aaaaaaeeeeiiiiooooouuuuyncszccn'
        ),
        '[^a-z0-9]+', ' ', 'g'
      )
    )
  ) stored;

comment on column contacts.name_normalized is
  'Accent/case/punctuation-folded contacts.name, generated. Mirrors normalizeName() in src/lib/instagram-contact-link.js so Instagram auto-linking counts same-name duplicates over the TRUE set (IG-LINK.2, mig 540). Read-only — never write it.';

-- Serves the auto-link lookup: equality on (location_id, name_normalized).
-- Without it the resolver seq-scanned contacts on every inbound DM.
create index if not exists idx_contacts_location_name_normalized
  on contacts (location_id, name_normalized)
  where name_normalized <> '';
