// Attendee CSV export (EVENTS-EXPORT.1). One row per team member, with the
// booking/team columns repeated. Pure — the route feeds it the same shape the
// /api/events/[id]/teams route returns (registration → teams.team_members +
// the attached payment's contact_phone).

const HEADER = [
  'Event', 'Date', 'Team', 'Wave', 'Booking status', 'Registered at',
  'Name', 'Email', 'Role', 'Membership', 'Booking phone',
]

// One CSV cell: RFC-4180 quoting PLUS a CSV-injection guard. A value that
// begins with =, +, -, @ (or a control char) is a formula trigger in Excel /
// Sheets — prefix it with a single quote so it's rendered as text, never
// executed. Then quote if it contains a comma, quote, or newline.
export function csvCell(value) {
  let s = value == null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * Build the attendee CSV. One row per team member; a booking with no members
 * still emits a single row (blank person columns) so it isn't silently dropped.
 * @param {{name?:string, race_date?:string}} event
 * @param {Array<object>} registrations  race_registrations with teams.team_members + payment
 * @returns {string} CSV text (CRLF line endings, header first)
 */
export function buildAttendeeCsv(event, registrations) {
  const rows = [HEADER]
  for (const reg of (registrations || [])) {
    const team = reg?.teams || {}
    const wave = reg?.wave || {}
    const waveLabel = wave.label || wave.start_time || ''
    const phone = reg?.payment?.contact_phone || ''
    const base = [
      event?.name || '',
      event?.race_date || '',
      team.name || '',
      waveLabel,
      reg?.status || '',
      reg?.registered_at || '',
    ]
    const members = Array.isArray(team.team_members) ? team.team_members : []
    if (members.length === 0) {
      rows.push([...base, '', '', '', '', phone])
      continue
    }
    for (const m of members) {
      rows.push([
        ...base,
        m?.name || '',
        m?.email || '',
        m?.role || '',
        m?.is_member ? 'Member' : 'Non-member',
        phone,
      ])
    }
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}
