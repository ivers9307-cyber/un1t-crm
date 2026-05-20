// APPROVALS.1 — registry of approval surfaces.
//
// Each provider plugs into the central /approvals dashboard. To
// add a new category later:
//   1. Drop a new provider file under src/lib/approvals/providers/.
//   2. Register it in PROVIDERS below.
//   3. (Optional) add a sidebar / mobile entry — the count is
//      already rolled up automatically.
//
// Provider contract:
//   {
//     key:           stable identifier, used in URLs + tab ids
//     label:         operator-facing tab title
//     reviewBase:    source page operators jump to for the actual
//                    review (clicked item appends `?focus=<id>`)
//     fetchPending(db, user) → Promise<{ count: number, items: ApprovalItem[] }>
//     // BOOKKEEPER-APPROVALS.1 — optional. Synchronous gate that
//     // runs BEFORE fetchPending. Return false to skip this
//     // provider entirely for this user (the tab won't render).
//     // Default = always visible. Use for permission-gated tabs
//     // where showing a permanently-empty tab to non-permitted
//     // users would just confuse them.
//     isVisible?(user) → boolean
//   }
//
// ApprovalItem shape (uniform across categories so the UI can
// render one component):
//   {
//     id:          row id
//     title:       primary label (e.g. submitter name)
//     subtitle:    secondary line (e.g. period / amount)
//     meta:        small badge string (e.g. location name)
//     submittedAt: ISO timestamp string
//     amount:      number | null  — when relevant (invoices, expenses)
//     currency:    string | null
//     reviewUrl:   absolute path to the source page with the row
//                  highlighted (e.g. /schedule/expenses?focus=<id>)
//   }
//
// Each fetchPending is role-scoped:
//   • master            → sees everything platform-wide
//   • owner-at-location → sees pending items at the owned locations
//   • manager / head_coach → sees schedule items (time-off + swaps)
//     at their locations, NOT invoices/expenses (which are finance
//     surfaces). Permission keys per-route still apply on the
//     source pages — this registry is best-effort filter, not auth.

import { contractorInvoicesProvider } from './providers/contractor-invoices'
import { fteExpensesProvider } from './providers/fte-expenses'
import { timeOffProvider } from './providers/time-off'
import { shiftSwapsProvider } from './providers/shift-swaps'
import { rostersProvider } from './providers/rosters'
import { invoicesQueueProvider } from './providers/invoices-queue'

export const APPROVALS_PROVIDERS = Object.freeze([
  // BOOKKEEPER-APPROVALS.1 — invoices_queue tab first so bookkeepers
  // see their work front-and-centre. fetchPending self-gates on the
  // bookkeeper permission; non-bookkeepers see a 0-count empty tab
  // (the inbox UI hides 0-count tabs by default in another change).
  invoicesQueueProvider,
  contractorInvoicesProvider,
  fteExpensesProvider,
  timeOffProvider,
  shiftSwapsProvider,
  rostersProvider,
])

/**
 * Fetch pending approvals across every registered provider in
 * parallel. Returns an object keyed by provider.key plus a `total`
 * convenience field for the sidebar badge.
 *
 * @param {object} db   — Supabase service-role client
 * @param {object} user — getCurrentUser() result
 * @returns {Promise<{ providers: Array<{key, label, count, items, reviewBase}>, total: number }>}
 */
export async function getPendingApprovals(db, user) {
  // BOOKKEEPER-APPROVALS.1 — apply isVisible() filter first so
  // hidden providers don't even fire their query.
  const visible = APPROVALS_PROVIDERS.filter(
    (p) => typeof p.isVisible !== 'function' || p.isVisible(user)
  )

  const settled = await Promise.allSettled(
    visible.map(async (p) => {
      const { count, items } = await p.fetchPending(db, user)
      return {
        key: p.key,
        label: p.label,
        reviewBase: p.reviewBase,
        count,
        items,
      }
    })
  )

  const providers = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value
    const p = visible[i]
    // One bad provider shouldn't blank the whole inbox. Log + return
    // an empty bucket so the UI still renders the other tabs.
    console.warn(`[approvals] provider '${p.key}' failed: ${s.reason?.message || s.reason}`)
    return { key: p.key, label: p.label, reviewBase: p.reviewBase, count: 0, items: [] }
  })

  const total = providers.reduce((sum, p) => sum + p.count, 0)
  return { providers, total }
}

/**
 * Fast count-only variant for the sidebar badge — same parallel
 * fan-out but without item materialisation. Each provider can
 * optimise via .countOnly() if defined; otherwise falls back to
 * fetchPending + read .count off the result.
 */
export async function getPendingApprovalsCount(db, user) {
  // Mirror the isVisible() filter from getPendingApprovals so the
  // sidebar badge matches what the inbox renders.
  const visible = APPROVALS_PROVIDERS.filter(
    (p) => typeof p.isVisible !== 'function' || p.isVisible(user)
  )
  const settled = await Promise.allSettled(
    visible.map(async (p) => {
      if (typeof p.countPending === 'function') {
        return p.countPending(db, user)
      }
      const { count } = await p.fetchPending(db, user)
      return count
    })
  )
  return settled.reduce((sum, s) => sum + (s.status === 'fulfilled' ? (s.value || 0) : 0), 0)
}

// Permission helpers — exported so the API routes share the same
// scoping logic the providers use.

export function userIsMaster(user) {
  return user?.role === 'master' || user?.profileRole === 'master'
}

export function ownerLocationIds(user) {
  return Object.entries(user?.rolesByLocation || {})
    .filter(([, r]) => r === 'owner')
    .map(([loc]) => loc)
}

/**
 * Locations where the user holds a role that can approve schedule
 * items (time-off, swaps): manager, head_coach, owner. Master is
 * handled separately (sees all locations).
 */
export function scheduleApproverLocationIds(user) {
  return Object.entries(user?.rolesByLocation || {})
    .filter(([, r]) => r === 'manager' || r === 'head_coach' || r === 'owner')
    .map(([loc]) => loc)
}
