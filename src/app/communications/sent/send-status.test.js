// COMMSFIX.C.5 — the sends list is where an operator finds out a campaign died.
//
// STATUS_STYLE had no 'failed' entry, so a failed campaign fell through to the
// grey 'draft' style — visually identical to a campaign nobody has sent yet —
// and there was nowhere to say WHY. A campaign whose populate keeps erroring
// sat at an amber "queued" chip forever; the 8 Aug audience truncation lived in
// exactly that blind spot.
//
// The decision is a pure function so it is testable without rendering the
// server component (page.js holds JSX in a .js file, which the node-environment
// vitest transform cannot import).

import { describe, it, expect } from 'vitest'
import { sendStatusChip } from './send-status.js'

describe('sendStatusChip (COMMSFIX.C.5)', () => {
  it('gives a failed send a RED chip, not the grey draft fallback', () => {
    const chip = sendStatusChip({ status: 'failed' })
    expect(chip.className).toMatch(/rose/)
    expect(chip.className).not.toBe(sendStatusChip({ status: 'draft' }).className)
  })

  it('carries last_error as the chip title so the operator learns why', () => {
    const chip = sendStatusChip({ status: 'failed', last_error: 'audience query failed: column contacts.foo does not exist' })
    expect(chip.title).toBe('audience query failed: column contacts.foo does not exist')
  })

  it('surfaces a last_error even while the campaign is still queued and retrying', () => {
    // The status stays 'queued' until the grace window expires (see
    // campaignFailurePatch), but the operator should be able to hover and see
    // that something is going wrong right now.
    const chip = sendStatusChip({ status: 'queued', last_error: 'postmark 500' })
    expect(chip.title).toBe('postmark 500')
    expect(chip.className).toMatch(/amber/)
  })

  it('has no title at all for a healthy send', () => {
    expect(sendStatusChip({ status: 'sent' }).title).toBeUndefined()
    expect(sendStatusChip({ status: 'sent' }).className).toMatch(/emerald/)
  })

  it('falls back to the draft style for an unknown status', () => {
    expect(sendStatusChip({ status: 'weird' }).className)
      .toBe(sendStatusChip({ status: 'draft' }).className)
  })

  it('keeps the existing statuses on their existing colours', () => {
    expect(sendStatusChip({ status: 'scheduled' }).className).toMatch(/blue/)
    expect(sendStatusChip({ status: 'sending' }).className).toMatch(/amber/)
    expect(sendStatusChip({ status: 'cancelled' }).className).toMatch(/rose/)
  })
})
