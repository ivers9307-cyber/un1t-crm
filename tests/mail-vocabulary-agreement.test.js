// MAIL-ARCH.2 — every consumer of the Mail vocabulary agrees, on every row.
//
// Three readers of one set of predicates: the SERVER (which stamps `archived`
// and `needs_reply` on every row it hands out), the WEB components (which read
// the stamps through shared/mail-vocabulary via @/lib/mail-vocabulary), and
// the MOBILE list/swipe helpers (which read them through the `shared` seam).
// The refuter's finding that motivated the move was a mobile-only reading of
// `archived` that OR-ed status back in; tests/shared-pair-sync.test.js now
// proves the web and shared bindings are the same object, and this file
// proves the consumers that do not import the predicate directly (the mobile
// verdict helpers, the server's own definitions) still say the same thing
// over a matrix of rows — including the exact row that used to disagree.
import { describe, it, expect } from 'vitest'
import * as shared from '../shared/mail-vocabulary.js'
import * as web from '../src/components/mail/mail-vocabulary.js'
import * as mobile from '../mobile/lib/email-tickets.js'
import {
  isArchived as serverIsArchived,
  isNeedsReply as serverIsNeedsReply,
  stampMailRow,
  MAIL_VIEWS as SERVER_MAIL_VIEWS,
} from '../src/app/api/email/mail/_helpers.js'

// ── The matrix ───────────────────────────────────────────────────────────────
// Every combination of the columns the predicates read. `undefined` in a stamp
// column means "not stamped" (a row that did not come from a mail route).
const STATUSES = ['open', 'pending', 'solved', 'closed', undefined]
const DIRECTIONS = ['inbound', 'outbound', null]
const STAMPS = [true, false, undefined]
const ROWS = []
for (const status of STATUSES) {
  for (const last_message_direction of DIRECTIONS) {
    for (const archived of STAMPS) {
      for (const needs_reply of STAMPS) {
        for (const is_spam of [true, false, undefined]) {
          ROWS.push({ id: `t-${ROWS.length}`, status, last_message_direction, archived, needs_reply, is_spam, unread: false })
        }
      }
    }
  }
}
const stamped = ROWS.filter(r => typeof r.archived === 'boolean')
const unstamped = ROWS.filter(r => typeof r.archived !== 'boolean')

describe('the matrix is real', () => {
  it('covers stamped and unstamped rows, and the swipe-reopen row in particular', () => {
    expect(ROWS.length).toBe(STATUSES.length * DIRECTIONS.length * STAMPS.length * STAMPS.length * 3)
    expect(stamped.length).toBeGreaterThan(0)
    expect(unstamped.length).toBeGreaterThan(0)
    expect(ROWS.some(r => r.status === 'solved' && r.archived === false)).toBe(true)
  })
})

describe('web reads the shared implementation — the same objects, not copies', () => {
  it('every shared export is the identical binding on the web side', () => {
    for (const name of Object.keys(shared)) {
      expect(web[name], name).toBe(shared[name])
    }
  })
})

