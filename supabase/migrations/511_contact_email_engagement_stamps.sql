-- 511 — GAPS-P1 A: contacts.last_email_open_at / last_email_click_at.
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- THREE places in the app drive contacts.last_email_open_at, and the column
-- has never existed. Verified live against un1t-crm on 2026-08-09: zero
-- columns named last_email_open_at on public.contacts.
--
--   • src/lib/sequences/cron-triggers.js — SIGNAL_FIELDS whitelists
--     'last_email_open_at' as a STORED inactivity signal and queries
--     contacts directly on it (its docstring even asserted the column was
--     stored; that assertion is corrected in the same change as this file).
--   • src/components/sequences/SequenceSettings.jsx — offers "Last email
--     open" to operators in the inactivity-signal dropdown.
--   • src/lib/sequence-templates.js — BOTH packaged win-back templates
--     (win_back_60d, lapsing_member_cascade) default to this signal.
--
-- The failure is not local. selectAll throws on query error and
-- runInactivityTriggers has no inner try/catch, so a single sequence on this
-- signal raises 42703 (undefined_column) out of the WHOLE function; the only
-- catch is at the cron boundary, so the inactivity sweep dies for EVERY
-- sequence at EVERY location with a console.warn as the sole symptom. It arms
-- itself the moment anyone clones either win-back template — the two most
-- obvious templates in the gallery for a gym.
--
-- Removing the signal would leave both templates pointing at something
-- useless: last_emailed_at measures whether WE emailed them, and
-- last_booking_at reads a 26-row table that is consultations, not gym
-- attendance. So the column becomes real. It also unlocks engagement-recency
-- segmentation ("opened in the last 30 days"), which is why both columns are
-- registered as date audience fields in the same change.
--
-- AGREEMENT IS THE POINT
-- ──────────────────────
-- The backfill below takes max(opened_at) per contact from email_sends. The
-- Postmark webhook (postmark-webhook-processor.js) then stamps the contact on
-- every Open with the SAME timestamp it writes to email_sends.opened_at. Those
-- are the same quantity only if neither side can move the stamp BACKWARDS:
--
--   • the stamp RPCs below only write when the new timestamp is strictly
--     later (or the column is NULL), so a replayed / late-arriving event, or
--     two Open events racing on one contact, can never regress it;
--   • the backfill writes GREATEST(existing, computed) — GREATEST ignores
--     NULLs in Postgres — so it is a plain assignment on a virgin column and
--     still cannot regress a stamp if this migration is ever re-run after the
--     webhook has started writing.
--
-- A stamp that went backwards would make "opened in the last 30 days" quietly
-- wrong: no error, no log line, just a smaller audience than the truth.
--
-- The stamp is deliberately NOT FirstOpen-gated (unlike mig 508's
-- increment_contact_opens, which counts unique opens). email_sends.opened_at
-- is rewritten on EVERY Open event, so max(opened_at) tracks every open, and
-- the webhook must stamp on every open for the two to stay equal.

-- ─── 1. The columns ────────────────────────────────────────────────────────

alter table public.contacts
  add column if not exists last_email_open_at  timestamptz,
  add column if not exists last_email_click_at timestamptz;

comment on column public.contacts.last_email_open_at is
  'GAPS-P1 (mig 511) — most recent Postmark Open for this contact = max(email_sends.opened_at). Maintained by public.stamp_contact_email_open() from the Postmark webhook; monotonic (never moves backwards). Registered audience field + the inactivity cron''s last_email_open_at signal.';
comment on column public.contacts.last_email_click_at is
  'GAPS-P1 (mig 511) — most recent Postmark Click for this contact = max(email_sends.clicked_at). Maintained by public.stamp_contact_email_click() from the Postmark webhook; monotonic (never moves backwards). Registered audience field.';

-- Plain btree, not partial. `is empty` / `is not empty` are registered ops for
-- date audience fields, and a btree indexes NULLs — a
-- `where last_email_open_at is not null` partial index would be smaller
-- (~6,400 of 8,568 contacts are NULL today) but could not serve them.

