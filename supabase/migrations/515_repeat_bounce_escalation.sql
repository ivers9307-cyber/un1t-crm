-- 515 — GAPS-P5: repeat-bounce escalation + list health.
--
-- WHAT ALREADY WORKS. A HARD bounce is terminal and handled: the Postmark
-- webhook stamps contacts.email_status='bounced' and auto-unsubscribes, and
-- buildAudienceQuery excludes email_status IN ('bounced','complained') from
-- every marketing send. Measured at Stillorgan 2026-08-09: 26 hard-bounce
-- events across 26 contacts, 23 of them flagged. Untouched by this migration.
--
-- WHAT DOES NOT. A SOFT or TRANSIENT bounce is temporary and is correctly NOT
-- suppressed — a full mailbox or a greylisting server is not a dead address,
-- and suppressing on one would be a bug. But nothing escalates REPEATED
-- failure. Same measurement: 102 soft events over 38 contacts, 100 transient
-- over 30, 42 'rejected' over 11 — and 32 contacts that bounced across THREE
-- OR MORE DISTINCT CAMPAIGNS while never once hard-bouncing. Fifteen of those
-- have zero successful deliveries ever: every send made to them bounced.
--
-- WHAT THIS ADDS. An audit trail for escalating that pattern. It does NOT add
-- a second suppression mechanism: the thing that removes a contact from a send
-- is still contacts.email_suppressed_at (mig 395), read by buildAudienceQuery /
-- buildAudienceQueryAsync, by sendEmailStep in sequences, and by
-- host-contact-list's isEmailable. That column is a bare timestamp with
-- nowhere to record WHY, which is the gap this table fills. Suppressing
-- someone with no recoverable reasoning is not acceptable, so the audit row is
-- written first and the stamp second.
--
-- Thresholds live in src/lib/bounce-escalation.js and are deliberately
-- narrower than Mailchimp's (7 soft bounces, no delivery condition): 3+
-- distinct campaigns AND never delivered to. Bounces are counted per CAMPAIGN,
-- not per event — three bounces inside one campaign's retries are one failure.
--
-- Applied by the repeat-bounce-sweep cron (nightly 05:45 UTC, after the 05:15
-- engagement sweep so the two never race the same stamp).

create table email_bounce_escalations (
  id            uuid        primary key default gen_random_uuid(),
  contact_id    uuid        not null references contacts(id) on delete cascade,
  -- REQUIRED. Service-role routes bypass RLS, so this column is the only
  -- tenant boundary the list-health surface has; check:location-scoping also
  -- derives the tenant-table set from it. The sweep takes it from the
  -- contact's own location, falling back to a bounced campaign's location,
  -- and skips the contact entirely rather than guessing.
  location_id   uuid        not null references locations(id),

  -- 'suppress' is acted on. 'review' is RECORDED ONLY: the contact has been
  -- delivered to at some point, so the bounces could be a mailbox that was
  -- full for a stretch. Nothing automatic ever touches a review row.
  decision      text        not null check (decision in ('suppress', 'review')),
  reason        text        not null,

  -- The reasoning, kept so an operator can audit the call without replaying
  -- the query that made it. bounced_campaign_count is the DISTINCT campaign
  -- count the threshold was applied to; bounce_events is the raw event count
  -- and is always >= it.
  bounced_campaign_count int    not null,
  bounced_campaign_ids   uuid[] not null default '{}',
  bounce_types           text[] not null default '{}',
  bounce_events          int    not null default 0,
  successful_deliveries  int    not null default 0,
  first_bounce_at        timestamptz,
  last_bounce_at         timestamptz,
  evaluated_at           timestamptz not null,

  -- Whether contacts.email_suppressed_at was ALREADY set when this decision
  -- landed. The nightly hygiene sweep stamps the same column for inactivity,
  -- so without this an operator releasing a row cannot tell whether the stamp
  -- they are clearing was ours to clear.
  stamp_was_already_set  boolean not null default false,
  suppressed_at          timestamptz,

  -- Release = undo. 'operator' is a human decision and is PERMANENT: the
  -- sweep never re-suppresses that contact. 'stamp_cleared_externally' is the
  -- sweep tidying up after an open/click or a re-consent cleared the stamp,
  -- and does not block a later re-evaluation.
  released_at    timestamptz,
  released_by    uuid references profiles(id),
  release_reason text check (release_reason in ('operator', 'stamp_cleared_externally')),
  release_note   text,

  created_at timestamptz not null default now()
);

-- One live escalation per contact. Also the structural half of idempotence:
-- the sweep checks for an active row before inserting, and this makes a
-- concurrent second run a constraint error rather than a duplicate suppression.
create unique index email_bounce_escalations_active_contact
  on email_bounce_escalations (contact_id)
  where released_at is null;

