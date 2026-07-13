// CC.1 — presentation-format helpers extracted from
// /contacts/[id]/page.js so the contact section components
// (GlofoxProfileCard, the rails, the page itself) share one copy.
// Pure formatting only — no data access.

export function relativeTime(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  const abs = Math.abs(ms)
  const future = ms < 0
  const days = Math.floor(abs / 86_400_000)
  if (days < 1) {
    const hours = Math.floor(abs / 3_600_000)
    if (hours < 1) return future ? 'in a moment' : 'just now'
    return future ? `in ${hours}h` : `${hours}h ago`
  }
  if (days < 30) return future ? `in ${days}d` : `${days}d ago`
  const months = Math.floor(days / 30.44)
  return future ? `in ${months}mo` : `${months}mo ago`
}

export function formatMoney(cents, currency) {
  if (!Number.isFinite(cents)) return null
  const amount = cents / 100
  // Currency code → symbol map covers the common ones; falls back
  // to the code itself prefixed if unknown.
  const SYM = { EUR: '€', GBP: '£', USD: '$' }
  const sym = SYM[currency] || (currency ? `${currency} ` : '€')
  return sym + amount.toLocaleString('en-IE', { maximumFractionDigits: 0 })
}

export function formatDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

// "HH:MM(:SS)" wall-clock → "H:MM AM/PM".
export function formatTime(time) {
  if (!time) return ''
  const [h, m] = time.split(':')
  const hour = parseInt(h)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 || 12
  return `${h12}:${m} ${ampm}`
}
