import { describe, it, expect } from 'vitest'
import {
  newBlockId,
  newBlockOfType,
  defaultBlocks,
  blocksOrDefault,
  BLOCK_TYPES,
  BlocksArraySchema,
  setByPath,
  primaryCta,
  pageCtas,
  offerOf,
  OFFER_DEFAULT,
} from './landing-page-blocks.js'

describe('newBlockId', () => {
  it('returns a non-empty string', () => {
    const id = newBlockId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })
  it('returns different ids on each call', () => {
    expect(newBlockId()).not.toBe(newBlockId())
  })
})

describe('newBlockOfType', () => {
  it('creates each registered type', () => {
    for (const t of BLOCK_TYPES) {
      const b = newBlockOfType(t.type)
      expect(b.type).toBe(t.type)
      expect(b.id).toBeTruthy()
    }
  })
  it('throws on unknown type', () => {
    expect(() => newBlockOfType('made-up')).toThrow(/Unknown block type/)
  })
  it('hero has the expected fields', () => {
    const b = newBlockOfType('hero')
    expect(b).toHaveProperty('eyebrow')
    expect(b).toHaveProperty('headline')
    expect(b).toHaveProperty('subhead')
  })
})

describe('defaultBlocks', () => {
  it('returns a non-empty array', () => {
    expect(defaultBlocks().length).toBeGreaterThan(0)
  })
  it('starts with hero, then booking', () => {
    const arr = defaultBlocks()
    expect(arr[0].type).toBe('hero')
    expect(arr[1].type).toBe('booking')
  })
  it('does not include opt-in blocks (gallery, embed) by default', () => {
    const types = defaultBlocks().map((b) => b.type)
    expect(types).not.toContain('gallery')
    expect(types).not.toContain('embed')
  })
})

describe('blocksOrDefault', () => {
  // defaultBlocks() generates fresh UUIDs each call, so we compare
  // by the type sequence rather than full deep-equal — that's the
  // contract callers rely on (an empty/bad input gives them a
  // properly-ordered starter set).
  const defaultTypes = () => defaultBlocks().map((b) => b.type)

  it('returns defaults when input is null/undefined/non-array', () => {
    expect(blocksOrDefault(null).map((b) => b.type)).toEqual(defaultTypes())
    expect(blocksOrDefault(undefined).map((b) => b.type)).toEqual(defaultTypes())
    expect(blocksOrDefault('not an array').map((b) => b.type)).toEqual(defaultTypes())
  })
  it('returns defaults when input is empty', () => {
    expect(blocksOrDefault([]).map((b) => b.type)).toEqual(defaultTypes())
  })
  it('returns defaults when all entries are malformed', () => {
    expect(blocksOrDefault([{ id: 'x' }, null, 'string']).map((b) => b.type)).toEqual(defaultTypes())
  })
  it('drops unknown-type blocks but keeps known ones', () => {
    const input = [
      { id: 'a', type: 'hero', headline: 'Test' },
      { id: 'b', type: 'whatever' },
      { id: 'c', type: 'booking', slug: 'foo' },
    ]
    const out = blocksOrDefault(input)
    expect(out.map((b) => b.type)).toEqual(['hero', 'booking'])
  })
  it('passes through a fully valid blocks array', () => {
    const input = [
      { id: 'a', type: 'hero', headline: 'Hello' },
      { id: 'b', type: 'pillars', items: [] },
    ]
    expect(blocksOrDefault(input)).toEqual(input)
  })
})

describe('BlocksArraySchema', () => {
  it('accepts a valid array', () => {
    const arr = defaultBlocks()
    const r = BlocksArraySchema.safeParse(arr)
    expect(r.success).toBe(true)
  })
  it('rejects unknown type', () => {
    const r = BlocksArraySchema.safeParse([{ id: 'a', type: 'made-up' }])
    expect(r.success).toBe(false)
  })
  it('rejects missing id', () => {
    const r = BlocksArraySchema.safeParse([{ type: 'hero' }])
    expect(r.success).toBe(false)
  })
  it('caps at 40 blocks', () => {
    const tooMany = Array.from({ length: 41 }, () => ({ id: 'x', type: 'hero' }))
    const r = BlocksArraySchema.safeParse(tooMany)
    expect(r.success).toBe(false)
  })
})

