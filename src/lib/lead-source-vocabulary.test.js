// WAYSIN.5 — the studio's lead-source vocabulary: defaults ∪ the owner's list ∪
// values seen on the studio's contacts, lowercased, deduped, defaults first;
// a failed read is a failure, never a shorter list.
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LEAD_SOURCES, leadSourceVocabulary, leadSourceLabel, buildLeadSourceVocabulary,
  studioLeadSourcesFromSettings,
} from './lead-source-vocabulary'
import { leadSourceSchema } from './schemas'

const LOC = 'a0000000-0000-4000-8000-000000000001'

// Logs every awaited query and answers it from `tables[table](entry)`.
function makeDb(tables) {
  const log = []
  return {
    log,
    from(table) {
      const entry = { table, select: null, filters: {}, range: null, order: null }
      const q = {
        select(c) { entry.select = c; return q },
        eq(c, v) { entry.filters[c] = v; return q },
        order(c) { entry.order = c; return q },
        range(a, b) { entry.range = [a, b]; return q },
        maybeSingle() { entry.single = true; return q },
        then(resolve, reject) {
          log.push(entry)
          const fn = tables[table]
          return Promise.resolve(fn ? fn(entry) : { data: [], error: null }).then(resolve, reject)
        },
      }
      return q
    },
  }
}

describe('DEFAULT_LEAD_SOURCES', () => {
  it('is the nine the enum used to hold', () => {
    expect(DEFAULT_LEAD_SOURCES).toEqual(['booking', 'meta', 'tiktok', 'walkin', 'referral', 'website', 'whatsapp', 'classpass', 'other'])
  })
})

describe('leadSourceLabel', () => {
  it("the nine keep their words; anything else is itself", () => {
    expect(leadSourceLabel('walkin')).toBe('Walk-in')
    expect(leadSourceLabel('classpass')).toBe('ClassPass')
    expect(leadSourceLabel('meta')).toBe('Meta (Facebook/Instagram)')
    expect(leadSourceLabel('corp_promo')).toBe('corp_promo')
    expect(leadSourceLabel(null)).toBe('')
  })
})

describe('studioLeadSourcesFromSettings', () => {
  it('reads strings only, normalised and deduped; anything else is empty', () => {
    expect(studioLeadSourcesFromSettings({ lead_sources: [' A_b ', 'a_b', 3, null, 'c'] })).toEqual(['a_b', 'c'])
    expect(studioLeadSourcesFromSettings({ lead_sources: 'x' })).toEqual([])
    expect(studioLeadSourcesFromSettings(null)).toEqual([])
  })
})

describe('buildLeadSourceVocabulary', () => {
  it('unions the three origins without duplicates, lowercased, defaults first then alphabetical', () => {
    const v = buildLeadSourceVocabulary(['Zeta_Club', 'meta'], ['META', 'corp_promo', ' Zeta_club ', 'hatch_launch'])
    expect(v.map((s) => s.value)).toEqual([...DEFAULT_LEAD_SOURCES, 'corp_promo', 'hatch_launch', 'zeta_club'])
    const by = Object.fromEntries(v.map((s) => [s.value, s.origin]))
    expect(by.meta).toBe('default')
    expect(by.zeta_club).toBe('studio')
    expect(by.corp_promo).toBe('seen')
  })
})

describe('leadSourceVocabulary', () => {
  it("reads the studio's settings and every contact at the studio, paged and pinned", async () => {
    const db = makeDb({
      locations: () => ({ data: { id: LOC, settings: { lead_sources: ['clubhouse_partner'] } }, error: null }),
      contacts: () => ({ data: [
        { id: 'c1', lead_source: 'Meta', last_lead_source: 'corp_promo' },
        { id: 'c2', lead_source: null, last_lead_source: null },
        { id: 'c3', lead_source: 'hatch_launch', last_lead_source: 'CLUBHOUSE_PARTNER' },
      ], error: null }),
    })
    const res = await leadSourceVocabulary(db, LOC)
    expect(res.ok).toBe(true)
    expect(res.studio).toEqual(['clubhouse_partner'])
    expect(res.sources.map((s) => [s.value, s.origin]).slice(DEFAULT_LEAD_SOURCES.length)).toEqual([
      ['clubhouse_partner', 'studio'], ['corp_promo', 'seen'], ['hatch_launch', 'seen'],
    ])
    const loc = db.log.find((e) => e.table === 'locations')
    expect(loc.filters).toEqual({ id: LOC })
    const contacts = db.log.find((e) => e.table === 'contacts')
    expect(contacts.select).toBe('id, lead_source, last_lead_source')
    expect(contacts.filters).toEqual({ location_id: LOC })
    expect(contacts.order).toBe('id')
    expect(contacts.range).toEqual([0, 999])
  })

  it('a failed contacts read is ok:false', async () => {
    const db = makeDb({
      locations: () => ({ data: { id: LOC, settings: {} }, error: null }),
      contacts: () => ({ data: null, error: { message: 'boom' } }),
    })
    expect(await leadSourceVocabulary(db, LOC)).toEqual({ ok: false, error: 'boom' })
  })

  it('a failed studio read is ok:false', async () => {
    const db = makeDb({ locations: () => ({ data: null, error: { message: 'nope' } }) })
    expect(await leadSourceVocabulary(db, LOC)).toEqual({ ok: false, error: 'nope' })
  })
})

describe('leadSourceSchema (relaxed from the enum)', () => {
  it('trims and lowercases a slug', () => {
    expect(leadSourceSchema.parse(' META ')).toBe('meta')
    expect(leadSourceSchema.parse('Clubhouse_Partner')).toBe('clubhouse_partner')
    expect(leadSourceSchema.parse('corp_promo')).toBe('corp_promo')
  })
  it('refuses spaces, a leading _ or -, an empty value and more than 80 characters', () => {
    expect(leadSourceSchema.safeParse('Clubhouse Partner ').success).toBe(false)
    expect(leadSourceSchema.safeParse('_x').success).toBe(false)
    expect(leadSourceSchema.safeParse('   ').success).toBe(false)
    expect(leadSourceSchema.safeParse('a'.repeat(81)).success).toBe(false)
    expect(leadSourceSchema.safeParse('a'.repeat(80)).success).toBe(true)
  })
})
