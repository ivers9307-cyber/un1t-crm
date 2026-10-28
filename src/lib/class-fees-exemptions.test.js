// FEES.4 — the never-charged list.
import { describe, it, expect, vi } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { makeDb } from './class-fees.test-helpers.js'
import { addExemption, removeExemption, listExemptions, exemptContactIds } from './class-fees-exemptions.js'

const LOC = 'loc-hatch'
const tables = () => ({
  locations: [
    { id: LOC, organization_id: 'org-1' },
    { id: 'loc-stillorgan', organization_id: 'org-1' },
    { id: 'loc-cars', organization_id: 'org-2' },
  ],
  contacts: [
    { id: 'c-hatch', location_id: LOC, first_name: 'Ann', last_name: 'A', email: 'ann@x.test' },
    { id: 'c-sibling', location_id: 'loc-stillorgan', first_name: 'Bob', last_name: 'B', email: 'bob@x.test' },
    { id: 'c-other-org', location_id: 'loc-cars', first_name: 'Cy', last_name: 'C', email: 'cy@x.test' },
  ],
  class_fee_exemptions: [],
  class_fees: [
    { id: 'f-pending', location_id: LOC, contact_id: 'c-hatch', penalty: 'fee', status: 'pending' },
    { id: 'f-outstanding', location_id: LOC, contact_id: 'c-hatch', penalty: 'fee', status: 'outstanding' },
    { id: 'f-charged', location_id: LOC, contact_id: 'c-hatch', penalty: 'fee', status: 'charged' },
    { id: 'f-forfeit', location_id: LOC, contact_id: 'c-hatch', penalty: 'credit_forfeit', status: 'recorded' },
    { id: 'f-other-studio', location_id: 'loc-stillorgan', contact_id: 'c-hatch', penalty: 'fee', status: 'pending' },
  ],
})
const status = (db, id) => db.store.class_fees.find((f) => f.id === id)

describe('class fee exemptions', () => {
  it('adding a member waives what they owe here (never what is charged, recorded or at another studio)', async () => {
    const db = makeDb(tables())
    expect(await addExemption(db, { locationId: LOC, contactId: 'c-hatch', note: ' Staff ', actorId: 'u-staff' })).toEqual({ ok: true, waived: 2 })
    expect(status(db, 'f-pending')).toMatchObject({ status: 'waived', waive_rule: 'exempt', waived_reason: 'Exempt member, never charged', waived_by: null })
    expect(status(db, 'f-outstanding')).toMatchObject({ status: 'waived', waive_rule: 'exempt' })
    expect(status(db, 'f-charged').status).toBe('charged')
    expect(status(db, 'f-forfeit').status).toBe('recorded')
    expect(status(db, 'f-other-studio').status).toBe('pending')
    expect(db.store.class_fee_exemptions).toEqual([expect.objectContaining({ location_id: LOC, contact_id: 'c-hatch', note: 'Staff', added_by: 'u-staff' })])
  })

  it('adding twice keeps one row', async () => {
    const db = makeDb(tables())
    await addExemption(db, { locationId: LOC, contactId: 'c-hatch' })
    await addExemption(db, { locationId: LOC, contactId: 'c-hatch' })
    expect(db.store.class_fee_exemptions).toHaveLength(1)
  })

  it('a contact from a sibling studio in the organisation may be added; another organisation may not', async () => {
    const db = makeDb(tables())
    expect((await addExemption(db, { locationId: LOC, contactId: 'c-sibling' })).ok).toBe(true)
    expect(await addExemption(db, { locationId: LOC, contactId: 'c-other-org' })).toEqual({ ok: false, reason: 'not_found' })
    expect(await addExemption(db, { locationId: LOC, contactId: 'nobody' })).toEqual({ ok: false, reason: 'not_found' })
  })

  it('lists with names, answers who is exempt, and removes without touching past fees', async () => {
    const db = makeDb(tables())
    await addExemption(db, { locationId: LOC, contactId: 'c-hatch' })
    expect(await listExemptions(db, LOC)).toEqual([expect.objectContaining({ contact_id: 'c-hatch', member_name: 'Ann A', member_email: 'ann@x.test' })])
    expect([...await exemptContactIds(db, LOC, ['c-hatch', 'c-sibling'])]).toEqual(['c-hatch'])
    expect(await removeExemption(db, { locationId: LOC, contactId: 'c-hatch' })).toEqual({ ok: true, removed: 1 })
    expect((await exemptContactIds(db, LOC)).size).toBe(0)
    expect(status(db, 'f-pending').status).toBe('waived')
  })
})
