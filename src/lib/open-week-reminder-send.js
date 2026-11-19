// OPENWEEK.7 — the open week class reminder run (cron open-week-reminders,
// every 15 minutes). Richard, 19 Nov 2026: the only message an open week
// signup gets is a WhatsApp reminder of each class, the evening before a
// morning class or the morning of a lunch or afternoon class
// (src/lib/open-week-reminders.js holds the timing).
//
// Who: a person with a granted (or staff-handled) claim on a LIVE open week
// promo, for each of their BOOKED classes at that studio inside the week. The
// bookings are read from class_bookings, so a class they moved or booked by
// hand is reminded and a cancelled one is not.
//
// This is the one deliberate exception to the rule that the CRM never sends a
// class reminder for a un1t.online booking or at a un1t.online studio
// (docs/rules/integrations.md): Richard lifted it for open week classes only.
// tests/class-bookings-readers-guard.test.js pins this file as the only
// 'open-week-messaging' reader.
//
// Once only: customer_engagement_nudges (type open_week_reminder, dedup key
// cb:<class_bookings.id>) is claimed before the send. A send that failed for
// a reason that can clear (no approved template yet, Meta down, WhatsApp off)
// releases the claim so a later run inside the late window retries; a person
// with no WhatsApp number or who opted out keeps the claim (never retried).
// Consent is the ADMINISTRATIVE family (transactional-consent.js).
import { maybeSendBookingWhatsappConfirm } from '@/lib/automations/booking-whatsapp-confirm'
import { transactionalWhatsappSuppression } from '@/lib/transactional-consent'
import { CORP_PROMO_COLUMNS, promoView } from '@/lib/corp-promos-db'
import { isOpenWeek, openWeekState, openWeekStartMs } from '@/lib/open-week'
import { reminderPlan, isReminderDue, reminderParams } from '@/lib/open-week-reminders'
import { zoneOfLocation, zonedWallClockToInstant, addDaysISO } from '@/lib/location-time'
import { logError, logWarn } from '@/lib/log'

export const REMINDER_TYPE = 'open_week_reminder'
const LOG = 'open-week-reminders'
const PAGE = 1000
const CHUNK = 200
const UNIQUE_VIOLATION = '23505'
// A send that failed this way can succeed later: release the claim.
const PERMANENT_SKIPS = new Set(['no_phone', 'unnormalisable_phone'])

async function pagedClaimants(db, { locationId, promoKey }) {
  const ids = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('corp_promo_claims').select('id, contact_id')
      .eq('location_id', locationId).eq('promo_key', promoKey).in('status', ['granted', 'handled'])
      .order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) return { ok: false, error }
    for (const r of data || []) if (r.contact_id) ids.add(r.contact_id)
    if ((data || []).length < PAGE) return { ok: true, ids: [...ids] }
  }
}

async function bookingsFor(db, { locationId, contactIds, fromIso, toIso }) {
  const rows = []
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const chunk = contactIds.slice(i, i + CHUNK)
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db.from('class_bookings').select('id, contact_id, class_name, starts_at, status')
        .eq('location_id', locationId).eq('status', 'BOOKED').in('contact_id', chunk)
        .gte('starts_at', fromIso).lt('starts_at', toIso)
        .order('id', { ascending: true }).range(from, from + PAGE - 1)
      if (error) return { ok: false, error }
      rows.push(...(data || []))
      if ((data || []).length < PAGE) break
    }
  }
  return { ok: true, rows }
}

// The bookings already reminded (claimed). The unique index is the real
// guard against a race; this read keeps a normal run from re-claiming.
async function alreadyClaimed(db, bookingIds) {
  const taken = new Set()
  for (let i = 0; i < bookingIds.length; i += CHUNK) {
    const keys = bookingIds.slice(i, i + CHUNK).map((id) => `cb:${id}`)
    const { data, error } = await db.from('customer_engagement_nudges').select('dedup_key')
      .eq('type', REMINDER_TYPE).in('dedup_key', keys)
    if (error) return { ok: false, error }
    for (const r of data || []) taken.add(r.dedup_key)
  }
  return { ok: true, taken }
}

async function claim(db, contactId, bookingId) {
  try {
    const { data, error } = await db.from('customer_engagement_nudges')
      .insert({ contact_id: contactId, type: REMINDER_TYPE, dedup_key: `cb:${bookingId}` }).select('id')
    if (error) return error.code === UNIQUE_VIOLATION ? { taken: true } : { error }
    return { id: data?.[0]?.id ?? null }
  } catch (e) {
    return { error: { message: e?.message || String(e) } }
  }
}

async function release(db, claimId, ids) {
  if (!claimId) return
  try {
    const { error } = await db.from('customer_engagement_nudges').delete().eq('id', claimId)
    if (error) logError(LOG, 'claim not released; this reminder will not be retried', { ...ids, code: error.code ?? null })
  } catch (e) {
    logError(LOG, 'claim release threw; this reminder will not be retried', { ...ids, errClass: e?.name })
  }
}