describe('setByPath', () => {
  it('replaces the whole tree on empty path', () => {
    expect(setByPath({ a: 1 }, [], 'X')).toBe('X')
  })
  it('sets a top-level object key', () => {
    expect(setByPath({ a: 1, b: 2 }, ['a'], 9)).toEqual({ a: 9, b: 2 })
  })
  it('does not mutate the input', () => {
    const original = { a: 1, b: 2 }
    setByPath(original, ['a'], 9)
    expect(original).toEqual({ a: 1, b: 2 })
  })
  it('creates a missing intermediate object', () => {
    expect(setByPath({ a: 1 }, ['nested', 'key'], 'v')).toEqual({
      a: 1,
      nested: { key: 'v' },
    })
  })
  it('sets an array element by index', () => {
    expect(setByPath([10, 20, 30], [1], 99)).toEqual([10, 99, 30])
  })
  it('sets a nested array element', () => {
    expect(setByPath({ items: [{ t: 'a' }, { t: 'b' }] }, ['items', 1, 't'], 'X'))
      .toEqual({ items: [{ t: 'a' }, { t: 'X' }] })
  })
  it('preserves sibling array elements (shallow copy of the array)', () => {
    const arr = [{ t: 'a' }, { t: 'b' }, { t: 'c' }]
    const out = setByPath(arr, [1, 't'], 'X')
    expect(out).toEqual([{ t: 'a' }, { t: 'X' }, { t: 'c' }])
    // The unchanged elements should be the SAME references (we
    // didn't deep-clone the array's items).
    expect(out[0]).toBe(arr[0])
    expect(out[2]).toBe(arr[2])
  })
  it('creates a missing array when the path expects one', () => {
    expect(setByPath({ a: 1 }, [0], 'X')).toEqual(['X'])
  })
  it('handles a deep block-style path (pillars.items[2].title)', () => {
    const block = {
      id: 'h1',
      type: 'pillars',
      items: [
        { number: '01', title: 'A', body: 'aa' },
        { number: '02', title: 'B', body: 'bb' },
        { number: '03', title: 'C', body: 'cc' },
      ],
    }
    const out = setByPath(block, ['items', 2, 'title'], 'New C')
    expect(out.items[2].title).toBe('New C')
    expect(out.items[0]).toBe(block.items[0])
    expect(out.id).toBe('h1')
  })
})

describe('lead_form block type', () => {
  it('is registered in BLOCK_TYPES', () => {
    expect(BLOCK_TYPES.some((t) => t.type === 'lead_form')).toBe(true)
  })
  it('factory produces the expected default shape', () => {
    const b = newBlockOfType('lead_form')
    expect(b.type).toBe('lead_form')
    expect(typeof b.id).toBe('string')
    for (const k of ['heading', 'subtext', 'button_label', 'success_message', 'consent_label', 'tag', 'lead_source']) {
      expect(typeof b[k]).toBe('string')
      expect(b[k].length).toBeGreaterThan(0)
    }
    expect(b.tag).toBe('hatch-founding-member')
    expect(b.lead_source).toBe('hatch_launch')
  })
  it('validates through BlocksArraySchema', () => {
    expect(BlocksArraySchema.safeParse([newBlockOfType('lead_form')]).success).toBe(true)
  })
})

describe('reviews block type', () => {
  it('is registered in BLOCK_TYPES', () => {
    const reviews = BLOCK_TYPES.find((t) => t.type === 'reviews')
    expect(reviews).toBeTruthy()
    expect(reviews.label).toBe('Google reviews')
  })

  it('newBlockOfType("reviews") returns the config defaults', () => {
    const b = newBlockOfType('reviews')
    expect(b.type).toBe('reviews')
    expect(typeof b.id).toBe('string')
    expect(b.min_rating).toBe(4)
    // show_aggregate is gone — the aggregate header was retired with the
    // Google Business Profile sync (mig 410).
    expect(b.show_aggregate).toBeUndefined()
    expect(b.speed).toBe('normal')
    expect(b.title).toBe('What our members say')
  })

  it('blocksOrDefault keeps a saved reviews block (known type)', () => {
    const saved = [{ id: 'x', type: 'reviews', min_rating: 5 }]
    expect(blocksOrDefault(saved)).toHaveLength(1)
  })

  it('reviews is NOT in the default starter set', () => {
    expect(defaultBlocks().some((b) => b.type === 'reviews')).toBe(false)
  })
})

