// HATCHINV.1 — the Arrears tile's money format. Under €1,000 the text is what
// it always was (Stillorgan is byte-identical); from €1,000 up it carries the
// thousands separator the contact header used before the tile took over.
import { describe, it, expect } from 'vitest'
import { arrearsTile } from './command-centre-arrears'

describe('arrearsTile money format', () => {
  it('under €1,000 is unchanged: whole euros, no separator, rounded', () => {
    expect(arrearsTile({ arrearsCents: 0, arrearsCount: 0 }, null).text).toBe('€0')
    expect(arrearsTile({ arrearsCents: 5000, arrearsCount: 1 }, null).text).toBe('€50')
    expect(arrearsTile({ arrearsCents: 4999, arrearsCount: 1 }, null).text).toBe('€50')
    expect(arrearsTile({ arrearsCents: 50, arrearsCount: 1 }, null).text).toBe('€1')
    expect(arrearsTile({ arrearsCents: 99949, arrearsCount: 1 }, null).text).toBe('€999')
  })

  it('€1,000 and over keeps the thousands separator', () => {
    expect(arrearsTile({ arrearsCents: 123400, arrearsCount: 1 }, null).text).toBe('€1,234')
  })

  it('the separator also shows on a Glofox + un1t.online sum and before the "+ amount" note', () => {
    expect(arrearsTile({ arrearsCents: 100000, arrearsCount: 1 }, { overdue: true, arrears_cents: 23400, studios: [] }).text).toBe('€1,234')
    expect(arrearsTile(null, { overdue: true, arrears_cents: 250000, amount_unreported: true, studios: [] }).text).toBe('€2,500 + amount not reported')
  })
})
