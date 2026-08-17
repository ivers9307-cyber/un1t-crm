// SESSION-REPORT.4 — pure helpers for the shareable post-class card. No IO.
// The card image (ImageResponse) + the share page render from cardModel().

const BRAND_ACCENT = '#0B0B0C' // near-black: the "no vivid zone" fallback band

/**
 * The session's hardest zone with a real share of time → drives the card colour.
 * Highest-id zone with seconds >= max(30, 10% of total); else the max-seconds
 * zone; Z1/warm-up or no data → brand accent (never a flat grey card).
 * @param {Array<{id,name,color,seconds}>} zones (from zoneBreakdown)
 */
export function dominantZone(zones) {
  const list = zones || []
  const total = list.reduce((a, z) => a + (Number(z.seconds) || 0), 0)
  let pick = null
  if (total > 0) {
    const threshold = Math.max(30, total * 0.1)
    const real = list.filter((z) => (Number(z.seconds) || 0) >= threshold)
    pick = real.length ? real[real.length - 1] : list.reduce((m, z) => ((Number(z.seconds) || 0) > (Number(m?.seconds) || 0) ? z : m), null)
  }
  if (!pick || pick.id === 1) {
    return { id: pick?.id ?? 0, name: pick?.name ?? 'Session', color: BRAND_ACCENT }
  }
  return { id: pick.id, name: pick.name, color: pick.color }
}

/**
 * Downsample HR samples (~80 pts) → SVG polyline points, normalised to their
 * own min/max so the line fills the box. Returns null for <2 valid samples.
 */
export function tracePolyline(samples, { width = 600, height = 140, points = 80 } = {}) {
  const arr = (samples || []).filter((s) => Number.isFinite(s?.bpm))
  if (arr.length < 2) return null
  const stride = Math.max(1, Math.ceil(arr.length / points))
  const ds = arr.filter((_, i) => i % stride === 0)
  if (ds[ds.length - 1] !== arr[arr.length - 1]) ds.push(arr[arr.length - 1])
  const bpms = ds.map((s) => s.bpm)
  const lo = Math.min(...bpms)
  const span = Math.max(1, Math.max(...bpms) - lo)
  const n = ds.length
  return ds
    .map((s, i) => {
      const x = (n === 1 ? 0 : (i / (n - 1)) * width)
      const y = height - ((s.bpm - lo) / span) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/** A full SVG markup string for the trace (for an ImageResponse data-URI <img>). */
export function traceSvg(points, { width = 600, height = 140, stroke = '#FFFFFF', strokeWidth = 4 } = {}) {
  if (!points) return null
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/></svg>`
}

/** First name + last initial (privacy on a public URL). Blank → "Member". */
export function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'Member'
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
}

function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat('en-IE', { day: 'numeric', month: 'short', timeZone: 'Europe/Dublin' }).format(new Date(iso))
  } catch { return '' }
}

/**
 * Report payload + extras → the flat field set the card JSX + page render. Pure.
 */
export function cardModel(report, { name, tracePoints = null } = {}) {
  const s = report.summary || {}
  const vc = report.comparisons?.vs_category
  const categoryLine = (vc && vc.percentile != null && vc.sample_size >= 2)
    ? (Math.round(vc.percentile * 100) >= 50
        // Clamp to 1: a best-ever session (percentile 1) would render
        // "Top 0%" — nonsense. Floor the brag line at "Top 1%".
        ? `Top ${Math.max(1, 100 - Math.round(vc.percentile * 100))}% of your ${vc.category} classes`
        : `Building your ${vc.category} base`)
    : null
  return {
    name: shortName(name),
    className: report.session?.class?.name || null,
    dateLabel: report.session?.started_at ? formatDate(report.session.started_at) : '',
    points: Number.isFinite(s.effort_points) ? s.effort_points : 0,
    avgHr: Number.isFinite(s.avg_hr_bpm) ? s.avg_hr_bpm : null,
    peakHr: Number.isFinite(s.peak_hr_bpm) ? s.peak_hr_bpm : null,
    minutes: report.session?.duration_seconds ? Math.round(report.session.duration_seconds / 60) : null,
    zones: s.zones || [],
    dominant: dominantZone(s.zones || []),
    tracePoints,
    highlight: report.highlight?.message || null,
    categoryLine,
    nextAction: report.next_action || null,
  }
}
