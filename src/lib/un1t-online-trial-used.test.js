// UN1TWRITE.21 — the seam spec E fills; D ships defaults that do nothing.
import { describe, it, expect } from 'vitest'
import { trialUsedHandoff, trialUsedOptionsText } from './un1t-online-trial-used'

describe('the E seam defaults', () => {
  it('hand off nothing and list no options', async () => {
    expect(await trialUsedHandoff({}, { request: {}, contact: {}, locationId: 'loc-1' })).toEqual({ handled: false })
    expect(await trialUsedOptionsText({}, 'loc-1')).toBeNull()
  })
})
