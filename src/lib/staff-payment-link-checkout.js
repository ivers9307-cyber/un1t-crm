// PAYLINK.1 — the customer's side of a staff-sent payment link: the public
// page /buy/<token> (loadBuyPage, GET) and its "Continue to payment" POST
// (startStaffLinkCheckout).
//
// The CRM never charges a card. The POST finds (or, only with the customer's
// own tick on THIS request, creates) the person's un1t.online account and asks
// un1t.online for its own hosted checkout (createCheckoutLink); un1t.online
// takes the money. The paid sweep (Task 7) sees the payment in the mirror.
//
// GET reads only: no un1t.online call of any kind (no account search, no
// checkout, no legal-document read), so a WhatsApp link-preview crawler can
// never cause one. Its only write is the first-open stamp (markOpened).
//
// NEVER A CHECKOUT FOR SOMEONE WHO HAS PAID: before an account step and again
// once the account is known, the un1t_transactions mirror is read with the
// link's own rule (isPaymentForLink). The mirror lags un1t.online by up to
// ~17 minutes, so the link's own checkouts on the write ledger decide too: one
// younger than 20 minutes is handed back as it is, one 20 to 60 minutes old
// means "we're confirming, try again in a few minutes", and only after an hour
// (or with none) is a new one made. A read that fails (mirror or ledger) is
// "unknown", and unknown is never "unpaid": no checkout, the page says try again.
//
// The token and the checkout URL are never logged or stored on the row; logs
// carry ids and codes only (module 'paylink'). Every read here runs on the
// service role, so each one is pinned to the link's own studio, organisation
// and contact.
import { ensureUn1tAccount } from '@/lib/un1t-online-account'
import { createCheckoutLink } from '@/lib/un1t-online-write-ops'
import { Un1tWriteRefused, Un1tWriteUnknown } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { getLocationBranding } from '@/lib/location-branding'
import { studioTermsCopy, studioPublicPath } from '@/lib/landing-pages'
import { readUn1tLegalDocs } from '@/lib/un1t-online-legal'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import { appLinksFrom } from '@/lib/un1t-online-app-links'
import { isSellableUn1tProduct } from '@/lib/agent/mia-offer-limits'
import { UN1T_CHECKOUT_REUSE_MS } from '@/lib/trial-checkout-window'
import { un1tPriceLabel } from '@/lib/agent/un1t-tools'
import {
  resolveStaffPaymentLink, markOpened, isPaymentForLink, paymentLinkCopy, BUY_PATH, LIVE_STATUSES,
} from '@/lib/staff-payment-links'
import { logWarn, logError } from '@/lib/log'

const LOG = 'paylink'
export const PAYLINK_ORIGIN = 'staff_payment_link'
const CONTACT_COLS = 'id, first_name, last_name, name, email, phone, un1t_user_id, organization_id'
const LOCATION_COLS = 'id, name, organization_id, settings'
const PRODUCT_COLS = 'un1t_id, title, type, status, price_cents, currency, billing_interval, billing_interval_count'
const TX_COLS = 'un1t_id, un1t_user_id, product_id, type, amount_cents, refunded, remote_created_at'
const LEDGER_COLS = 'id, stage, checkout_url, idempotency_key, created_at'
const OPEN_STAGES = new Set(['sent', 'unknown'])

/** No new checkout while this link's newest one is younger than this (the mirror's lag, with margin). */
export const PAYLINK_CHECKOUT_COOLDOWN_MS = 60 * 60_000

// The page's own lines, over these defaults per key, from
// locations.settings.un1t_online.payment_link (beside paymentLinkCopy's keys).
export const PAGE_DEFAULTS = Object.freeze({
  paid_heading: "You're in, {first_name}!",
  confirming_text: "Thanks, {first_name}! We're confirming your payment. This can take a couple of minutes.",
  set_password_text: 'Check your inbox for a code to set your password, then log in to the un1t.online app with this email address.',
  continue_button: 'Continue to payment',
  not_you_text: 'Not you? Reply to us on WhatsApp.',
  retry_later_text: 'Please try again in a few minutes.',
})

/** paymentLinkCopy's keys plus the page's own lines. `un1tOnline` = locations.settings.un1t_online. */
export function buyPageCopy(un1tOnline) {
  const block = un1tOnline && typeof un1tOnline === 'object' ? un1tOnline.payment_link : null
  const s = block && typeof block === 'object' ? block : {}
  const out = { ...paymentLinkCopy(s) }
  for (const [key, def] of Object.entries(PAGE_DEFAULTS)) out[key] = typeof s[key] === 'string' && s[key].trim() ? s[key] : def
  return out
}

