// COMMSFIX.C.5 — a campaign that cannot send must SAY SO.
//
// Today a failing tick logs to Vercel and returns the error in the cron's JSON
// summary, and that is the entire trail: the campaign row keeps status 'queued'
// forever, the sends list shows an amber "queued" chip, and an operator has no
// way to learn their send is dead. The 8 Aug audience truncation lived in this
// blind spot.
//
// Two rules, tested as a pure decision function so the cron's Supabase plumbing
// stays out of it:
//   1. EVERY failing tick stamps campaigns.last_error (mig 509).
//   2. Status flips to 'failed' only once it is genuinely stuck: an error was
//      already on the row coming into this tick, populate never completed
//      (send_started_at null) and the campaign is older than the grace window.

import { describe, it, expect } from 'vitest'
import { campaignFailurePatch, QUEUED_FAILURE_GRACE_MS } from './route.js'

const NOW = Date.parse('2026-08-09T12:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()

const queued = (over = {}) => ({
  id: 'camp-1',
  created_at: ago(60 * 60_000),
  send_started_at: null,
  last_error: null,
  ...over,
})

describe('campaignFailurePatch (COMMSFIX.C.5)', () => {
  it('stamps last_error on the first failing tick, without failing the campaign', () => {
    const patch = campaignFailurePatch(queued(), 'audience query failed: column x does not exist', NOW)
    expect(patch.last_error).toMatch(/column x does not exist/)
    expect(patch.status).toBeUndefined()
  })

  it('flips to failed once an error was ALREADY on the row and populate never started', () => {
    const patch = campaignFailurePatch(
      queued({ last_error: 'audience query failed' }),
      'audience query failed',
      NOW,
    )
    expect(patch.status).toBe('failed')
    expect(patch.last_error).toBe('audience query failed')
  })

  it('never fails a campaign that already started sending — chunks retry, they do not die', () => {
    const patch = campaignFailurePatch(
      queued({ last_error: 'postmark blip', send_started_at: ago(5 * 60_000) }),
      'postmark blip again',
      NOW,
    )
    expect(patch.status).toBeUndefined()
    expect(patch.last_error).toBe('postmark blip again')
  })

  it('holds off inside the grace window — a fresh campaign gets to retry', () => {
    const patch = campaignFailurePatch(
      queued({ created_at: ago(2 * 60_000), last_error: 'transient' }),
      'transient',
      NOW,
    )
    expect(patch.status).toBeUndefined()
  })

  it('grace window is 15 minutes', () => {
    expect(QUEUED_FAILURE_GRACE_MS).toBe(15 * 60_000)
  })

  it('truncates a runaway error message so one bad tick cannot bloat the row', () => {
    const patch = campaignFailurePatch(queued(), 'x'.repeat(5000), NOW)
    expect(patch.last_error.length).toBeLessThanOrEqual(1000)
  })

  it('handles a non-string error without writing "[object Object]" nonsense as the whole message', () => {
    const patch = campaignFailurePatch(queued(), new Error('boom'), NOW)
    expect(patch.last_error).toContain('boom')
  })
})
