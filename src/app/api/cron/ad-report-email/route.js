// src/app/api/cron/ad-report-email/route.js
//
// TZ.6 — hourly; each location acts at its daily slot: 07:00 UTC for a
// Europe/Dublin studio (as before), 07:00 local for any other zone, once per
// local day (src/lib/cron-daily-slot.js). The date in the email is the
// studio's today. (Which day the KPIs cover is loadAdsDashboard's: TZ.11c.)
//
// defineCron owns the CRON_SECRET check, the error boundary and the heartbeat.
// A quiet tick (no studio at its slot) answers with `stamp: false`, so the row
// keeps its daily clock; a slot tick stamps unless the gate faulted (a claim
// write failed), which answers 500 unstamped. An unreadable locations list is
// a failed run (it used to loop over nothing and stamp). One studio failing is
// a result with a fixed line; the detail is logged.
import { defineCron } from '@/lib/define-cron'
import { loadAdsDashboard } from '@/lib/ads/read'
import { buildAdReportEmail } from '@/lib/ads/report'
import { sendEmail } from '@/lib/postmark'
import { gateDailySlot, slotFor } from '@/lib/cron-daily-slot'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'ad-report-email' }, async ({ db }) => {
  // TZ.6 — which locations are at their daily slot this tick (claimed, so
  // never twice in one local day). An unreadable zone acts for nobody.
  const gate = await gateDailySlot(db, 'ad-report-email', { module: 'ad-report-email' })
  if (!gate.ok) return { ok: false, body: { error: 'locations unreadable', slot: gate.summary } }
  if (gate.slots.size === 0) {
    // TZ.6: a quiet tick (no slot taken) never stamps, so the row keeps the legacy
    // clock; a faulted one (a claim write failed) answers 500 and the slot pages.
    return { ok: !gate.faulted, stamp: false, body: { results: [], slot: gate.summary } }
  }
  const { data: locations, error: locationsErr } = await db.from('locations').select('id, name, settings, timezone').eq('active', true)
  if (locationsErr) {
    logError('ad-report-email', 'locations read failed; no report sent', { err: locationsErr })
    return { ok: false, body: { error: 'Could not read the locations' } }
  }
  const results = []
  for (const loc of locations || []) {
    const slot = slotFor(gate.slots, loc.id)
    if (!slot) continue // TZ.6: not this location's slot
    const recipients = loc.settings?.ads?.report_recipients || []
    const { data: hasAccount } = await db.from('ad_accounts').select('id').eq('location_id', loc.id).eq('is_active', true).limit(1).maybeSingle()
    if (!recipients.length || !hasAccount) continue
    try {
      const dash = await loadAdsDashboard(db, loc.id, 1) // yesterday
      const date = slot.day // en-CA 'YYYY-MM-DD' in the studio's zone, as the Dublin one was
      const { subject, html } = buildAdReportEmail({ locationName: loc.name, date, kpis: dash.kpis, perAd: dash.perAd })
      for (const to of recipients) await sendEmail({ to, subject, htmlBody: html, stream: 'outbound', tag: 'ad-report' })
      results.push({ loc: loc.id, sent: recipients.length })
    } catch (e) {
      logWarn('ad-report-email', 'report failed for location', { locationId: loc.id, err: e?.message })
      results.push({ loc: loc.id, error: 'report failed' })
    }
  }
  // A slot tick stamps (slotTickStampable: the gate read and some slot was
  // taken); a faulted one answers 500 unstamped.
  return { ok: !gate.faulted, body: { results } }
})
