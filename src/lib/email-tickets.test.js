// Tests for the pure ticket identity + lifecycle rules.
// No DB, no env — every function here is a pure decision function so the
// webhook can be reasoned about without a database.

import { describe, it, expect } from 'vitest'
import {
  resolveTicketAction,
  shouldStampFirstResponse,
  ticketSubject,
  ticketsDueForAutoClose,
  DEFAULT_AUTO_CLOSE_DAYS,
} from './email-tickets'

describe('resolveTicketAction', () => {
  it('creates a fresh ticket when nothing threaded', () => {
    expect(resolveTicketAction(null)).toEqual({ action: 'create', reopenedFrom: null })
  })

  it('creates a fresh ticket when the threaded row has no id', () => {
    expect(resolveTicketAction({ status: 'open' })).toEqual({ action: 'create', reopenedFrom: null })
  })

  it('appends to an open ticket without reopening it', () => {
    expect(resolveTicketAction({ id: 't1', status: 'open' }))
      .toEqual({ action: 'append', ticketId: 't1', reopen: false })
  })

  it('appends to a pending ticket and reopens it', () => {
    expect(resolveTicketAction({ id: 't2', status: 'pending' }))
      .toEqual({ action: 'append', ticketId: 't2', reopen: true })
  })

  it('appends to a solved ticket and reopens it', () => {
    expect(resolveTicketAction({ id: 't3', status: 'solved' }))
      .toEqual({ action: 'append', ticketId: 't3', reopen: true })
  })

  it('mints a NEW ticket when the thread resolves to a closed one', () => {
    expect(resolveTicketAction({ id: 't4', status: 'closed' }))
      .toEqual({ action: 'create', reopenedFrom: 't4' })
  })
})

describe('shouldStampFirstResponse', () => {
  it('stamps on the first outbound reply', () => {
    expect(shouldStampFirstResponse({
      firstResponseAt: null, direction: 'outbound', isInternalNote: false,
    })).toBe(true)
  })

  it('does not stamp twice', () => {
    expect(shouldStampFirstResponse({
      firstResponseAt: '2026-08-05T10:00:00Z', direction: 'outbound', isInternalNote: false,
    })).toBe(false)
  })

  it('does not stamp on inbound', () => {
    expect(shouldStampFirstResponse({
      firstResponseAt: null, direction: 'inbound', isInternalNote: false,
    })).toBe(false)
  })

  it('does not stamp on an internal note — the member never saw it', () => {
    expect(shouldStampFirstResponse({
      firstResponseAt: null, direction: 'outbound', isInternalNote: true,
    })).toBe(false)
  })
})

describe('ticketSubject', () => {
  it('takes the inbound subject for a new ticket', () => {
    expect(ticketSubject(null, 'Billing question')).toBe('Billing question')
  })

  it('KEEPS the original subject on an existing ticket', () => {
    // Deliberately unlike mig 394, where subject tracked the most recent inbound.
    // A ticket is named by the issue that opened it.
    expect(ticketSubject('Billing question', 'Re: Billing question')).toBe('Billing question')
  })

  it('falls back for an empty inbound subject', () => {
    expect(ticketSubject(null, '   ')).toBe('(no subject)')
    expect(ticketSubject(null, null)).toBe('(no subject)')
  })
})

describe('ticketsDueForAutoClose', () => {
  const now = Date.parse('2026-08-05T12:00:00Z')

  it('closes a solved ticket past the window', () => {
    const t = { id: 'a', status: 'solved', solved_at: '2026-07-20T12:00:00Z' }
    expect(ticketsDueForAutoClose([t], 7, now)).toEqual([t])
  })

  it('leaves a solved ticket inside the window', () => {
    const t = { id: 'b', status: 'solved', solved_at: '2026-08-04T12:00:00Z' }
    expect(ticketsDueForAutoClose([t], 7, now)).toEqual([])
  })

  it('ignores tickets that are not solved', () => {
    const t = { id: 'c', status: 'open', solved_at: '2026-07-01T12:00:00Z' }
    expect(ticketsDueForAutoClose([t], 7, now)).toEqual([])
  })

  it('ignores a solved ticket with no solved_at', () => {
    expect(ticketsDueForAutoClose([{ id: 'd', status: 'solved', solved_at: null }], 7, now)).toEqual([])
  })

  it('returns nothing for a nonsense window rather than closing everything', () => {
    const t = { id: 'e', status: 'solved', solved_at: '2026-01-01T12:00:00Z' }
    expect(ticketsDueForAutoClose([t], -1, now)).toEqual([])
    expect(ticketsDueForAutoClose([t], 'soon', now)).toEqual([])
    // These are the shapes that actually occur — an unset Postgres settings
    // column reads back null, an empty operator form field posts '' — not
    // exotic inputs. Number() coerces all four of these to 0, which is
    // finite and >= 0, so a loose guard lets them straight through.
    expect(ticketsDueForAutoClose([t], null, now)).toEqual([])
    expect(ticketsDueForAutoClose([t], '', now)).toEqual([])
    expect(ticketsDueForAutoClose([t], false, now)).toEqual([])
    expect(ticketsDueForAutoClose([t], [], now)).toEqual([])
  })

  it('honours an explicit numeric 0 as close-as-soon-as-solved', () => {
    const t = { id: 'f', status: 'solved', solved_at: '2026-08-05T11:00:00Z' }
    expect(ticketsDueForAutoClose([t], 0, now)).toEqual([t])
  })

  it('tolerates a non-array', () => {
    for (const bad of [null, undefined, '', {}, 0]) {
      expect(ticketsDueForAutoClose(bad, 7, now)).toEqual([])
    }
  })

  it('uses DEFAULT_AUTO_CLOSE_DAYS as a real window, and includes the exact cutoff', () => {
    const dayMs = 86_400_000
    const atCutoff = {
      id: 'g', status: 'solved',
      solved_at: new Date(now - DEFAULT_AUTO_CLOSE_DAYS * dayMs).toISOString(),
    }
    const anHourFresher = {
      id: 'h', status: 'solved',
      solved_at: new Date(now - DEFAULT_AUTO_CLOSE_DAYS * dayMs + 3_600_000).toISOString(),
    }
    expect(ticketsDueForAutoClose([atCutoff, anHourFresher], DEFAULT_AUTO_CLOSE_DAYS, now))
      .toEqual([atCutoff])
  })
})
