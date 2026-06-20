-- 301: Social v1 — mutual friend graph + feed reactions + per-member social settings.
-- All member-facing (champ-app); standings/feed computed on read, no feed table.

CREATE TABLE IF NOT EXISTS public.member_friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  addressee_contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending','accepted','blocked')),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (requester_contact_id <> addressee_contact_id)
);
-- One row per unordered pair (prevents A<->B duplicate + reverse-direction dupes).
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_friendships_pair ON public.member_friendships
  (LEAST(requester_contact_id, addressee_contact_id), GREATEST(requester_contact_id, addressee_contact_id));
CREATE INDEX IF NOT EXISTS idx_member_friendships_addressee ON public.member_friendships (addressee_contact_id, status);
CREATE INDEX IF NOT EXISTS idx_member_friendships_requester ON public.member_friendships (requester_contact_id, status);

ALTER TABLE public.member_friendships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read own friendships" ON public.member_friendships FOR SELECT TO public
  USING (requester_contact_id = (SELECT private.auth_contact_id())
      OR addressee_contact_id = (SELECT private.auth_contact_id()));
-- Writes go through the service client (champ-app routes enforce who-can-do-what); no customer write policy.

CREATE TABLE IF NOT EXISTS public.feed_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reactor_contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('session','achievement')),
  entity_id uuid NOT NULL,
  reaction text NOT NULL CHECK (reaction IN ('strong','fire','clap','wow')),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reactor_contact_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_feed_reactions_entity ON public.feed_reactions (entity_type, entity_id);

ALTER TABLE public.feed_reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read+write own reactions" ON public.feed_reactions FOR ALL TO public
  USING (reactor_contact_id = (SELECT private.auth_contact_id()))
  WITH CHECK (reactor_contact_id = (SELECT private.auth_contact_id()));

CREATE TABLE IF NOT EXISTS public.member_social_settings (
  contact_id uuid PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
  private_mode boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_social_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members manage own social settings" ON public.member_social_settings FOR ALL TO public
  USING (contact_id = (SELECT private.auth_contact_id()))
  WITH CHECK (contact_id = (SELECT private.auth_contact_id()));

-- Reaction-push coalescing reuses the engagement-nudge idempotency log.
ALTER TABLE public.customer_engagement_nudges DROP CONSTRAINT IF EXISTS customer_engagement_nudges_type_check;
ALTER TABLE public.customer_engagement_nudges ADD CONSTRAINT customer_engagement_nudges_type_check
  CHECK (type IN ('streak_at_risk','goal_complete','tier_up','reaction'));

COMMENT ON TABLE public.member_friendships IS 'Social v1 (2026-06): mutual friend graph, same-studio. Service-role write, member self-read.';
COMMENT ON TABLE public.feed_reactions IS 'Social v1 (2026-06): tap reactions on session/achievement feed items. One per reactor per entity.';
