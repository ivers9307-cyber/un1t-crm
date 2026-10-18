// HATCHPIPE.2 — what un1t.online says this contact owes and has paid, for the
// contact page (spec A, Task 12).
//
// A contact can be a client of more than one studio's un1t.online account
// (`un1t_clients.contact_id`). For each such studio the viewer may see, ask the
// membership seam for the contact's payments picture and hand the contact page
// one shape: the studios, whether anything is overdue, and the overdue amount
// per currency.
//
// Scoping (the part that can leak): every studio must pass
// `assertLocationAccess(user, loc) === null` BEFORE any read for it, and the
// client-row probe is itself narrowed to the viewer's own studios, so another
// studio's billing is never queried, let alone rendered.
import { assertLocationAccess } from '@/lib/auth'
import { membershipReadsFor, supportsRead } from '@/lib/membership/reads'
import { logWarn } from '@/lib/log'
import { formatDate } from '@/components/contact/format'

const TX_LIMIT = 10

const emptyBilling = () => ({ studios: [], overdue: false, arrearsCentsByCurrency: {} })

// An unreadable date sorts last, so a studio with a readable `since` wins.
const sinceMs = (iso) => {
  const n = Date.parse(iso)
  return Number.isFinite(n) ? n : Infinity
}

/**
 * @param {object} db  service-role client
 * @param {{ locations?: Array<{id: string}> }|null} user
 * @param {string} contactId
 * @returns {Promise<{ studios: Array<{ locationId: string, locationName: string, subscriptions: object[], transactions: object[], invoices: object[], pastDue: object|null }>, overdue: boolean, arrearsCentsByCurrency: Record<string, number> }>}
 */
export async function loadUn1tBilling(db, user, contactId) {
  try {
    if (!db || !user || !contactId) return emptyBilling()
    // Only the viewer's own studios are ever asked about.
    const viewerLocIds = [...new Set((user.locations || []).map((l) => l?.id).filter(Boolean))]
    if (viewerLocIds.length === 0) return emptyBilling()

    const { data: clientRows, error: clientErr } = await db
      .from('un1t_clients')
      .select('location_id')
      .eq('contact_id', contactId)
      .in('location_id', viewerLocIds)
    if (clientErr) throw new Error(clientErr.message || String(clientErr))

    const locIds = [...new Set((clientRows || []).map((r) => r?.location_id).filter(Boolean))]
      .filter((loc) => assertLocationAccess(user, loc) === null)
    if (locIds.length === 0) return emptyBilling()

    const studios = []
    for (const locationId of locIds) {
      const r = await membershipReadsFor(db, locationId)
      if (
        r.source !== 'un1t_online' ||
        r.state !== 'configured' ||
        r.capabilities?.invoices !== true ||
        !supportsRead(r, 'paymentsFor')
      ) continue
      const res = await r.reads.paymentsFor(db, locationId, [contactId], { limit: TX_LIMIT })
      if (!res?.success || !res.data) {
        logWarn('un1t-billing', 'payments read failed; studio dropped', { contactId, locationId })
        continue
      }
      const d = res.data
      studios.push({
        locationId,
        locationName: '',
        subscriptions: d.subscriptions || [],
        transactions: d.transactions || [],
        invoices: d.invoices || [],
        pastDue: d.pastDue ?? null,
      })
    }
    if (studios.length === 0) return emptyBilling()

    const names = new Map()
    try {
      const { data: locRows, error: locErr } = await db
        .from('locations')
        .select('id, name')
        .in('id', studios.map((s) => s.locationId))
      if (locErr) throw new Error(locErr.message || String(locErr))
      for (const l of locRows || []) names.set(l.id, l.name)
    } catch {
      logWarn('un1t-billing', 'studio names unreadable', { contactId })
    }
    for (const s of studios) s.locationName = names.get(s.locationId) || 'Studio'

    const arrearsCentsByCurrency = {}
    for (const s of studios) {
      const p = s.pastDue
      if (!p) continue
      const cents = p.amountCents
      if (Number.isFinite(cents) && cents > 0 && p.currency) {
        const cur = String(p.currency).toUpperCase()
        arrearsCentsByCurrency[cur] = (arrearsCentsByCurrency[cur] || 0) + cents
      }
    }
    return { studios, overdue: studios.some((s) => s.pastDue != null), arrearsCentsByCurrency }
  } catch (e) {
    logWarn('un1t-billing', 'load failed', { contactId, message: e?.message ? String(e.message).slice(0, 200) : undefined })
    return emptyBilling()
  }
}

/**
 * The header-band risk chip for an un1t.online overdue, or null. The title
 * names the studio with the earliest `since`.
 */
export function un1tHeaderRisk(billing) {
  if (!billing?.overdue) return null
  const overdueStudios = (billing.studios || []).filter((s) => s.pastDue != null)
  if (overdueStudios.length === 0) return null
  const pick = overdueStudios.reduce((best, s) => (sinceMs(s.pastDue.since) < sinceMs(best.pastDue.since) ? s : best))
  const since = formatDate(pick.pastDue.since)
  return {
    label: 'Payment overdue',
    cls: 'bg-red-50 text-red-700 border-red-200',
    title: `Payment overdue on un1t.online at ${pick.locationName}${since ? ` since ${since}` : ''}`,
  }
}

/** Glofox arrears plus un1t.online's EUR arrears. Another currency is never added. */
export function mergeArrearsCents(glofoxCents, billing) {
  const extra = Number(billing?.arrearsCentsByCurrency?.EUR) || 0
  if (extra === 0) return glofoxCents
  return (Number(glofoxCents) || 0) + extra
}
