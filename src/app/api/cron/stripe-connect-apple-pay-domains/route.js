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
// outcome, not a failure. A failed accounts read is a 500 with no stamp.
//
// Secured by CRON_SECRET (Vercel cron sends Authorization: Bearer <secret>).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logWarn } from '@/lib/log'
import {
  listCheckoutDomains,
  listConnectedAccounts,
  ensureAccountDomains,
} from '@/lib/payments/apple-pay-domains'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEARTBEAT = 'stripe-connect-apple-pay-domains'

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    // No Stripe on this deployment (a preview): nothing to register.
    await stampHeartbeat(HEARTBEAT, { skipped: 'stripe_not_configured' })
    return NextResponse.json({ success: true, data: { skipped: 'stripe_not_configured' } })
  }

  const db = createServerClient()
  let accounts
  try {
    accounts = await listConnectedAccounts(db)
  } catch (err) {
    logError('apple-pay-domains', 'connected accounts read failed', { error: err?.message || String(err) })
    return NextResponse.json({ success: false, error: 'accounts_read_failed' }, { status: 500 })
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
  if (failedAccounts === 0 && !tenantReadFailed) await stampHeartbeat(HEARTBEAT, outcome)
  return NextResponse.json({ success: true, data: { ...outcome, inactive, summary } })
}
