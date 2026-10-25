// @vitest-environment jsdom
//
// PUBLISH-CONFIRM.1 + ROSTERROLE.1 — the publish modal's outcome and its
// owner-button label.
//
// Two findings, one screen:
//   1. A successful publish showed NOTHING. The parent closed the modal the
//      moment the POST resolved, so there was no confirmation at all, and the
//      "Approval requested" panel the modal already carried was unreachable
//      by construction — the close always won.
//   2. The button label came from `user.role`. That is the role at the active
//      studio ONLY when the user has a row there: resolveActiveLocationRole
//      falls back to their HIGHEST role anywhere else, so an owner at Hatch
//      viewing a studio they hold no role at read as 'owner' and was offered
//      "Publish over budget" for a publish the route (hasRoleAtLocation) would
//      have turned into a draft. The label promised authority the server did
//      not grant.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

vi.setConfig({ testTimeout: 20000 })

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams('view=week&week=2026-05-04&month=2026-05-01'),
}))
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

const LOC = 'loc1'

// A manager at this studio, an owner at ANOTHER one. The old check read
// `user.role` (the active studio's role) and so is indistinguishable from a
// plain manager here; hasRoleAtLocation answers on rolesByLocation[LOC].
const managerHere = {
  id: 'u1',
  role: 'manager',
  profileRole: 'manager',
  rolesByLocation: { [LOC]: 'manager', loc2: 'owner' },
  activeLocation: { id: LOC, name: 'Stillorgan' },
}

// THE DIVERGENCE. No role row at the active studio, owner at another one, so
// resolveActiveLocationRole falls back to the highest role anywhere and
// `user.role` reads 'owner'. hasRoleAtLocation answers false, which is what
// the publish route answers.
const ownerElsewhere = {
  id: 'u2',
  role: 'owner',
  profileRole: 'owner',
  rolesByLocation: { loc2: 'owner' },
  activeLocation: { id: LOC, name: 'Stillorgan' },
}

// A master bypasses on profileRole, at every studio.
const master = {
  id: 'u3',
  role: 'master',
  profileRole: 'master',
  rolesByLocation: {},
  activeLocation: { id: LOC, name: 'Stillorgan' },
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

const OVER_BUDGET = {
  blockCount: 12, periodProjectedEur: 5400, monthProjectedTotalEur: 5400,
  monthlyBudgetEur: 5000, overBudget: true, overrunEur: 400, months: [], staffingGaps: [],
}
const UNDER_BUDGET = {
  blockCount: 12, periodProjectedEur: 900, monthProjectedTotalEur: 900,
  monthlyBudgetEur: 5000, overBudget: false, overrunEur: 0, months: [], staffingGaps: [],
}

// `publishBody` is what the real (non-dry-run) POST answers.
function fetchWith({ impact = UNDER_BUDGET, publishBody } = {}) {
  return vi.fn(async (url, opts) => {
    if (String(url).includes('/schedule/rosters')) {
      const body = JSON.parse(opts?.body || '{}')
      if (body.dry_run) return okResponse({ success: true, impact })
      return okResponse(publishBody || {
        success: true,
        data: { id: 'r-1' },
        impact,
        needs_approval: false,
        published_summary: { shift_count: 12, coaches_notified: 3 },
      })
    }
    if (String(url).includes('contractor-spend')) return okResponse({ success: true, data: {} })
    return okResponse({ data: [] })
  })
}

async function openPublishModal(user = managerHere) {
  render(<ScheduleCalendar user={user} />)
  await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
  fireEvent.click(screen.getByText('Publish'))
  await screen.findByText('Publish roster')
  await waitFor(() => expect(screen.getByText('Blocks in period')).toBeTruthy())
}

function clickConfirm() {
  const buttons = screen.getAllByRole('button')
  // The modal's confirm is the last button rendered in it.
  const confirm = buttons.filter((b) => /^(Publish|Request owner approval|Publish €)/.test(b.textContent)).at(-1)
  fireEvent.click(confirm)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })
beforeEach(() => { global.fetch = fetchWith() })

describe('publish confirmation (PUBLISH-CONFIRM.1)', () => {
  it('shows what it published: shift count and coaches told', async () => {
    await openPublishModal()
    clickConfirm()
    const panel = await screen.findByTestId('publish-success')
    expect(panel.textContent).toMatch(/Roster published/)
    expect(panel.textContent).toMatch(/12 shifts/)
    expect(panel.textContent).toMatch(/3 coaches were told/)
  })

  it('says nobody was messaged rather than "0 coaches"', async () => {
    global.fetch = fetchWith({
      publishBody: {
        success: true, data: { id: 'r-1' }, impact: UNDER_BUDGET, needs_approval: false,
        published_summary: { shift_count: 12, coaches_notified: 0 },
      },
    })
    await openPublishModal()
    clickConfirm()
    const panel = await screen.findByTestId('publish-success')
    expect(panel.textContent).toMatch(/Nothing changed for any coach/)
  })

  it('keeps the modal open until Done, so the confirmation cannot be missed', async () => {
    await openPublishModal()
    clickConfirm()
    await screen.findByTestId('publish-success')
    expect(screen.queryByText('Publish roster')).toBeTruthy()
    fireEvent.click(screen.getByText('Done'))
    await waitFor(() => expect(screen.queryByText('Publish roster')).toBeNull())
  })

  // The panel that could never appear: a 202/draft used to close the modal
  // before its own "Approval requested" branch rendered.
  it('renders the approval-requested panel on a 202/draft', async () => {
    global.fetch = fetchWith({
      impact: OVER_BUDGET,
      publishBody: { success: true, data: { id: 'r-1' }, impact: OVER_BUDGET, needs_approval: true },
    })
    await openPublishModal()
    clickConfirm()
    const panel = await screen.findByTestId('publish-approval-requested')
    expect(panel.textContent).toMatch(/Approval requested/)
    expect(screen.queryByTestId('publish-success')).toBeNull()
  })
})

describe('owner button label (ROSTERROLE.1)', () => {
  it('offers the manager flow to a manager here who owns a DIFFERENT studio', async () => {
    global.fetch = fetchWith({ impact: OVER_BUDGET })
    await openPublishModal(managerHere)
    expect(screen.getByText('Request owner approval')).toBeTruthy()
  })

  // The case the old `user.role` check got wrong in the dangerous direction:
  // it offered an over-budget publish the route would have refused.
  it('does NOT offer the owner flow to an owner-elsewhere with no role here', async () => {
    global.fetch = fetchWith({ impact: OVER_BUDGET })
    await openPublishModal(ownerElsewhere)
    expect(screen.getByText('Request owner approval')).toBeTruthy()
    expect(screen.queryByText('Publish €400 over budget')).toBeNull()
  })

  it('offers the owner flow to a master, who bypasses on profileRole', async () => {
    global.fetch = fetchWith({ impact: OVER_BUDGET })
    await openPublishModal(master)
    expect(screen.queryByText('Request owner approval')).toBeNull()
    expect(screen.getByText('Publish €400 over budget')).toBeTruthy()
  })

  it('offers the owner flow to an owner AT this studio', async () => {
    global.fetch = fetchWith({ impact: OVER_BUDGET })
    await openPublishModal({
      ...managerHere, role: 'owner', profileRole: 'owner',
      rolesByLocation: { [LOC]: 'owner' },
    })
    expect(screen.getByText('Publish €400 over budget')).toBeTruthy()
  })
})
