// HYROX-TC — the block-regenerate route runs arc generation (the heaviest Claude
// call in the feature, max_tokens 8000). It MUST provision the same 300s function
// timeout as the sibling arc/session generation routes (POST /api/hyrox/blocks,
// sessions/[id]/regenerate). 120s timed the function out mid-call in prod on the
// first live click — 504, no arc, no wipe (2026-07-23). This locks that in.
import { describe, it, expect } from 'vitest'
import { maxDuration } from './route'

describe('POST /api/hyrox/blocks/[id]/regenerate', () => {
  it('provisions the full 300s timeout for arc generation (regression: 120s 504)', () => {
    expect(maxDuration).toBe(300)
  })
})
