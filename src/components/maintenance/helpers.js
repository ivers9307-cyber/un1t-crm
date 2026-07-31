// EQUIP-MAINT.1 — presentation helpers shared by the maintenance tabs.

// Chips MUST use the -700 text ramp on a /10 background. Lower ramps
// (-300/-400) are unreadable on this light theme and are lint-blocked
// by check:guardrails (no-low-contrast-chip).
export const STATUS_CHIP = Object.freeze({
  in_service:     'bg-emerald-500/10 text-emerald-700',
  out_of_service: 'bg-red-500/10 text-red-700',
  retired:        'bg-slate-500/10 text-slate-700',
})

export const STATUS_LABEL = Object.freeze({
  in_service: 'In service',
  out_of_service: 'Out of service',
  retired: 'Retired',
})

/** Human text for an interval in weeks. */
export function formatInterval(weeks) {
  if (weeks === 1) return 'Weekly'
  if (weeks === 2) return 'Fortnightly'
  if (weeks === 13) return 'Quarterly'
  if (weeks === 26) return 'Every 6 months'
  if (weeks === 52) return 'Annually'
  return `Every ${weeks} weeks`
}

export const WEEKDAYS = Object.freeze([
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
])

export const INTERVAL_OPTIONS = Object.freeze([1, 2, 4, 8, 13, 26, 52])
