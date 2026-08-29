// INBOX-SURFACE.C — the Mail tab's gate is DATA, not permission.
//
// THE PROPERTY THIS FILE EXISTS FOR
// /communications/mail is the email surface; the tab is data-gated on
// "does this studio hold any ACTIVE email account" (RETIRE-TICKETS.1 — the
// per-mailbox surface flag it used to read retired with mig 578). A studio
// with none has nothing there, so the tab must not be in the strip: an
// operator who clicks an empty surface concludes their mail has gone missing.
// An empty surface in the nav is worse than no surface.
//
// The strip itself only receives a boolean (CommunicationsTabs.test.jsx pins
// that it is honoured). What is pinned HERE is the half that can only be got
// wrong in the layout: which query answers the question, that it is scoped to
// this studio, and — the part with real blast radius — WHICH WAY IT FAILS.
//
// 🔴 IT FAILS TO THE PRE-TRIAL STATE. An unreadable answer (a blipped query, or
// mig 575 not yet applied, which is a 42703 on the whole select) hides the Mail
// tab and changes nothing else. That is the only safe direction: showing it on
// a guess produces exactly the empty surface the gate exists to prevent, while
// hiding it costs a URL that still works if typed. It is deliberately NOT the
// posture the ticket routes take for a failed mailbox lookup — that one refuses
// with a 500, because there the failure decides what mail you are shown. This
// is chrome, and a blank hub is a worse answer than a missing tab.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
}))

import CommunicationsHubLayout from './layout.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC = 'a0000000-0000-0000-0000-000000000001'

/** An owner at LOC — holds email_inbox by role default, so canEmailInbox is true. */
const owner = () => ({
  id: 'u1',
  role: 'owner',
  activeLocation: { id: LOC, name: 'UN1T Stillorgan', features: {} },
  activeAssignment: { permissions: {} },
})

/**
 * A minimal email_mailboxes double that RECORDS its filters, so a test can
 * prove the query is scoped to this studio rather than merely that it answered.
 * A gate that returned true off another studio's mailbox would put a tab in
 * this studio's nav with nothing behind it — the exact failure being prevented.
 */
function mockDb({ rows = [], error = null, throws = false } = {}) {
  const filters = []
  const builder = {
    select: () => builder,
    eq: (col, val) => { filters.push([col, val]); return builder },
    limit: () => Promise.resolve({ data: error ? null : rows, error }),
  }
  createServerClient.mockImplementation(() => {
    if (throws) throw new Error('no service key')
    return { from: () => builder }
  })
  return filters
}

/** Walk the returned element tree for CommunicationsTabs' props. */
function tabsProps(tree) {
  let found = null
  const visit = (node) => {
    if (!node || typeof node !== 'object' || found) return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (node.type?.name === 'CommunicationsTabs') { found = node.props; return }
    visit(node.props?.children)
  }
  visit(tree)
  return found
}

const render = async () => tabsProps(await CommunicationsHubLayout({ children: null }))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(owner())
})

describe('the Mail tab gate', () => {
  it('is OFF for a studio with no active email account', async () => {
    mockDb({ rows: [] })
    expect((await render()).canMail).toBe(false)
  })

  it('is ON once the studio holds an active account', async () => {
    mockDb({ rows: [{ id: 'mb-1' }] })
    expect((await render()).canMail).toBe(true)
  })

  it('asks about THIS studio and only ACTIVE accounts — and never reads the retired surface column', async () => {
    // A deactivated account is hidden from every inbox, so it is not a reason
    // to put the tab in the nav. RETIRE-TICKETS.1: the `.eq('surface', …)`
    // half of this filter retired with the column (mig 578) — nothing may
    // read it any more, which this exact-filters assertion also proves.
    const filters = mockDb({ rows: [{ id: 'mb-1' }] })
    await render()
    expect(filters).toEqual([
      ['location_id', LOC],
      ['active', true],
    ])
  })

  it('is OFF when the query ERRORS', async () => {
    mockDb({ error: { code: '08006', message: 'connection reset' } })
    expect((await render()).canMail).toBe(false)
  })

  it('is OFF when the client cannot even be built, rather than throwing', async () => {
    // A thrown gate would blank the whole Messages hub over a tab.
    mockDb({ throws: true })
    expect((await render()).canMail).toBe(false)
  })

  it('leaves the WhatsApp tab exactly as it was on every failure path', async () => {
    mockDb({ error: { message: 'boom' } })
    const props = await render()
    expect(props.canWhatsapp).toBe(true)
    expect(props.canMail).toBe(false)
  })

  it('never queries at all without the email_inbox key', async () => {
    // No key, no surface, no reason to spend a round-trip per hub render.
    // Keeps `whatsapp` so the strip still renders and canMail is assertable —
    // otherwise the layout's own hide-when-empty guard drops the strip and the
    // test would pass without proving anything about the gate.
    getCurrentUser.mockResolvedValue({
      ...owner(),
      role: 'staff',
      activeAssignment: { permissions: { email_inbox: false, whatsapp: true } },
    })
    mockDb({ rows: [{ id: 'mb-1' }] })
    const props = await render()
    expect(props.canMail).toBe(false)
    expect(createServerClient).not.toHaveBeenCalled()
  })
})
