// INVWEEKLY.1 — the weekly invoices email: counting, wording and who gets it.
import { describe, it, expect, vi } from 'vitest'
import { createFakeDb } from '../../../tests/helpers/fake-db.js'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
import {
  summariseAwaiting, buildWeeklySummaryEmail, loadAwaitingRows, countNotInvoiceSince, weeklySummaryRecipients,
} from './weekly-summary'

const LOC = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const ready = { status: 'extracted', prepared_at: '2026-11-23T10:00:00Z', review_reasons: [] }
const flagged = (...r) => ({ status: 'extracted', prepared_at: '2026-11-23T10:00:00Z', review_reasons: r })
const dup = { status: 'received', review_reasons: ['duplicate_file'], analysis_queued_at: null }
const unreadable = { status: 'quality_approved', review_reasons: ['unreadable'], analysis_queued_at: null }
const reading = { status: 'received', review_reasons: [], analysis_queued_at: '2026-11-23T10:00:00Z' }
const legacy = { status: 'extracted', prepared_at: null, review_reasons: [] }

describe('summariseAwaiting', () => {
  it('counts Ready, Needs a look, set aside and being read as the screen piles them', () => {
    const s = summariseAwaiting([ready, ready, flagged('new_supplier'), flagged('new_supplier', 'no_vat_rate'), dup, unreadable, reading, legacy])
    expect(s).toMatchObject({ ready: 2, needsALook: 3, setAside: 2, beingRead: 1, waiting: 6 })
  })

  it('lists each reason once, in the screen order, with how many invoices carry it', () => {
    const s = summariseAwaiting([flagged('no_vat_rate'), flagged('new_supplier', 'no_vat_rate'), flagged('already_in_xero')])
    expect(s.reasons).toEqual([
      { label: 'Already in Xero', count: 1 },
      { label: 'New supplier', count: 1 },
      { label: 'No VAT rate', count: 2 },
    ])
  })

  it('an empty or missing list is nothing waiting', () => {
    expect(summariseAwaiting([])).toMatchObject({ waiting: 0, reasons: [] })
    expect(summariseAwaiting(null)).toMatchObject({ waiting: 0 })
  })

  it('duplicates and unreadable files alone are not "waiting"', () => {
    expect(summariseAwaiting([dup, unreadable]).waiting).toBe(0)
  })
})

describe('buildWeeklySummaryEmail', () => {
  const summary = summariseAwaiting([ready, ready, flagged('new_supplier'), dup])

  it('puts the counts in the subject and links to the Invoices page', () => {
    const { subject, html } = buildWeeklySummaryEmail({ locationName: 'Studio One', summary, notInvoiceThisWeek: 3, appUrl: 'https://crm.example.com/' })
    expect(subject).toBe('Invoices at Studio One: 2 ready to send, 1 need a look')
    expect(html).toContain('href="https://crm.example.com/invoices"')
    expect(html).toContain('2 invoices are ready to send to Xero.')
    expect(html).toContain('1 invoice needs a look first')
    expect(html).toContain('New supplier')
    expect(html).toContain('1 duplicate or unreadable file')
    expect(html).toContain('3 emails this week that did not hold an invoice')
  })

  it('says so when nothing is ready', () => {
    const { subject, html } = buildWeeklySummaryEmail({ locationName: 'S', summary: summariseAwaiting([flagged('no_account')]), appUrl: 'https://x.test' })
    expect(subject).toBe('Invoices at S: 1 need a look')
    expect(html).toContain('No invoices are ready to send yet.')
    expect(html).not.toContain('Set aside')
  })

  it('escapes the studio name', () => {
    const { html } = buildWeeklySummaryEmail({ locationName: 'A <b>& Co', summary, appUrl: 'https://x.test' })
    expect(html).toContain('A &lt;b&gt;&amp; Co')
    expect(html).not.toContain('<b>&')
  })
})

describe('loadAwaitingRows and countNotInvoiceSince', () => {
  const q = (id, status, over = {}) => ({ id, location_id: LOC, status, created_at: '2026-11-22T10:00:00Z', ...over })
  const db = () => createFakeDb({ tables: { invoices_queue: [
    q('a', 'extracted'), q('b', 'received'), q('c', 'forwarded'), q('d', 'rejected'),
    q('e', 'not_invoice'), q('f', 'not_invoice', { created_at: '2026-11-01T10:00:00Z' }),
    q('g', 'extracted', { location_id: OTHER }), q('h', 'not_invoice', { location_id: OTHER }),
  ] } })

  it('reads only this studio and only rows still waiting', async () => {
    expect((await loadAwaitingRows(db(), LOC)).map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('counts this studio\'s set-aside emails since a date', async () => {
    expect(await countNotInvoiceSince(db(), LOC, '2026-11-16T00:00:00Z')).toBe(1)
  })

  it('a failed queue read throws, a failed count is zero', async () => {
    const broken = createFakeDb({ tables: { invoices_queue: [] }, errors: { invoices_queue: { select: { message: 'boom' } } } })
    await expect(loadAwaitingRows(broken, LOC)).rejects.toThrow(/invoice queue/)
    expect(await countNotInvoiceSince(broken, LOC, '2026-11-16T00:00:00Z')).toBe(0)
  })
})

describe('weeklySummaryRecipients', () => {
  const prof = (id, role, over = {}) => ({ id, email: `${id}@example.com`, role, active: true, deleted_at: null, permissions: {}, ...over })
  const at = (profile_id, over = {}) => ({ id: `pl-${profile_id}-${over.location_id || LOC}`, profile_id, location_id: LOC, role: 'staff', permissions: {}, ...over })
  const make = (profiles, assignments) => createFakeDb({ tables: { profiles, profile_locations: assignments } })

  it('a master assigned to the studio and a bookkeeper there are emailed; a plain owner is not', async () => {
    const db = make(
      [prof('master', 'master'), prof('keeper', 'owner'), prof('owner', 'owner'), prof('coach', 'staff')],
      [at('master'), at('keeper', { permissions: { bookkeeper: true } }), at('owner', { role: 'owner' }), at('coach')],
    )
    expect((await weeklySummaryRecipients(db, LOC)).sort()).toEqual(['keeper@example.com', 'master@example.com'])
  })

  it('a master or bookkeeper of another studio is not emailed', async () => {
    const db = make(
      [prof('master', 'master'), prof('keeper', 'owner')],
      [at('master', { location_id: OTHER }), at('keeper', { location_id: OTHER, permissions: { bookkeeper: true } })],
    )
    expect(await weeklySummaryRecipients(db, LOC)).toEqual([])
  })

  it('skips inactive and deleted staff, and anyone without a usable address', async () => {
    const db = make(
      [
        prof('gone', 'master', { active: false }),
        prof('tomb', 'master', { deleted_at: '2026-10-01T00:00:00Z' }),
        prof('blank', 'master', { email: null }),
        prof('bad', 'master', { email: 'not-an-address' }),
        prof('ok', 'master', { email: ' OK@Example.com ' }),
      ],
      ['gone', 'tomb', 'blank', 'bad', 'ok'].map((id) => at(id)),
    )
    expect(await weeklySummaryRecipients(db, LOC)).toEqual(['ok@example.com'])
  })

  it('a bookkeeper flag that is not exactly true does not count', async () => {
    const db = make([prof('k', 'owner')], [at('k', { permissions: { bookkeeper: 'false' } })])
    expect(await weeklySummaryRecipients(db, LOC)).toEqual([])
  })
})