-- The list-health page: active rows for one location, newest first.
create index email_bounce_escalations_location_active
  on email_bounce_escalations (location_id, decision, created_at desc)
  where released_at is null;

-- The reconcile pass scans active suppressions across all locations.
create index email_bounce_escalations_active_suppressions
  on email_bounce_escalations (contact_id)
  where released_at is null and decision = 'suppress';

create index email_bounce_escalations_contact on email_bounce_escalations (contact_id);

alter table email_bounce_escalations enable row level security;

-- ONE permissive SELECT policy scoped by location (the mig 510 / 487 shape).
-- Deliberately NOT a restrictive FOR ALL USING (false) to "deny writes": that
-- denies SELECT too and fails silently (migs 483/485, gated by
-- check:rls-restrictive). No write policies at all — RLS is default-deny, and
-- the only writers are the sweep and the release route on the service-role
-- client, which bypasses RLS. A staff-writable audit table would let anyone
-- with a session rewrite the reason a contact was suppressed, which defeats
-- the point of having a reason.
create policy email_bounce_escalations_select
  on email_bounce_escalations
  as permissive for select to authenticated
  using (private.auth_is_in_location(location_id));

comment on table email_bounce_escalations is
  'GAPS-P5 (mig 515) — audit trail for repeat soft/transient bounce escalation. decision=suppress means contacts.email_suppressed_at (mig 395) was stamped for this contact and WHY; decision=review is recorded only and never auto-acted on. Written by the repeat-bounce-sweep cron; undone via /api/communications/list-health/[id]/release, which clears the stamp and sets release_reason=operator (permanent — the sweep never re-suppresses that contact).';

comment on column email_bounce_escalations.bounced_campaign_count is
  'DISTINCT campaigns this contact bounced in. The threshold (3, src/lib/bounce-escalation.js) applies to this, not to bounce_events: three bounces inside one campaign are one failed delivery observed three times.';

comment on column email_bounce_escalations.release_reason is
  'operator = a human undid it, permanent (the sweep never re-suppresses that contact). stamp_cleared_externally = the sweep closed the row because contacts.email_suppressed_at had been cleared by an open/click, a re-consent or a manual edit; that contact CAN be re-evaluated.';

-- ── List-health bounce breakdown ────────────────────────────────────
--
-- "How many bounces of each type, over how many people, at this location" —
-- the headline number on the list-health surface. It lives in Postgres
-- because campaign_recipients carries no location_id: the location comes off
-- the campaign, and doing that in the route would mean either a PostgREST
-- embedded filter (which silently breaks head:true counts — CLASSIFY.1) or an
-- unbounded .in('campaign_id', …) over every campaign at the location.
--
-- service_role ONLY, mirroring campaign_link_click_stats (mig 510): the
-- function takes a bare location uuid and does no access check of its own, so
-- granting EXECUTE to authenticated would hand every signed-in user a
-- cross-tenant read straight off /rest/v1/rpc. The caller runs
-- assertLocationAccess first.
create or replace function public.email_bounce_type_summary(p_location_id uuid)
returns table (bounce_type text, events bigint, contacts bigint)
language sql
stable
-- SECURITY INVOKER: the only caller is the service-role client, which
-- bypasses RLS anyway, so DEFINER buys nothing while making a future
-- accidental grant to authenticated a cross-location read.
security invoker
set search_path = public
as $$
  select coalesce(nullif(btrim(lower(r.bounce_type)), ''), 'unknown') as bounce_type,
         count(*)::bigint                     as events,
         count(distinct r.contact_id)::bigint as contacts
    from public.campaign_recipients r
    join public.campaigns c on c.id = r.campaign_id
   where c.location_id = p_location_id
     -- bounce_type, NOT bounced_at. The Postmark webhook writes both, but
     -- campaign-sender's permanent-rejection branch (Postmark 300 invalid
     -- email / 406 inactive recipient) writes status='bounced' and
     -- bounce_type='rejected' with no timestamp. Keying on bounced_at would
     -- report zero rejections while 42 of them sit in the table. The sweep
     -- scans on the same predicate so the two never disagree.
     and r.bounce_type is not null
   group by 1
   order by count(*) desc, 1 asc;
$$;

revoke execute on function public.email_bounce_type_summary(uuid)
  from public, authenticated, anon;
grant execute on function public.email_bounce_type_summary(uuid)
  to service_role;

-- ── Cron heartbeat ─────────────────────────────────────────────────
-- Nightly, generous grace: list hygiene is not urgent, and a missed night
-- changes nothing about who can be mailed. Every cron with a heartbeat row
-- MUST call stampHeartbeat() or it reads as stale while running fine.
insert into cron_heartbeats (name, expected_interval_seconds, grace_seconds)
values ('repeat-bounce-sweep', 86400, 21600)
on conflict (name) do nothing;
