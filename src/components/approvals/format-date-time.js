import { formatInZone, resolveZone } from '@shared/zoned-time'

// APPROVALSQ.3 — the one date-time format on the /approvals cards: "14 Nov 2026, 11:20",
// on the studio's clock (`timezone`, falling back through resolveZone), never the
// browser's. An empty value is a dash; an unreadable one is shown as given.
export function formatApprovalDateTime(value, timezone = null) {
  if (!value) return '—'
  try {
    return formatInZone(new Date(value), resolveZone(timezone), { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return value }
}
