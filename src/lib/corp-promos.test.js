import { describe, it, expect } from 'vitest'
import { CORP_PROMO_SEEDS, CORP_PROMO_COPY_DEFAULT, liveSeededCorpPromos, seededCorpPromosForStudio, CORP_PROMO_GLOFOX_COPY_DEFAULT, corpPromoCopyFromBlocks, fillCorpPromoTokens } from './corp-promos'
import { readCorpPromo, listCorpPromos, promoView } from './corp-promos-db'
import { glofoxPlanForPromo, glofoxCorpPromoKeys, glofoxCorpPromoPlanNames } from './corp-promo-glofox-plans'

const HATCH = 'loc-hatch'
const STILL = 'loc-still'
const row = (over = {}) => ({
  id: 'p1', location_id: HATCH, key: 'hatch-3-free', name: 'Corporate trial (Hatch Street)', platform: 'un1t_online',
  credits: 3, expires_in_days: 7, live: true, tag: 'hatch-corp-promo', lead_source: 'corp_promo',
  glofox_membership_id: null, glofox_plan_code: null, glofox_plan_name: null, ...over,
})
const ROWS = [
  row(),
  row({ id: 'p2', key: 'hatch-old', name: 'Old promo', live: false }),
  row({ id: 'p3', location_id: STILL, key: 'stillorgan-newstart', name: 'New Start (Stillorgan)', platform: 'glofox', tag: 'stillorgan-newstart', glofox_membership_id: 'mem-1', glofox_plan_code: 'plan-1', glofox_plan_name: 'New Start Free Trial' }),
]

// A corp_promos fake: eq filters, order, range, maybeSingle; `fail` errors every read.
function fakeDb(rows = ROWS, { fail = null } = {}) {
  const log = []
  return {
    log,
    from(table) {
      const entry = { table, select: null, filters: {}, order: null, range: null }
      log.push(entry)
      const run = () => {
        if (fail) return { data: null, error: fail }
        const hit = rows.filter((r) => Object.entries(entry.filters).every(([k, v]) => r[k] === v))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        return { data: entry.range ? hit.slice(entry.range[0], entry.range[1] + 1) : hit, error: null }
      }
      const q = {
        select(cols) { entry.select = cols; return q },
        eq(col, v) { entry.filters[col] = v; return q },
        order(col) { entry.order = col; return q },
        range(a, b) { entry.range = [a, b]; return q },
        async maybeSingle() {
          const out = run()
          if (out.error) return out
          return { data: out.data[0] || null, error: null }
        },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
      }
      return q
    },
  }
}

describe('corp promo seeds (mig 816)', () => {
  it('hatch-3-free: 3 credits for 7 days at Hatch Street, live, no Glofox plan', () => {
    expect(CORP_PROMO_SEEDS['hatch-3-free']).toMatchObject({ studio: 'hatch', publicPath: 'hatch-street', credits: 3, expiresInDays: 7, live: true, glofox: null })
    expect(Object.isFrozen(CORP_PROMO_SEEDS['hatch-3-free'])).toBe(true)
  })

  it('no seed carries a Glofox plan (the ids live in corp_promos, server side)', () => {
    for (const seed of Object.values(CORP_PROMO_SEEDS)) expect(seed.glofox).toBeNull()
    expect(glofoxPlanForPromo(CORP_PROMO_SEEDS['stillorgan-newstart'])).toBeNull()
  })

  it('lists only live seeds, and per studio by public path', () => {
    expect(liveSeededCorpPromos().map((p) => p.key)).toEqual(['hatch-3-free', 'stillorgan-newstart'])
    expect(seededCorpPromosForStudio('hatch-street').map((p) => p.key)).toEqual(['hatch-3-free'])
    expect(seededCorpPromosForStudio('stillorgan').map((p) => p.key)).toEqual(['stillorgan-newstart'])
    expect(seededCorpPromosForStudio('nowhere')).toEqual([])
  })
})