/**
 * {first_name} filled; with no name, the token and the comma before it go.
 * A function replacer, so a `$&` or `$1` in a name is never read as a pattern.
 */
export function fillFirstName(template, firstName) {
  const t = String(template || '')
  return firstName ? t.replace(/\{first_name\}/g, () => firstName) : t.replace(/,?\s*\{first_name\}/g, () => '')
}

const errCode = (error) => ({ code: error?.code ?? null })

async function readLocation(db, link) {
  const { data, error } = await db.from('locations').select(LOCATION_COLS).eq('id', link.location_id).maybeSingle()
  if (error) throw Object.assign(new Error('location unreadable'), errCode(error))
  return data || null
}

// Fresh by id, inside the link's organisation.
async function readContact(db, link) {
  let q = db.from('contacts').select(CONTACT_COLS).eq('id', link.contact_id)
  if (link.organization_id) q = q.eq('organization_id', link.organization_id)
  const { data, error } = await q.maybeSingle()
  if (error) throw Object.assign(new Error('contact unreadable'), errCode(error))
  return data || null
}

// The CURRENT product (what un1t.online will charge), at the link's studio.
async function readProduct(db, link) {
  const { data, error } = await db.from('un1t_products').select(PRODUCT_COLS)
    .eq('location_id', link.location_id).eq('un1t_id', link.un1t_product_id).limit(1).maybeSingle()
  if (error) throw Object.assign(new Error('product unreadable'), errCode(error))
  return data || null
}

/** The mirror transaction that pays this link for `userId`, or null. Throws on a read error. */
async function findPayment(db, link, userId) {
  if (!userId) return null
  const { data, error } = await db.from('un1t_transactions').select(TX_COLS)
    .eq('location_id', link.location_id).eq('un1t_user_id', String(userId)).eq('product_id', link.un1t_product_id)
    .gte('remote_created_at', link.created_at)
    .order('remote_created_at', { ascending: false }).range(0, 99)
  if (error) throw Object.assign(new Error('transactions unreadable'), errCode(error))
  const probe = { ...link, un1t_user_id: String(userId) }
  return (Array.isArray(data) ? data : []).find((t) => isPaymentForLink(probe, t)) || null
}

// This link's checkouts for this account and product, newest first. Throws on a read error.
async function readCheckoutLedger(db, link, userId) {
  const { data, error } = await db.from('un1t_write_events').select(LEDGER_COLS)
    .eq('location_id', link.location_id).eq('op', 'checkout').eq('origin_ref', link.id)
    .eq('un1t_user_id', String(userId)).eq('target', link.un1t_product_id)
    .order('created_at', { ascending: false }).range(0, 99)
  if (error) throw Object.assign(new Error('checkout ledger unreadable'), errCode(error))
  return Array.isArray(data) ? data : []
}

// n of a `paylink:<id>:r<n>` key, -1 for any other.
function keyIndex(linkId, key) {
  const prefix = `paylink:${linkId}:r`
  if (typeof key !== 'string' || !key.startsWith(prefix)) return -1
  const n = Number(key.slice(prefix.length))
  return Number.isInteger(n) && n >= 0 ? n : -1
}

function productView(product) {
  const recurring = product?.type === 'recurring'
  return {
    title: String(product?.title || '').trim(),
    price_label: un1tPriceLabel({
      price_cents: product?.price_cents,
      currency: product?.currency || 'EUR',
      billing_interval: recurring ? product?.billing_interval : null,
      billing_interval_count: recurring ? product?.billing_interval_count : null,
    }),
  }
}

const personView = (contact) => ({
  first_name: String(contact?.first_name || '').trim() || String(contact?.name || '').trim().split(/\s+/)[0] || '',
  email: contact?.email || '',
})

async function termsFor(db, location) {
  let publicPath = null
  try {
    publicPath = await studioPublicPath(db, location.id)
  } catch (err) {
    logWarn(LOG, 'studio path unreadable', { locationId: location.id, code: err?.cause?.code ?? err?.code ?? null })
  }
  if (!publicPath) return null
  return un1tTermsPayload({ terms: await studioTermsCopy(db, location.id), studioName: location.name, publicPath })
}

/**
 * GET /buy/<token>. Reads only; stamps `opened` on the first open.
 * @returns {Promise<{ kind: 'not_found' }
 *   | { kind: 'paid'|'expired'|'unavailable', branding, copy?, person?, appLinks?, createdAccount? }
 *   | { kind: 'ready', branding, copy, product: { title, price_label }, person: { first_name, email },
 *       isNew: boolean, terms: object|null, appLinks, createdAccount: boolean }>} never throws
 */