/**
 * One run. `ok` is false only when a whole read failed (nothing for that
 * studio was sent); one message failing is counted, never a failed run.
 * @param {object} db service-role client
 * @param {{ now?: Date }} [opts]
 */
export async function runOpenWeekReminders(db, { now = new Date() } = {}) {
  const stats = { ok: true, studios: 0, due: 0, sent: 0, already: 0, suppressed: 0, skipped: 0, retry: 0, failed_reads: 0 }
  const nowMs = now.getTime()

  const { data: promoRows, error: promoErr } = await db.from('corp_promos').select(CORP_PROMO_COLUMNS)
    .eq('kind', 'open_week').eq('live', true).order('key', { ascending: true })
  if (promoErr) {
    logError(LOG, 'open week promos unreadable; nothing sent', { code: promoErr.code ?? null })
    return { ...stats, ok: false }
  }
  for (const promo of (promoRows || []).map(promoView).filter(isOpenWeek)) {
    const locationId = promo.locationId
    const { data: location, error: locErr } = await db.from('locations').select('id, name, timezone').eq('id', locationId).maybeSingle()
    if (locErr || !location) {
      logError(LOG, 'studio unreadable; its reminders wait for the next run', { locationId, code: locErr?.code ?? null })
      stats.ok = false; stats.failed_reads++
      continue
    }
    const zone = zoneOfLocation(location)
    if (openWeekState(promo, zone, now) === 'over') continue
    stats.studios++

    const claimants = await pagedClaimants(db, { locationId, promoKey: promo.key })
    if (!claimants.ok) {
      logError(LOG, 'open week claims unreadable; nothing sent at this studio', { locationId, code: claimants.error?.code ?? null })
      stats.ok = false; stats.failed_reads++
      continue
    }
    if (claimants.ids.length === 0) continue
    const fromIso = new Date(openWeekStartMs(promo, zone)).toISOString()
    const toIso = new Date(zonedWallClockToInstant(addDaysISO(promo.windowEndsOn, 1), '00:00', zone)).toISOString()
    const booked = await bookingsFor(db, { locationId, contactIds: claimants.ids, fromIso, toIso })
    if (!booked.ok) {
      logError(LOG, 'bookings unreadable; nothing sent at this studio', { locationId, code: booked.error?.code ?? null })
      stats.ok = false; stats.failed_reads++
      continue
    }

    const due = booked.rows
      .map((b) => ({ b, startMs: Date.parse(b.starts_at) }))
      .filter(({ startMs }) => Number.isFinite(startMs))
      .map((x) => ({ ...x, plan: reminderPlan(x.b.starts_at, zone) }))
      .filter(({ plan, startMs }) => isReminderDue(plan, startMs, nowMs))
    if (due.length === 0) continue
    const claimed = await alreadyClaimed(db, due.map(({ b }) => b.id))
    if (!claimed.ok) {
      logError(LOG, 'sent reminders unreadable; nothing sent at this studio', { locationId, code: claimed.error?.code ?? null })
      stats.ok = false; stats.failed_reads++
      continue
    }

    for (const { b, plan } of due) {
      stats.due++
      if (claimed.taken.has(`cb:${b.id}`)) { stats.already++; continue }
      const ids = { locationId, contactId: b.contact_id, bookingId: b.id }

      const c = await claim(db, b.contact_id, b.id)
      if (c.taken) { stats.already++; continue }
      if (c.error) { logWarn(LOG, 'claim failed; retried next run', { ...ids, code: c.error.code ?? null }); stats.retry++; continue }

      const { data: contact, error: cErr } = await db.from('contacts')
        .select('id, first_name, name, phone, wa_phone, wa_status, contact_preferences ( whatsapp_administrative )')
        .eq('id', b.contact_id).maybeSingle()
      if (cErr || !contact) {
        logWarn(LOG, 'contact unreadable; retried next run', { ...ids, code: cErr?.code ?? null })
        await release(db, c.id, ids); stats.retry++
        continue
      }
      // A STOP or block, a number not on WhatsApp, or an admin WhatsApp opt-out.
      if (transactionalWhatsappSuppression(contact)) { stats.suppressed++; continue }
      const out = await maybeSendBookingWhatsappConfirm({
        db, locationId, contact, purpose: 'class_reminder',
        bodyParams: reminderParams({ contact, startsAt: b.starts_at, className: b.class_name, studioName: location.name, zone, dayWord: plan.dayWord }),
      })
      if (out?.sent) { stats.sent++; continue }
      if (PERMANENT_SKIPS.has(out?.reason)) { stats.skipped++; continue }
      logWarn(LOG, 'reminder not sent; retried next run while it is still due', { ...ids, reason: out?.reason ?? 'unknown' })
      await release(db, c.id, ids); stats.retry++
    }
  }
  return stats
}
