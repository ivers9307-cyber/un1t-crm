-- 750 — UN1TRADAR.3 follow-up: index un1t_bookings (location_id, remote_created_at).
--
-- UN1TRADAR.3 (#2127) bounds the radar's last_booked_at read in
-- src/lib/membership/reads/un1t-online-radar.js to
-- remote_created_at >= now - 400 days, per studio (location_id = $1). The
-- un1t.online mirror (mig 726) keeps a studio's full booking history and never
-- prunes it, and the only existing index is (location_id, contact_id), so
-- without this the bounded read would filter an ever-growing slice of the
-- table. With it the read stays an index range scan as Hatch's history grows.
--
-- Index only: no grant decision (an index is not a relation a client can be
-- granted), and no schema object a client can see. Forward-only; IF NOT EXISTS
-- makes a re-apply a no-op.

CREATE INDEX IF NOT EXISTS un1t_bookings_location_remote_created
  ON public.un1t_bookings (location_id, remote_created_at);
