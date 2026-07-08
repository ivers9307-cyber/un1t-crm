import { describe, it, expect } from 'vitest'
import { pickLatestPhones, attendeeCsvResponse } from './attendee-export'

describe('pickLatestPhones', () => {
  it('keeps the first non-empty phone per registration (payments are created_at DESC)', () => {
    const payments = [
      { race_registration_id: 'r1', contact_phone: '+353111' }, // latest, good
      { race_registration_id: 'r1', contact_phone: '+353000' }, // older, ignored
      { race_registration_id: 'r2', contact_phone: '' },        // latest is empty…
      { race_registration_id: 'r2', contact_phone: '+353222' }, // …fall back to older good one
    ]
    expect(pickLatestPhones(payments)).toEqual({ r1: '+353111', r2: '+353222' })
  })

  it('omits registrations with no phone anywhere, and tolerates empty input', () => {
    expect(pickLatestPhones([{ race_registration_id: 'r3', contact_phone: null }])).toEqual({})
    expect(pickLatestPhones([])).toEqual({})
    expect(pickLatestPhones(undefined)).toEqual({})
  })
})

describe('attendeeCsvResponse', () => {
  const race = { name: 'Summer Throwdown', slug: 'summer-throwdown', race_date: '2026-08-01' }

  it('returns a CSV download with BOM, header row, and a slugged filename', async () => {
    const res = attendeeCsvResponse(race, [])
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="summer-throwdown-attendees.csv"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    // Read raw bytes: Response.text() strips a leading BOM on decode, so assert
    // the UTF-8 BOM (EF BB BF) is really in the downloaded file via arrayBuffer.
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(buf.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    const body = new TextDecoder().decode(buf)
    expect(body).toContain('Event,Date,Team,Wave')
  })

  it('emits one row per team member with the booking phone attached', async () => {
    const regs = [
      {
        id: 'r1',
        status: 'confirmed',
        registered_at: '2026-07-01T10:00:00Z',
        teams: { name: 'Team A', team_members: [{ name: 'Ann', email: 'ann@x.ie', role: 'captain', is_member: true }] },
        wave: { label: 'Wave 1' },
        payment: { contact_phone: '+353111' },
      },
    ]
    const body = await attendeeCsvResponse(race, regs).text()
    expect(body).toContain('Ann')
    expect(body).toContain('ann@x.ie')
    expect(body).toContain('Member')
    expect(body).toContain('+353111')
  })

  it('falls back to a safe filename when slug and name are unusable', async () => {
    const res = attendeeCsvResponse({ name: '', slug: '', race_date: null }, [])
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="event-attendees.csv"')
  })
})
