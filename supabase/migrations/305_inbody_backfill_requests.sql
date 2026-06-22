-- INBODY SP2 Phase 2b — on-demand single-member backfill queue.
--
-- The webhook (Phase 1) + enrich (Phase 2a) only capture NEW scans going
-- forward. To pull a member who was scanned BEFORE the integration existed, an
-- operator clicks "Sync InBody" on the contact page; that enqueues a row here.
-- The on-site Pi (the only thing that can call the IP-whitelisted Lookin'Body
-- API) polls GET /api/bridge/inbody/backfill-pending, calls GetDateTimes(phone)
-- → GetFullInBodyData per scan, and relays them to
-- POST /api/bridge/inbody/backfill-ingest, which lands them in inbody_scans and
-- marks this row done.
--
-- Service-role only: the contact page (service-role server render) + the bridge
-- endpoints are the only readers/writers. No authenticated/anon policies —
-- same posture as inbody_webhook_events (mig 284).

create table if not exists public.inbody_backfill_requests (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid references public.contacts(id) on delete cascade,
  phone           text not null,            -- the usertoken to GetDateTimes on
  location_id     uuid references public.locations(id) on delete set null,
  status          text not null default 'pending',  -- pending | done | error
  requested_at    timestamptz not null default now(),
  requested_by    uuid,                     -- profile id of the operator
  processed_at    timestamptz,
  scans_found     integer,                  -- datetimes returned by GetDateTimes
  scans_ingested  integer,                  -- rows actually written to inbody_scans
  error           text
);

-- The Pi drains pending requests oldest-first.
create index if not exists inbody_backfill_requests_pending
  on public.inbody_backfill_requests (requested_at) where status = 'pending';

-- The contact page shows the latest request for a member ("last synced…").
create index if not exists inbody_backfill_requests_contact
  on public.inbody_backfill_requests (contact_id, requested_at desc);

alter table public.inbody_backfill_requests enable row level security;
