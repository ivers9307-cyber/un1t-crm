-- WAPHONE-BACKFILL.2 — pin the search_path on private.wa_phone_from_phone.
--
-- Advisor `function_search_path_mutable` (WARN) after mig 525: a function
-- with a role-mutable search_path can be made to resolve an unqualified name
-- against an attacker-controlled schema. Harmless here in practice (the body
-- only calls built-ins), but the fix is free and the advisor should stay
-- clean so a real finding is not lost in noise.
--
-- Empty search_path is safe: pg_catalog is always searched implicitly, and
-- every call in the body (regexp_replace, substring, length, btrim) is a
-- built-in. No schema-qualified user objects are referenced.

alter function private.wa_phone_from_phone(text) set search_path = '';
