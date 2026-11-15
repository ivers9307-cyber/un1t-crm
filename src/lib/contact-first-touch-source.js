// UTMSOURCE.1 (mig 837) — contacts.utm_source / contacts.utm_medium, the
// first-touch source and medium of the landing URL a person first came
// through, so a lead or a paid trial can be read as ads / organic / email off
// the contact. The public funnel routes (trial purchase, class booking,
// consult booking, corp claim) all stamp through here, so the rule lives once.
//
// The rule, and why it is not folded into the routes' ad stamp:
//   * Measurement only. utm_source / utm_medium are NOT an ad signal
//     (TRIALLEAK.1): an Instagram bio link or an email link carries them with
//     no ad id. So this stamp never sets ad_provider or attributed_at, which
//     the Ads dashboard counts as ad leads, and it runs for visitors the ad
//     stamp skips.
//   * First touch. Written once, and only while the contact has no
//     attribution at all: utm_source, utm_medium AND attributed_at all NULL.
//     attributed_at is in the guard so a person first attributed to an ad
//     (before these columns existed) is not later labelled with the source of
//     a return visit (an email link, say) beside their original campaign. A
//     route must therefore call this BEFORE its ad stamp, which sets
//     attributed_at for the same visit.
//   * Low trust. Values go through cleanAdValue: cut to 200 characters, and an
//     unfilled Meta macro ({{site_source_name}}) is no value.
//   * Best effort. Losing the tag must never cost the booking or the payment:
//     this never throws. A supabase builder resolves with { error } rather
//     than throwing, so the error is read here and logged.

import { cleanAdValue } from './campaign-funnel-attribution'
import { logWarn } from './log'

export const FIRST_TOUCH_SOURCE_KEYS = Object.freeze(['utm_source', 'utm_medium'])

/** The cleaned { utm_source?, utm_medium? } of an attribution object, or null when it carries neither. */
export function firstTouchSourcePatch(attribution) {
  if (!attribution || typeof attribution !== 'object') return null
  const patch = {}
  for (const k of FIRST_TOUCH_SOURCE_KEYS) {
    const raw = attribution[k]
    if (typeof raw !== 'string') continue
    const v = cleanAdValue(raw.trim())
    if (v) patch[k] = v
  }
  return Object.keys(patch).length ? patch : null
}

/**
 * Stamp-if-null. Resolves { stamped: boolean, error?: true }; never throws.
 * `stamped: true` means the write was sent without an error, not that a row
 * changed (the first-touch guard may match nothing, which is the point).
 */
export async function stampFirstTouchSource(db, contactId, attribution, { module = 'attribution' } = {}) {
  const patch = firstTouchSourcePatch(attribution)
  if (!patch || !contactId) return { stamped: false }
  try {
    const { error } = await db.from('contacts')
      .update(patch)
      .eq('id', contactId)
      .is('utm_source', null)
      .is('utm_medium', null)
      .is('attributed_at', null)
    if (error) {
      logWarn(module, 'utm source/medium persist failed', { code: error.code ?? null })
      return { stamped: false, error: true }
    }
    return { stamped: true }
  } catch (e) {
    logWarn(module, 'utm source/medium persist threw', { errClass: e?.name })
    return { stamped: false, error: true }
  }
}
