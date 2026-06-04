import { describe, it, expect } from 'vitest'
import { smsSegmentInfo, waBodyVariables, SMS_MAX_LEN, SMS_MERGE_TAGS, WA_VARIABLE_FIELDS } from './compose.js'

describe('smsSegmentInfo', () => {
  it('reports 0 segments for empty text', () => {
    expect(smsSegmentInfo('')).toEqual({ len: 0, segments: 0 })
    expect(smsSegmentInfo(null)).toEqual({ len: 0, segments: 0 })
    expect(smsSegmentInfo(undefined)).toEqual({ len: 0, segments: 0 })
  })

  it('is 1 segment up to 160 chars', () => {
    expect(smsSegmentInfo('a')).toEqual({ len: 1, segments: 1 })
    expect(smsSegmentInfo('a'.repeat(160))).toEqual({ len: 160, segments: 1 })
  })

  it('rolls to 2 segments at 161 (153 chars/segment concatenated)', () => {
    expect(smsSegmentInfo('a'.repeat(161))).toEqual({ len: 161, segments: 2 })
    expect(smsSegmentInfo('a'.repeat(306))).toEqual({ len: 306, segments: 2 })
    expect(smsSegmentInfo('a'.repeat(307))).toEqual({ len: 307, segments: 3 })
  })

  it('exposes the hard cap + merge tags', () => {
    expect(SMS_MAX_LEN).toBe(1600)
    expect(SMS_MERGE_TAGS.map(t => t.tag)).toContain('{{first_name}}')
  })
})

describe('waBodyVariables', () => {
  const tpl = (text) => ({ components: [{ type: 'HEADER', text: 'hi' }, { type: 'BODY', text }] })

  it('returns [] when no template / no body', () => {
    expect(waBodyVariables(null)).toEqual([])
    expect(waBodyVariables({})).toEqual([])
    expect(waBodyVariables({ components: [{ type: 'HEADER', text: 'x {{1}}' }] })).toEqual([])
  })

  it('extracts, dedupes and sorts numeric placeholders from BODY only', () => {
    expect(waBodyVariables(tpl('Hi {{1}}, your {{2}} is ready'))).toEqual(['1', '2'])
    expect(waBodyVariables(tpl('{{2}} then {{1}} then {{2}} again'))).toEqual(['1', '2'])
    expect(waBodyVariables(tpl('no vars here'))).toEqual([])
  })

  it('sorts numerically, not lexically (10 after 9)', () => {
    expect(waBodyVariables(tpl('{{10}} {{2}} {{1}}'))).toEqual(['1', '2', '10'])
  })

  it('exposes the mappable contact fields', () => {
    expect(WA_VARIABLE_FIELDS).toContain('first_name')
    expect(WA_VARIABLE_FIELDS).toContain('location_name')
  })
})
