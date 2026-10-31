// Front-page (split chooser) data for the public /welcome render.
// Extracted from src/app/welcome/page.js so the SAAS-6 org resolution
// is unit-testable (the page itself is JSX; this module is pure data).
//
// SAAS-6: chooser_settings is per-ORGANIZATION (mig 414), so this
// reader must decide WHICH org's front page to render.
//
// W1.L4: the page passes the organisation the REQUEST HOST maps to
// (resolveTenantOrgId(host): the in-code brands — un1tdublin.com is UN1T
// Group's — then tenant_domains, so <slug>.repset.ie and a custom domain
// render THAT org's chooser). A host with no organisation (the CRM host)
// keeps the UN1T Group slug fallback byte-identical.

import { createServerClient } from '@/lib/supabase'
import { blocksOrDefault } from '@/lib/landing-page-blocks'
import { tileModeFor } from '@/lib/landing-page-visibility'

// PAGES.1: the tile columns of a kind='studio' landing_pages row.
const TILE_COLUMNS = 'slug, chrome, blocks, publish_state, locations:primary_location_id ( name )'

// Default left→right order when the operator hasn't set tile_order.
export const TILE_ORDER = ['stillorgan', 'hatch-street']

// The org whose chooser a host with NO organisation (the CRM host) renders.
// Resolved by slug — never a hardcoded UUID.
export const FRONT_PAGE_ORG_SLUG = 'un1t-group'

/**
 * Load the whole front page: the org's chooser row (headline / intro /
 * tile_order) plus every studio tile OF THAT ORG (PAGES.1: its kind='studio'
 * landing_pages row; label, CTA and cover are the page's chrome.chooser_*,
 * then the location name and the hero image). Tiles are returned in the operator's saved
 * order, falling back to TILE_ORDER. Fail-soft: any error renders the
 * empty chooser rather than 500ing the public page.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} [db]  Injectable for tests.
 * @param {{ orgId?: string|null }} [opts]  W1.L4: the host's organisation
 *   (resolveTenantOrgId); null keeps the slug fallback.
 */
export async function loadFrontPage(db = null, { orgId = null } = {}) {
  try {
    const client = db || createServerClient()

    let org = orgId ? { id: orgId } : null
    if (!org) {
      const { data } = await client
        .from('organizations')
        .select('id')
        .eq('slug', FRONT_PAGE_ORG_SLUG)
        .maybeSingle()
      org = data
    }

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
      // PAGES.1 — a tile is a studio page of THIS organisation (another
      // tenant's studios must never render on this org's front page). When
      // the org can't be resolved (transitional) the unfiltered set is
      // identical in today's single-marketing-domain reality.
      org?.id
        ? client.from('landing_pages')
            .select(TILE_COLUMNS)
            .eq('kind', 'studio')
            .eq('organization_id', org.id)
        : client.from('landing_pages')
            .select(TILE_COLUMNS)
            .eq('kind', 'studio'),
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

    // The path of a tile is its page slug (chooser_settings.tile_order holds slugs).
    const byPath = new Map((tilesRes.data || []).map((r) => [r.slug, r]))
    const tiles = order
      .map((path) => byPath.get(path))
      .filter(Boolean)
      .map((r) => {
        const chrome = r.chrome && typeof r.chrome === 'object' ? r.chrome : {}
        const hero = blocksOrDefault(r.blocks).find((b) => b.type === 'hero')
        // 'active' | 'coming_soon' | 'hidden'; a draft or retired page is hidden.
        const mode = tileModeFor(r.publish_state)
        return {
          path: r.slug,
          // Operator label wins over the location name; fall back to the slug.
          name: (typeof chrome.chooser_label === 'string' && chrome.chooser_label.trim())
            || r.locations?.name
            || r.slug,
          cta: (typeof chrome.chooser_cta_text === 'string' && chrome.chooser_cta_text.trim()) || 'Enter',
          cover: chrome.chooser_image_url || hero?.image_url || null,
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
 * return the public path for THAT studio, its studio page's /<slug>
 * (PAGES.1; /welcome/<slug> redirects there), so a location-scoped tenant domain lands strays on the one studio
 * rather than the org chooser. Returns null when there is no location
 * (whole-org / unmapped / legacy hostname) or the location has no
 * LIVE studio page, in which case the caller renders the chooser
 * exactly as today. Fail-soft: any error → null (never blocks the
 * public page).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient|null} db  Injectable for tests.
 * @param {string|null} locationId  From resolveTenantLocationId(host).
 * @returns {Promise<string|null>}  '/<slug>' or null.
 */
export async function publicWelcomePathForLocation(db, locationId) {
  if (!locationId) return null
  try {
    const client = db || createServerClient()
    // One studio page per location (partial unique index), so no ordering.
    // Only a LIVE page: the proxy admits no other, so a draft slug looped
    // /welcome → /<slug> → /welcome, and a coming_soon one 404'd instead of
    // showing the chooser.
    const { data } = await client
      .from('landing_pages')
      .select('slug')
      .eq('kind', 'studio')
      .eq('primary_location_id', locationId)
      .eq('publish_state', 'live')
      .maybeSingle()
    return data?.slug ? `/${data.slug}` : null
  } catch {
    return null
  }
}
