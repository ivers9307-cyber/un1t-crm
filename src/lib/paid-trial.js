// PAIDTRIAL.1 — pure helpers for the paid trial product (the /trial page).
// No IO. The block itself is PAID_TRIAL_DEFAULT in landing-page-blocks.js.

import { resolveLandingPath } from '@/lib/public-landing'

export const PAID_TRIAL_LEAD_SOURCE = 'meta_trial'
export const PAID_TRIAL_MIN_CENTS = 100
export const PAID_TRIAL_MAX_CENTS = 50_000

// The copy a block falls back to when an operator blanks a field. Kept in step
// with PAID_TRIAL_DEFAULT in landing-page-blocks.js.
const DEFAULT_TRIAL_USED_TEXT = "It looks like you've already had a trial with us at Stillorgan, so the 14 Day Reset can't be redeemed on this account. If that's not right, or you'd like to talk about your options, tap I need help and the team will be in touch."
const DEFAULT_ACTIVE_MEMBER_TEXT = "It looks like you already have an active membership at UN1T Hatch Street, which already covers your classes. If that's not right, tap I need help and the team will be in touch."
const DEFAULT_HELP_CTA_LABEL = 'I need help'
const DEFAULT_HELP_SENT_TEXT = 'Thanks. The team will be in touch shortly.'
const DEFAULT_SCROLL_CUE_LABEL = 'Learn more about the studio'

// TRIALSTUDIO.10 — what a Hatch Street buyer back from un1t.online's checkout
// reads while the 2-minute cron settles the purchase off the 15-minute
// mirror: never "it's on your account" before it is. The block's
// pending_body; this is its default (PAID_TRIAL_DEFAULT uses it too).
export const PAID_TRIAL_PENDING_BODY = "Thanks, your payment is being confirmed. un1t.online will email your receipt and we'll have your trial on your account shortly."

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

// Final-review F2 — the explanation email a Hatch Street (un1t.online) buyer
// gets when the CRM created their un1t.online account at checkout: the
// set-password step's first email, before un1t.online's own reset code. The
// block's account_email_subject / account_email_body; these are their
// defaults (PAID_TRIAL_DEFAULT uses them too). Tokens: {first_name},
// {product_name}, {studio_name}. Never the class funnel's "booked in" copy:
// nothing is booked.
export const PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT = Object.freeze({
  account_email_subject: 'Your trial is on your un1t.online account',
  account_email_body: 'Hi {first_name}, thanks for buying {product_name} at {studio_name}. It is on your un1t.online account. A code to set your password is on its way in a separate email from un1t.online; once you are in, book your classes in the app. Reply to this email if anything looks off.',
})

/**
 * The buyer-facing words a paid_trial block owns, each blank or missing field
 * on its default (a stored block can predate the field). Pure. Used by
 * paidTrialConfigFromBlocks and by the /trial page, which hands the card these
 * resolved words even for a studio that is not for sale (a return still reads
 * them), so the card never renders an empty message.
 */
export function paidTrialCopyFromBlock(b) {
  const block = b && typeof b === 'object' ? b : {}
  return {
    studioLabel: str(block.studio_label) || '',
    trialUsedText: str(block.trial_used_text) || DEFAULT_TRIAL_USED_TEXT,
    activeMemberText: str(block.active_member_text) || DEFAULT_ACTIVE_MEMBER_TEXT,
    helpCtaLabel: str(block.help_cta_label) || DEFAULT_HELP_CTA_LABEL,
    helpSentText: str(block.help_sent_text) || DEFAULT_HELP_SENT_TEXT,
    pendingBody: str(block.pending_body) || PAID_TRIAL_PENDING_BODY,
    scrollCueLabel: str(block.scroll_cue_label) || DEFAULT_SCROLL_CUE_LABEL,
  }
}

/**
 * The trial buyer's account email copy off a paid_trial block (or the block
 * list), each blank or missing field on its default. Pure.
 * @returns {{ subject: string, body: string }}
 */
export function paidTrialAccountEmailCopy(blockOrBlocks) {
  const b = Array.isArray(blockOrBlocks)
    ? blockOrBlocks.find((x) => x && typeof x === 'object' && x.type === 'paid_trial')
    : blockOrBlocks
  const block = b && typeof b === 'object' ? b : {}
  return {
    subject: str(block.account_email_subject) || PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT.account_email_subject,
    body: str(block.account_email_body) || PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT.account_email_body,
  }
}

