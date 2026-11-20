// BRIEFING.1 — /api/cron/morning-briefing
//
// OWNERDAILY.1 (19 Nov 2026): the owner's DAILY briefing (it was Mondays). It
// carries revenue month to date, yesterday's new leads and trials
// (owner-daily-headline.js), the members and churn/arrears pulse strip, and
// the triage list, and it replaces the Monday radar digest, which no longer
// sends. TZ.6: the schedule is hourly and each location acts at its daily
// slot: 06:00 UTC for a Europe/Dublin studio, 06:00 local for any other zone,
// once per local day (src/lib/cron-daily-slot.js); the date line is in the
// studio's zone. Per active location: builds the
// same "Needs attention" feed the Today dashboard shows (location
// level — approvals row omitted, see fetchLocationTodayFeed), renders
// it with buildMorningBriefingEmail, and emails the location's
// configured recipients.
//
// Recipients: reuses `locations.churn_digest_recipients` (the Monday
// radar digest list) — deliberately, so the briefing needs zero new
// config to start flowing and "who gets operational email" stays one
// list. Split into its own column + settings field later if the two
// audiences ever need to diverge. Empty list = briefing off for that
// location.
//
// Always sends when recipients are configured — an explicit "all
// clear" beats a silent gap (a missing email is indistinguishable
// from a broken cron). One bad location can't stall the sweep.
//
// defineCron owns the CRON_SECRET check, the error boundary and the stamp. A
// quiet tick (no studio at its slot) answers success with `stamp: false`, so
// the row keeps its daily clock; a faulted gate (a claim write failed) or an
// unreadable locations list answers 500 unstamped. One location failing is
// reported in perLocation (fixed text; the detail is logged); a slot tick
// where every location that had a briefing to send failed answers 500 and
// does not stamp.

import { defineCron } from '@/lib/define-cron'
import { sendEmail } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import { fetchLocationTodayFeed } from '@/lib/today-feed-data'
import { fetchStudioPulse } from '@/lib/studio-pulse-data'
import { fetchDailyHeadline } from '@/lib/owner-daily-headline'
import { buildMorningBriefingEmail, shapePulseMetrics } from '@/lib/morning-briefing'
import { gateDailySlot, slotFor } from '@/lib/cron-daily-slot'
import { formatInZone } from '@/lib/location-time'
import { locationIdsWithoutCapability } from '@/lib/membership/locations-for-source'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// loadRadar pages a few thousand rows per location and the low-fill
// row makes a live Glofox call — same ceiling as the radar digest.
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'morning-briefing' }, async ({ db }) => {
  const appUrl = getAppUrl()
  const nowMs = Date.now()

  // TZ.6 — which locations are at their Monday slot this tick (claimed, so
  // never twice in one local day). An unreadable zone acts for nobody.
  const gate = await gateDailySlot(db, 'morning-briefing', { nowMs, module: 'morning-briefing' })
  if (!gate.ok) return { ok: false, body: { error: 'locations unreadable', slot: gate.summary } }
  if (gate.slots.size === 0) {
    // TZ.6: a quiet tick (no slot taken) never stamps, so the row keeps the legacy
    // clock; a faulted one (a claim write failed) answers 500 and the slot pages.
    return { ok: !gate.faulted, stamp: false, body: { emails_sent: 0, perLocation: [], slot: gate.summary } }
  }

  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name, churn_digest_recipients')
    .eq('active', true)
  if (locErr) {
    logError('morning-briefing', 'failed to list locations', { err: locErr })
    return { ok: false, body: { error: 'Could not list locations' } }
  }

  // UN1TCAP.1 — the pulse strip is membership numbers (members, at-risk,
  // trend): a studio whose source provides no membership data (none, or
  // un1t.online today) gets the briefing WITHOUT the strip, not a row of
  // Glofox-shaped zeros. Best-effort like the strip itself: an unreadable
  // capability list drops every strip this tick and still sends the briefing.
  const { ids: noMembershipData, error: capErr } = await locationIdsWithoutCapability(db, 'memberships')
  if (capErr) console.warn(`[cron][morning-briefing] membership capability unreadable; sending without the pulse strip: ${capErr.message || capErr}`)
  const pulseAllowed = (locationId) => !capErr && !noMembershipData.has(locationId)

  let emailsSent = 0
  const perLocation = []

  for (const loc of locations || []) {
    const slot = slotFor(gate.slots, loc.id)
    if (!slot) continue // TZ.6: not this location's slot
    const recipients = Array.isArray(loc.churn_digest_recipients)
      ? loc.churn_digest_recipients
      : []
    if (recipients.length === 0) continue // briefing off for this location

    try {
      // BRIEFING.2 — the pulse strip is best-effort (fetchStudioPulse
      // returns null on failure); the triage list is the core payload.
      const [rows, pulseBundle, headline] = await Promise.all([
        // TZ.17 — the feed's "today" is this studio's day (the slot's zone).
        fetchLocationTodayFeed(db, loc.id, nowMs, { zone: slot.zone }),
        pulseAllowed(loc.id) ? fetchStudioPulse(db, loc.id) : null,
        // OWNERDAILY.1 — best-effort: a figure that cannot be read is left out.
        fetchDailyHeadline(db, loc.id, { nowMs, zone: slot.zone }).catch(() => null),
      ])
      const { subject, html } = buildMorningBriefingEmail(rows, {
        locationName: loc.name,
        dateLabel: formatInZone(nowMs, slot.zone, { weekday: 'long', day: 'numeric', month: 'long' }),
        appUrl,
        pulse: pulseBundle ? shapePulseMetrics(pulseBundle) : [],
        headline,
      })
      for (const to of recipients) {
        await sendEmail({ to, subject, htmlBody: html, stream: 'outbound', tag: 'morning-briefing' })
        emailsSent++
      }
      perLocation.push({ location_id: loc.id, location_name: loc.name, rows: rows.length, recipients: recipients.length, ok: true })
    } catch (err) {
      // One bad location can't stall the rest of the sweep.
      logWarn('morning-briefing', 'briefing failed for location', { locationId: loc.id, err })
      perLocation.push({ location_id: loc.id, location_name: loc.name, ok: false, error: 'briefing failed' })
    }
  }

  // A slot tick stamps unless the gate faulted (a claim write failed), or
  // every location that had a briefing to send failed: then nothing was sent.
  const allFailed = perLocation.length > 0 && perLocation.every((p) => !p.ok)
  if (allFailed) {
    return { ok: false, body: { error: 'Every location failed', emails_sent: emailsSent, perLocation } }
  }
  return { ok: !gate.faulted, body: { emails_sent: emailsSent, perLocation } }
})
