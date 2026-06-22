-- INBODY SP2 (ingestion bootstrap) — staging log of InBody / Lookin'Body
-- WebAPI webhook notifications.
--
-- The InBody webhook is a NOTIFY, not the data: each completed scan POSTs
-- { EquipSerial, TelHP (phone), UserID, TestDatetimes (YYYYMMDDHHMMSS),
--   Account, Equip, Type, IsTempData } — NO measurements. We capture every
-- notification here (matched to a contact or not), then a later enrich step
-- pulls the actual body-composition data from the Lookin'Body REST API into
-- the existing `inbody_scans` table (mig 272).
--
-- Service-role only: the webhook handler + future enrich cron use the
-- service-role client (RLS-bypassing). No authenticated/anon policies —
-- intentional, same posture as rate_limit_buckets.

create table if not exists public.inbody_webhook_events (
  id                 uuid primary key default gen_random_uuid(),
  received_at        timestamptz not null default now(),
  account            text,
  tel_hp             text,
  user_id            text,
  test_datetime      text,          -- raw YYYYMMDDHHMMSS from the payload
  equip              text,
  equip_serial       text,
  is_temp_data       boolean,
  payload            jsonb not null, -- full raw notification (safety net)
  matched_contact_id uuid references public.contacts(id) on delete set null,
  location_id        uuid references public.locations(id) on delete set null,
  processed          boolean not null default false,  -- scan pulled into inbody_scans?
  processed_at       timestamptz
);

-- Idempotent capture: a re-sent notification collides here (DO NOTHING upsert).
-- Non-partial so ON CONFLICT can target it; NULLs are distinct in PG, so
-- malformed (null-field) notifications simply aren't de-duped.
create unique index if not exists inbody_webhook_events_dedup
  on public.inbody_webhook_events (account, user_id, test_datetime);

-- Enrich cron picks up un-pulled notifications oldest-first.
create index if not exists inbody_webhook_events_unprocessed
  on public.inbody_webhook_events (received_at) where processed = false;

create index if not exists inbody_webhook_events_contact
  on public.inbody_webhook_events (matched_contact_id) where matched_contact_id is not null;

alter table public.inbody_webhook_events enable row level security;
