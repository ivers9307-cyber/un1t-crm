// Stripe Connect payment adapter (EVENTS-HOST.1).
//
// Third-party-hosted events settle here: a DIRECT charge onto the host's own
// connected account (Stripe-Account header), with a flat per-ticket booking
// fee kept by UN1T as the application_fee_amount. The host is merchant of
// record, so refunds/chargebacks debit the host and money never touches a
// UN1T balance.
//
// The real implementation (Stripe SDK, PaymentIntents/Checkout, account.updated
// + payout webhooks, SCA/3DS) lands in the Stripe Connect PR once the platform
// account + STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are provisioned. This stub
// keeps the dispatcher interface complete and fails LOUD if a stripe_connect
// event somehow tries to take money before that PR ships (it can't in practice:
// charges are gated on host.charges_enabled, which no host has yet).

export const provider = 'stripe_connect'

const NOT_READY =
  'Stripe Connect is not wired yet — this host has no live payment processor. ' +
  '(EVENTS-HOST.1 foundation; the charge/refund path ships in the Stripe Connect PR.)'

// eslint-disable-next-line no-unused-vars
export async function createPayment(_args) {
  throw new Error(NOT_READY)
}

// eslint-disable-next-line no-unused-vars
export async function getPayment(_providerRef) {
  throw new Error(NOT_READY)
}

// eslint-disable-next-line no-unused-vars
export async function refundPayment(_providerRef, _opts) {
  throw new Error(NOT_READY)
}
