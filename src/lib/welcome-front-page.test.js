// Behaviour pins for the /welcome front-page loader (SAAS-6).
//
// chooser_settings went per-organization (mig 414); the public reader
// must still resolve THE UN1T chooser for un1tdublin.com (single-
// domain reality until SAAS-8's tenant_domains maps hostname → org):
//   • org resolved by slug 'un1t-group', chooser read by that org id
//   • tiles bounded to the org's locations
//   • legacy id='default' fallbacks (row missing / org missing) so the
//     public page never blanks mid-transition
//
// The db is injected, so nothing is mocked at module level.

import { describe, it, expect } from 'vitest'
import { loadFrontPage, publicWelcomePathForLocation, FRONT_PAGE_ORG_SLUG, TILE_ORDER } from './welcome-front-page.js'

const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000001'

function tile(publicPath, orgId, name) {
  return {
    public_path: publicPath,
    chooser_label: null,
    chooser_cta_text: null,
    chooser_image_url: null,
    blocks: null,
    publish_state: 'live',
    locations: { name, organization_id: orgId },
  }
}

// Query-recording db stub covering the loader's three tables.
function makeDb({ org, chooserByOrg, legacyChooser = null, tiles = [] } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      return {
        select: () => ({
          eq: (col, val) => {
            calls.push([table, col, val])
            return {
              maybeSingle: async () => {
                if (table === 'organizations') return { data: org ?? null, error: null }
                if (table === 'chooser_settings' && col === 'organization_id') return { data: chooserByOrg ?? null, error: null }
                if (table === 'chooser_settings' && col === 'id') return { data: legacyChooser, error: null }
                return { data: null, error: null }
              },
            }
          },
          not: (...args) => {
            calls.push([table, 'not', args[0]])
            return Promise.resolve({ data: tiles, error: null })
          },
        }),
      }
    },
  }
}

describe('loadFrontPage — /welcome still resolves the UN1T chooser (SAAS-6)', () => {
  it('resolves the org by slug and reads the chooser by organization_id, tiles in saved order', async () => {
    const db = makeDb({
      org: { id: ORG_A },
      chooserByOrg: { headline: 'Choose your studio', intro: 'Two studios.', tile_order: ['hatch-street', 'stillorgan'] },
      tiles: [
        tile('stillorgan', ORG_A, 'Stillorgan'),
        tile('hatch-street', ORG_A, 'Hatch Street'),
      ],
    })

    const page = await loadFrontPage(db)

    expect(db.calls).toContainEqual(['organizations', 'slug', FRONT_PAGE_ORG_SLUG])
    expect(db.calls).toContainEqual(['chooser_settings', 'organization_id', ORG_A])
    expect(page.headline).toBe('Choose your studio')
    expect(page.intro).toBe('Two studios.')
    expect(page.tiles.map((t) => t.path)).toEqual(['hatch-street', 'stillorgan'])
    expect(page.tiles.map((t) => t.name)).toEqual(['Hatch Street', 'Stillorgan'])
  })

  it('excludes another org\'s tiles from the front page', async () => {
    const db = makeDb({
      org: { id: ORG_A },
      chooserByOrg: { headline: null, intro: null, tile_order: ['stillorgan', 'rival-gym'] },
      tiles: [
        tile('stillorgan', ORG_A, 'Stillorgan'),
        tile('rival-gym', ORG_B, 'Rival Gym'),
      ],
    })

    const page = await loadFrontPage(db)
    expect(page.tiles.map((t) => t.path)).toEqual(['stillorgan'])
  })

  it('falls back to the legacy id=default row when the org-scoped row is missing (transition)', async () => {
    const db = makeDb({
      org: { id: ORG_A },
      chooserByOrg: null,
      legacyChooser: { headline: 'Legacy headline', intro: null, tile_order: [] },
      tiles: [tile('stillorgan', ORG_A, 'Stillorgan'), tile('hatch-street', ORG_A, 'Hatch Street')],
    })

    const page = await loadFrontPage(db)
    expect(db.calls).toContainEqual(['chooser_settings', 'id', 'default'])
    expect(page.headline).toBe('Legacy headline')
    // Empty tile_order → default order pin.
    expect(page.tiles.map((t) => t.path)).toEqual(TILE_ORDER)
  })

  it('falls back to the id=default row (unfiltered tiles) when the org cannot be resolved', async () => {
    const db = makeDb({
      org: null,
      legacyChooser: { headline: null, intro: null, tile_order: [] },
      tiles: [tile('stillorgan', ORG_A, 'Stillorgan'), tile('hatch-street', ORG_A, 'Hatch Street')],
    })

    const page = await loadFrontPage(db)
    expect(db.calls).toContainEqual(['chooser_settings', 'id', 'default'])
    expect(page.tiles.map((t) => t.path)).toEqual(TILE_ORDER)
  })

  it('fails soft to an empty chooser on any thrown error', async () => {
    const db = { from() { throw new Error('boom') } }
    const page = await loadFrontPage(db)
    expect(page).toEqual({ headline: null, intro: null, tiles: [] })
  })
})

// A location-scoped tenant domain (mig 432) lands strays on ONE studio's
// public welcome page instead of the org chooser. This resolves that
// studio's path from its location_id; null means "render the chooser as
// today" (whole-org, unmapped, or no public landing).
describe('publicWelcomePathForLocation — per-location domain landing (mig 432)', () => {
  // Chain stub matching .select().eq().not().order().limit().maybeSingle()
  function landingDb(row) {
    let touched = false
    const chain = {
      select: () => chain,
      eq: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: row, error: null }),
    }
    return {
      touched: () => touched,
      from: (t) => { if (t === 'landing_page_settings') touched = true; return chain },
    }
  }

  it('null locationId → null (whole-org / unmapped → chooser), no DB touch', async () => {
    const db = landingDb(null)
    expect(await publicWelcomePathForLocation(db, null)).toBe(null)
    expect(db.touched()).toBe(false)
  })

  it('location with a public landing row → /welcome/<public_path>', async () => {
    const db = landingDb({ public_path: 'stillorgan' })
    expect(await publicWelcomePathForLocation(db, 'loc-1')).toBe('/welcome/stillorgan')
  })

  it('location with no public landing → null (fall back to chooser)', async () => {
    const db = landingDb(null)
    expect(await publicWelcomePathForLocation(db, 'loc-1')).toBe(null)
  })

  it('fails soft to null on a thrown error (never blocks the public page)', async () => {
    const db = { from() { throw new Error('boom') } }
    expect(await publicWelcomePathForLocation(db, 'loc-1')).toBe(null)
  })
})
