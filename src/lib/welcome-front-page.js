// Front-page (split chooser) data for the public /welcome render.
// Extracted from src/app/welcome/page.js so the SAAS-6 org resolution
// is unit-testable (the page itself is JSX; this module is pure data).
//
// SAAS-6: chooser_settings is per-ORGANIZATION (mig 414), so this
// reader must decide WHICH org's front page to render. Single-domain
// reality today: un1tdublin.com is the only marketing hostname and the
// brand registry (src/lib/brands.js) carries no brand→organization
// linkage yet, so we resolve the UN1T Group org by slug.
//
// SAAS-8 HANDOFF: tenant_domains will map the request hostname to an
// organization. When it lands, thread the host in from the page
// (headers()) and swap the slug lookup below for that mapping — the
// rest of this loader is already org-keyed and needs no change.
// Behaviour today is identical for un1tdublin.com.

import { createServerClient } from '@/lib/supabase'
import { blocksOrDefault } from '@/lib/landing-page-blocks'
import { tileModeFor } from '@/lib/landing-page-visibility'

// Default left→right order when the operator hasn't set tile_order.
export const TILE_ORDER = ['stillorgan', 'hatch-street']

// The org whose chooser un1tdublin.com renders until SAAS-8 supplies a
// hostname→org mapping. Resolved by slug — never a hardcoded UUID.
export const FRONT_PAGE_ORG_SLUG = 'un1t-group'

/**
 * Load the whole front page: the org's chooser row (headline / intro /
 * tile_order) plus every studio tile OF THAT ORG (label, CTA, cover,
 * hero-image fallback). Tiles are returned in the operator's saved
 * order, falling back to TILE_ORDER. Fail-soft: any error renders the
 * empty chooser rather than 500ing the public page.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} [db]  Injectable for tests.
 */
export async function loadFrontPage(db = null) {
  try {
    const client = db || createServerClient()

    const { data: org } = await client
      .from('organizations')
      .select('id')
      .eq('slug', FRONT_PAGE_ORG_SLUG)
      .maybeSingle()

    const [chooserRes, tilesRes] = await Promise.all([
      org?.id
        ? client.from('chooser_settings')
            .select('headline, intro, tile_order')
            .eq('organization_id', org.id)
            .maybeSingle()
        : client.from('chooser_settings')
            .select('headline, intro, tile_order')
            .eq('id', 'default')
            .maybeSingle(),
      client.from('landing_page_settings')
        .select('public_path, chooser_label, chooser_cta_text, chooser_image_url, blocks, publish_state, locations:location_id ( name, organization_id )')
        .not('public_path', 'is', null),
    ])

    let chooser = chooserRes.data
    if (!chooser && org?.id) {
      // Transitional fallback (mig 414 not yet applied / backfill
      // missed): the legacy singleton row keeps the page rendering.
      const legacy = await client.from('chooser_settings')
        .select('headline, intro, tile_order')
        .eq('id', 'default')
        .maybeSingle()
      chooser = legacy.data
    }
    chooser = chooser || {}

    const order = Array.isArray(chooser.tile_order) && chooser.tile_order.length
      ? chooser.tile_order
      : TILE_ORDER

    // Tiles are the org's locations only — another tenant's studios
    // must never render on this org's front page. When the org can't
    // be resolved (transitional) the unfiltered set is identical in
    // today's single-marketing-domain reality.
    const rows = (tilesRes.data || [])
      .filter((r) => !org?.id || r.locations?.organization_id === org.id)

    const byPath = new Map(rows.map((r) => [r.public_path, r]))
    const tiles = order
      .map((path) => byPath.get(path))
      .filter(Boolean)
      .map((r) => {
        const hero = blocksOrDefault(r.blocks).find((b) => b.type === 'hero')
        const mode = tileModeFor(r.publish_state)   // 'active' | 'coming_soon' | 'hidden'
        return {
          path: r.public_path,
          // Operator label wins over the location name; fall back to path.
          name: (r.chooser_label && r.chooser_label.trim())
            || r.locations?.name
            || r.public_path,
          cta: (r.chooser_cta_text && r.chooser_cta_text.trim()) || 'Enter',
          cover: r.chooser_image_url || hero?.image_url || null,
          mode,
          // coming_soon tiles render dimmed + non-clickable (the old
          // DISABLED_TILE_PATHS behaviour); hidden tiles are removed below.
          disabled: mode === 'coming_soon',
        }
      })
      .filter((t) => t.mode !== 'hidden')

    return {
      headline: (chooser.headline && chooser.headline.trim()) || null,
      intro: (chooser.intro && chooser.intro.trim()) || null,
      tiles,
    }
  } catch {
    return { headline: null, intro: null, tiles: [] }
  }
}

/**
 * Repset per-location domains (mig 432): given the location_id a
 * request host maps to (resolveTenantLocationId, tenant-domains-edge),
 * return the public welcome path for THAT studio — /welcome/<public_path>
 * — so a location-scoped tenant domain lands strays on the one studio
 * rather than the org chooser. Returns null when there is no location
 * (whole-org / unmapped / legacy hostname) or the location has no
 * public landing path, in which case the caller renders the chooser
 * exactly as today. Fail-soft: any error → null (never blocks the
 * public page).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient|null} db  Injectable for tests.
 * @param {string|null} locationId  From resolveTenantLocationId(host).
 * @returns {Promise<string|null>}  '/welcome/<public_path>' or null.
 */
export async function publicWelcomePathForLocation(db, locationId) {
  if (!locationId) return null
  try {
    const client = db || createServerClient()
    const { data } = await client
      .from('landing_page_settings')
      .select('public_path')
      .eq('location_id', locationId)
      .not('public_path', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return data?.public_path ? `/welcome/${data.public_path}` : null
  } catch {
    return null
  }
}
