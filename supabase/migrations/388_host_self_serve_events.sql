-- HOST-PORTAL.3 — host self-serve event creation.
-- Adds the draft→pending_review→published→rejected lifecycle to race_events
-- (default 'published' so every existing + staff-created event is unaffected),
-- free-text venue columns for host-run venues, an audit trail, a per-host hidden
-- anchor location (event_hosts.anchor_location_id), and a flag to exclude those
-- anchors from staff/public/reporting location surfaces.

alter table race_events
  add column if not exists status text not null default 'published'
    check (status in ('draft', 'pending_review', 'published', 'rejected')),
  add column if not exists venue_name text,
  add column if not exists venue_address text,
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid,
  add column if not exists rejected_reason text;

comment on column race_events.status is
  'Publication lifecycle. Only host-authored events leave ''published''; staff/internal events keep the default.';

create index if not exists idx_race_events_host_pending
  on race_events (host_id, status) where host_id is not null;

alter table event_hosts
  add column if not exists anchor_location_id uuid references locations(id);

comment on column event_hosts.anchor_location_id is
  'Hidden per-host locations row used as location_id for all this host''s events. Provisioned lazily on first host-authored event create. Avoids the teams (location_id, name) cross-host collision.';

alter table locations
  add column if not exists is_host_anchor boolean not null default false;

comment on column locations.is_host_anchor is
  'TRUE = a hidden per-host anchor location for host-run events. Exclude from staff location pickers, public UN1T listings, and org location rollups.';
