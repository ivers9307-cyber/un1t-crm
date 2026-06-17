// Canonical time-off type catalogue + employment-gated option lists. Shared by
// web (RequestTimeOffModal, TimeOffManager) + mobile (time-off-new) so the
// gating can't drift. The DB CHECK (mig 283) allows all five; the manager
// approval screen + reports render/bucket them.
//
// Gating (product decision 2026-06-17): full-time employees get the four leave
// types; contractors + casual staff get 'unavailable' only. Unknown/null
// employment defaults to the full menu (don't over-restrict a mis-typed FTE).

export const TIME_OFF_TYPES = [
  { value: 'holiday', label: 'Holiday' },
  { value: 'sick', label: 'Sick' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'other', label: 'Other' },
  { value: 'unavailable', label: 'Unavailable' },
]

// employment_type values that only get 'unavailable'.
const RESTRICTED_EMPLOYMENT = ['contractor', 'casual']
const FTE_VALUES = ['holiday', 'sick', 'unpaid', 'other']
const RESTRICTED_VALUES = ['unavailable']

export function allowedTimeOffValues(employmentType) {
  return RESTRICTED_EMPLOYMENT.includes(employmentType) ? RESTRICTED_VALUES : FTE_VALUES
}

export function timeOffTypesFor(employmentType) {
  const allowed = allowedTimeOffValues(employmentType)
  return TIME_OFF_TYPES.filter(t => allowed.includes(t.value))
}

export function defaultTimeOffTypeFor(employmentType) {
  return RESTRICTED_EMPLOYMENT.includes(employmentType) ? 'unavailable' : 'holiday'
}

export function timeOffTypeLabel(value) {
  return TIME_OFF_TYPES.find(t => t.value === value)?.label || value
}
