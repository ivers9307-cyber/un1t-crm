// Tests for the pure ticket identity + lifecycle rules.
// No DB, no env — every function here is a pure decision function so the
// webhook can be reasoned about without a database.

import { describe, it, expect } from 'vitest'
import {
  resolveTicketAction,
  shouldStampFirstResponse,
  ticketSubject,
  pickThreadedTicket,
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

describe('pickThreadedTicket', () => {
  const a = { ticket_id: 'T1', created_at: '2026-08-01T10:00:00Z' }
  const b = { ticket_id: 'T2', created_at: '2026-08-05T10:00:00Z' }

  it('picks the most recent message’s ticket, whatever order the rows arrive in', () => {
    expect(pickThreadedTicket([a, b])).toBe('T2')
    expect(pickThreadedTicket([b, a])).toBe('T2')
  })

  it('ignores rows with no ticket_id, however recent', () => {
    expect(pickThreadedTicket([{ ticket_id: null, created_at: '2026-08-09T10:00:00Z' }, a]))
      .toBe('T1')
  })

  it('returns null when nothing threads', () => {
    expect(pickThreadedTicket([])).toBeNull()
    expect(pickThreadedTicket(null)).toBeNull()
    expect(pickThreadedTicket(undefined)).toBeNull()
    expect(pickThreadedTicket([{ ticket_id: null, created_at: '2026-08-01T10:00:00Z' }])).toBeNull()
  })

  it('is deterministic when timestamps tie — lowest id wins', () => {
    // Rows written in one transaction share a created_at. Falling back to
    // array order there is routing by database row order, which is the bug
    // class this whole module exists to refuse.
    const t = '2026-08-05T10:00:00Z'
    expect(pickThreadedTicket([{ ticket_id: 'B', created_at: t }, { ticket_id: 'A', created_at: t }]))
      .toBe('A')
    expect(pickThreadedTicket([{ ticket_id: 'A', created_at: t }, { ticket_id: 'B', created_at: t }]))
      .toBe('A')
  })

  it('skips an unparseable created_at rather than choosing it', () => {
    expect(pickThreadedTicket([{ ticket_id: 'X', created_at: 'nonsense' }, b])).toBe('T2')
    expect(pickThreadedTicket([{ ticket_id: 'X', created_at: null }])).toBeNull()
    expect(pickThreadedTicket([{ ticket_id: 'X' }])).toBeNull()
  })
})
