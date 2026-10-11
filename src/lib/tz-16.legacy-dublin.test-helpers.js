// tz-16.legacy-dublin.test-helpers.js — TZ.16. The FROZEN pre-change bodies of
// every display formatter the web display sweep touched, copied unchanged from
// origin/main (ed5792e5) so tz-16.tz.test.js can prove Europe/Dublin output is
// byte-identical. Test-only; TZ.18b deletes this file with the other legacy
// copies.

// src/app/(team)/contracts/[id]/page.js:32, (team)/contracts/page.js:38,
// (team)/contracts/templates/[id]/page.js:20, account/contracts/[id]/page.js:23
// (four identical copies).
export function contractFmtDateLegacyDublin(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// account/contracts/page.js:30 (the member's own list: date only).
export function accountContractListFmtLegacyDublin(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// (team)/contracts/[id]/page.js:212 and account/contracts/[id]/page.js:178.
export function contractSignedLegacyDublin(timestamp) {
  return new Date(timestamp).toLocaleString('en-IE', { timeZone: 'Europe/Dublin' })
}

// communications/(marketing-era)/list-health/page.js:65
export function listHealthDateLabelLegacyDublin(iso) {
  if (!iso) return 'Not recorded'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Not recorded'
  return d.toLocaleDateString('en-IE', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/Dublin' })
}

// welcome/[location]/status/page.js:88 (`new Date()` made a parameter).
export function statusUpdatedLegacyDublin(now) {
  return now.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin' })
}

// components/AcControlPanel.jsx:69
export function acAsOfLabelLegacyDublin(iso) {
  if (!iso) return null
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return null
  return t.toLocaleTimeString('en-IE', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin',
  })
}

// components/CalendarFeedCard.jsx:16
export function calendarFeedStampLegacyDublin(iso) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return null
  return new Date(t).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

// components/DealCard.jsx:134, contact/ContactDrawer.jsx:212,
// contact/ContactHeaderBand.jsx:187 (three identical inline copies).
export function nextClassLabelLegacyDublin(iso) {
  return new Date(iso).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Dublin' })
}

// components/InvoicesManager.jsx:878
export function invoiceFormatDayLegacyDublin(iso) {
  if (!iso) return 'an unknown date'
  return new Date(iso).toLocaleDateString('en-IE', { dateStyle: 'medium', timeZone: 'Europe/Dublin' })
}

// components/OfferSalesList.jsx:13
export function offerSalesTimeLegacyDublin(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin', weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short',
  })
}

// components/OrderDetail.jsx:408
export function orderDetailDateTimeLegacyDublin(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin',
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return String(iso) }
}

// components/OrdersTable.jsx:237 (OrderRow)
export function orderRowDateLegacyDublin(createdAt) {
  const dt = createdAt ? new Date(createdAt) : null
  return dt ? dt.toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) : ''
}

// components/OrdersTable.jsx:462 (OrderCard)
export function orderCardDateLegacyDublin(createdAt) {
  const dt = createdAt ? new Date(createdAt) : null
  return dt ? dt.toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  }) : ''
}

// components/automations/ClassClimateCard.jsx:19 and BathroomClimateCard.jsx:19
// (identical `fmtDublin`).
export function climateFmtLegacyDublin(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin', weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { return iso }
}

// components/dashboard/AdsRefreshButton.jsx:9
export function adsFmtSyncedLegacyDublin(ts) {
  if (!ts) return 'never'
  try {
    return new Intl.DateTimeFormat('en-IE', {
      timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(ts))
  } catch { return 'unknown' }
}

// components/host/HostEmailReport.jsx:43 (WHEN_FORMATTER + formatWhen)
const WHEN_FORMATTER = new Intl.DateTimeFormat('en-IE', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Dublin',
})
export function hostFormatWhenLegacyDublin(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return WHEN_FORMATTER.format(d)
}

// components/AuditLogTable.jsx:69
export function auditFmtDtLegacyDublin(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin',
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch {
    return iso
  }
}

// lib/email-forward.js:134
export function forwardTimestampLegacyDublin(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Intl.DateTimeFormat('en-IE', {
    timeZone: 'Europe/Dublin',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(t))
}

// lib/mail/reply-quote.js:90
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function attributionStampLegacyDublin(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(t))
  const get = (type) => parts.find(p => p.type === type)?.value || ''
  const weekday = get('weekday')
  const day = String(Number(get('day')) || get('day'))
  const month = MONTHS[Number(get('month')) - 1] || get('month')
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${weekday} ${day} ${month} ${get('year')} at ${hour}:${get('minute')}`
}

// lib/sale-offers.js:42
export function formatSaleDeadlineLegacyDublin(endsAt, { uppercase = true } = {}) {
  if (!endsAt) return ''
  const d = new Date(endsAt)
  if (Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-IE', {
    timeZone: 'Europe/Dublin',
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc }, {})
  const text = `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`
  return uppercase ? text.toUpperCase() : text
}
