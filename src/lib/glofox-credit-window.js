// CREDITWINDOW.1 — the last day a Glofox promo plan's credits can book.
//
// A Glofox plan's credits carry an expiry ({ interval, interval_count }) and a
// start rule. With starts_on PURCHASE_DATE the credits run from the day of the
// claim: a 1-week plan claimed on 21 Nov is "active from 21/11, expires 27/11"
// in Glofox. Glofox judges a booking against the CLASS date, and answers
// YOU_HAVE_NO_CREDITS_LEFT for a class after the expiry while the account still
// shows every credit (22 Nov 2026: nine Open Week bookings refused this way,
// each for a class seven or more days after the claim).
//
// So a promo page must not offer a class its plan cannot book. The plan is read
// from the studio's synced catalogue (glofox_memberships.plans), never from
// Glofox at request time. Anything unreadable or unrecognised is "unknown"
// (null) and caps nothing: the page lists as before and Glofox still arbitrates.
import { dayStrIn, addDaysISO } from '@/lib/location-time'
import { glofoxPlanForPromo } from '@/lib/corp-promo-glofox-plans'
import { logWarn } from '@/lib/log'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// 'YYYY-MM-DD' + n calendar months, clamped to the month's last day.
function addMonthsISO(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastOfMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  first.setUTCDate(Math.min(d, lastOfMonth))
  return first.toISOString().slice(0, 10)
}

// The last valid day of one credit line bought on `purchaseDay`, or null.
function lineLastDay(expiry, purchaseDay) {
  if (!expiry || typeof expiry !== 'object') return null
  const n = Number(expiry.interval_count)
  if (!Number.isInteger(n) || n < 1) return null
  if (expiry.interval === 'day') return addDaysISO(purchaseDay, n - 1)
  if (expiry.interval === 'week') return addDaysISO(purchaseDay, 7 * n - 1)
  if (expiry.interval === 'month') return addDaysISO(addMonthsISO(purchaseDay, n), -1)
  return null
}

/**
 * The last studio-local day a plan bought on `purchaseDay` can book, or null
 * when it cannot be judged (not PURCHASE_DATE, no active credit line, or a
 * line whose expiry is unreadable). Several lines: the shortest. Pure.
 * @param {object|null} plan  one entry of glofox_memberships.plans
 * @param {string} purchaseDay  'YYYY-MM-DD' on the studio's clock
 * @returns {string|null}
 */
export function creditLastDay(plan, purchaseDay) {
  if (!plan || typeof plan !== 'object' || plan.starts_on !== 'PURCHASE_DATE') return null
  if (typeof purchaseDay !== 'string' || !DATE_RE.test(purchaseDay)) return null
  const lines = (Array.isArray(plan.credits) ? plan.credits : []).filter((c) => c && c.active === true)
  if (lines.length === 0) return null
  let last = null
  for (const line of lines) {
    const day = lineLastDay(line.expiry, purchaseDay)
    if (!day) return null
    if (!last || day < last) last = day
  }
  return last
}

/** Is this public class (its studio-local `day`) bookable by `lastDay`? Unknown keeps it. */
export function withinCreditWindow(cls, lastDay) {
  if (!lastDay) return true
  return !!cls && typeof cls.day === 'string' && cls.day <= lastDay
}

/**
 * The last day a claim made now could book on this promo's Glofox plan, or
 * null (no cap): not a Glofox promo, no plan binding, the catalogue row or
 * plan missing or unreadable, or a plan creditLastDay cannot judge.
 * @returns {Promise<string|null>}
 */
export async function readPromoCreditLastDay(db, { locationId, promo, zone, now = new Date() }) {
  if (!promo || promo.platform !== 'glofox') return null
  const bound = glofoxPlanForPromo(promo)
  if (!bound) return null
  try {
    const { data, error } = await db.from('glofox_memberships')
      .select('plans')
      .eq('glofox_membership_id', bound.membershipId)
      .eq('location_id', locationId)
      .maybeSingle()
    if (error) {
      logWarn('credit-window', 'plan catalogue unreadable; classes not capped', { locationId, promo: promo.key, code: error.code ?? null })
      return null
    }
    const plans = Array.isArray(data?.plans) ? data.plans : []
    const plan = plans.find((p) => p && String(p.code) === bound.planCode) || null
    return creditLastDay(plan, dayStrIn(now, zone))
  } catch (e) {
    logWarn('credit-window', 'plan catalogue read threw; classes not capped', { locationId, promo: promo?.key ?? null, errClass: e?.name })
    return null
  }
}