export async function loadBuyPage(db, token, { now = Date.now() } = {}) {
  let res
  try {
    res = await resolveStaffPaymentLink(db, token, { now })
  } catch (err) {
    logError(LOG, 'link unreadable; page unavailable', { code: err?.code ?? null, errClass: err?.name })
    return { kind: 'unavailable', branding: null, copy: buyPageCopy(null) }
  }
  if (res.kind === 'not_found') return { kind: 'not_found' }
  const { link, state } = res
  const ids = { linkId: link.id, locationId: link.location_id }

  let location
  let contact
  try {
    location = await readLocation(db, link)
    contact = await readContact(db, link)
  } catch (err) {
    logWarn(LOG, 'buy page context unreadable', { ...ids, code: err?.code ?? null })
    return { kind: 'unavailable', branding: await getLocationBranding(db, link.location_id), copy: buyPageCopy(null) }
  }
  const branding = { ...(await getLocationBranding(db, link.location_id)), studioName: location?.name || '' }
  const copy = buyPageCopy(location?.settings?.un1t_online)
  const base = {
    branding, copy,
    person: personView(contact),
    appLinks: appLinksFrom(location?.settings),
    createdAccount: !!link.terms_accepted_at,
  }
  if (state === 'paid') return { kind: 'paid', ...base }
  if (state !== 'live' || !location || !contact) return { kind: 'expired', ...base }

  let product
  try {
    product = await readProduct(db, link)
  } catch (err) {
    logWarn(LOG, 'product unreadable; page unavailable', { ...ids, code: err?.code ?? null })
    return { kind: 'unavailable', ...base }
  }
  if (!isSellableUn1tProduct(product)) return { kind: 'expired', ...base }

  try {
    if (await findPayment(db, link, link.un1t_user_id || contact.un1t_user_id)) return { kind: 'paid', ...base }
  } catch (err) {
    logWarn(LOG, 'transactions unreadable; page unavailable', { ...ids, code: err?.code ?? null })
    return { kind: 'unavailable', ...base }
  }

  // No API call: a person whose account exists but is not linked yet sees the
  // tick, and the POST then finds and links the account without creating one.
  const isNew = !link.un1t_user_id && !contact.un1t_user_id
  // Always, when the studio has them: an existing member whose account turns
  // out not to exist (terms_required) gets the tick without a reload.
  const terms = await termsFor(db, location)
  if (isNew && !terms) {
    logWarn(LOG, 'no studio page for the terms links; page unavailable', { ...ids, code: 'no_public_path' })
    return { kind: 'unavailable', ...base }
  }

  if (link.status === 'sent') await markOpened(db, link.id, new Date(now).toISOString())
  return { kind: 'ready', ...base, product: productView(product), isNew, terms }
}

/**
 * POST /api/public/buy/<token>: the account (when needed) and a fresh
 * un1t.online hosted checkout. Never throws.
 * @param {{ token: string, acceptTerms: boolean, now?: number }} args
 * @returns {Promise<{ kind: 'redirect', url: string } | { kind: 'not_found' }
 *   | { kind: 'paid'|'expired'|'unavailable'|'help', reason?: string } | { kind: 'terms_required' }
 *   | { kind: 'confirming' }>}  confirming: a checkout made in the last hour may be paid; no new one
 */
