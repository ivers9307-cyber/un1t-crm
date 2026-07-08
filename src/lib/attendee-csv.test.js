// Attendee CSV (EVENTS-EXPORT.1) — one row per member, escaping + injection guard.

import { describe, it, expect } from 'vitest'
import { buildAttendeeCsv, csvCell } from './attendee-csv.js'

const event = { name: 'Spring Hyrox', race_date: '2026-03-01' }

const reg = {
  status: 'confirmed',
  registered_at: '2026-02-01T10:00:00Z',
  wave: { start_time: '09:00', label: 'Wave 1' },
  payment: { contact_phone: '+353871234567' },
  teams: {
    name: 'Team A',
    team_members: [
      { name: 'Jane', email: 'jane@x.ie', role: 'captain', is_member: true },
      { name: 'Bob', email: 'bob@x.ie', role: 'member', is_member: false },
    ],
  },
}

describe('buildAttendeeCsv', () => {
  it('emits a header + one row per team member with the booking columns repeated', () => {
    const csv = buildAttendeeCsv(event, [reg])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('Event,Date,Team,Wave,Booking status,Registered at,Name,Email,Role,Membership,Booking phone')
    expect(lines).toHaveLength(3) // header + 2 members
    // Booking phone is prefixed with ' — the +353 leader is a formula trigger,
    // so the injection guard neutralises it (spreadsheets still render +353…).
    expect(lines[1]).toBe("Spring Hyrox,2026-03-01,Team A,Wave 1,confirmed,2026-02-01T10:00:00Z,Jane,jane@x.ie,captain,Member,'+353871234567")
    expect(lines[2]).toContain("Bob,bob@x.ie,member,Non-member,'+353871234567")
  })

  it('still emits one row for a booking with no team members', () => {
    const csv = buildAttendeeCsv(event, [{ ...reg, teams: { name: 'Solo', team_members: [] } }])
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe("Spring Hyrox,2026-03-01,Solo,Wave 1,confirmed,2026-02-01T10:00:00Z,,,,,'+353871234567")
  })

  it('falls back to wave start_time when there is no label, and handles missing payment/team', () => {
    const csv = buildAttendeeCsv(event, [{ status: 'pending', registered_at: '', wave: { start_time: '10:30' }, teams: { name: 'T', team_members: [{ name: 'A', email: '', role: 'member', is_member: false }] } }])
    expect(csv.split('\r\n')[1]).toBe('Spring Hyrox,2026-03-01,T,10:30,pending,,A,,member,Non-member,')
  })

  it('returns just the header for no registrations', () => {
    expect(buildAttendeeCsv(event, []).split('\r\n')).toHaveLength(1)
    expect(buildAttendeeCsv(event, null).split('\r\n')).toHaveLength(1)
  })
})

describe('csvCell', () => {
  it('quotes values containing commas, quotes, or newlines (RFC-4180)', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
  })

  it('neutralises spreadsheet formula-injection triggers', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('-2')).toBe("'-2")
    expect(csvCell('@x')).toBe("'@x")
    // a leading-hyphen formula that also needs quoting still gets both
    expect(csvCell('=a,b')).toBe('"\'=a,b"')
  })

  it('renders null/undefined as empty', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })
})
