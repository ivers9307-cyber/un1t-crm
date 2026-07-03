// src/lib/ads/read.js
// Dashboard read layer: shape per-ad rows (pure) + load the full dashboard payload.
import { computeCostPerBooking, loadSpendByAd, loadBookingsByAd } from './attribution'

function dublinDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(d) // YYYY-MM-DD
}

/** Pure: join ad entities to spend/bookings/insight totals, compute cpa, sort
 *  by cost-per-booking ascending with null-cpa (no bookings) rows last. */
export function shapePerAdTable(entities, spendByAd, bookingsByAd, insightTotalsByAd) {
  const cb = computeCostPerBooking(spendByAd, bookingsByAd)
  const rows = entities.map((e) => {
    const id = e.external_id
    const totals = insightTotalsByAd[id] || {}
    const m = cb[id] || { spend: Number(spendByAd[id] || 0), bookings: Number(bookingsByAd[id] || 0), cpa: null }
    return {
      ad_id: id,
      name: e.name || id,
      status: e.status || null,
      spend: m.spend,
      impressions: Number(totals.impressions || 0),
      ctr: Number(totals.ctr || 0),
      link_clicks: Number(totals.link_clicks || 0),
      landing_page_views: Number(totals.landing_page_views || 0),
      bookings: m.bookings,
      cpa: m.cpa,
    }
  })
  rows.sort((a, b) => {
    if (a.cpa === null && b.cpa === null) return 0
    if (a.cpa === null) return 1
    if (b.cpa === null) return -1
    return a.cpa - b.cpa
  })
  return rows
}

/** Load the whole dashboard payload for a location over the last `sinceDays`.
 *  Returns { kpis, perAd, trend }. All reads scoped to location_id + level='ad'. */
export async function loadAdsDashboard(db, locationId, sinceDays = 30) {
  const since = dublinDateStr(-sinceDays)
  const until = dublinDateStr(0)

  const { data: entRows } = await db.from('ad_entities')
    .select('external_id, name, status').eq('location_id', locationId).eq('level', 'ad')
  const entities = entRows || []

  const spendByAd = await loadSpendByAd(db, locationId, since, until)
  const bookingsByAd = await loadBookingsByAd(db, locationId, since, until)

  // Per-ad insight totals + daily spend trend from ad_insights_daily (level='ad').
  const { data: insights } = await db.from('ad_insights_daily')
    .select('entity_external_id, date, spend, impressions, link_clicks, landing_page_views, clicks')
    .eq('location_id', locationId).eq('level', 'ad').gte('date', since).lte('date', until)
  const insightTotalsByAd = {}
  const trendByDate = {}
  for (const r of insights || []) {
    const id = r.entity_external_id
    const t = (insightTotalsByAd[id] ||= { impressions: 0, link_clicks: 0, landing_page_views: 0, clicks: 0 })
    t.impressions += Number(r.impressions || 0)
    t.link_clicks += Number(r.link_clicks || 0)
    t.landing_page_views += Number(r.landing_page_views || 0)
    t.clicks += Number(r.clicks || 0)
    ;(trendByDate[r.date] ||= { date: r.date, spend: 0, bookings: 0 }).spend += Number(r.spend || 0)
  }
  // Derive blended per-ad ctr = clicks / impressions * 100 (2dp).
  for (const id of Object.keys(insightTotalsByAd)) {
    const t = insightTotalsByAd[id]
    t.ctr = t.impressions > 0 ? Math.round((t.clicks / t.impressions) * 10000) / 100 : 0
  }

  // Attributed bookings per date for the trend (class + consult sources).
  const { data: cbrDates } = await db.from('class_booking_requests')
    .select('created_at, contacts!inner(ad_external_id)')
    .eq('location_id', locationId).eq('status', 'booked')
    .gte('created_at', since).lte('created_at', until + 'T23:59:59')
  for (const r of cbrDates || []) {
    if (!r.contacts?.ad_external_id) continue
    const d = String(r.created_at).slice(0, 10)
    ;(trendByDate[d] ||= { date: d, spend: 0, bookings: 0 }).bookings += 1
  }
  const { data: bkDates } = await db.from('bookings')
    .select('booking_date, contacts!inner(ad_external_id)')
    .eq('location_id', locationId).eq('source', 'meta_book')
    .gte('booking_date', since).lte('booking_date', until)
  for (const r of bkDates || []) {
    if (!r.contacts?.ad_external_id) continue
    const d = String(r.booking_date).slice(0, 10)
    ;(trendByDate[d] ||= { date: d, spend: 0, bookings: 0 }).bookings += 1
  }

  const perAd = shapePerAdTable(entities, spendByAd, bookingsByAd, insightTotalsByAd)
  const trend = Object.values(trendByDate).sort((a, b) => a.date.localeCompare(b.date))

  const totalSpend = perAd.reduce((s, r) => s + r.spend, 0)
  const totalBookings = perAd.reduce((s, r) => s + r.bookings, 0)
  const totalImpr = perAd.reduce((s, r) => s + r.impressions, 0)
  const totalClicks = Object.values(insightTotalsByAd).reduce((s, t) => s + (t.clicks || 0), 0)
  const kpis = {
    spend: Math.round(totalSpend * 100) / 100,
    bookings: totalBookings,
    cpa: totalBookings > 0 ? Math.round((totalSpend / totalBookings) * 100) / 100 : null,
    ctr: totalImpr > 0 ? Math.round((totalClicks / totalImpr) * 10000) / 100 : 0,
    active_ads: entities.filter((e) => e.status === 'ACTIVE').length,
  }
  return { kpis, perAd, trend }
}
