// STUDIO-KPI.4 — parse/format for the operator-editable trainer-name
// mapping (settings.glofox.trainer_names). The settings tab shows the
// map as "trainerId = Name" lines; these helpers round-trip it.

import { describe, it, expect } from 'vitest'
import { parseTrainerNames, formatTrainerNames } from './glofox-trainer-names'

const ID1 = '61a38e7d0cf1970aae0fb3a9'
const ID2 = 'deadbeefdeadbeefdeadbeef'

describe('parseTrainerNames', () => {
  it('parses "id = Name" lines into a map', () => {
    expect(parseTrainerNames(`${ID1} = Jess Murphy\n${ID2} = Dan Byrne`)).toEqual({
      [ID1]: 'Jess Murphy',
      [ID2]: 'Dan Byrne',
    })
  })

  it('accepts ":" as the separator and tolerates loose whitespace', () => {
    expect(parseTrainerNames(`  ${ID1}: Jess Murphy  `)).toEqual({ [ID1]: 'Jess Murphy' })
  })

  it('lowercases ids so lookups match Glofox payload ids', () => {
    expect(parseTrainerNames(`${ID2.toUpperCase()} = Dan`)).toEqual({ [ID2]: 'Dan' })
  })

  it('ignores blank lines and lines that are not id = name', () => {
    expect(parseTrainerNames(`\nnot a mapping\n${ID1} = Jess\nshort1234 = Nope\n`))
      .toEqual({ [ID1]: 'Jess' })
  })

  it('returns null when nothing parses (so settings stores no empty object)', () => {
    expect(parseTrainerNames('')).toBeNull()
    expect(parseTrainerNames('   \n junk ')).toBeNull()
    expect(parseTrainerNames(null)).toBeNull()
  })
})

describe('formatTrainerNames', () => {
  it('round-trips through parseTrainerNames', () => {
    const map = { [ID1]: 'Jess Murphy', [ID2]: 'Dan Byrne' }
    expect(parseTrainerNames(formatTrainerNames(map))).toEqual(map)
  })

  it('returns "" for empty / missing maps', () => {
    expect(formatTrainerNames(null)).toBe('')
    expect(formatTrainerNames({})).toBe('')
    expect(formatTrainerNames('x')).toBe('')
  })
})
