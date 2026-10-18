// WAHOMESTUDIO.1 (R1) — where a thread for a contact belongs when it is opened
// on another studio's number. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn() }))
import { numberlessHomeStudio, numberlessSiblingLocationIds } from './whatsapp-thread-location.js'
import { logWarn } from './log'
import { fakeWhatsAppDb, link } from './whatsapp-numbers-fake-db.test-helpers.js'

const STILL = 'a0000000-0000-4000-8000-000000000001'
const HATCH = 'a0000000-0000-4000-8000-000000000002'
const OTHER = 'a0000000-0000-4000-8000-000000000003'

// The shared fake models the link table (WAORGNUMBER.1): `numbers` are
// whatsapp_numbers rows and, with no `links`, each is switched on at its home.
const makeDb = (state) => fakeWhatsAppDb(state)

let state
beforeEach(() => {
  vi.clearAllMocks()
  state = {
    locations: [{ id: STILL, organization_id: 'O1' }, { id: HATCH, organization_id: 'O1' }, { id: OTHER, organization_id: 'O2' }],
    numbers: [{ id: 'n1', location_id: STILL, is_active: true }],
    contacts: [{ id: 'k1', location_id: HATCH }],
  }
})

describe('numberlessHomeStudio', () => {
  it('a home studio with no number, same organisation → the home studio', async () => {
    expect(await numberlessHomeStudio(makeDb(state), { id: 'k1', location_id: HATCH }, STILL)).toBe(HATCH)
  })
  it('reads the contact’s studio when the row carries no location_id (Review Focus 4)', async () => {
    expect(await numberlessHomeStudio(makeDb(state), { id: 'k1' }, STILL)).toBe(HATCH)
  })
  it('home has its own active number → null', async () => {
    state.numbers.push({ id: 'n2', location_id: HATCH, is_active: true })
    expect(await numberlessHomeStudio(makeDb(state), { id: 'k1', location_id: HATCH }, STILL)).toBeNull()
  })
  it('home studio with the org number switched on is not numberless (WAORGNUMBER.1)', async () => {
    // The number is homed at STILL; Hatch has no number of its own, but the
    // organisation number is switched on there too.
    state.links = [link(STILL, 'n1'), link(HATCH, 'n1')]
    expect(await numberlessHomeStudio(makeDb(state), { id: 'k1', location_id: HATCH }, STILL)).toBeNull()
  })
  it('a number homed at Hatch but switched off there does not count (WAORGNUMBER.1)', async () => {
    state.numbers.push({ id: 'n2', location_id: HATCH, is_active: true })
    state.links = [link(STILL, 'n1'), link(STILL, 'n2')]
    expect(await numberlessHomeStudio(makeDb(state), { id: 'k1', location_id: HATCH }, STILL)).toBe(HATCH)
  })
  it('an inactive home number does not count as a number', async () => {
    state.numbers.push({ id: 'n2', location_id: HATCH, is_active: false })
    expect(await numberlessHomeStudio(makeDb(state), { id: 'k1', location_id: HATCH }, STILL)).toBe(HATCH)
  })
  it('another organisation, the same studio, no contact, or no studio → null', async () => {
    const db = makeDb(state)
    expect(await numberlessHomeStudio(db, { id: 'k9', location_id: OTHER }, STILL)).toBeNull()
    expect(await numberlessHomeStudio(db, { id: 'k1', location_id: STILL }, STILL)).toBeNull()
    expect(await numberlessHomeStudio(db, null, STILL)).toBeNull()
    expect(await numberlessHomeStudio(db, { id: 'k1', location_id: HATCH }, null)).toBeNull()
  })
  it('a failed read → null, logged (files where it does today)', async () => {
    state.faults = { location_whatsapp_numbers: { message: 'boom' } }
    expect(await numberlessHomeStudio(makeDb(state), { id: 'k1', location_id: HATCH }, STILL)).toBeNull()
    expect(logWarn).toHaveBeenCalledWith('wa-thread-location', 'home studio lookup failed; filing at the number’s studio', expect.objectContaining({ err: expect.stringContaining('boom') }))
  })
})

describe('numberlessSiblingLocationIds', () => {
  it('lists same-organisation studios with no active number, excluding the studio itself', async () => {
    expect(await numberlessSiblingLocationIds(makeDb(state), STILL)).toEqual([HATCH])
  })
  it('a sibling with an active number is excluded; an inactive number does not count as one', async () => {
    state.numbers.push({ id: 'n2', location_id: HATCH, is_active: true })
    expect(await numberlessSiblingLocationIds(makeDb(state), STILL)).toEqual([])
    state.numbers[1].is_active = false
    expect(await numberlessSiblingLocationIds(makeDb(state), STILL)).toEqual([HATCH])
  })
  it('sibling with a switched-on number is not counted (WAORGNUMBER.1)', async () => {
    state.links = [link(STILL, 'n1'), link(HATCH, 'n1')]
    expect(await numberlessSiblingLocationIds(makeDb(state), STILL)).toEqual([])
  })
  it('a sibling whose own number is switched off there is still numberless (WAORGNUMBER.1)', async () => {
    state.numbers.push({ id: 'n2', location_id: HATCH, is_active: true })
    state.links = [link(STILL, 'n1')]
    expect(await numberlessSiblingLocationIds(makeDb(state), STILL)).toEqual([HATCH])
  })
  it('another organisation’s studios are never listed', async () => {
    expect(await numberlessSiblingLocationIds(makeDb(state), STILL)).not.toContain(OTHER)
    expect(await numberlessSiblingLocationIds(makeDb(state), OTHER)).toEqual([])
  })
  it('an unknown studio or a studio with no organisation has no siblings', async () => {
    expect(await numberlessSiblingLocationIds(makeDb(state), 'a0000000-0000-4000-8000-0000000000ff')).toEqual([])
    expect(await numberlessSiblingLocationIds(makeDb(state), null)).toEqual([])
  })
  it('THROWS on a failed read, never returns a smaller set', async () => {
    for (const table of ['locations', 'location_whatsapp_numbers']) {
      state.faults = { [table]: { message: 'boom' } }
      await expect(numberlessSiblingLocationIds(makeDb(state), STILL)).rejects.toThrow(/boom/)
    }
  })
})
