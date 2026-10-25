// OPENAPI-EVENTS.1 — the event create/update bodies moved out of the two
// route files so the OpenAPI spec can document the same objects. These pin
// the rules that moved with them, and that the handlers still validate with
// exactly these objects (the re-exports are the same instances).
import { describe, it, expect, vi } from 'vitest'

vi.mock('next/headers', () => ({ cookies: vi.fn(), headers: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))

import {
  EventCreateFields, EventCreateSchema, EventUpdateFields, EventUpdateSchema,
  WaveCreateInputSchema, WaveUpdateInputSchema,
} from './event-save-schemas.js'
import { CreateSchema } from '@/app/api/events/route.js'
import { UpdateSchema } from '@/app/api/events/[id]/route.js'

const LOC = '11111111-1111-4111-8111-111111111111'
const race = { location_id: LOC, name: 'Autumn Hyrox', race_date: '2026-11-07', waves: [{ start_time: '10:00' }] }

describe('event save schemas (OPENAPI-EVENTS.1)', () => {
  it('the handlers validate with these exact objects', () => {
    expect(CreateSchema).toBe(EventCreateSchema)
    expect(UpdateSchema).toBe(EventUpdateSchema)
  })

  it('create: every kind but lead_gen needs a date and a wave; lead_gen needs neither', () => {
    expect(EventCreateSchema.safeParse(race).success).toBe(true)
    const noWave = EventCreateSchema.safeParse({ ...race, waves: [] })
    expect(noWave.success).toBe(false)
    expect(noWave.error.issues.map((i) => i.path.join('.'))).toEqual(['waves'])
    const noDate = EventCreateSchema.safeParse({ ...race, race_date: null })
    expect(noDate.success).toBe(false)
    expect(noDate.error.issues.map((i) => i.path.join('.'))).toEqual(['race_date'])
    expect(EventCreateSchema.safeParse({ location_id: LOC, name: 'Open evening', kind: 'lead_gen' }).success).toBe(true)
  })

  it('create waves carry no id; update waves may (matched by id, else by start_time)', () => {
    expect(Object.keys(WaveCreateInputSchema.shape)).not.toContain('id')
    expect(Object.keys(WaveUpdateInputSchema.shape)).toContain('id')
    expect(EventUpdateSchema.safeParse({ waves: [] }).success).toBe(false) // at least one when sent
    expect(EventUpdateSchema.safeParse({ waves: [{ id: '22222222-2222-4222-8222-222222222222', start_time: '09:30' }] }).success).toBe(true)
  })

  it('update: charity switched on with a blank charity name is refused (CHARITY.12)', () => {
    const r = EventUpdateSchema.safeParse({ charity_enabled: true, charity: { name: '  ' } })
    expect(r.success).toBe(false)
    expect(r.error.issues[0].path).toEqual(['charity', 'name'])
    expect(EventUpdateSchema.safeParse({ charity_enabled: true, charity: { name: 'Pieta' } }).success).toBe(true)
    expect(EventUpdateSchema.safeParse({ charity_enabled: true }).success).toBe(true) // settings not sent: not judged
  })

  it('both Fields objects carry the jsonb settings the spec documents', () => {
    for (const shape of [EventCreateFields.shape, EventUpdateFields.shape]) {
      expect(Object.keys(shape)).toEqual(expect.arrayContaining(['waves', 'charity_enabled', 'charity', 'find_team', 'entry_policy']))
    }
    expect(EventCreateSchema.safeParse({ ...race, entry_policy: { cutoff_hours: 24, self_cancel_enabled: false } }).success).toBe(true)
    expect(EventCreateSchema.safeParse({ ...race, entry_policy: { cutoff_hours: 9999 } }).success).toBe(false)
    expect(EventUpdateSchema.safeParse({ entry_policy: null }).success).toBe(true)
  })
})