create index if not exists idx_contacts_last_email_open_at  on public.contacts (last_email_open_at);
create index if not exists idx_contacts_last_email_click_at on public.contacts (last_email_click_at);

-- ─── 2. The maintenance RPCs ───────────────────────────────────────────────
--
-- Mirrors mig 508's style: language sql, one minimal UPDATE, search_path
-- pinned to '' with every object schema-qualified (function_search_path_mutable
-- advisor), SECURITY INVOKER (the default) because the only caller is the
-- service-role client.
--
-- The guard lives in SQL rather than in the processor on purpose: it is then
-- atomic against a concurrent webhook worker, and it cannot be lost by a later
-- edit to the JS. Arg names are load-bearing — PostgREST resolves rpc
-- arguments BY NAME, so p_contact_id / p_at must match the call sites verbatim.

create or replace function public.stamp_contact_email_open(p_contact_id uuid, p_at timestamptz)
returns void language sql set search_path = '' as $$
  update public.contacts
     set last_email_open_at = p_at
   where id = p_contact_id
     and (last_email_open_at is null or last_email_open_at < p_at);
$$;

create or replace function public.stamp_contact_email_click(p_contact_id uuid, p_at timestamptz)
returns void language sql set search_path = '' as $$
  update public.contacts
     set last_email_click_at = p_at
   where id = p_contact_id
     and (last_email_click_at is null or last_email_click_at < p_at);
$$;

comment on function public.stamp_contact_email_open(uuid, timestamptz) is
  'GAPS-P1 (mig 511) — monotonic stamp of contacts.last_email_open_at. Writes only when p_at is strictly later than the stored value (or it is NULL), so a replayed or late-arriving Postmark event can never move the stamp backwards. Called by the Postmark Open handler on EVERY open. service_role only.';
comment on function public.stamp_contact_email_click(uuid, timestamptz) is
  'GAPS-P1 (mig 511) — monotonic stamp of contacts.last_email_click_at. Same never-backwards guard as stamp_contact_email_open. Called by the Postmark Click handler on EVERY click. service_role only.';

-- ─── 3. Grants ─────────────────────────────────────────────────────────────
--
-- Postgres grants EXECUTE to PUBLIC by default, and nothing web-facing should
-- be able to move a contact's engagement recency (it drives who gets swept
-- into a win-back sequence).

revoke execute on function public.stamp_contact_email_open(uuid, timestamptz)  from public, anon, authenticated;
revoke execute on function public.stamp_contact_email_click(uuid, timestamptz) from public, anon, authenticated;
grant  execute on function public.stamp_contact_email_open(uuid, timestamptz)  to service_role;
grant  execute on function public.stamp_contact_email_click(uuid, timestamptz) to service_role;

-- ─── 4. One-time backfill from email_sends ─────────────────────────────────
--
-- email_sends has carried the truth all along (19,206 rows, opened_at /
-- clicked_at per send). Expected against prod as measured 2026-08-09:
--   • 2,183 contact rows updated
--   • 2,177 receive a last_email_open_at
--   •   317 receive a last_email_click_at
-- (6 contacts carry a click but no open — Postmark click tracking without a
-- recorded open — which is why the two counts do not nest.)
--
-- Only contacts WITH email_sends rows are touched, and only where the value
-- actually changes, so re-running this migration writes nothing.

with agg as (
  select contact_id,
         max(opened_at)  as last_open,
         max(clicked_at) as last_click
    from public.email_sends
   where contact_id is not null
   group by contact_id
)
update public.contacts c
   set last_email_open_at  = greatest(c.last_email_open_at, agg.last_open),
       last_email_click_at = greatest(c.last_email_click_at, agg.last_click)
  from agg
 where c.id = agg.contact_id
   and (agg.last_open is not null or agg.last_click is not null)
   and (c.last_email_open_at  is distinct from greatest(c.last_email_open_at,  agg.last_open)
     or c.last_email_click_at is distinct from greatest(c.last_email_click_at, agg.last_click));
