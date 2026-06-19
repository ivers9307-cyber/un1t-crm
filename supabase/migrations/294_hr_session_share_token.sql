-- 294: SESSION-REPORT.4 — opt-in shareable post-class card. A member mints an
-- unguessable token to make ONE session's card publicly viewable at
-- /share/<token> (champ-app). Public reads go through the service client keyed
-- by this token (capability-token pattern, like deposit/race public pages), so
-- no RLS policy change is needed. Nullable + revocable (set back to NULL).
ALTER TABLE public.heart_rate_sessions ADD COLUMN IF NOT EXISTS share_token text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_sessions_share_token
  ON public.heart_rate_sessions (share_token) WHERE share_token IS NOT NULL;

COMMENT ON COLUMN public.heart_rate_sessions.share_token IS
  'SESSION-REPORT.4 (mig 294): unguessable opt-in token for the public shareable card at champ-app /share/<token>. NULL = not shared. Minted/cleared via POST/DELETE /api/sessions/[id]/share.';
