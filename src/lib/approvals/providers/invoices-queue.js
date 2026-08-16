// BOOKKEEPER-APPROVALS.1 provider — invoices_queue rows awaiting
// bookkeeper sign-off.
//
// Source: `invoices_queue` (mig 185). Rows land here from four
// upstream surfaces (supplier_email, contractor_invoice,
// fte_expense_item, car_document) once the owner-side approval is
// done. The bookkeeper then runs Analyse + Send-to-Xero from
// inside /invoices.
//
// What counts as "awaiting bookkeeper" for this tab — every
// pre-terminal status. Each one represents a stop where the
// bookkeeper still has to do something:
//   - 'received'         — supplier email just landed via Postmark;
//                          bookkeeper opens it + clicks Analyse to
//                          run Claude Vision.
//   - 'quality_approved' — pre-set when an upstream approval
//                          enqueued it (FTE expense, contractor
//                          invoice, car doc). Bookkeeper clicks
//                          Analyse to run Claude Vision.
//   - 'extracted'        — Vision parsed the fields; bookkeeper
//                          picks Xero account + supplier and clicks
//                          Send.
//   - 'data_approved'    — flip-to-Xero failed; bookkeeper retries.
//
// Terminal states ('forwarded', 'rejected') are excluded — the
// bookkeeper is done with them.
//
// Scope:
//   - bookkeeper permission required (per-user grantable). The
//     registry-level filter is best-effort — the actual auth is
//     the bulk-helpers gate inside `/invoices`. Filtering here
//     just stops the tab from showing up at all for users who
//     can't act on the items.
//   - Within bookkeepers: master sees every location; owner sees
//     their location's rows. Managers + head_coaches + staff who
//     happen to have the bookkeeper key set still only see what
//     they have role-level access to in invoices_queue (RLS in
//     mig 184 already enforces this — we mirror it here so the
//     count is right).

import { userIsMaster, viewerActiveLocationId } from '../registry'

// Statuses the bookkeeper needs to action from /invoices. See
// the status-stop notes in the header above.
const PENDING_STATUSES = ['received', 'quality_approved', 'extracted', 'data_approved']

// Heuristic — does the user have a path to act on these rows? We
// can't import shared/permissions.js without circular trouble
// (registry → providers → registry), so re-encode the master-+-
// per-user check inline. The actual auth lives on the
// /api/invoices-inbox routes.
function userIsBookkeeper(user) {
  if (!user) return false
  // Master defaults ON for bookkeeper (see DEFAULT_WEB_PERMISSIONS_BY_ROLE
  // in shared/permissions.js). Per-user `permissions` overrides
  // win when present.
  const explicit = user.permissions?.bookkeeper
  if (typeof explicit === 'boolean') return explicit
  return userIsMaster(user)
}

// Friendly source labels. Keys match invoices_queue.source_type.
const SOURCE_LABEL = {
  supplier_email:     'Supplier',
  contractor_invoice: 'Contractor',
  fte_expense_item:   'Expense',
  car_document:       'Car',
}

export const invoicesQueueProvider = {
  key: 'invoices_queue',
  label: 'Bookkeeper queue',
  reviewBase: '/invoices',

  // BOOKKEEPER-APPROVALS.1 — hide the tab entirely for users
  // without the bookkeeper key. Non-bookkeepers don't even see a
  // 0-count tab; the registry filters this out before fetchPending
  // would otherwise fire.
  isVisible(user) {
    return userIsBookkeeper(user)
  },

  async fetchPending(db, user) {
    if (!userIsBookkeeper(user)) return { count: 0, items: [] }
    // APPROVALS-LOCATION-SCOPE — bookkeepers only see invoices for
    // the studio they're currently in. Switch active location to
    // see another studio's queue. TENANT.8 (item 4) — this also means
    // the registry's bundlesDenyCategory(user.activeLocation.features,
    // key) check already covers every row here; no per-row check needed.
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }

    const q = db
      .from('invoices_queue')
      .select(`
        id, status, source_type, sender_email, subject,
        received_at, extracted_at, data_reviewed_at,
        extracted_fields, xero_error,
        location:location_id ( id, name )
      `)
      .in('status', PENDING_STATUSES)
      .eq('location_id', activeId)

    const { data, error } = await q
      .order('received_at', { ascending: false })
      .limit(50)
    if (error) throw new Error(`invoices_queue: ${error.message}`)

    const items = (data || []).map((r) => {
      const f = r.extracted_fields || {}
      const sourceLabel = SOURCE_LABEL[r.source_type] || 'Invoice'
      const supplier = f.supplier_name || r.sender_email || '(no supplier)'
      const invoiceNumber = f.invoice_number
      // BOOKKEEPER-QUEUE-STATUS — surface the action the bookkeeper
      // needs to take per status, so the queue is self-documenting
      // without opening each row.
      const actionHint = (() => {
        if (r.status === 'received' || r.status === 'quality_approved') {
          return 'Needs analyse'
        }
        if (r.status === 'extracted') return 'Awaiting review + send'
        if (r.status === 'data_approved' && r.xero_error) return 'Retry — Xero push failed'
        if (r.status === 'data_approved') return 'Sending to Xero…'
        return null
      })()
      const subtitleBits = [
        `${sourceLabel}: ${supplier}`,
        invoiceNumber ? `#${invoiceNumber}` : null,
        actionHint,
      ].filter(Boolean)

      return {
        id: r.id,
        title: f.supplier_name || sourceLabel,
        subtitle: subtitleBits.join(' · '),
        meta: r.location?.name || null,
        submittedAt: r.extracted_at || r.received_at,
        amount: typeof f.total === 'number' ? Number(f.total) : null,
        currency: f.currency || 'EUR',
        // Drill straight into the inbox detail panel for this row.
        // /invoices reads `?focus=<id>` and pre-selects the row.
        reviewUrl: `/invoices?focus=${r.id}`,
      }
    })
    return { count: items.length, items }
  },

  // Fast count-only variant for the sidebar badge. Mirrors the
  // scope logic in fetchPending so the badge number matches what
  // the tab shows.
  async countPending(db, user) {
    if (!userIsBookkeeper(user)) return 0
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    const q = db
      .from('invoices_queue')
      .select('*', { count: 'exact', head: true })
      .in('status', PENDING_STATUSES)
      .eq('location_id', activeId)
    const { count, error } = await q
    if (error) throw new Error(`invoices_queue count: ${error.message}`)
    return count || 0
  },
}


