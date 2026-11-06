// HOSTAPPLEPAY.1 — register our checkout domains on every Stripe CONNECTED
// account, so Apple Pay shows on a host's (or a studio's) embedded checkout.
//
// Why: Stripe Connect payments here are DIRECT charges. The Checkout Session is
// created on the connected account (src/lib/payments/stripe-connect.js) and the
// browser loads Stripe.js AS that account (RaceCheckoutPage's
// `loadStripe(pk, { stripeAccount })`). Stripe then shows Apple Pay only when the
// page's domain is a Payment Method Domain registered ON THAT CONNECTED ACCOUNT.
// The registration on UN1T's own platform account does not count, and nothing
// registered one on a host's account, so every host checkout showed Google Pay
// (which needs no domain proof in Checkout) and never Apple Pay.
//
// The Apple proof file itself is already served on every host
// (public/.well-known/apple-developer-merchantid-domain-association, APPLEPAY.1);
// Stripe fetches it when a domain is created or validated.
//
// Everything here is idempotent: list what the account already holds, create
// what is missing, re-validate a registered domain whose Apple Pay status is not
// active. Safe to run on every onboarding step and from the daily cron
// (/api/cron/stripe-connect-apple-pay-domains), which also picks up a domain or
// host added later.

import { getStripe } from '../stripe'
import { BRANDS, getCrmHostnames } from '../brands'
import { logWarn } from '../log'

// The public paths a Stripe Connect checkout is mounted on. A brand host that
// serves any of them is a domain a buyer can pay on.
export const CHECKOUT_PATHS = Object.freeze(['/event-pay/', '/race-pay/', '/class-pay/'])

/**
 * Lower-case, port-free hostname, or null when it is not a domain Stripe could
 * ever verify for Apple Pay (localhost, a bare IP, a Vercel preview host).
 */
export function normalizeCheckoutDomain(raw) {
  if (typeof raw !== 'string') return null
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0]
  if (!host || !host.includes('.')) return null
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.test')) return null
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null
  if (host.endsWith('.vercel.app')) return null
  return host
}

/**
 * The in-code domains a checkout can be served on: the CRM hosts (every public
 * path passes there) and each BRANDS host whose allow-list carries a checkout
 * path. Pure; no DB.
 * @returns {string[]}
 */
export function staticCheckoutDomains() {
  const out = new Set()
  for (const h of getCrmHostnames()) {
    const d = normalizeCheckoutDomain(h)
    if (d) out.add(d)
  }
  for (const brand of BRANDS) {
    const paths = brand.allowedPaths || []
    if (!CHECKOUT_PATHS.some((p) => paths.includes(p))) continue
    for (const h of brand.hostnames || []) {
      const d = normalizeCheckoutDomain(h)
      if (d) out.add(d)
    }
  }
  return [...out].sort()
}

/**
 * Every domain a buyer can pay on: the in-code ones plus each ACTIVE
 * tenant_domains host (customer links are built on those since SAAS-8, and the
 * tenant tier allows '/event-pay/'). A failed tenant read returns the in-code
 * set with `tenantReadFailed: true`, never "no tenant domains" silently.
 * @returns {Promise<{ domains: string[], tenantReadFailed: boolean }>}
 */
export async function listCheckoutDomains(db) {
  const out = new Set(staticCheckoutDomains())
  let tenantReadFailed = false
  try {
    const { data, error } = await db.from('tenant_domains').select('hostname').eq('active', true)
    if (error) throw error
    for (const row of data || []) {
      const d = normalizeCheckoutDomain(row.hostname)
      if (d) out.add(d)
    }
  } catch (err) {
    tenantReadFailed = true
    logWarn('apple-pay-domains', 'tenant_domains read failed; registering the in-code domains only', {
      error: err?.message || String(err),
    })
  }
  return { domains: [...out].sort(), tenantReadFailed }
}

