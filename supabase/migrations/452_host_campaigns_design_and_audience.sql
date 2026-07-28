-- HOST-EMAIL.4 — visual composer + per-event audience for host campaigns.
-- design_json: Unlayer design document (NULL = legacy plain-text campaign).
-- audience_event_id: restrict recipients to confirmed attendees of one of
-- the host's events (resolved from race_registrations at SEND time — the
-- host_contacts source_event_id only records the FIRST event that added a
-- contact, so it cannot answer "who attended event X"); NULL = everyone.
ALTER TABLE public.host_campaigns
  ADD COLUMN IF NOT EXISTS design_json jsonb,
  ADD COLUMN IF NOT EXISTS audience_event_id uuid REFERENCES public.race_events(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.host_campaigns.design_json IS 'Unlayer design document for the visual composer (HOST-EMAIL.4); NULL = plain-text campaign.';
COMMENT ON COLUMN public.host_campaigns.audience_event_id IS 'HOST-EMAIL.4 — restrict recipients to confirmed attendees of this event (resolved from race_registrations at send time); NULL = all host contacts.';