describe('video_testimonials block type', () => {
  it('is registered in BLOCK_TYPES', () => {
    const meta = BLOCK_TYPES.find((t) => t.type === 'video_testimonials')
    expect(meta).toBeTruthy()
    expect(meta.label).toBe('Video testimonials')
  })

  it('factory produces the expected default shape', () => {
    const b = newBlockOfType('video_testimonials')
    expect(b.type).toBe('video_testimonials')
    expect(typeof b.id).toBe('string')
    expect(b.id.length).toBeGreaterThan(0)
    expect(typeof b.title).toBe('string')
    expect(b.title.length).toBeGreaterThan(0)
    expect(Array.isArray(b.items)).toBe(true)
    expect(b.items).toHaveLength(0)
  })

  it('validates through BlocksArraySchema (empty + populated)', () => {
    expect(BlocksArraySchema.safeParse([newBlockOfType('video_testimonials')]).success).toBe(true)
    const populated = {
      id: 'v1',
      type: 'video_testimonials',
      title: 'Hear from our members',
      items: [{ video_url: 'https://x/v.mp4', poster_url: 'https://x/p.jpg', name: 'Sarah' }],
    }
    expect(BlocksArraySchema.safeParse([populated]).success).toBe(true)
  })

  it('is NOT in the default starter set (opt-in like gallery)', () => {
    expect(defaultBlocks().some((b) => b.type === 'video_testimonials')).toBe(false)
  })

  it('blocksOrDefault keeps a saved video_testimonials block', () => {
    const saved = [{ id: 'x', type: 'video_testimonials', items: [] }]
    expect(blocksOrDefault(saved)).toHaveLength(1)
  })
})

describe('primaryCta (WEBSITE-REDESIGN 2026-06)', () => {
  it('prefers lead_form over booking and event, using its button_label', () => {
    const blocks = [
      { id: 'b', type: 'booking', slug: 'consult' },
      { id: 'l', type: 'lead_form', button_label: 'Join the waitlist' },
      { id: 'e', type: 'event', slug: 'race' },
    ]
    expect(primaryCta(blocks)).toEqual({ href: '#waitlist', label: 'Join the waitlist' })
  })

  it('falls back to the default waitlist label when button_label is blank', () => {
    expect(primaryCta([{ id: 'l', type: 'lead_form', button_label: '   ' }]).label).toBe('Join the waitlist')
  })

  it('uses booking when no lead_form exists', () => {
    expect(primaryCta([{ id: 'b', type: 'booking', slug: 'x' }])).toEqual({
      href: '#book',
      label: 'Book a free consult',
    })
  })

  it('uses the event anchor + title when only an event block exists', () => {
    expect(primaryCta([{ id: 'e', type: 'event', slug: 'spring-race', title: 'Sign up' }])).toEqual({
      href: '#event-spring-race',
      label: 'Sign up',
    })
    // Slugless event still gets a stable anchor (matches the renderer id).
    expect(primaryCta([{ id: 'e', type: 'event' }]).href).toBe('#event-signup')
  })

  it('returns null when the page has no funnel block (no dead anchors)', () => {
    expect(primaryCta([{ id: 'h', type: 'hero' }, { id: 's', type: 'stats', items: [] }])).toBeNull()
    expect(primaryCta([])).toBeNull()
    expect(primaryCta(null)).toBeNull()
  })
})

describe('class_funnel block type', () => {
  it('is registered in the palette with the Glofox label', () => {
    const meta = BLOCK_TYPES.find((t) => t.type === 'class_funnel')
    expect(meta).toBeTruthy()
    expect(meta.label).toBe('Glofox Class Booking Funnel')
  })

  it('newBlockOfType builds a class_funnel with default copy', () => {
    const b = newBlockOfType('class_funnel')
    expect(b.type).toBe('class_funnel')
    expect(b.id).toBeTruthy()
    expect(b.heading).toBeTruthy()
    expect(b.consult_slug).toBe('') // no upsell until the operator picks one
  })

  it('blocksOrDefault keeps a saved class_funnel block', () => {
    const saved = [{ id: 'x1', type: 'class_funnel', heading: 'Hi' }]
    expect(blocksOrDefault(saved)).toHaveLength(1)
  })

  it('primaryCta points the header at the funnel anchor', () => {
    const cta = primaryCta([{ id: 'x1', type: 'class_funnel', heading: 'Book a class' }])
    expect(cta).toEqual({ href: '#start', label: 'Claim 3 free classes' })
  })

  it('lead_form still outranks class_funnel for the CTA', () => {
    const cta = primaryCta([
      { id: 'a', type: 'class_funnel' },
      { id: 'b', type: 'lead_form', button_label: 'Join' },
    ])
    expect(cta.href).toBe('#waitlist')
  })
})

