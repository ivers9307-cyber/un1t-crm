// STUDIO-KPI.4 — parse/format for the operator-editable trainer-name
// mapping (settings.glofox.trainer_names). The settings tab shows the
// map as "trainerId = Name" lines; these helpers round-trip it.

import { describe, it, expect } from 'vitest'
import { parseTrainerNames, formatTrainerNames } from './glofox-trainer-names'

const ID1 = 'aaaaaaaaaaaaaaaaaaaaaaa1'
const ID2 = 'deadbeefdeadbeefdeadbeef'

describe('parseTrainerNames', () => {
  it('parses "id = Name" lines into a map', () => {
    expect(parseTrainerNames(`${ID1} = Coach One\n${ID2} = Coach Two`)).toEqual({
      [ID1]: 'Coach One',
      [ID2]: 'Coach Two',
    })
  })

  it('accepts ":" as the separator and tolerates loose whitespace', () => {
    expect(parseTrainerNames(`  ${ID1}: Coach One  `)).toEqual({ [ID1]: 'Coach One' })
  })

  it('lowercases ids so lookups match Glofox payload ids', () => {
    expect(parseTrainerNames(`${ID2.toUpperCase()} = Dan`)).toEqual({ [ID2]: 'Dan' })
  })

  it('ignores blank lines and lines that are not id = name', () => {
    expect(parseTrainerNames(`\nnot a mapping\n${ID1} = Coach One\nshort1234 = Nope\n`))
      .toEqual({ [ID1]: 'Coach One' })
  })

  it('returns null when nothing parses (so settings stores no empty object)', () => {
    expect(parseTrainerNames('')).toBeNull()
    expect(parseTrainerNames('   \n junk ')).toBeNull()
    expect(parseTrainerNames(null)).toBeNull()
  })
})

describe('formatTrainerNames', () => {
  it('round-trips through parseTrainerNames', () => {
    const map = { [ID1]: 'Coach One', [ID2]: 'Coach Two' }
    expect(parseTrainerNames(formatTrainerNames(map))).toEqual(map)
  })

  it('returns "" for empty / missing maps', () => {
    expect(formatTrainerNames(null)).toBe('')
    expect(formatTrainerNames({})).toBe('')
    expect(formatTrainerNames('x')).toBe('')
  })
})