describe('promoView', () => {
  it('adds the camelCase accessors the fulfilment code reads', () => {
    expect(promoView(row())).toEqual({
      id: 'p1', locationId: HATCH, key: 'hatch-3-free', name: 'Corporate trial (Hatch Street)', platform: 'un1t_online',
      credits: 3, expiresInDays: 7, live: true, tag: 'hatch-corp-promo', leadSource: 'corp_promo', glofox: null,
      kind: 'promo', windowStartsOn: null, windowEndsOn: null, maxClasses: null, maxPerDay: null,
    })
  })

  it('OPENWEEK.1: an open week row carries its window and limits', () => {
    const v = promoView(row({ key: 'hatch-open-week', kind: 'open_week', window_starts_on: '2026-11-23', window_ends_on: '2026-11-30', max_classes: 5, max_per_day: 1 }))
    expect(v).toMatchObject({ kind: 'open_week', windowStartsOn: '2026-11-23', windowEndsOn: '2026-11-30', maxClasses: 5, maxPerDay: 1 })
  })

  it('glofox is the plan binding; a blank membership id or plan code is no plan', () => {
    expect(promoView(ROWS[2]).glofox).toEqual({ membershipId: 'mem-1', planCode: 'plan-1', planName: 'New Start Free Trial' })
    expect(promoView(row({ platform: 'glofox', glofox_membership_id: 'mem-1', glofox_plan_code: '  ' })).glofox).toBeNull()
  })
})

describe('readCorpPromo', () => {
  it('returns the studio\'s row as a view, scoped by location and key, named columns', async () => {
    const db = fakeDb()
    const res = await readCorpPromo(db, { locationId: HATCH, key: 'hatch-3-free' })
    expect(res).toEqual({ ok: true, promo: expect.objectContaining({ key: 'hatch-3-free', expiresInDays: 7, credits: 3, leadSource: 'corp_promo' }) })
    expect(db.log[0]).toMatchObject({ table: 'corp_promos', filters: { location_id: HATCH, key: 'hatch-3-free' } })
    expect(db.log[0].select).not.toContain('*')
  })

  it('null for an unknown key at that studio, and for another studio\'s key', async () => {
    expect(await readCorpPromo(fakeDb(), { locationId: HATCH, key: 'nope' })).toEqual({ ok: true, promo: null })
    expect(await readCorpPromo(fakeDb(), { locationId: HATCH, key: 'stillorgan-newstart' })).toEqual({ ok: true, promo: null })
  })

  it('a read error is ok:false, never "no promo"', async () => {
    const res = await readCorpPromo(fakeDb(ROWS, { fail: { message: 'boom' } }), { locationId: HATCH, key: 'hatch-3-free' })
    expect(res).toEqual({ ok: false, error: 'boom' })
  })

  it('a thrown read is ok:false too; no studio is ok:false', async () => {
    const db = { from() { throw new Error('down') } }
    expect(await readCorpPromo(db, { locationId: HATCH, key: 'hatch-3-free' })).toEqual({ ok: false, error: 'down' })
    expect((await readCorpPromo(fakeDb(), { key: 'hatch-3-free' })).ok).toBe(false)
  })
})

