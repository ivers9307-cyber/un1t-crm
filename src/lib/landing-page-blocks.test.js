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
