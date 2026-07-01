import { describe, it, expect } from 'vitest'
import { extractVariableIndexes, buildBodyExample, buildHeaderTextExample, missingSampleError, samplesFromExample } from './whatsapp-template-samples.js'

describe('samplesFromExample', () => {
  it('maps a Meta example array to a 1-indexed sample map', () => {
    expect(samplesFromExample(['Sarah', 'UN1T'])).toEqual({ 1: 'Sarah', 2: 'UN1T' })
  })
  it('returns {} for missing/non-array input (new template)', () => {
    expect(samplesFromExample(undefined)).toEqual({})
    expect(samplesFromExample(null)).toEqual({})
  })
  it('round-trips with buildBodyExample', () => {
    const map = samplesFromExample(buildBodyExample('Hi {{1}} {{2}}', { 1: 'A', 2: 'B' }).body_text[0])
    expect(map).toEqual({ 1: 'A', 2: 'B' })
  })
})

describe('extractVariableIndexes', () => {
  it('returns distinct indexes in numeric order', () => {
    expect(extractVariableIndexes('Hi {{1}} at {{2}}')).toEqual([1, 2])
  })
  it('sorts and dedupes out-of-order / repeated vars', () => {
    expect(extractVariableIndexes('{{2}} then {{1}} then {{2}}')).toEqual([1, 2])
  })
  it('returns [] when there are no variables / bad input', () => {
    expect(extractVariableIndexes('no vars here')).toEqual([])
    expect(extractVariableIndexes('')).toEqual([])
    expect(extractVariableIndexes(null)).toEqual([])
  })
})

describe('buildBodyExample', () => {
  it('wraps operator samples in Meta body_text shape [[...]]', () => {
    expect(buildBodyExample('Hi {{1}}, welcome to {{2}}', { 1: 'Sarah', 2: 'UN1T' }))
      .toEqual({ body_text: [['Sarah', 'UN1T']] })
  })
  it('orders samples by variable index, not insertion order', () => {
    expect(buildBodyExample('{{2}} {{1}}', { 2: 'B', 1: 'A' }))
      .toEqual({ body_text: [['A', 'B']] })
  })
  it('returns null when the body has no variables', () => {
    expect(buildBodyExample('Static body', {})).toBeNull()
  })
  it('fills a missing sample with empty string (validation guards separately)', () => {
    expect(buildBodyExample('Hi {{1}}', {})).toEqual({ body_text: [['']] })
  })
})

describe('buildHeaderTextExample', () => {
  it('builds header_text for a text-header variable', () => {
    expect(buildHeaderTextExample('Order {{1}}', { 1: '1234' })).toEqual({ header_text: ['1234'] })
  })
  it('returns null when the header has no variable', () => {
    expect(buildHeaderTextExample('Welcome', {})).toBeNull()
  })
})

describe('missingSampleError', () => {
  it('flags a missing body sample', () => {
    expect(missingSampleError({ bodyText: 'Hi {{1}}', bodySamples: {} }))
      .toBe('Add a sample value for body variable {{1}}')
  })
  it('flags a missing header sample', () => {
    expect(missingSampleError({ bodyText: 'x', headerText: 'Order {{1}}', headerSamples: {} }))
      .toBe('Add a sample value for header variable {{1}}')
  })
  it('treats whitespace-only samples as missing', () => {
    expect(missingSampleError({ bodyText: 'Hi {{1}}', bodySamples: { 1: '   ' } }))
      .toBe('Add a sample value for body variable {{1}}')
  })
  it('passes when every variable has a non-empty sample', () => {
    expect(missingSampleError({ bodyText: 'Hi {{1}} {{2}}', bodySamples: { 1: 'A', 2: 'B' } })).toBeNull()
  })
  it('passes when there are no variables at all', () => {
    expect(missingSampleError({ bodyText: 'Static', headerText: 'Static' })).toBeNull()
  })
})
