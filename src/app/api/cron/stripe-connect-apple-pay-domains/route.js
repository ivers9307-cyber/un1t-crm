// GET /api/cron/stripe-connect-apple-pay-domains — HOSTAPPLEPAY.1
//
// Daily. Makes sure every Stripe connected account the estate charges on (each
// event host, each studio on Stripe) holds every domain a buyer can pay on as a
// Payment Method Domain, with Apple Pay validated. Direct charges show Apple Pay
// only for a domain registered on the CONNECTED account
// (src/lib/payments/apple-pay-domains.js says why). The onboarding paths do the
// same the moment an account can charge; this run backfills accounts that
// onboarded before them, picks up a domain added later (a new tenant domain)
// and retries anything a hook missed. Idempotent: an account already in step
// costs one list call.
//
// Stamps 'stripe-connect-apple-pay-domains' (mig 813) only when every Stripe
// call answered; an Apple Pay status Stripe left 'inactive' is reported in the
// outcome, not a failure. A failed accounts read is a 500 with no stamp. A run
// where an account or the tenant domain read failed still answers success
// (the failure is counted and logged) but returns `stamp: false`.
//
// defineCron owns the CRON_SECRET check, the error boundary and the stamp.

import { defineCron } from '@/lib/define-cron'
import { logError, logWarn } from '@/lib/log'
import {
  listCheckoutDomains,
  listConnectedAccounts,
  ensureAccountDomains,
} from '@/lib/payments/apple-pay-domains'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// One list call per connected account plus a create or revalidate per missing
// domain; a handful of accounts in practice.
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'stripe-connect-apple-pay-domains' }, async ({ db }) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    // No Stripe on this deployment (a preview): nothing to register.
    return { outcome: { skipped: 'stripe_not_configured' }, body: { data: { skipped: 'stripe_not_configured' } } }
  }

  let accounts
  try {
    accounts = await listConnectedAccounts(db)
  } catch (err) {
    logError('apple-pay-domains', 'connected accounts read failed', { error: err?.message || String(err) })
    return { ok: false, body: { error: 'accounts_read_failed' } }
  }

  const { domains, tenantReadFailed } = await listCheckoutDomains(db)

  const summary = []
  let failedAccounts = 0
  let created = 0
  let revalidated = 0
  const inactive = []
  for (const acct of accounts) {
    const res = await ensureAccountDomains(acct.accountId, domains)
    for (const r of res.results) {
      if (r.action === 'created') created += 1
      if (r.action === 'revalidated') revalidated += 1
      if (r.action !== 'failed' && r.applePay !== 'active') inactive.push({ account: acct.accountId, domain: r.domain })
    }
    if (!res.ok) {
      failedAccounts += 1
      logWarn('apple-pay-domains', 'account not fully registered', {
        accountId: acct.accountId,
        kind: acct.kind,
        error: res.error,
        failed: res.results.filter((r) => r.action === 'failed').map((r) => ({ domain: r.domain, error: r.error })),
      })
    }
    summary.push({ account: acct.accountId, kind: acct.kind, ok: res.ok })
  }

  const outcome = {
    accounts: accounts.length,
    domains: domains.length,
    created,
    revalidated,
    apple_pay_inactive: inactive.length,
    failed_accounts: failedAccounts,
    tenant_read_failed: tenantReadFailed,
  }
  return {
    stamp: failedAccounts === 0 && !tenantReadFailed,
    outcome,
    body: { data: { ...outcome, inactive, summary } },
  }
})