describe('listCorpPromos', () => {
  it('this studio\'s rows only, ordered by key, paged', async () => {
    const db = fakeDb()
    const res = await listCorpPromos(db, { locationId: HATCH })
    expect(res.ok).toBe(true)
    expect(res.promos.map((p) => p.key)).toEqual(['hatch-3-free', 'hatch-old'])
    expect(db.log[0]).toMatchObject({ order: 'key', range: [0, 999], filters: { location_id: HATCH } })
  })

  it('liveOnly filters to live rows', async () => {
    const res = await listCorpPromos(fakeDb(), { locationId: HATCH, liveOnly: true })
    expect(res.promos.map((p) => p.key)).toEqual(['hatch-3-free'])
  })

  it('reads a second page when the first is full', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => row({ id: `p${i}`, key: `k-${String(i).padStart(4, '0')}` }))
    const db = fakeDb(many)
    const res = await listCorpPromos(db, { locationId: HATCH })
    expect(res.promos).toHaveLength(1001)
    expect(db.log.map((e) => e.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('a read error is ok:false', async () => {
    expect(await listCorpPromos(fakeDb(ROWS, { fail: { message: 'boom' } }), { locationId: HATCH })).toEqual({ ok: false, error: 'boom' })
  })
})

describe('glofoxPlanForPromo / the studio\'s Glofox promos', () => {
  it('null without the plan columns', () => {
    expect(glofoxPlanForPromo(promoView(row()))).toBeNull()
    expect(glofoxPlanForPromo(null)).toBeNull()
    expect(glofoxPlanForPromo({ key: 'x' })).toBeNull()
  })

  it('the plan from the row view', () => {
    expect(glofoxPlanForPromo(promoView(ROWS[2]))).toEqual({ membershipId: 'mem-1', planCode: 'plan-1', planName: 'New Start Free Trial' })
  })

  it('glofoxCorpPromoKeys and plan names are the studio\'s Glofox rows only', async () => {
    expect(await glofoxCorpPromoKeys(fakeDb(), STILL)).toEqual({ ok: true, keys: ['stillorgan-newstart'] })
    expect(await glofoxCorpPromoKeys(fakeDb(), HATCH)).toEqual({ ok: true, keys: [] })
    expect(await glofoxCorpPromoPlanNames(fakeDb(), STILL)).toEqual({ ok: true, names: ['new start free trial'] })
    expect((await glofoxCorpPromoKeys(fakeDb(ROWS, { fail: { message: 'boom' } }), STILL)).ok).toBe(false)
  })
})

describe('corpPromoCopyFromBlocks', () => {
  it('no block: every default', () => {
    expect(corpPromoCopyFromBlocks([], 'hatch-3-free')).toEqual({ ...CORP_PROMO_COPY_DEFAULT, ticks: [...CORP_PROMO_COPY_DEFAULT.ticks] })
  })

  it('the card title defaults to Exclusive Corporate Trial, with no eyebrow', () => {
    const copy = corpPromoCopyFromBlocks([], 'hatch-3-free')
    expect(copy.title).toBe('Exclusive Corporate Trial')
    expect(copy.eyebrow).toBe('')
  })

  it('blank fields fall back; filled ones win; blank ticks skipped', () => {
    const copy = corpPromoCopyFromBlocks([{ type: 'corp_promo', heading: 'Hello', cta_label: '  ', ticks: ['One', ''] }], 'hatch-3-free')
    expect(copy.heading).toBe('Hello')
    expect(copy.cta_label).toBe(CORP_PROMO_COPY_DEFAULT.cta_label)
    expect(copy.ticks).toEqual(['One'])
  })

  it("the block naming this promo wins over a general one; another promo's block is never used", () => {
    const blocks = [
      { type: 'corp_promo', promo_key: 'other', heading: 'Other' },
      { type: 'corp_promo', heading: 'General' },
      { type: 'corp_promo', promo_key: 'hatch-3-free', heading: 'Mine' },
    ]
    expect(corpPromoCopyFromBlocks(blocks, 'hatch-3-free').heading).toBe('Mine')
    expect(corpPromoCopyFromBlocks(blocks.slice(0, 2), 'hatch-3-free').heading).toBe('General')
    expect(corpPromoCopyFromBlocks(blocks.slice(0, 1), 'hatch-3-free').heading).toBe(CORP_PROMO_COPY_DEFAULT.heading)
  })
})

describe('fillCorpPromoTokens', () => {
  it('fills known tokens and leaves unknown ones', () => {
    expect(fillCorpPromoTokens('{credits} by {expires_on} {x}', { credits: 3, expires_on: 'Tue 4 Nov' })).toBe('3 by Tue 4 Nov {x}')
  })
})

describe('glofox promos (NEWSTART.1)', () => {
  it('glofox copy defaults never mention un1t.online', () => {
    expect(JSON.stringify(CORP_PROMO_GLOFOX_COPY_DEFAULT)).not.toMatch(/un1t\.online/i)
    expect(Object.keys(CORP_PROMO_GLOFOX_COPY_DEFAULT).sort()).toEqual(Object.keys(CORP_PROMO_COPY_DEFAULT).sort())
    expect(corpPromoCopyFromBlocks([], 'stillorgan-newstart', { platform: 'glofox' }).heading).toBe(CORP_PROMO_GLOFOX_COPY_DEFAULT.heading)
    expect(corpPromoCopyFromBlocks([], 'hatch-3-free')).toEqual({ ...CORP_PROMO_COPY_DEFAULT, ticks: [...CORP_PROMO_COPY_DEFAULT.ticks] })
  })
})

describe('OPENWEEK.1 open week words', () => {
  it('uses the open week defaults for kind open_week, on either platform', async () => {
    const { corpPromoCopyFromBlocks: words, OPEN_WEEK_COPY_DEFAULT } = await import('./corp-promos')
    for (const platform of ['un1t_online', 'glofox']) {
      const c = words([], 'hatch-open-week', { platform, kind: 'open_week' })
      expect(c.title).toBe('Open Week at {studio_name}')
      expect(c.heading).toBe('Open Week at {studio_name}')
      expect(c.subhead).toBe("Come and try coach-led classes, on us. Pick your classes for 23–30 November and we'll book you in.")
      expect(c.ticks).toEqual(['Up to 5 classes, free', 'One class a day, 23–30 November', 'Booked for you, see them in the app'])
      expect(c.cta_label).toBe('Book my classes')
      expect(c.pick_heading).toBe('Pick your classes')
      expect(c.pick_hint).toBe('One class a day, up to {max_classes}.')
      expect(c.pick_cta).toBe('Continue with {count} classes')
      expect(c.class_list_heading).toBe('Your classes')
      expect(c.studio_heading).toBe('Choose your studio')
      expect(c.done_title).toBe("You're in 🎉")
      expect(c.done_body).toBe("We're booking you into the classes below. Check your email for how to log in to the app.")
      expect(c.active_member_text).toBe("You're already a member at {studio_name}, so just book your classes in the app as usual.")
      expect(c.already_claimed_text).toBe("You've already signed up for Open Week. Your classes are in the app; reply to our email if anything looks off.")
      expect(c.over_text).toBe('Open Week has finished. Ask at the front desk about trying a class.')
      expect(c.email_subject).toBe('Your Open Week classes at {studio_name}')
      expect(c.email_body).toBe("Hi {first_name}, we're booking you into your Open Week classes at {studio_name}:\n{class_list}\nYou'll get a confirmation for each class as it's booked. Log in to the app with this email to see them. Reply to this email if anything looks off.")
      expect(c.trial_used_text).toBe(OPEN_WEEK_COPY_DEFAULT.trial_used_text)
    }
  })

  it("a block's own field still wins", async () => {
    const { corpPromoCopyFromBlocks: words } = await import('./corp-promos')
    const c = words([{ type: 'corp_promo', promo_key: 'hatch-open-week', heading: 'Try us free', pick_cta: 'Next' }], 'hatch-open-week', { kind: 'open_week' })
    expect(c.heading).toBe('Try us free')
    expect(c.pick_cta).toBe('Next')
  })

  it('a normal promo carries no open week keys', async () => {
    const { corpPromoCopyFromBlocks: words } = await import('./corp-promos')
    expect(words([], 'hatch-3-free', {}).pick_heading).toBeUndefined()
  })
})