async function listAccountDomains(stripe, accountId) {
  const existing = new Map()
  let startingAfter
  // At most a handful of domains per account; the loop is bounded anyway.
  for (let page = 0; page < 20; page += 1) {
    const res = await stripe.paymentMethodDomains.list(
      { limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      { stripeAccount: accountId },
    )
    for (const d of res?.data || []) existing.set(String(d.domain_name).toLowerCase(), d)
    if (!res?.has_more || !res.data?.length) break
    startingAfter = res.data[res.data.length - 1].id
  }
  return existing
}

const applePayStatus = (d) => d?.apple_pay?.status || null

/**
 * Make sure every domain is registered on the connected account, and that its
 * Apple Pay status is active (re-validating one that is not). Never throws.
 *
 * @param {string} accountId acct_…
 * @param {string[]} domains
 * @returns {Promise<{ ok: boolean, error?: string, results: { domain: string, action: 'exists'|'created'|'revalidated'|'failed', applePay: string|null, error?: string }[] }>}
 *   ok is false when a Stripe call failed (the list, or any create/validate). An
 *   Apple Pay status that stays 'inactive' after a successful call is reported,
 *   not a failure: Stripe answered, and the reason is in its status_details.
 */
export async function ensureAccountDomains(accountId, domains) {
  if (!accountId) return { ok: false, error: 'no_account', results: [] }
  let stripe
  let existing
  try {
    stripe = getStripe()
    existing = await listAccountDomains(stripe, accountId)
  } catch (err) {
    return { ok: false, error: err?.message || String(err), results: [] }
  }

  const results = []
  for (const domain of domains) {
    const have = existing.get(domain)
    try {
      if (!have) {
        const created = await stripe.paymentMethodDomains.create(
          { domain_name: domain, enabled: true },
          { stripeAccount: accountId },
        )
        results.push({ domain, action: 'created', applePay: applePayStatus(created) })
      } else if (applePayStatus(have) !== 'active') {
        const validated = await stripe.paymentMethodDomains.validate(have.id, {}, { stripeAccount: accountId })
        results.push({ domain, action: 'revalidated', applePay: applePayStatus(validated) })
      } else {
        results.push({ domain, action: 'exists', applePay: 'active' })
      }
    } catch (err) {
      results.push({ domain, action: 'failed', applePay: applePayStatus(have), error: err?.message || String(err) })
    }
  }
  const ok = results.every((r) => r.action !== 'failed')
  return { ok, results }
}

/**
 * Best-effort onboarding hook: register every checkout domain on one connected
 * account. Never throws; logs a failure with the account id and domains (no
 * customer data). Use from the onboarding paths, where a Stripe hiccup must
 * never fail the status sync; the daily cron retries whatever this missed.
 * @returns {Promise<{ ok: boolean, error?: string, results: object[] }>}
 */
export async function registerCheckoutDomainsForAccount(db, accountId) {
  try {
    const { domains } = await listCheckoutDomains(db)
    const res = await ensureAccountDomains(accountId, domains)
    if (!res.ok) {
      logWarn('apple-pay-domains', 'checkout domain registration incomplete', {
        accountId,
        error: res.error,
        failed: res.results.filter((r) => r.action === 'failed').map((r) => ({ domain: r.domain, error: r.error })),
      })
    }
    return res
  } catch (err) {
    logWarn('apple-pay-domains', 'checkout domain registration threw', { accountId, error: err?.message || String(err) })
    return { ok: false, error: err?.message || String(err), results: [] }
  }
}

/**
 * Every Stripe connected account the estate charges on: each event host with
 * an account, and each studio whose payments settings carry one. A failed read
 * throws: the cron must not report "no accounts" when it could not look.
 * @returns {Promise<{ accountId: string, kind: 'host'|'location', id: string }[]>}
 */
export async function listConnectedAccounts(db) {
  const out = []
  const seen = new Set()
  const { data: hosts, error: hostErr } = await db
    .from('event_hosts')
    .select('id, stripe_connected_account_id')
    .not('stripe_connected_account_id', 'is', null)
  if (hostErr) throw new Error(`event_hosts read failed: ${hostErr.message}`)
  for (const h of hosts || []) {
    const acct = h.stripe_connected_account_id
    if (acct && !seen.has(acct)) { seen.add(acct); out.push({ accountId: acct, kind: 'host', id: h.id }) }
  }
  const { data: locs, error: locErr } = await db
    .from('locations')
    // Only the one JSON path: `settings` carries credentials (CLAUDE.md).
    .select('id, acct:settings->payments->>stripe_connected_account_id')
    .not('settings->payments->>stripe_connected_account_id', 'is', null)
  if (locErr) throw new Error(`locations read failed: ${locErr.message}`)
  for (const l of locs || []) {
    const acct = l.acct
    if (acct && !seen.has(acct)) { seen.add(acct); out.push({ accountId: acct, kind: 'location', id: l.id }) }
  }
  return out
}
