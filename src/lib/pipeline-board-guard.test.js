import { describe, it, expect } from 'vitest'
import { assertNotLegacyBoard } from './pipeline-board-guard.js'

describe('assertNotLegacyBoard', () => {
  it('legacyBoardRefused', async () => {
    const res = assertNotLegacyBoard({ board_type: null })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: "This board is built in code and can't be changed here." })
  })
  it('configuredBoardAllowed', () => {
    expect(assertNotLegacyBoard({ board_type: 'acquisition' })).toBeNull()
  })
})
