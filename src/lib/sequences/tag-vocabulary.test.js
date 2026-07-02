import { describe, it, expect } from 'vitest'
import { PLATFORM_TAGS, knownTagVocabulary, isPhantomTag } from './tag-vocabulary.js'
import { EVENT_TYPE_TAGS } from '../glofox.js'

describe('PLATFORM_TAGS stays in sync with real writers', () => {
  it('is a superset of every Glofox webhook event tag', () => {
    const eventTags = Object.values(EVENT_TYPE_TAGS).flat()
    for (const tag of eventTags) {
      expect(PLATFORM_TAGS, `EVENT_TYPE_TAGS writes '${tag}' but PLATFORM_TAGS omits it`).toContain(tag)
    }
  })

  it('carries the trial-transition + first-booking tags', () => {
    for (const tag of [
      'glofox_trial_ended', 'glofox_trial_converted', 'glofox_trial_credits_low',
      'glofox_trial_engaged', 'glofox_first_booking',
    ]) expect(PLATFORM_TAGS).toContain(tag)
  })

  it('has no duplicates', () => {
    expect(new Set(PLATFORM_TAGS).size).toBe(PLATFORM_TAGS.length)
  })
})

describe('knownTagVocabulary', () => {
  it('includes platform tags plus tags applied by the graph itself', () => {
    const graph = { nodes: [
      { id: 'a', type: 'apply_tag', config: { tag: 'my_custom_marker' } },
      { id: 'b', type: 'whatsapp', config: { template_id: 't' } },
    ] }
    const vocab = knownTagVocabulary(graph)
    expect(vocab.has('glofox_first_booking')).toBe(true)
    expect(vocab.has('my_custom_marker')).toBe(true)
    expect(vocab.has('never_written_anywhere')).toBe(false)
  })

  it('tolerates a null/empty graph', () => {
    expect(knownTagVocabulary(null).has('glofox_trial_engaged')).toBe(true)
    expect(knownTagVocabulary({}).has('glofox_trial_engaged')).toBe(true)
  })
})

describe('isPhantomTag', () => {
  const vocab = knownTagVocabulary({ nodes: [{ type: 'apply_tag', config: { tag: 'sent_marker' } }] })

  it('flags the live bug: a tag nothing writes', () => {
    expect(isPhantomTag('first_booking_made', vocab)).toBe(true)
  })

  it('accepts platform tags and in-graph applied tags', () => {
    expect(isPhantomTag('glofox_first_booking', vocab)).toBe(false)
    expect(isPhantomTag('sent_marker', vocab)).toBe(false)
  })

  it('never flags an empty tag (that is a validation error, not a phantom)', () => {
    expect(isPhantomTag('', vocab)).toBe(false)
    expect(isPhantomTag('   ', vocab)).toBe(false)
    expect(isPhantomTag(null, vocab)).toBe(false)
  })
})
