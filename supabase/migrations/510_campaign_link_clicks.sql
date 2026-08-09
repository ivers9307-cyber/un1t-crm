-- 510 — COMMSFIX.F.1: per-link click report + the end of the clicked_links
-- read-modify-write.
--
-- WHY NOW. campaign_recipients.clicked_links is a jsonb array that the
-- Postmark processor maintained by select → push → update. That has always
-- been a lost-update race; it never lost anything only because the webhook
-- dedup key collapsed every repeat Click on a message into one event, so at
-- most one Click per message ever reached the processor. COMMSFIX.C narrows
-- that key, repeat Clicks start flowing, and two concurrent Clicks for one
-- message would each read the array, append, and overwrite each other.
--
-- The array is also the wrong shape for the question operators actually ask —
-- "which link did people click?" is a GROUP BY url, and you cannot group
-- across thousands of jsonb arrays. One row per click event fixes both: every click
-- is an INSERT (no read, nothing to lose) and the report is a plain aggregate.
--
-- clicked_links is DEPRECATED, not dropped (repo convention): the data stays
-- on disk and a later migration drops it, so the code can roll back with no
-- DB action. Nothing in src reads it today — only the processor wrote it.

create table campaign_link_clicks (
  id                  uuid        primary key default gen_random_uuid(),
  campaign_id         uuid        not null references campaigns(id) on delete cascade,
  -- Nullable + SET NULL: a click is a historical fact about the campaign and
  -- must survive the contact being deleted. Unique-clicker counts simply stop
  -- attributing those rows (count(distinct contact_id) skips nulls).
  contact_id          uuid        references contacts(id) on delete set null,
  -- REQUIRED. Service-role routes bypass RLS, so the report route's location
  -- filter is the only tenant boundary there is; check:location-scoping also
  -- derives the tenant-table set from this column.
  location_id         uuid        not null references locations(id),
  url                 text        not null,
  clicked_at          timestamptz not null,
  postmark_message_id text,
  created_at          timestamptz not null default now()
);

-- The report's GROUP BY url.
create index campaign_link_clicks_campaign_url on campaign_link_clicks (campaign_id, url);
-- count(distinct contact_id) per campaign.
create index campaign_link_clicks_campaign_contact on campaign_link_clicks (campaign_id, contact_id);
-- Future per-contact click history (and the FK's own lookup).
create index campaign_link_clicks_contact on campaign_link_clicks (contact_id);

alter table campaign_link_clicks enable row level security;

-- ONE permissive SELECT policy, scoped TO authenticated by location — the
-- mig 487 / 440 shape. Deliberately NOT a restrictive FOR ALL USING (false)
-- to "deny writes": that denies SELECT too and fails silently (migs 483/485,
-- gated by check:rls-restrictive).
--
-- No INSERT/UPDATE/DELETE policies at all, which is the same denial with no
-- policy to get wrong and no multiple_permissive_policies noise: RLS is
-- default-deny, the only writer is the Postmark processor on the service-role
-- client (which bypasses RLS), and a staff-writable click table would let
-- anyone with a session fabricate campaign engagement. Same posture as
-- sale_offers / offer_purchases (mig 503).
create policy campaign_link_clicks_select
  on campaign_link_clicks
  as permissive for select to authenticated
  using (private.auth_is_in_location(location_id));

-- ── Report aggregate ────────────────────────────────────────────────
-- Aggregating in the route would hit the 1,000-row select cap on any real
-- campaign as click volume grows (and repeat clicks start flowing again with
-- COMMSFIX.C.2), so the
-- GROUP BY lives in Postgres.
--
-- unique_clickers is the honest headline — one enthusiastic person clicking
-- five times is not five people — with total clicks kept beside it.
--
-- service_role ONLY, mirroring campaign_ab_variant_stats (mig 398): the
-- function takes a bare campaign uuid and does no location check of its own,
-- so granting EXECUTE to authenticated would hand every signed-in user a
-- cross-tenant read by uuid straight off /rest/v1/rpc. The route does the
-- assertLocationAccessOr404 check before it calls this.
create or replace function public.campaign_link_click_stats(p_campaign_id uuid)
returns table (url text, clicks bigint, unique_clickers bigint)
language sql
stable
-- SECURITY INVOKER: the only caller is the service-role client, which bypasses
-- RLS anyway, so DEFINER buys nothing — while a future accidental
-- `grant execute … to authenticated` would become a cross-location IDOR under
-- DEFINER (the class #1307/#1311 just fixed) but still lands on this table's
-- location-scoped SELECT policy under INVOKER.
security invoker
set search_path = public
as $$
  select c.url,
         count(*)::bigint                     as clicks,
         count(distinct c.contact_id)::bigint as unique_clickers
    from public.campaign_link_clicks c
   where c.campaign_id = p_campaign_id
   group by c.url
   order by count(distinct c.contact_id) desc, count(*) desc, c.url asc;
$$;

revoke execute on function public.campaign_link_click_stats(uuid)
  from public, authenticated, anon;
grant execute on function public.campaign_link_click_stats(uuid)
  to service_role;

-- ── Backfill ────────────────────────────────────────────────────────
-- One row per array element. location_id comes off the campaign (the
-- recipient row has none), clicked_at falls back through the recipient's own
-- stamps because the early array entries predate the clicked_at key.
-- jsonb_typeof guards the handful of rows that could hold a non-array, and
-- the cross join lateral drops empty arrays ('[]' is the column default) for
-- free — and most of them ARE empty.
--
-- Verified against prod 2026-08-09 (the earlier "~19,140 rows each holding one
-- entry" reading was wrong: clicked_links DEFAULTS to '[]'::jsonb, so nearly
-- every recipient row is non-null and empty). Actual history: 18,147 empty
-- defaults, 993 recipients carrying at least one click, 23 of those carrying
-- MORE than one (pre-dating the 2026-05-08 dedup key that capped the rest),
-- 218 distinct URLs. **This backfill inserts 1,108 rows** — check that number
-- after applying; a materially different count means the click path changed
-- between this migration being written and applied.
insert into public.campaign_link_clicks (campaign_id, contact_id, location_id, url, clicked_at, postmark_message_id)
select r.campaign_id, r.contact_id, c.location_id,
       e->>'url',
       coalesce((e->>'clicked_at')::timestamptz, r.clicked_at, r.sent_at),
       r.postmark_message_id
  from public.campaign_recipients r
  join public.campaigns c on c.id = r.campaign_id
  cross join lateral jsonb_array_elements(r.clicked_links) e
 where r.clicked_links is not null
   and jsonb_typeof(r.clicked_links) = 'array'
   and e->>'url' is not null;

comment on table campaign_link_clicks is
  'COMMSFIX.F (mig 510) — one row per Postmark Click event. Replaces the campaign_recipients.clicked_links jsonb array (and its read-modify-write). Written only by the Postmark webhook processor on the service-role client; read via campaign_link_click_stats().';

comment on column campaign_recipients.clicked_links is
  'DEPRECATED (mig 510) — superseded by campaign_link_clicks; no longer written. Drop in a later migration.';
