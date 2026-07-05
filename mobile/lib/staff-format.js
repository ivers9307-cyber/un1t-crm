// Pure label formatters for the staff enums shown in the mobile UI.
// The DB stores raw values (role 'head_coach', employment_type 'fte');
// these humanise them for display. Unknown values fall through to the
// raw string; empty → em-dash.

const ROLE_LABELS = Object.freeze({
  master: 'Master',
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
  reception: 'Reception',
})

export function formatRole(role) {
  return ROLE_LABELS[role] || (role ? String(role) : '—')
}

const EMPLOYMENT_LABELS = Object.freeze({
  fte: 'Full-time',
  contractor: 'Contractor',
  casual: 'Casual',
})

export function formatEmploymentType(type) {
  return EMPLOYMENT_LABELS[type] || (type ? String(type) : '—')
}
