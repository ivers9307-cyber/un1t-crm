-- 508 — COMMSFIX.C.3: the contact engagement counter RPCs that never existed.
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- src/lib/postmark-webhook-processor.js has called
--   db.rpc('increment_contact_opens',  { p_contact_id })   (Open, FirstOpen-gated)
--   db.rpc('increment_contact_clicks', { p_contact_id })   (Click)
-- for months. NEITHER FUNCTION EXISTS in the database — a live pg_proc query
-- against un1t-crm confirmed it, and mig 314 only ever mentioned them in a
-- comment. The failure was doubly silent: the calls sat inside `try { await }
-- catch {}`, and supabase-js reports PostgREST/Postgres errors in the RESULT
-- object rather than by throwing, so the catch was not even the layer doing the
-- hiding.
--
-- The damage is operator-facing, not cosmetic. contacts.total_emails_opened and
-- total_emails_clicked (mig 005) are registered AUDIENCE FILTER FIELDS
-- ('Emails Opened' / 'Emails Clicked' in AudienceBuilder). Frozen at 0, an
-- "Emails Clicked > 0" engaged-member audience matches NOBODY, and an
-- "Emails Opened = 0" re-engagement audience sweeps in the ~1,900 contacts who
-- actually do open — a wrong send with no error anywhere.
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
--   1. Creates the two functions, mirroring mig 314's atomic-counter style:
--      language sql, one minimal UPDATE, COALESCE on the counter (the columns
--      are nullable-with-default, so a bare `col + 1` on a NULL would silently
--      lose the increment), search_path pinned to '' with every object
--      schema-qualified (function_search_path_mutable advisor), and SECURITY
--      INVOKER (the default) because the only caller is the service-role client.
--      Dedup / idempotency stays in the caller, exactly as mig 314 states:
--      increment_contact_opens is FirstOpen-gated in the processor.
--   2. Locks execution down to service_role. Postgres grants EXECUTE to PUBLIC
--      by default, and nothing web-facing should be able to move a contact's
--      engagement counters.
--   3. Backfills both columns from email_sends, which has carried the truth all
--      along (opened_at / clicked_at per send).
--
-- Arg names are load-bearing: PostgREST resolves rpc arguments BY NAME, so
-- p_contact_id must match the processor's call sites verbatim.

-- ─── 1. The functions ──────────────────────────────────────────────────────

create or replace function public.increment_contact_opens(p_contact_id uuid)
returns void language sql set search_path = '' as $$
  update public.contacts
     set total_emails_opened = coalesce(total_emails_opened, 0) + 1
   where id = p_contact_id;
$$;

create or replace function public.increment_contact_clicks(p_contact_id uuid)
returns void language sql set search_path = '' as $$
  update public.contacts
     set total_emails_clicked = coalesce(total_emails_clicked, 0) + 1
   where id = p_contact_id;
$$;

comment on function public.increment_contact_opens(uuid) is
  'COMMSFIX.C.3 (mig 508) — atomic +1 on contacts.total_emails_opened. Called by the Postmark Open handler, FirstOpen-gated (unique opens). service_role only.';
comment on function public.increment_contact_clicks(uuid) is
  'COMMSFIX.C.3 (mig 508) — atomic +1 on contacts.total_emails_clicked. Called by the Postmark Click handler. service_role only.';

-- ─── 2. Grants ─────────────────────────────────────────────────────────────

revoke execute on function public.increment_contact_opens(uuid)  from public, anon, authenticated;
revoke execute on function public.increment_contact_clicks(uuid) from public, anon, authenticated;
grant  execute on function public.increment_contact_opens(uuid)  to service_role;
grant  execute on function public.increment_contact_clicks(uuid) to service_role;

-- ─── 3. One-time backfill from email_sends ─────────────────────────────────
--
-- email_sends is the source of truth the counters should always have tracked.
-- Counting DISTINCT SENDS with a non-null stamp (not summing open_count) is
-- deliberate and matches what the two audience fields mean to an operator:
-- "how many of our emails has this person opened", one per email. It also
-- sidesteps open_count/click_count being capped at 1 since 2026-05-08 by the
-- over-broad webhook dedup key that COMMSFIX.C.2 has just narrowed.
--
-- Only contacts WITH email_sends rows are touched. Verified against prod
-- before applying (2026-08-09): 222 contacts carry a non-zero counter today
-- (all capped at 1 — a legacy partial write, not these RPCs, which have never
-- existed), and EVERY ONE of them has email_sends rows, so the join reaches
-- all of them; 194 get a corrected value and the rest already match. No
-- contact holds stale non-zero counters outside the join, so there is nothing
-- for a wider UPDATE to clear, and writing zeros over ~6,400 contacts that
-- already hold zero is pure churn.

with agg as (
  select contact_id,
         count(*) filter (where opened_at  is not null) as opens,
         count(*) filter (where clicked_at is not null) as clicks
    from public.email_sends
   where contact_id is not null
   group by contact_id
)
update public.contacts c
   set total_emails_opened  = agg.opens,
       total_emails_clicked = agg.clicks
  from agg
 where c.id = agg.contact_id
   and (coalesce(c.total_emails_opened,  0) is distinct from agg.opens
     or coalesce(c.total_emails_clicked, 0) is distinct from agg.clicks);