export async function startStaffLinkCheckout(db, { token, acceptTerms = false, now = Date.now() } = {}, deps = {}) {
  const {
    ensureAccount = ensureUn1tAccount, createLink = createCheckoutLink, legalDocs = readUn1tLegalDocs,
  } = deps
  const nowIso = new Date(now).toISOString()

  let res
  try {
    res = await resolveStaffPaymentLink(db, token, { now })
  } catch (err) {
    logError(LOG, 'link unreadable; no checkout', { code: err?.code ?? null, errClass: err?.name })
    return { kind: 'unavailable' }
  }
  if (res.kind === 'not_found') return { kind: 'not_found' }
  const { link } = res
  if (res.state === 'paid') return { kind: 'paid' }
  if (res.state !== 'live') return { kind: 'expired' }
  const ids = { linkId: link.id, locationId: link.location_id }

  // The link's row, only while it is still live (and, where given, still in the status read).
  const updateLink = async (patch, { status = null } = {}) => {
    let q = db.from('staff_payment_links').update({ ...patch, updated_at: nowIso }).eq('id', link.id)
    q = status ? q.eq('status', status) : q.in('status', LIVE_STATUSES)
    const { data, error } = await q.select('id')
    if (error) return { error }
    return { error: null, hit: Array.isArray(data) && data.length > 0 }
  }
  const markPaid = async (tx, code) => {
    const { error, hit } = await updateLink({ status: 'paid', paid_transaction_id: tx?.un1t_id ?? null, paid_at: nowIso }, { status: link.status })
    if (error) logWarn(LOG, 'link not stamped paid', { ...ids, code: error.code ?? null })
    else if (!hit) logWarn(LOG, 'link changed before the paid stamp', { ...ids, code })
    return { kind: 'paid' }
  }
  const help = async (reason) => {
    const { error } = await updateLink({ last_error: reason })
    if (error) logWarn(LOG, 'help reason not stamped', { ...ids, reason, code: error.code ?? null })
    else logWarn(LOG, 'payment link needs staff', { ...ids, reason })
    return { kind: 'help', reason }
  }

  let location
  let contact
  let product
  try {
    location = await readLocation(db, link)
    contact = await readContact(db, link)
    product = await readProduct(db, link)
  } catch (err) {
    logWarn(LOG, 'checkout context unreadable', { ...ids, code: err?.code ?? null })
    return { kind: 'unavailable' }
  }
  if (!location || !contact) return { kind: 'expired' }
  if (!isSellableUn1tProduct(product)) return { kind: 'expired' }

  // ── 1. Paid already? (the mirror, before anything is written) ──
  const knownUser = link.un1t_user_id || contact.un1t_user_id || null
  try {
    const tx = await findPayment(db, link, knownUser)
    if (tx) return markPaid(tx, 'paid_in_mirror')
  } catch (err) {
    logWarn(LOG, 'transactions unreadable; no checkout', { ...ids, code: err?.code ?? null })
    return { kind: 'unavailable' }
  }

  // ── 2. The account: created only with this request's own tick ──
  let request = null
  if (acceptTerms === true) {
    let version = null
    try {
      version = (await legalDocs(db, link.location_id))?.version ?? null
    } catch (err) {
      logWarn(LOG, 'legal documents version unread', { ...ids, errClass: err?.name })
    }
    request = { terms_accepted_at: nowIso, terms_source: 'buy_page', terms_version: version }
  }
  let account
  try {
    account = await ensureAccount(db, {
      locationId: link.location_id, organizationId: link.organization_id ?? location.organization_id ?? null,
      contact, request, origin: PAYLINK_ORIGIN, originRef: link.id,
    })
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return { kind: 'unavailable' }
    if (err instanceof Un1tWriteRefused) {
      if (err.result?.retryable) return { kind: 'unavailable' }
      return help(`un1t_account_refused:${err.code ?? 'unknown'}`)
    }
    logError(LOG, 'account step threw', { ...ids, code: err?.code ?? null, errClass: err?.name })
    return { kind: 'unavailable' }
  }
  if (account?.kind === 'retry') return { kind: 'unavailable' }
  if (account?.kind === 'card') {
    if (account.reason === 'terms_not_accepted') return { kind: 'terms_required' }
    return help(account.reason || 'account_card')
  }
  const userId = account?.un1tUserId ? String(account.un1tUserId) : null
  if (!userId) return help('un1t_outcome_unknown')

  // ── 3. Stamp the account (and the acceptance, when we created it) BEFORE the checkout ──
  if (userId !== link.un1t_user_id || account.kind === 'created') {
    const patch = { un1t_user_id: userId }
    if (account.kind === 'created' && request?.terms_accepted_at) patch.terms_accepted_at = request.terms_accepted_at
    const { error, hit } = await updateLink(patch)
    if (error) {
      logError(LOG, 'un1t user id not stamped; no checkout', { ...ids, code: error.code ?? null })
      return { kind: 'unavailable' }
    }
    if (!hit) {
      logWarn(LOG, 'link left live before the account stamp; no checkout', ids)
      return { kind: 'expired' }
    }
  }

  // ── 4. Paid already under the account just found? ──
  if (userId !== knownUser) {
    try {
      const tx = await findPayment(db, link, userId)
      if (tx) return markPaid(tx, 'paid_in_mirror')
    } catch (err) {
      logWarn(LOG, 'transactions unreadable; no checkout', { ...ids, code: err?.code ?? null })
      return { kind: 'unavailable' }
    }
  }

  // ── 5. This link's checkouts so far (Ruling J). The mirror lags
  // un1t.online by up to ~17 minutes, so a recent checkout may already be
  // paid: reuse it (under 20 min), or hold off (20 to 60 min), never mint a
  // second one in that window. ──
  let ledger
  try {
    ledger = await readCheckoutLedger(db, link, userId)
  } catch (err) {
    logError(LOG, 'checkout ledger unreadable; no checkout', { ...ids, code: err?.code ?? null })
    return { kind: 'unavailable' }
  }
  const newest = ledger[0] || null
  let resumeKey = null
  if (newest && newest.stage !== 'refused') {
    const age = now - Date.parse(newest.created_at || '')
    // An unreadable time cannot be told from a recent one.
    if (!Number.isFinite(age) || age < 0) return { kind: 'confirming' }
    if (age < UN1T_CHECKOUT_REUSE_MS) {
      if (newest.stage === 'done' && typeof newest.checkout_url === 'string' && newest.checkout_url) {
        return { kind: 'redirect', url: newest.checkout_url }
      }
      if (OPEN_STAGES.has(newest.stage) && newest.idempotency_key) resumeKey = newest.idempotency_key
      else return { kind: 'confirming' }
    } else if (age < PAYLINK_CHECKOUT_COOLDOWN_MS) {
      return { kind: 'confirming' }
    }
  }

  // ── 6. un1t.online's hosted checkout, back to this page on the customer host.
  // A fresh key r<n>, n past every key this link has used (an attempt still
  // open keeps its own key). ──
  const counted = Number.isInteger(link.checkout_count) && link.checkout_count >= 0 ? link.checkout_count : 0
  const n = Math.max(counted, ...ledger.map((e) => keyIndex(link.id, e?.idempotency_key) + 1))
  const idempotencyKey = resumeKey || `paylink:${link.id}:r${n}`
  const nextCount = Math.max(n, keyIndex(link.id, idempotencyKey) + 1)
  let checkout
  try {
    const baseUrl = await resolveCustomerBaseUrl(db, link.location_id)
    const page = `${baseUrl}${BUY_PATH}${token}`
    checkout = await createLink(db, {
      locationId: link.location_id, userId, productId: link.un1t_product_id,
      successUrl: `${page}?paid=1`, cancelUrl: `${page}?cancelled=1`,
      idempotencyKey, origin: PAYLINK_ORIGIN, originRef: link.id, actor: null,
    })
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return { kind: 'unavailable' }
    if (err instanceof Un1tWriteRefused) {
      if (err.result?.retryable) return { kind: 'unavailable' }
      return help(err.code || 'un1t_checkout_refused')
    }
    if (err instanceof Un1tWriteUnknown) {
      logWarn(LOG, 'checkout unclear', { ...ids, code: err.code ?? null })
      return { kind: 'unavailable' }
    }
    logError(LOG, 'checkout threw', { ...ids, code: err?.code ?? null, errClass: err?.name })
    return { kind: 'unavailable' }
  }
  if (checkout?.free === true) {
    // Ruling H: never read as paid (no transaction behind it); staff check the account.
    logWarn(LOG, 'un1t.online answered the checkout as free', { ...ids, ledgerId: checkout.ledgerId ?? null, code: 'checkout_free' })
    return help('checkout_free')
  }
  if (typeof checkout?.checkoutUrl !== 'string' || !checkout.checkoutUrl) {
    logWarn(LOG, 'checkout carried no page to pay on', { ...ids, code: 'checkout_no_url' })
    return { kind: 'unavailable' }
  }

  // A lost stamp is logged, never a reason to hold the customer back: the
  // sweep settles on un1t_user_id, and the next press reuses this key.
  const { error, hit } = await updateLink({ status: 'checkout_started', checkout_count: nextCount, last_checkout_ledger_id: checkout.ledgerId ?? null })
  if (error) logWarn(LOG, 'checkout not stamped', { ...ids, ledgerId: checkout.ledgerId ?? null, code: error.code ?? null })
  else if (!hit) {
    // Settled (paid by the sweep) or replaced while un1t.online answered:
    // the customer is not sent to pay a link that is no longer live.
    logWarn(LOG, 'link left live while its checkout was made; no checkout handed out', { ...ids, code: 'settled_meanwhile' })
    try {
      const again = await resolveStaffPaymentLink(db, token, { now })
      return { kind: again.kind === 'link' && again.state === 'paid' ? 'paid' : 'expired' }
    } catch {
      return { kind: 'unavailable' }
    }
  }
  return { kind: 'redirect', url: checkout.checkoutUrl }
}
