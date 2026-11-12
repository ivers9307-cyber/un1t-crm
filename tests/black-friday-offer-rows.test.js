// BLACKFRIDAY.8 — mig 829 is customer-facing data: every price must match the brief.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/829_black_friday_offer_rows.sql', 'utf8')
const STILL = "'a0000000-0000-0000-0000-000000000001'"
const HATCH = "'28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'"

function rowsFor(loc) {
  return sql.split('\n').filter((l) => l.trim().startsWith(`(${loc},`))
}
const find = (loc, slug) => rowsFor(loc).find((l) => l.includes(`'${slug}'`))

describe('mig 829 Black Friday rows', () => {
  const stillPrices = { '1-year-membership-bf-2026': 216900, '6-month-membership-bf-2026': 114400, '3-month-membership-bf-2026': 59700, '1-month-membership-bf-2026': 9900, '30-class-pack-bf-2026': 51000, '20-class-pack-bf-2026': 38000 }
  const hatchPrices = { '1-year-membership-bf-2026': 226800, '6-month-membership-bf-2026': 119400, '3-month-membership-bf-2026': 62700, '1-month-membership-bf-2026': 9900, '30-class-pack-bf-2026': 54000, '20-class-pack-bf-2026': 40000 }

  it('carries all 12 prices at the right studio', () => {
    for (const [slug, p] of Object.entries(stillPrices)) expect(find(STILL, slug), slug).toContain(`, ${p}, `)
    for (const [slug, p] of Object.entries(hatchPrices)) expect(find(HATCH, slug), slug).toContain(`, ${p}, `)
  })

  it('gift rows are 10000 and 3900 at both studios, no product id', () => {
    for (const loc of [STILL, HATCH]) {
      expect(find(loc, 'cyber-monday-gift-card')).toContain(', 10000, NULL,')
      expect(find(loc, 'gift-a-reset')).toContain(', 3900, NULL,')
    }
    expect(find(HATCH, 'gift-a-reset')).toContain('UN1T Hatch Street')
    expect(find(STILL, 'gift-a-reset')).toContain('UN1T Stillorgan')
  })

  it('every Hatch membership/pack has a product id except the inactive 1-month', () => {
    for (const slug of Object.keys(hatchPrices)) {
      const r = find(HATCH, slug)
      if (slug.startsWith('1-month')) {
        expect(r).toMatch(/, 9900, NULL, '', false, /)
      } else {
        expect(r).toMatch(/, '[0-9a-f]{8}-[0-9a-f-]{27}', /)
        expect(r).toContain(', true, ')
      }
    }
    for (const slug of Object.keys(stillPrices)) expect(find(STILL, slug)).toContain(', NULL, ')
  })

  it('Hatch renewal fine print is verbatim', () => {
    expect(find(HATCH, '1-year-membership-bf-2026')).toContain('Renews at €2,268 every 12 months after your bonus time. Cancel any time before.')
    expect(find(HATCH, '6-month-membership-bf-2026')).toContain('Renews at €1,194 every 6 months after your bonus time. Cancel any time before.')
    expect(find(HATCH, '3-month-membership-bf-2026')).toContain('Renews at €627 every 3 months after your bonus time. Cancel any time before.')
  })

  it('windows: sale rows 23 Nov, gift rows 30 Nov, all end 30 Nov 23:59:59', () => {
    for (const loc of [STILL, HATCH]) {
      for (const l of rowsFor(loc)) {
        expect(l).toContain("'2026-11-30 23:59:59+00'")
        expect(l).toContain(l.includes('gift') ? "'2026-11-30 00:00:00+00'" : "'2026-11-23 00:00:00+00'")
      }
    }
    expect(rowsFor(STILL)).toHaveLength(8)
    expect(rowsFor(HATCH)).toHaveLength(8)
  })

  it('no row text says "€100 off" or "discount"', () => {
    const body = sql.split('\n').filter((l) => !l.startsWith('--')).join('\n')
    expect(body).not.toMatch(/€100 off/i)
    expect(body).not.toMatch(/discount/i)
  })

  it('upserts only new rows: timed slugs are -bf-2026, the only others are the two gifts', () => {
    const slugs = new Set([...rowsFor(STILL), ...rowsFor(HATCH)].map((l) => l.match(/^\s*\('[^']+', '([^']+)'/)[1]))
    for (const s of slugs) {
      if (!s.endsWith('-bf-2026')) expect(['cyber-monday-gift-card', 'gift-a-reset']).toContain(s)
    }
    expect(sql).toMatch(/ON CONFLICT \(location_id, slug\) DO UPDATE/)
  })

  it('the deactivation UPDATE excludes -bf-2026 slugs and is Stillorgan-only', () => {
    const upd = sql.match(/UPDATE public\.sale_offers[\s\S]*?;/)[0]
    expect(upd).toContain('SET active = false')
    expect(upd).toContain(STILL)
    expect(upd).toContain("slug NOT LIKE '%-bf-2026'")
  })

  it('merges the legal line without overwriting settings', () => {
    expect(sql).toContain("coalesce(settings->'offers_page', '{}'::jsonb)")
    expect(sql).toContain('CHAMP CHAMP FITNESS LIMITED, DUBLIN, IRELAND')
    expect(sql).toContain("WHERE slug = 'un1t-stillorgan'")
  })

  it('header says apply after the code deploys', () => {
    expect(sql).toMatch(/BLACKFRIDAY\.8/)
    expect(sql).toMatch(/APPLY AFTER THE CODE DEPLOYS/)
  })
})
