// Pure view-model helpers for the public events listing (/[location]/events).
// No IO — the page does the Supabase read and hands rows in. Sold-out logic
// mirrors src/app/api/public/events/[slug]/route.js (capacity stays server-side;
// only a boolean leaves).
import { eventKindLabel } from '@shared/events'

const EUR = (cents) => {
  const n = (Number(cents) || 0) / 100
  return Number.isInteger(n) ? `€${n}` : `€${n.toFixed(2)}`
}

/** ISO YYYY-MM-DD → "Sun 12 Jul". Anchored at noon UTC so the weekday/day are
 *  stable in any timezone (the Dublin-wall-clock caveat is about times, not dates).
 *  Uses en-GB locale to produce the comma-free "Sun 12 Jul" format. */
export function formatEventDate(iso) {
  if (!iso) return ''
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d)
}

function formatOpensDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Dublin' }).format(d)
}

/** "Free" | "€25" | "From €15" (cheaper of member/non-member when member pricing on). */
export function eventPriceLabel(e) {
  if (e?.non_member_fee_cents == null) return 'Free'
  if (e?.member_pricing_enabled && e?.member_fee_cents != null) {
    return `From ${EUR(Math.min(e.member_fee_cents, e.non_member_fee_cents))}`
  }
  return EUR(e.non_member_fee_cents)
}

/** Mirrors the public route: full = ≥1 capped wave, no uncapped wave, every
 *  capped wave full. people mode counts team sizes; teams mode counts regs.
 *  Only CONFIRMED registrations consume capacity. */
export function isEventSoldOut(waves, registrations, capacityMode) {
  const capped = (waves || []).filter((w) => w.capacity != null)
  if (capped.length === 0) return false
  if ((waves || []).some((w) => w.capacity == null)) return false // an uncapped wave absorbs
  const mode = capacityMode === 'people' ? 'people' : 'teams'
  const confirmed = (registrations || []).filter((r) => r.status === 'confirmed')
  return capped.every((w) => {
    const inWave = confirmed.filter((r) => r.wave_id === w.id)
    const used = mode === 'people'
      ? inWave.reduce((sum, r) => sum + (Number(r.team?.size) || 1), 0)
      : inWave.length
    return used >= w.capacity
  })
}

/** Row → card view-model. `now` injectable for tests. */
export function toBrowseCard(e, { soldOut = false, now = Date.now() } = {}) {
  const opensAt = e?.registration_opens_at ? Date.parse(e.registration_opens_at) : null
  let badge = null
  if (opensAt && now < opensAt) badge = `Opens ${formatOpensDate(e.registration_opens_at)}`
  else if (soldOut) badge = 'Sold out'
  return {
    slug: e.slug,
    title: e.name,
    kindLabel: eventKindLabel(e.kind),
    dateLabel: formatEventDate(e.race_date),
    priceLabel: eventPriceLabel(e),
    badge,
  }
}
