// UN1TDUN.1 — /pay-link/<token>: the short pay link a un1t.online payment
// reminder carries (un1t-dunning.js mints it; the WhatsApp template's URL
// button ends in the token).
//
// On open: find the run whose metadata.payment.link_suffix is the token,
// looking ONLY among the runs of the dunning sequences of un1t.online studios
// (locations.dunning_sequence_id where membership_source = 'un1t_online'),
// then GET /invoices/{id} LIVE with that studio's token (the fail-fast,
// budgeted reader Mia uses: no retries, a 5 s timeout). Still open and the
// URL is https on stripe.com → redirect to the Stripe hosted invoice page,
// where the member pays with any card. Paid / void / refunded → "all paid
// up". Anything else (un1t.online unreachable, a refused token, an odd
// answer) → "try again shortly" with the studio's name.
//
// The Stripe URL is a bearer link to the member's invoice, so it is never
// stored, never logged and never rendered: it exists only in the redirect.
// The token is the only credential and is never logged either. A token that
// matches nothing is not_found (the page 404s; nothing confirms a token).
// Reads only; nothing here writes.
import { openUn1tMemberReader } from '@/lib/agent/un1t-member-read'
import { Un1tApiError, Un1tAuthError } from '@/lib/un1t-online'
import { normaliseUn1tInvoiceStatus } from '@/lib/membership/reads/un1t-online-shape'
import { getLocationBranding } from '@/lib/location-branding'
import { logWarn } from '@/lib/log'

const LOG_MODULE = 'un1t-pay-link'
const PLATFORM = 'un1t_online'
// newUn1tPayToken mints 32 base64url characters; anything far off that shape
// is refused before a single query.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22,64}$/
// An invoice in one of these states owes nothing.
const SETTLED = new Set(['paid', 'void', 'refunded'])

/**
 * The URL to send a member to, or null: https, on stripe.com or a subdomain
 * of it, with no credentials in it. Pure.
 */
export function safeStripeInvoiceUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  let u
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  const host = u.hostname.toLowerCase()
  if (host !== 'stripe.com' && !host.endsWith('.stripe.com')) return null
  return u.href
}

async function brandingFor(db, locationId) {
  const b = await getLocationBranding(db, locationId)
  return { companyName: b?.companyName || '', studioName: b?.locationName || '', logoUrl: b?.logoUrl || null }
}

/**
 * @param {object} db     service-role client
 * @param {string} token  the path segment
 * @param {{ openReader?: Function }} [deps]
 * @returns {Promise<{ kind: 'not_found' } | { kind: 'redirect', url: string }
 *   | { kind: 'paid' | 'unavailable', branding: { companyName, studioName, logoUrl } | null }>}
 */
export async function resolveUn1tPayLink(db, token, { openReader = openUn1tMemberReader } = {}) {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return { kind: 'not_found' }

  const { data: locs, error: locErr } = await db
    .from('locations')
    .select('id, dunning_sequence_id')
    .eq('membership_source', PLATFORM)
  if (locErr) {
    logWarn(LOG_MODULE, 'studio read failed', { code: locErr.code ?? null })
    return { kind: 'unavailable', branding: null }
  }
  const locationBySequence = new Map()
  for (const l of locs || []) if (l?.dunning_sequence_id) locationBySequence.set(l.dunning_sequence_id, l.id)
  if (locationBySequence.size === 0) return { kind: 'not_found' }

  const { data: runs, error: runErr } = await db
    .from('sequence_enrollments')
    .select('id, sequence_id, metadata')
    .in('sequence_id', [...locationBySequence.keys()])
    .eq('metadata->payment->>link_suffix', token)
    .limit(2)
  if (runErr) {
    logWarn(LOG_MODULE, 'run read failed', { code: runErr.code ?? null })
    return { kind: 'unavailable', branding: null }
  }
  // Two runs on one token cannot happen with 24 random bytes; if it ever
  // does, neither member is sent to the other's invoice.
  if (!Array.isArray(runs) || runs.length !== 1) return { kind: 'not_found' }
  const run = runs[0]
  const payment = run?.metadata?.payment
  const invoiceId = typeof payment?.invoice_id === 'string' ? payment.invoice_id.trim() : ''
  const locationId = locationBySequence.get(run.sequence_id)
  if (payment?.platform !== PLATFORM || payment?.link_suffix !== token || !invoiceId || !locationId) {
    return { kind: 'not_found' }
  }

  const branding = await brandingFor(db, locationId)
  const unavailable = { kind: 'unavailable', branding }

  const reader = await openReader(db, locationId)
  if (!reader?.ok) {
    logWarn(LOG_MODULE, 'un1t.online reader unavailable', { locationId, reason: reader?.reason ?? null })
    return unavailable
  }
  let invoice
  try {
    invoice = await reader.getOne(`/invoices/${encodeURIComponent(invoiceId)}`)
  } catch (err) {
    const status = err instanceof Un1tApiError || err instanceof Un1tAuthError ? err.status ?? null : null
    logWarn(LOG_MODULE, 'invoice read failed', { locationId, status, errClass: err?.name ?? null })
    return unavailable
  }
  const state = normaliseUn1tInvoiceStatus(invoice?.status)
  if (SETTLED.has(state)) return { kind: 'paid', branding }
  if (state !== 'open') {
    logWarn(LOG_MODULE, 'invoice in a state with no payment page', { locationId, state })
    return unavailable
  }
  const url = safeStripeInvoiceUrl(invoice?.invoice_url)
  if (!url) {
    // Never the URL itself: only that it was not one we send people to.
    logWarn(LOG_MODULE, 'open invoice has no usable payment page', { locationId, present: invoice?.invoice_url != null })
    return unavailable
  }
  return { kind: 'redirect', url }
}
