import { describe, it, expect } from 'vitest'
import {
  newBlockId,
  newBlockOfType,
  defaultBlocks,
  blocksOrDefault,
  BLOCK_TYPES,
  BlocksArraySchema,
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
