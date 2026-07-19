// RCOV — re-hunt queue-patch semantics.
//
// The wedge this guards against: claim_recon_hunt_batch (mig 370) and
// the QStash worker's CAS (src/lib/recon/hunt-queue.js) only claim
// rows whose status is uncovered/not_found. A needs_attention line
// re-queued AS-IS is therefore queued-but-unclaimable — before the
// finalizer's own status-filtered pending gate, one click on Re-hunt
// wedged the weekly report + heartbeat forever. The patch must re-open
// a needs_attention line as 'uncovered' so the drain can actually
// claim it; uncovered/not_found lines keep their status (huntLine's
// own outcome moves them, unchanged).
import { describe, it, expect } from 'vitest'
import { ALLOWED_FROM, rehuntPatch } from './route'

const NOW = '2026-07-19T12:00:00.000Z'

describe('ALLOWED_FROM', () => {
  it('permits exactly the operator-rehuntable states', () => {
    expect(ALLOWED_FROM).toEqual(['uncovered', 'not_found', 'needs_attention'])
  })
})

describe('rehuntPatch', () => {
  it('re-opens a needs_attention line as uncovered so the claim paths can drain it', () => {
    expect(rehuntPatch({ status: 'needs_attention' }, NOW)).toEqual({
      status: 'uncovered',
      hunt_queued_at: NOW,
      hunt_claimed_at: null,
      updated_at: NOW,
    })
  })

  it('leaves an uncovered line status untouched (huntLine outcome moves it)', () => {
    expect(rehuntPatch({ status: 'uncovered' }, NOW)).not.toHaveProperty('status')
  })

  it('leaves a not_found line status untouched', () => {
    expect(rehuntPatch({ status: 'not_found' }, NOW)).toEqual({
      hunt_queued_at: NOW,
      hunt_claimed_at: null,
      updated_at: NOW,
    })
  })
})
