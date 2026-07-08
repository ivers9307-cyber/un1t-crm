-- HOST-PORTAL.1 — host-portal login identity. Maps a Supabase auth user to an
-- event_host so a host can log in to their own scoped portal (host.un1tdublin.com,
-- /host/*) and see only their own events/revenue. A host auth user has a row
-- here but NO profiles row → the staff getCurrentUser() returns null for them
-- (and staff have no host_users row → getCurrentHost() returns null for them):
-- clean separation over the shared auth.users table. Service-role only; the
-- /api/host routes resolve + scope via getCurrentHost().

CREATE TABLE IF NOT EXISTS public.host_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id       uuid NOT NULL REFERENCES public.event_hosts(id) ON DELETE CASCADE,
  auth_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auth_user_id)
);

CREATE INDEX IF NOT EXISTS idx_host_users_host ON public.host_users (host_id);

ALTER TABLE public.host_users ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.host_users IS
  'HOST-PORTAL.1 — maps a Supabase auth user to an event_host (host-portal login). One login per host for now (UNIQUE auth_user_id); can grow to multiple members. Service-role only; /api/host routes scope via getCurrentHost().';
