import { describe, it, expect } from 'vitest'
import { parseCsv } from './csv-parse.js'

describe('parseCsv', () => {
  it('returns empty for empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] })
    expect(parseCsv(null)).toEqual({ headers: [], rows: [] })
    expect(parseCsv(undefined)).toEqual({ headers: [], rows: [] })
  })

  it('parses a basic 2-column CSV', () => {
    const { headers, rows } = parseCsv('email,total\nme@x.com,99')
    expect(headers).toEqual(['email', 'total'])
    expect(rows).toEqual([{ email: 'me@x.com', total: '99' }])
  })

  it('lowercases + normalises header keys (spaces, casing)', () => {
    // Glofox CSV exports use Title Case headers with spaces.
    const { rows } = parseCsv('Member Email,Total Amount\nme@x.com,99')
    expect(rows[0]).toEqual({ member_email: 'me@x.com', total_amount: '99' })
  })

  it('handles quoted fields with embedded commas', () => {
    const { rows } = parseCsv('name,note\n"Smith, Jane","note, with comma"')
    expect(rows[0]).toEqual({ name: 'Smith, Jane', note: 'note, with comma' })
  })

  it('handles escaped quotes inside quoted fields', () => {
    const { rows } = parseCsv('label,quote\nA,"he said ""hi"""')
    expect(rows[0]).toEqual({ label: 'A', quote: 'he said "hi"' })
  })

  it('handles CRLF line endings', () => {
    const { rows } = parseCsv('a,b\r\n1,2\r\n3,4')
    expect(rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }])
  })

  it('handles CR-only line endings (legacy Mac)', () => {
    const { rows } = parseCsv('a,b\r1,2\r3,4')
    expect(rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }])
  })

  it('skips blank lines between rows', () => {
    const { rows } = parseCsv('a,b\n1,2\n\n3,4\n')
    expect(rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }])
  })

  it('handles missing trailing fields (shorter row than header)', () => {
    const { rows } = parseCsv('a,b,c\n1,2')
    expect(rows[0]).toEqual({ a: '1', b: '2', c: '' })
  })

  it('handles quoted multi-line fields', () => {
    const { rows } = parseCsv('a,b\n"line1\nline2","x"')
    expect(rows[0]).toEqual({ a: 'line1\nline2', b: 'x' })
  })
})
