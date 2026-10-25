// Shared by FleetAdmin and ScreensSection: how long ago an instant was, as an
// operator reads it. null for no instant (the caller says what that means).
export function timeAgo(iso) {
  if (!iso) return null
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (!Number.isFinite(mins)) return null
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

// How long until an instant, for an override that is still in force.
export function timeUntil(iso) {
  if (!iso) return null
  const mins = Math.ceil((new Date(iso).getTime() - Date.now()) / 60000)
  if (!Number.isFinite(mins)) return null
  if (mins < 1) return 'less than a minute'
  if (mins < 60) return `${mins} min`
  const hrs = Math.round(mins / 60)
  return `${hrs} h`
}
