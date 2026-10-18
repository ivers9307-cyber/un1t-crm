// HATCHPIPE.2 — what un1t.online says this contact owes and has paid, for the
// contact page (spec A, Task 12).
//
// A contact can be a client of more than one studio's un1t.online account
// (`un1t_clients.contact_id`). For each such studio the viewer may see, ask the
// membership seam for the contact's payments picture and hand the contact page
// one shape: the studios, whether anything is overdue, and the overdue amount
// per currency.
//
// Scoping (the part that can leak): a studio is read only if the viewer holds
// Contacts there (web OR phone: the very `contactStudioIds` canViewContact
// narrows a crossover viewer with) AND it passes
// `assertLocationAccess(user, loc) === null`. The client-row probe is itself
// narrowed to those studios, so another studio's billing is never queried,
// let alone rendered.
import { assertLocationAccess } from '@/lib/auth'
import { contactStudioIds } from '@/lib/contact-crossovers'
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

// A studio's overdue rows, earliest `since` first (an unreadable date last), so
// the first row is always the one the header and the command centre name.
const sortedBySince = (rows) => (Array.isArray(rows) ? [...rows].sort((a, b) => sinceMs(a?.since) - sinceMs(b?.since)) : [])

/**
 * @param {object} db  service-role client
 * @param {{ locations?: Array<{id: string}> }|null} user
 * @param {string} contactId
 * @returns {Promise<{ studios: Array<{ locationId: string, locationName: string, subscriptions: object[], transactions: object[], invoices: object[], pastDues: object[] }>, overdue: boolean, arrearsCentsByCurrency: Record<string, number> }>}
 */
export async function loadUn1tBilling(db, user, contactId) {
  try {
    if (!db || !user || !contactId) return emptyBilling()
    // Only studios where the viewer holds Contacts are ever asked about.
    const viewerLocIds = contactStudioIds(user, [...new Set((user.locations || []).map((l) => l?.id).filter(Boolean))])
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
        pastDues: sortedBySince(d.pastDues),
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

    // Every overdue row counts: a member can owe on more than one subscription.
    // Like currencies are summed; a row with no amount (or no currency) keeps
    // the member overdue but adds nothing.
    const arrearsCentsByCurrency = {}
    for (const s of studios) {
      for (const p of s.pastDues) {
        const cents = p?.amountCents
        if (Number.isFinite(cents) && cents > 0 && p.currency) {
          const cur = String(p.currency).toUpperCase()
          arrearsCentsByCurrency[cur] = (arrearsCentsByCurrency[cur] || 0) + cents
        }
      }
    }
    return { studios, overdue: studios.some((s) => s.pastDues.length > 0), arrearsCentsByCurrency }
  } catch {
    logWarn('un1t-billing', 'load failed', { contactId })
    return emptyBilling()
  }
}

/**
 * The header-band risk chip for an un1t.online overdue, or null. The title
 * names the studio with the earliest `since`.
 */
export function un1tHeaderRisk(billing) {
  if (!billing?.overdue) return null
  // Earliest `since` across every studio's every overdue row.
  let pick = null
  for (const s of billing.studios || []) {
    for (const p of s.pastDues || []) {
      if (!pick || sinceMs(p.since) < sinceMs(pick.since)) pick = { locationName: s.locationName, since: p.since }
    }
  }
  if (!pick) return null
  const since = formatDate(pick.since)
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
