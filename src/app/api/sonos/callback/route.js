// SONOS.12 — completes the OAuth link. Stores the household the operator
// is linking, one row per location.
//
// The household is read from GET /households and, when the account holds
// more than one, the operator is sent back to pick. It is NEVER
// households[0] — that is the exact shape of the Xero tenants[0] bug that
// bound three locations to one org and filed 101 bills into the wrong
// legal entity (mig 554).
//
// This route is deliberately UNAUTHENTICATED — getCurrentUser() is never
// called here, because Sonos redirects the operator's browser straight to
// this URL with no way for us to attach a session cookie to that hop. The
// signed `state` minted by /api/sonos/connect (verifyState, imported
// below) is the only thing standing in for auth; see the guard right
// before it is used.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getSonosConfig, exchangeCode, sonosGetHouseholds } from '@/lib/sonos/client'
import { verifyState } from '../connect/route'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  // The redirect target is built off THIS request's own URL, not an env
  // var. NEXT_PUBLIC_SITE_URL does not exist anywhere else in this repo —
  // the app's actual "our own URL" var is NEXT_PUBLIC_APP_URL (used for
  // email links) — and either way it's the wrong tool here: NextResponse
  // .redirect() runs its target through `new URL(String(url))` with NO
  // base, so a relative path (what `${undefined}/automations/sonos...`
  // collapses to when the env var is unset) throws "Invalid URL" instead
  // of redirecting anywhere. That would have turned EVERY outcome of this
  // route — including the success path — into an unhandled 500 on every
  // deploy, since nothing sets NEXT_PUBLIC_SITE_URL today. request.url is
  // always absolute for an inbound request, so build against it instead —
  // the same approach settingsUrl() uses in src/app/api/xero/callback/route.js.
  const back = (params) => {
    const u = new URL('/automations/sonos', request.url)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    return NextResponse.redirect(u)
  }

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (url.searchParams.get('error')) {
    return back({ sonos: 'denied' })
  }
  if (!code || !state) return back({ sonos: 'bad_callback' })

  const cfg = getSonosConfig()
  if (!cfg || cfg.error) return back({ sonos: 'not_configured' })

  // verifyState's entire security guarantee is the HMAC over CRON_SECRET —
  // this route has no session to fall back on. `process.env.CRON_SECRET ||
  // ''` would silently downgrade to signing/verifying with a known empty
  // key (HMAC with '' proves nothing) if the var were ever unset, which
  // would let anyone forge a state naming any location. /api/sonos/connect
  // already refuses to MINT a state under this condition; fail closed the
  // same way here on the ACCEPTING side rather than falling through.
  if (!process.env.CRON_SECRET) return back({ sonos: 'not_configured' })

  const claims = verifyState(state, process.env.CRON_SECRET)
  if (!claims?.locationId) return back({ sonos: 'bad_state' })

  const tokenRes = await exchangeCode(cfg, code)
  if (!tokenRes.ok || !tokenRes.body?.refresh_token) {
    logWarn('sonos-callback', 'code exchange failed', { statusCode: tokenRes.statusCode })
    return back({ sonos: 'exchange_failed' })
  }

  const accessToken = tokenRes.body.access_token
  const hhRes = await sonosGetHouseholds(accessToken)
  const households = Array.isArray(hhRes.body?.households) ? hhRes.body.households : []
  if (!households.length) return back({ sonos: 'no_household' })

  // A Sonos account with several households cannot be resolved for the
  // operator — guessing is how the wrong-entity bug happened. Ask.
  const chosen = url.searchParams.get('household_id')
  if (households.length > 1 && !chosen) {
    return back({ sonos: 'pick_household', ids: households.map((h) => h.id).join(',') })
  }
  const householdId = chosen || households[0].id
  if (!households.some((h) => h.id === householdId)) return back({ sonos: 'bad_household' })

  const db = createServerClient()

  // sonos_connections carries TWO unique constraints (mig 556): location_id
  // (one connection per location) and household_id (one location per
  // household — the constraint that actually mirrors the Xero tenants[0]
  // bug; see src/lib/xero/tenant-binding.js). The upsert below only names
  // onConflict: 'location_id' because a Postgres ON CONFLICT clause can
  // arbitrate exactly one unique index — it does NOT also catch a clash on
  // the separate household_id index. If location B tries to claim a
  // household location A already holds, the upsert does not update A's
  // row; it hard-fails the INSERT itself with a 23505 unique violation, and
  // without this pre-check the operator would see only the generic
  // 'save_failed' with no way to tell what went wrong — there is no
  // in-app disconnect yet (mig 556's own column comment says as much), so a
  // silent failure strands them.
  //
  // Shaped after validateTenantChoice: read who currently holds the
  // resource and refuse the write outright when it is a DIFFERENT location,
  // rather than let the database discover it. This location's OWN existing
  // row is not a conflict — that's a reconnect, not a steal.
  const { data: clash, error: clashErr } = await db
    .from('sonos_connections')
    .select('location_id')
    .eq('household_id', householdId)
    .maybeSingle()
  if (clashErr) {
    logWarn('sonos-callback', 'household lookup failed', { error: clashErr.message })
    return back({ sonos: 'save_failed' })
  }
  if (clash && clash.location_id !== claims.locationId) {
    return back({ sonos: 'household_taken' })
  }

  const nowIso = new Date().toISOString()
  const { error } = await db.from('sonos_connections').upsert({
    location_id: claims.locationId,
    household_id: householdId,
    refresh_token: tokenRes.body.refresh_token,
    access_token: accessToken,
    access_token_expires_at: new Date(Date.now() + (tokenRes.body.expires_in || 86400) * 1000).toISOString(),
    linked_by: claims.profileId || null,
    updated_at: nowIso,
  }, { onConflict: 'location_id' })

  if (error) {
    // The pre-check above closes the common case; this closes the RACE —
    // two operators (or a double-submitted callback) linking the same
    // household in the gap between the SELECT above and this INSERT. Still
    // a unique_violation on household_id, so it still deserves the honest
    // answer rather than the generic save_failed.
    if (error.code === '23505') {
      logWarn('sonos-callback', 'household race lost to a concurrent link', { householdId })
      return back({ sonos: 'household_taken' })
    }
    logWarn('sonos-callback', 'connection write failed', { error: error.message })
    return back({ sonos: 'save_failed' })
  }

  return back({ sonos: 'connected' })
}
