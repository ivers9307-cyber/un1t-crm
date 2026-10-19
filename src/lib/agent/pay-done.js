// MIAHATCH.6 (Task 22) — what the public /pay-done/<token> return page does.
//
// un1t.online's hosted checkout sends a member back to
// <customer base>/pay-done/<token> (success) or ...?c=1 (cancel). The page is
// a CHECK TRIGGER, never proof of payment: it may ask settlePurchaseIntent to
// look (the mirror and the live entitlement are the proof), and it renders the
// same text whatever that finds. It reveals nothing a stranger holding a
// guessed token could use: an unknown or malformed token gets the generic
// default copy with no studio branding, the same status as a known one, and no
// read at all when the token cannot be one of ours.
//
// The token (Task 19) is 32 random bytes in base64url (43 chars of
// [A-Za-z0-9_-]); only its sha256 hex is stored on mia_purchase_intents. The
// hash is the scope of the one lookup (selecting id, location_id and status
// only), so everything after it keys off that row's own location.
//
// Settle runs only for a link_sent intent on the success variant, and only
// when the per-intent 30 s rate slot is free, so a refresh storm costs one
// settle. A settle that throws never breaks the page. Logs carry ids and
// codes only (module 'mia-un1t'), never the token or a URL.
import { hashPayDoneToken } from './purchase-intents'
import { settlePurchaseIntent } from './purchase-settle'
import { resolveAgentSettings } from './settings-resolve'
import { renderMiaCopy } from './mia-copy'
import { checkRateLimit } from '@/lib/rate-limit'
import { getLocationBranding } from '@/lib/location-branding'
import { logWarn } from '@/lib/log'

const LOG_MODULE = 'mia-un1t'
const TABLE = 'mia_purchase_intents'
const LIVE = 'link_sent'
const SETTLE_SLOT = Object.freeze({ max: 1, windowMs: 30_000 })

// mintPayDoneToken: randomBytes(32).toString('base64url') is always 43 chars.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/**
 * The intent whose success token hashes to `hash`, as { id, location_id, status },
 * or null for none (and for an unreadable row: logged, never thrown). Selects
 * only the three columns the page needs. The token hash is the scope: it is
 * 32 random bytes' sha256, so holding it is holding the capability.
 */
export async function findIntentByTokenHash(db, hash) {
  try {
    const { data, error } = await db.from(TABLE)
      .select('id, location_id, status')
      .eq('success_token_hash', hash)
      .maybeSingle()
    if (error) {
      logWarn(LOG_MODULE, 'pay-done intent unreadable', { op: 'pay_done_read', status: null, code: error.code ?? null })
      return null
    }
    return data ?? null
  } catch (err) {
    logWarn(LOG_MODULE, 'pay-done intent read threw', { op: 'pay_done_read', status: null, errClass: err?.name })
    return null
  }
}

/** The default copy for the variant, with no operator settings and no branding. Pure. */
export function genericPayDonePage(cancelled) {
  return { text: renderMiaCopy(cancelled ? 'pay_cancel_page_text' : 'pay_done_page_text', null), branding: null }
}

/** One settle attempt, behind the rate slot; nothing it says reaches the page. */
async function checkPayment(db, intent) {
  try {
    const slot = await checkRateLimit(db, `mia-pay-done:${intent.id}`, SETTLE_SLOT)
    if (!slot?.allowed) return
    await settlePurchaseIntent(db, intent.id, { detectedBy: 'pay_done', source: 'live' })
  } catch (err) {
    logWarn(LOG_MODULE, 'pay-done settle threw', { op: 'pay_done_settle', locationId: intent.location_id, intentId: intent.id, status: null, errClass: err?.name })
  }
}

/**
 * What /pay-done/<token> shows, after triggering a payment check when due.
 *
 * @param {object} db service-role client
 * @param {string} token the path segment, untrusted
 * @param {{ cancelled?: boolean }} [opts] cancelled: the ?c=1 variant (never settles)
 * @returns {Promise<{ text: string, branding: { companyName: string, logoUrl: string|null }|null }>}
 *   branding is null for an unknown, malformed or unreadable token.
 */
export async function payDonePage(db, token, { cancelled = false } = {}) {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return genericPayDonePage(cancelled)
  const intent = await findIntentByTokenHash(db, hashPayDoneToken(token))
  if (!intent) return genericPayDonePage(cancelled)

  if (!cancelled && intent.status === LIVE) await checkPayment(db, intent)

  const resolved = await resolveAgentSettings(db, intent.location_id)
  const text = renderMiaCopy(cancelled ? 'pay_cancel_page_text' : 'pay_done_page_text', resolved?.ok ? resolved.settings : null)
  const brand = await getLocationBranding(db, intent.location_id)
  return {
    text,
    branding: { companyName: brand?.companyName || '', logoUrl: brand?.logoUrl || null },
  }
}