/**
 * The product the page sells, read off a studio's landing blocks. `null` when
 * the row has no paid_trial block or the block is not sellable: the page shows
 * nothing to buy and the POST refuses with `not_configured`, never a guess at
 * a default plan. Pure: the un1t.online price comes in as `product`, the
 * mirrored `un1t_products` row the caller already read.
 *
 * Two shapes. A block with `un1t_product_id` sells that un1t.online product
 * (provider 'un1t_online'): sellable only when `product` is that id, active,
 * a one-off (`type 'one_time'`, never a recurring product) and priced above
 * zero, and the price and currency come from it. Any other
 * block is the Glofox shape (provider 'glofox'): the typed price and both
 * Glofox ids, exactly as before; `product` is ignored.
 * @returns {null | {
 *   provider: 'glofox' | 'un1t_online',
 *   productName: string, priceCents: number, currency: string, durationDays: number,
 *   membershipId: string|null, planCode: string|null, un1tProductId: string|null,
 *   tag: string, leadSource: string, eventSourceUrl: string,
 *   studioLabel: string, trialUsedText: string, activeMemberText: string,
 *   helpCtaLabel: string, helpSentText: string, pendingBody: string, scrollCueLabel: string, block: object }}
 */
export function paidTrialConfigFromBlocks(blocks, landingPath, { product = null } = {}) {
  const path = resolveLandingPath(landingPath)
  const list = Array.isArray(blocks) ? blocks : []
  const b = list.find((x) => x && typeof x === 'object' && x.type === 'paid_trial')
  if (!b) return null
  const rawDays = Number(b.duration_days)
  const durationDays = Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 365 ? Math.floor(rawDays) : 14
  const shared = {
    durationDays,
    productName: str(b.product_name) || `${durationDays} day trial`,
    tag: str(b.tag) || `${path}-trial`,
    leadSource: str(b.lead_source) || PAID_TRIAL_LEAD_SOURCE,
    eventSourceUrl: str(b.event_source_url) || `https://www.un1tdublin.com/trial`,
    ...paidTrialCopyFromBlock(b),
    block: b,
  }

  const un1tProductId = str(b.un1t_product_id)
  if (un1tProductId) {
    // A one-off only: the card says "charged once; nothing renews", so a
    // recurring product (a subscription) is never for sale here.
    if (!product || product.un1t_id !== un1tProductId || product.status !== 'active' || product.type !== 'one_time') return null
    const rawCents = Number(product.price_cents)
    const cents = Number.isFinite(rawCents) ? Math.floor(rawCents) : 0
    if (cents <= 0) return null
    return {
      ...shared,
      provider: 'un1t_online',
      priceCents: cents,
      currency: str(product.currency)?.toUpperCase() || 'EUR',
      membershipId: null,
      planCode: null,
      un1tProductId,
    }
  }

  const rawPrice = Number(b.price_cents)
  const priceCents = Number.isFinite(rawPrice) ? Math.floor(rawPrice) : 0
  if (priceCents < PAID_TRIAL_MIN_CENTS || priceCents > PAID_TRIAL_MAX_CENTS) return null
  const membershipId = str(b.membership_id)
  const planCode = str(b.plan_code)
  if (!membershipId || !planCode) return null
  return {
    ...shared,
    provider: 'glofox',
    priceCents,
    currency: str(b.currency)?.toUpperCase() || 'EUR',
    membershipId,
    planCode,
    un1tProductId: null,
  }
}

/** '€39' / '€39.50' for the panel and the checkout line. */
export function formatTrialPrice(cents, currency = 'EUR') {
  const n = (Number(cents) || 0) / 100
  const sym = currency === 'EUR' ? '€' : `${currency} `
  return Number.isInteger(n) ? `${sym}${n}` : `${sym}${n.toFixed(2)}`
}

/** The ticks list, position-preserving, blanks dropped. */
export function trialTicks(block) {
  const t = Array.isArray(block?.ticks) ? block.ticks : []
  return t.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 6)
}

/**
 * What the buyer's screen shows for one purchase row's public status.
 * 'granted' only when the Glofox plan is on the account; 'paid' is money in
 * and the grant in flight (the screen says so, never "it's on your account").
 * 'expired' is a checkout that lapsed; 'help' is a buyer the team has been
 * asked to look at (or already has). An un1t.online row awaiting payment is
 * simply 'pending': its payment_status is not the buyer's to read.
 */
export function trialPurchasePublicState(row) {
  if (!row) return 'notfound'
  if (row.status === 'granted') return 'granted'
  if (row.status === 'expired') return 'expired'
  if (row.status === 'help_requested' || row.status === 'handled') return 'help'
  if (row.payment_provider === 'un1t_online' && row.status === 'awaiting_payment') return 'pending'
  if (row.status === 'payment_failed' || row.payment_status === 'failed' || row.payment_status === 'expired') return 'failed'
  if (row.payment_status === 'paid') return 'paid'
  return 'pending'
}
