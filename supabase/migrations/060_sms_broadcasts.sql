-- 060 — SMS broadcasts + recipients
--
-- Phase 2 of the multi-location SMS rollout (mig 059 was Phase 1 —
-- per-location alpha sender ID + ad-hoc send from contact profile).
-- This adds one-shot broadcasts: pick an audience, type a message,
-- send (or schedule).
--
-- Mirrors whatsapp_broadcasts (mig 007) so the operator mental model
-- is the same across channels. Differences vs WA:
--   - body is freeform text, not a Meta-approved template
--   - no delivered/read columns — alpha sender IDs in IE/UK/EU are
--     send-only, and Twilio's delivery receipts for them are
--     unreliable across carriers, so we just track sent vs failed
--   - links to contacts.phone + filters by contacts.sms_status
--     (introduced in mig 059), not wa_phone / wa_status
--
-- The send path lives in src/lib/sms.js#sendBroadcast and goes
-- through sendLocationSms() so the per-location alpha sender ID
-- is honoured.

-- ============================================================
-- sms_broadcasts — one row per broadcast (draft/sending/sent/cancelled)
-- ============================================================
create table sms_broadcasts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  name text not null,

  -- Freeform message body (with merge-tag support — same set as
  -- email/whatsapp/ad-hoc SMS: {{first_name}}, {{name}},
  -- {{location_name}}, etc.). Hard cap at 1600 chars (~10 SMS
  -- segments) to prevent runaway sends.
  body text not null check (char_length(body) between 1 and 1600),

  -- Audience filter (same shape as email campaigns and WA broadcasts —
  -- the whitelisted JSONB filter format applied via applyAudienceFilter).
  audience_filter jsonb not null default '{"filters": [], "logic": "and"}'::jsonb,

  -- Status workflow.
  --   draft     — being composed; not yet sent.
  --   sending   — runner has picked it up and is processing recipients.
  --   sent      — finished (some recipients may have failed; see metrics).
  --   cancelled — admin abandoned a draft.
  status text not null default 'draft'
    check (status in ('draft', 'sending', 'sent', 'cancelled')),

  -- Scheduling. scheduled_at is the desired send time (NULL = "send
  -- now" once POST /send is hit). sent_at stamps the actual moment
  -- the runner finished iterating recipients.
  scheduled_at timestamptz,
  sent_at timestamptz,

  -- Metrics. Lighter than WA — alpha senders are send-only and
  -- delivery receipts in IE/UK/EU aren't reliable enough to surface.
  total_recipients int not null default 0,
  total_sent int not null default 0,
  total_failed int not null default 0,

  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table sms_broadcasts is
  'One-shot SMS sends to a filtered audience. Phase 2 of the multi-location SMS rollout (mig 059 was foundation). Mirrors whatsapp_broadcasts but for freeform SMS over Twilio with per-location alpha sender ID.';

create index sms_broadcasts_location_idx on sms_broadcasts (location_id);
create index sms_broadcasts_status_idx on sms_broadcasts (status)
  where status in ('draft', 'sending');

-- ============================================================
-- sms_broadcast_recipients — per-contact send result
-- ============================================================
-- Mirrors whatsapp_broadcast_recipients. One row per recipient,
-- per broadcast. Lets the detail page show "8 of 10 succeeded; here's
-- the 2 failures" without an extra round-trip.
create table sms_broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references sms_broadcasts(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,

  -- Twilio message SID (from the Messages.json POST response).
  -- NULL until the send attempt completes; populated for sent rows,
  -- absent for failed rows.
  twilio_message_sid text,

  -- pending  — row inserted but send not yet attempted (rare; only
  --            during a paused or partially-failed send).
  -- sent     — Twilio accepted the message.
  -- failed   — Twilio rejected (error_message captures the cause).
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  error_message text,

  sent_at timestamptz,
  failed_at timestamptz,

  created_at timestamptz not null default now(),

  unique (broadcast_id, contact_id)
);

create index sms_broadcast_recipients_broadcast_idx
  on sms_broadcast_recipients (broadcast_id);
create index sms_broadcast_recipients_contact_idx
  on sms_broadcast_recipients (contact_id);

-- ============================================================
-- RLS
-- ============================================================
-- Same per-location policy pattern as whatsapp_broadcasts /
-- whatsapp_broadcast_recipients. Authenticated users see only
-- broadcasts at their assigned locations. Master sees everything
-- via the auth_is_master OR-short.
alter table sms_broadcasts enable row level security;
alter table sms_broadcast_recipients enable row level security;

create policy sms_broadcasts_select_at_location
  on sms_broadcasts for select to authenticated
  using (private.auth_is_in_location(location_id));

create policy sms_broadcasts_insert_at_location
  on sms_broadcasts for insert to authenticated
  with check (private.auth_is_in_location(location_id));

create policy sms_broadcasts_update_at_location
  on sms_broadcasts for update to authenticated
  using (private.auth_is_in_location(location_id))
  with check (private.auth_is_in_location(location_id));

create policy sms_broadcasts_delete_at_location
  on sms_broadcasts for delete to authenticated
  using (private.auth_is_in_location(location_id));

-- Recipients inherit through the broadcast — no direct location_id
-- column, so the policies join via broadcast_id.
create policy sms_broadcast_recipients_select_at_location
  on sms_broadcast_recipients for select to authenticated
  using (
    exists (
      select 1 from sms_broadcasts b
      where b.id = sms_broadcast_recipients.broadcast_id
        and private.auth_is_in_location(b.location_id)
    )
  );

create policy sms_broadcast_recipients_insert_at_location
  on sms_broadcast_recipients for insert to authenticated
  with check (
    exists (
      select 1 from sms_broadcasts b
      where b.id = sms_broadcast_recipients.broadcast_id
        and private.auth_is_in_location(b.location_id)
    )
  );

-- updated_at trigger on the broadcasts table — keeps the field
-- accurate without ad-hoc updates from every code path.
create or replace function sms_broadcasts_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger sms_broadcasts_updated_at
  before update on sms_broadcasts
  for each row execute function sms_broadcasts_set_updated_at();
