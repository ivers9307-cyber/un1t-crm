// Public landing pages are addressed by a URL-safe `public_path` slug
// (e.g. 'stillorgan', 'hatch-street') that maps 1:1 to a
// landing_page_settings row → location_id. Public funnel endpoints take
// this slug from the client; this helper sanitises it and defaults to
// Stillorgan (the original hard-coded target) so pre-existing callers
// that send no path keep working.
const DEFAULT_LANDING_PATH = 'stillorgan'

export function resolveLandingPath(raw) {
  if (raw == null) return DEFAULT_LANDING_PATH
  const cleaned = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '') // slug charset only — never trust the client
    .slice(0, 64)
  return cleaned || DEFAULT_LANDING_PATH
}
