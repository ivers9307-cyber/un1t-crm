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
import * as mobileRelate from '../mobile/lib/mail-relate.js'
import * as webRelate from '../src/components/mail/mail-relate.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

  // MAIL-ARCH.4 — there is NO residual any more. MAIL-ARCH.3 left one:
  // mailStatusChip / mailRowDisplay / ticketToInboxRow (and the thread screen
  // and mail-relate.js) read shared.archivedOrStatus, whose stampless
  // fallback was the ticket-era `solved || closed`, kept for the window between
  // the Vercel deploy that taught the thread/related routes to stamp and the
  // OTA that taught the phone to read it. That window closed (#1619 live,
  // 5 Sep 2026) and the sibling is deleted, so every mobile helper reads
  // shared.isArchived and agrees with it on EVERY row, stamped or not — a
  // stampless legacy `solved` reads live, exactly as the server stamps it.
  it('unstamped rows: the mobile display helpers agree with shared on EVERY row — no `solved` residual', () => {
    for (const row of unstamped) {
      const chipSaysArchived = mobile.mailStatusChip(row)?.label === 'Archived'
      const rowSaysArchived = mobile.ticketToInboxRow(row).archived
      expect(chipSaysArchived, JSON.stringify(row)).toBe(shared.isArchived(row))
      expect(rowSaysArchived, JSON.stringify(row)).toBe(shared.isArchived(row))
    }
    // Spelled out: the row the two readings used to disagree on.
    expect(mobile.ticketToInboxRow({ id: 't', status: 'solved' }).archived).toBe(false)
    expect(mobile.mailStatusChip({ status: 'solved', needs_reply: false })).toBeNull()
  })
})

// ── MAIL-ARCH.3/4 — the two twins of the swipe-reopen bug ───────────────────
//
// The mobile THREAD screen (header chip + archive toggle) and mail-relate.js
// (nudge View target, merge picker) re-derived `archived` from status because
// the thread and related routes stamped nothing. Both routes stamp through
// stampMailRow (MAIL-ARCH.3), and both call sites — and the web's
// mail-relate.js twin (MAIL-ARCH.4) — read shared.isArchived: the stamp.
describe('MAIL-ARCH.4 — isArchived is the ONE reading of the stamp, on every surface', () => {
  it('archivedOrStatus no longer exists on shared or web', () => {
    expect(shared.archivedOrStatus).toBeUndefined()
    expect(web.archivedOrStatus).toBeUndefined()
  })

  it('a row the server stamped reads back, through shared, as exactly what the server decided', () => {
    for (const raw of ROWS) {
      const dbRow = { ...raw }
      delete dbRow.archived
      delete dbRow.needs_reply
      expect(shared.isArchived(stampMailRow(dbRow)), JSON.stringify(dbRow)).toBe(serverIsArchived(dbRow))
    }
  })

  // resolved_at follows the SAME verdict as `archived`: a row the server
  // stamps LIVE carries no resolution time even if the ticket-era solved_at
  // column is set — mobile/lib/inbox.js's needs-reply queue keys on it, and a
  // stamped-live row with a resolved_at would be filed as resolved.
  it('ticketToInboxRow.resolved_at is null exactly when the row is live — on every row of the matrix', () => {
    for (const row of ROWS) {
      const shaped = mobile.ticketToInboxRow({ ...row, solved_at: '2026-08-06T12:00:00Z', closed_at: null, updated_at: null })
      expect(shaped.resolved_at === null, JSON.stringify(row)).toBe(!shared.isArchived(row))
    }
    // The twin row, spelled out: solved on disk, LIVE on the wire, not resolved.
    const live = mobile.ticketToInboxRow({ status: 'solved', archived: false, solved_at: '2026-08-06T12:00:00Z' })
    expect(live.archived).toBe(false)
    expect(live.resolved_at).toBeNull()
  })

  it('mobile mail-relate agrees with the shared predicate on EVERY row (nudge target + picker)', () => {
    const now = new Date('2026-09-05T12:00:00Z')
    for (const row of ROWS) {
      const [picked] = mobileRelate.mergePickerRows([row], now)
      expect(picked.archived, JSON.stringify(row)).toBe(shared.isArchived(row))
      expect(picked.detail.includes('archived'), JSON.stringify(row)).toBe(shared.isArchived(row))
      // The nudge's View target is the first row shared calls live.
      const nudge = mobileRelate.relatedNudge({ related: [row], open_count: 1 })
      expect(nudge.viewId, JSON.stringify(row)).toBe(shared.isArchived(row) ? null : row.id)
    }
  })

  it('web mail-relate agrees with the shared predicate on EVERY row — the same reading as the phone', () => {
    for (const row of ROWS) {
      expect(webRelate.isOpenRelated(row), JSON.stringify(row)).toBe(!shared.isArchived(row))
      expect(webRelate.candidateLine(row).includes('archived'), JSON.stringify(row)).toBe(shared.isArchived(row))
      // …and the two twins say the same thing about the same row.
      expect(webRelate.isOpenRelated(row), JSON.stringify(row)).toBe(!mobileRelate.mergePickerRows([row])[0].archived)
    }
  })

  it('🔴 the twin rows: a solved conversation the server stamped LIVE is live in the picker and the nudge, on both surfaces', () => {
    const row = { id: 't-solved-live', status: 'solved', archived: false, needs_reply: false }
    expect(mobileRelate.mergePickerRows([row])[0].archived).toBe(false)
    expect(mobileRelate.relatedNudge({ related: [row], open_count: 1 }).viewId).toBe('t-solved-live')
    expect(webRelate.isOpenRelated(row)).toBe(true)
    expect(webRelate.newestOpenRelated([row])).toBe(row)
  })

  // The thread screen is a React Native component vitest cannot mount; pin
  // its two call sites at source level so the re-derivation cannot creep back
  // under a different import.
  it('the mobile thread screen reads isArchived(ticket) twice and nothing older', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '..', 'mobile/app/(staff)/email/[ticketId].jsx'), 'utf8')
    expect(src).not.toMatch(/isArchivedStatus|archivedOrStatus\(/)
    expect(src).toMatch(/from 'shared\/mail-vocabulary'/)
    // Both twins: the toggle's `next` and the header's `archived`.
    expect(src.match(/isArchived\(ticket\)/g)?.length).toBe(2)
  })

  it('neither mail-relate twin re-derives from status any more', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const rel of ['mobile/lib/mail-relate.js', 'src/components/mail/mail-relate.js']) {
      const src = readFileSync(join(here, '..', rel), 'utf8')
      expect(src, rel).not.toMatch(/isArchivedStatus|archivedOrStatus\(/)
      // Any spelling of a status-derived archive verdict: quoted closed/solved,
      // the ARCHIVED_STATUS constant, or a bare 'solved' literal anywhere.
      expect(src, rel).not.toMatch(/status\s*[!=]==?\s*['"](closed|solved)['"]|ARCHIVED_STATUS|['"]solved['"]/)
      expect(src, rel).toMatch(/isArchived\(/)
    }
  })

  it('isArchivedStatus is gone from mobile/lib/email-tickets.js — the reading lives in shared', () => {
    expect(mobile.isArchivedStatus).toBeUndefined()
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
