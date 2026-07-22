// Per-location payment rail for the class funnel (paid intro offer).
// Mirrors getLocationTrialConfig (glofox-push.js) — config lives on the
// location, at settings.payments. Revolut = UN1T is the merchant of record
// (shared merchant account, no per-location account needed). Stripe Connect =
// the location's own connected account (must be onboarded via the events-host
// flow before it can charge).
const PROVIDER_REVOLUT = 'revolut'
const PROVIDER_STRIPE_CONNECT = 'stripe_connect'

export function resolveLocationPaymentProvider(location) {
  const p = location?.settings?.payments || {}
  if (p.provider === PROVIDER_STRIPE_CONNECT) {
    return { provider: PROVIDER_STRIPE_CONNECT, connectedAccountId: p.stripe_connected_account_id || null }
  }
  return { provider: PROVIDER_REVOLUT, connectedAccountId: null }
}

export function locationCanTakePayments(location) {
  const { provider, connectedAccountId } = resolveLocationPaymentProvider(location)
  if (provider === PROVIDER_STRIPE_CONNECT) return !!connectedAccountId
  return true // Revolut: shared UN1T merchant, always able
}