describe('mobile agrees with the shared predicates on every row', () => {
  it('archiveToggleMeta: `next` is the opposite of isArchived and `undoTo` IS isArchived — on every row, stamped or not', () => {
    for (const row of ROWS) {
      const meta = mobile.archiveToggleMeta(row)
      expect(meta.next, JSON.stringify(row)).toBe(!shared.isArchived(row))
      expect(meta.undoTo, JSON.stringify(row)).toBe(shared.isArchived(row))
      expect(meta.underlay).toBe(shared.isArchived(row) ? 'INBOX' : 'ARCHIVE')
    }
  })

  it('🔴 the swipe-reopen row: a solved conversation the server stamped LIVE archives, it does not "reopen"', () => {
    const row = { status: 'solved', archived: false, needs_reply: true, last_message_direction: 'inbound' }
    expect(shared.isArchived(row)).toBe(false)
    expect(mobile.archiveToggleMeta(row)).toEqual({
      next: true, undoTo: false, snack: 'Conversation archived', underlay: 'ARCHIVE',
    })
  })

  it('mailRowDisplay / mailStatusChip / ticketToInboxRow agree on every STAMPED row (the wire shape)', () => {
    for (const row of stamped) {
      const archived = shared.isArchived(row)
      const waiting = shared.needsReply(row)
      const d = mobile.mailRowDisplay(row)
      expect(d.rail, JSON.stringify(row)).toBe(!archived && waiting)
      expect(d.chip !== null, JSON.stringify(row)).toBe(archived)
      const chip = mobile.mailStatusChip(row)
      expect(chip?.label === 'Archived', JSON.stringify(row)).toBe(archived)
      expect(chip?.label === 'Needs reply', JSON.stringify(row)).toBe(!archived && waiting)
      expect(mobile.ticketToInboxRow(row).archived, JSON.stringify(row)).toBe(archived)
    }
  })

  it('needsReply: mailRowDisplay.rail tracks the shared predicate on every live row', () => {
    for (const row of ROWS) {
      if (shared.isArchived(row)) continue
      // mailRowDisplay derives `archived` its own way for UNSTAMPED rows (below),
      // so compare only where both sides agree the row is live.
      if (typeof row.archived !== 'boolean' && row.status === 'solved') continue
      expect(mobile.mailRowDisplay(row).rail, JSON.stringify(row)).toBe(shared.needsReply(row))
    }
  })

  // The ONE residual, pinned so it stays a decision rather than a surprise.
  // mailStatusChip / mailRowDisplay / ticketToInboxRow keep the ticket-era
  // `solved || closed` fallback for rows with NO stamp, because the THREAD
  // response (/api/email/tickets/[id], which the mobile thread screen renders
  // mailStatusChip from) carries no `archived` stamp today, and flipping how a
  // legacy solved thread's header chip reads is a second behaviour change this
  // PR deliberately does not make. archiveToggleMeta does NOT share the
  // residual — its rows always come through ticketToInboxRow, which stamps.
  it('unstamped rows: the mobile display helpers differ from shared ONLY on legacy `solved`', () => {
    for (const row of unstamped) {
      const chipSaysArchived = mobile.mailStatusChip(row)?.label === 'Archived'
      const rowSaysArchived = mobile.ticketToInboxRow(row).archived
      if (row.status === 'solved') {
        expect(chipSaysArchived, JSON.stringify(row)).toBe(true)
        expect(rowSaysArchived, JSON.stringify(row)).toBe(true)
        expect(shared.isArchived(row)).toBe(false)
      } else {
        expect(chipSaysArchived, JSON.stringify(row)).toBe(shared.isArchived(row))
        expect(rowSaysArchived, JSON.stringify(row)).toBe(shared.isArchived(row))
      }
    }
  })
})

describe('the server and the shared vocabulary mean the same thing', () => {
  it('shared isArchived with no stamp IS the server definition, status by status', () => {
    for (const status of [...STATUSES, 'junk', null]) {
      expect(shared.isArchived({ status }), String(status)).toBe(serverIsArchived({ status }))
    }
  })

  it('a row the server stamped reads back, through shared, as exactly what the server decided', () => {
    for (const raw of ROWS) {
      // A raw DB row has no stamps yet — strip them, stamp, read back.
      const dbRow = { ...raw }
      delete dbRow.archived
      delete dbRow.needs_reply
      const stampedRow = stampMailRow(dbRow)
      expect(shared.isArchived(stampedRow), JSON.stringify(dbRow)).toBe(serverIsArchived(dbRow))
      expect(shared.needsReply(stampedRow), JSON.stringify(dbRow)).toBe(serverIsNeedsReply(dbRow))
      // …and the stamped row is what mobile's swipe reads.
      expect(mobile.archiveToggleMeta(stampedRow).next).toBe(!serverIsArchived(dbRow))
    }
  })

  it('stampMailRow: the stamps WIN over a stale column of the same name on the row', () => {
    // email_tickets has no `archived` / `needs_reply` column today, so this
    // cannot happen from a DB read — but a row that has been through a client
    // and back (an optimistic merge, a re-shape) can carry stale stamps, and
    // the helper's contract is that its own verdict replaces them.
    const out = stampMailRow({ status: 'open', last_message_direction: 'inbound', archived: true, needs_reply: false })
    expect(out.archived).toBe(false)
    expect(out.needs_reply).toBe(true)
  })

  it('stampMailRow keeps every column and adds exactly the two stamps', () => {
    const out = stampMailRow({ id: 'x', status: 'open', last_message_direction: 'inbound', subject: 's' })
    expect(out).toEqual({
      id: 'x', status: 'open', last_message_direction: 'inbound', subject: 's',
      needs_reply: true, archived: false,
    })
  })

  it('the view ids are the same list on the wire and on screen, in the same order', () => {
    expect(shared.MAIL_VIEWS.map(v => v.id)).toEqual([...SERVER_MAIL_VIEWS])
  })
})