describe('class_funnel trial product defaults', () => {
  it('newBlockOfType seeds empty trial fields', () => {
    const b = newBlockOfType('class_funnel')
    expect(b.trial_membership_id).toBe('')
    expect(b.trial_plan_code).toBe('')
  })
})

describe('class_funnel paid-intro defaults', () => {
  it('newBlockOfType seeds a free (0) price and EUR', () => {
    const b = newBlockOfType('class_funnel')
    expect(b.price_cents).toBe(0)
    expect(b.currency).toBe('EUR')
  })
})

describe('offerOf (HATCH-OFFER.1)', () => {
  const on = (extra = {}) => ({
    id: 'l', type: 'lead_form',
    offer: { enabled: true, price: '€189', cta_url: 'https://x.test/#join', cta_label: 'Claim your rate', ticks: ['a', 'b'], ...extra },
  })

  it('returns null when the block has no offer group', () => {
    expect(offerOf({ id: 'l', type: 'lead_form' })).toBeNull()
  })
  it('returns null when the offer is present but disabled', () => {
    expect(offerOf(on({ enabled: false }))).toBeNull()
  })
  it('returns null when enabled is anything but boolean true', () => {
    expect(offerOf(on({ enabled: 'yes' }))).toBeNull()
  })
  it('returns null for a non-object or array offer', () => {
    expect(offerOf({ id: 'l', type: 'lead_form', offer: 'nope' })).toBeNull()
    expect(offerOf({ id: 'l', type: 'lead_form', offer: ['nope'] })).toBeNull()
  })
  // A plain ['nope'] is already refused one line later by the
  // enabled !== true check, so it cannot tell us whether the
  // Array.isArray guard exists. An ENABLED array is the only shape
  // that reaches it — without the guard this returns an object and
  // the renderer then maps over a spread array.
  it('returns null for an array that claims to be enabled', () => {
    expect(offerOf({ id: 'l', type: 'lead_form', offer: Object.assign(['x'], { enabled: true }) })).toBeNull()
  })
  it('returns null for a null block', () => {
    expect(offerOf(null)).toBeNull()
  })
  it('coerces a missing or malformed ticks list to an empty array', () => {
    expect(offerOf(on({ ticks: undefined })).ticks).toEqual([])
    expect(offerOf(on({ ticks: 'a,b' })).ticks).toEqual([])
  })
  it('drops blank and non-string ticks', () => {
    expect(offerOf(on({ ticks: ['a', '  ', 7, 'b'] })).ticks).toEqual(['a', 'b'])
  })
  it('trims cta_url and falls back on a blank cta_label', () => {
    const o = offerOf(on({ cta_url: '  https://x.test/#join  ', cta_label: '   ' }))
    expect(o.cta_url).toBe('https://x.test/#join')
    expect(o.cta_label).toBe('Claim your rate')
  })
  it('treats a non-string cta_url as empty', () => {
    expect(offerOf(on({ cta_url: 42 })).cta_url).toBe('')
  })
})

describe('lead_form offer defaults (HATCH-OFFER.1)', () => {
  it('ships an offer group that is off by default', () => {
    const b = newBlockOfType('lead_form')
    expect(b.offer.enabled).toBe(false)
    expect(offerOf(b)).toBeNull()
  })
  it('says foundation, never founding, in the offer defaults', () => {
    const json = JSON.stringify(newBlockOfType('lead_form').offer).toLowerCase()
    expect(json).toContain('foundation')
    expect(json).not.toContain('founding')
  })
  it('defaults the claim link to the booking platform signup anchor', () => {
    expect(newBlockOfType('lead_form').offer.cta_url).toBe('https://hatchstreet.un1t.online/#join')
  })
  it('keeps a lead_form carrying a malformed offer renderable', () => {
    const kept = blocksOrDefault([{ id: 'l', type: 'lead_form', offer: 'broken' }])
    expect(kept).toHaveLength(1)
    expect(offerOf(kept[0])).toBeNull()
  })
})

