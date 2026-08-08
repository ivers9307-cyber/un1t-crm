-- 481: H6 — expiry for the shareable post-class card token (mig 294).
--
-- share_token alone made a shared card public FOREVER (or until the member
-- manually revoked it) — an unguessable-but-immortal capability URL. This adds
-- an expiry the champ-app share flow stamps when minting a token; the public
-- /share/<token> page (champ-app) rejects tokens past their expiry with the
-- same not-found shape as a revoked one.
--
-- Semantics:
--   * Set by champ-app when minting a share (POST /api/sessions/[id]/share);
--     re-sharing an already-shared session refreshes it.
--   * NULL = no expiry. Existing shared rows stay NULL — legacy never-expire —
--     until the member re-shares, at which point the new mint stamps a window.
--     Deliberate: retro-expiring links members already sent to friends would
--     silently break them; the H6 risk is new-link immortality, not old links.
--   * Nothing in un1t-crm reads or writes this column (verified: zero
--     share_token consumers in this repo — mint/clear + the public page are
--     champ-app surfaces per mig 294). Forward-only, code-later is safe.
ALTER TABLE public.heart_rate_sessions
  ADD COLUMN IF NOT EXISTS share_token_expires_at timestamptz;

COMMENT ON COLUMN public.heart_rate_sessions.share_token_expires_at IS
  'H6 (mig 481): expiry for share_token, stamped by champ-app when minting a share; the public /share/<token> page rejects expired tokens (404 shape, same as revoked). NULL = legacy never-expire share (pre-481 mints) until the member re-shares.';