describe('OFFER_DEFAULT seeding (HATCH-OFFER.1)', () => {
  // Every lead_form row in production was saved before the offer
  // group existed, so the editor seeds these on enable. If the shape
  // drifts from what OfferPanel reads, the operator ticks the box and
  // gets a panel with holes in it.
  it('carries every field the panel renders', () => {
    expect(Object.keys(OFFER_DEFAULT()).sort()).toEqual([
      'cta_label', 'cta_url', 'deadline', 'enabled', 'eyebrow', 'price',
      'section_eyebrow', 'section_heading', 'ticks', 'unit', 'was_price', 'was_price_note',
    ])
  })
  it('ships three tick lines, none blank', () => {
    const { ticks } = OFFER_DEFAULT()
    expect(ticks).toHaveLength(3)
    expect(ticks.every((t) => typeof t === 'string' && t.trim())).toBe(true)
  })
  it('survives offerOf once enabled, with nothing dropped', () => {
    const seeded = { ...OFFER_DEFAULT(), enabled: true }
    const o = offerOf({ id: 'l', type: 'lead_form', offer: seeded })
    expect(o).not.toBeNull()
    expect(o.price).toBe('€189')
    expect(o.ticks).toHaveLength(3)
    expect(o.cta_url).toBe('https://hatchstreet.un1t.online/#join')
  })
  it('is a factory, not a shared object — two calls must not alias', () => {
    const a = OFFER_DEFAULT()
    a.ticks.push('mutated')
    expect(OFFER_DEFAULT().ticks).toHaveLength(3)
  })
})

describe('pageCtas (HATCH-OFFER.1)', () => {
  const leadForm = (offer) => ({ id: 'l', type: 'lead_form', button_label: 'Keep me posted', ...(offer ? { offer } : {}) })
  const liveOffer = { enabled: true, cta_url: 'https://hatchstreet.un1t.online/#join', cta_label: 'Claim your rate' }

  it('promotes the offer to primary and demotes the form to secondary', () => {
    expect(pageCtas([leadForm(liveOffer)])).toEqual({
      primary: { href: 'https://hatchstreet.un1t.online/#join', label: 'Claim your rate', external: true },
      secondary: { href: '#waitlist', label: 'Keep me posted' },
    })
  })
  it('falls back to the form as primary when the offer is off', () => {
    expect(pageCtas([leadForm({ ...liveOffer, enabled: false })])).toEqual({
      primary: { href: '#waitlist', label: 'Keep me posted' },
      secondary: null,
    })
  })
  it('falls back to the form as primary when the offer has no url', () => {
    expect(pageCtas([leadForm({ ...liveOffer, cta_url: '   ' })])).toEqual({
      primary: { href: '#waitlist', label: 'Keep me posted' },
      secondary: null,
    })
  })
  it('never returns a secondary when there is no lead form', () => {
    expect(pageCtas([{ id: 'b', type: 'booking', slug: 'x' }]).secondary).toBeNull()
    expect(pageCtas([]).secondary).toBeNull()
  })
  it('returns both null for a page with no funnel block', () => {
    expect(pageCtas([{ id: 'h', type: 'hero' }])).toEqual({ primary: null, secondary: null })
  })
})

describe('primaryCta wraps pageCtas (HATCH-OFFER.1)', () => {
  it('returns the offer url when the offer is live', () => {
    const blocks = [{ id: 'l', type: 'lead_form', button_label: 'Keep me posted', offer: { enabled: true, cta_url: 'https://x.test/#join', cta_label: 'Claim' } }]
    expect(primaryCta(blocks).href).toBe('https://x.test/#join')
  })
  it('is identical to pageCtas().primary', () => {
    const blocks = [{ id: 'b', type: 'booking', slug: 'x' }]
    expect(primaryCta(blocks)).toEqual(pageCtas(blocks).primary)
  })
})
