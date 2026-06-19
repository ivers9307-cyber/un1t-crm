// Tests for contact-devices.js — validation is pure; lookup +
// listForContact use mocked Supabase chains.

import { describe, it, expect, vi } from 'vitest'
import { validateDeviceInput, lookupByIdentifier, listForContact, listForContacts } from './contact-devices.js'

// ── validateDeviceInput ──────────────────────────────────────────

describe('validateDeviceInput', () => {
  it('rejects unknown device_type', () => {
    const out = validateDeviceInput({ device_type: 'nope', identifier: 'abc' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/device_type/)
  })

  it('rejects missing identifier', () => {
    const out = validateDeviceInput({ device_type: 'chest_strap', identifier: '' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/identifier/)
  })

  it('builds a ble: device_key from a chest_strap MAC (protocol defaults to ble)', () => {
    const out = validateDeviceInput({ device_type: 'chest_strap', identifier: 'aa-bb-cc-dd-ee-ff' })
    expect(out.ok).toBe(true)
    expect(out.normalised.identifier).toBe('ble:AA:BB:CC:DD:EE:FF')
  })

  it('builds an ant: device_key from a chest_strap ANT+ device number', () => {
    const out = validateDeviceInput({ device_type: 'chest_strap', protocol: 'ant', identifier: '12345' })
    expect(out.ok).toBe(true)
    expect(out.normalised.identifier).toBe('ant:12345')
  })

  it('accepts an already-qualified device_key verbatim (scan flow)', () => {
    const fromBle = validateDeviceInput({ device_type: 'chest_strap', identifier: 'ble:aabbccddeeff' })
    expect(fromBle.normalised.identifier).toBe('ble:AA:BB:CC:DD:EE:FF')
    const fromAnt = validateDeviceInput({ device_type: 'chest_strap', identifier: 'ant:00777' })
    expect(fromAnt.normalised.identifier).toBe('ant:777')
  })

  it('rejects an invalid chest_strap MAC', () => {
    const out = validateDeviceInput({ device_type: 'chest_strap', identifier: 'not-a-mac' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/MAC/)
  })

  it('rejects an invalid ANT+ device number', () => {
    const out = validateDeviceInput({ device_type: 'chest_strap', protocol: 'ant', identifier: '99999' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/ANT\+/)
  })

  it('rejects an unknown protocol', () => {
    const out = validateDeviceInput({ device_type: 'chest_strap', protocol: 'zigbee', identifier: '1' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/protocol/)
  })

  it('keeps watch identifier verbatim', () => {
    const out = validateDeviceInput({ device_type: 'watch', identifier: 'apple-watch-XYZ-1234' })
    expect(out.ok).toBe(true)
    expect(out.normalised.identifier).toBe('apple-watch-XYZ-1234')
  })

  it('rejects watch identifier > 200 chars', () => {
    const out = validateDeviceInput({ device_type: 'watch', identifier: 'x'.repeat(201) })
    expect(out.ok).toBe(false)
  })

  it('lower-cases manufacturer + drops unknown ones to unknown', () => {
    const out = validateDeviceInput({ device_type: 'chest_strap', identifier: 'aabbccddeeff', manufacturer: 'POLAR' })
    expect(out.normalised.manufacturer).toBe('polar')
    const out2 = validateDeviceInput({ device_type: 'chest_strap', identifier: 'aabbccddeeff', manufacturer: 'mystery-brand' })
    expect(out2.normalised.manufacturer).toBe('unknown')
  })

  it('truncates labels longer than 80 chars', () => {
    const long = 'x'.repeat(200)
    const out = validateDeviceInput({ device_type: 'chest_strap', identifier: 'aabbccddeeff', label: long })
    expect(out.normalised.label.length).toBe(80)
  })

  it('null label/manufacturer accepted', () => {
    const out = validateDeviceInput({ device_type: 'chest_strap', identifier: 'aabbccddeeff' })
    expect(out.normalised.label).toBe(null)
    expect(out.normalised.manufacturer).toBe(null)
  })
})

// ── lookupByIdentifier ──────────────────────────────────────────

describe('lookupByIdentifier', () => {
  function mockDb({ data = null }) {
    return {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                limit: vi.fn(() => ({
                  maybeSingle: vi.fn(() => Promise.resolve({ data, error: null })),
                })),
              })),
            })),
          })),
        })),
      })),
    }
  }

  it('returns null when identifier is empty/null', async () => {
    expect(await lookupByIdentifier(mockDb({}), '', 'loc-1')).toBe(null)
    expect(await lookupByIdentifier(mockDb({}), null, 'loc-1')).toBe(null)
  })

  it('returns null when locationId is missing', async () => {
    expect(await lookupByIdentifier(mockDb({}), 'AA:BB:CC:DD:EE:FF', null)).toBe(null)
  })

  it('returns null when no match', async () => {
    expect(await lookupByIdentifier(mockDb({ data: null }), 'AA:BB:CC:DD:EE:FF', 'loc-1')).toBe(null)
  })

  it('returns shape on hit', async () => {
    const data = { contact_id: 'c-1', label: 'Polar H10', contacts: { id: 'c-1', location_id: 'loc-1' } }
    const out = await lookupByIdentifier(mockDb({ data }), 'AA:BB:CC:DD:EE:FF', 'loc-1')
    expect(out).toEqual({ contactId: 'c-1', locationId: 'loc-1', label: 'Polar H10' })
  })
})

// ── listForContact ──────────────────────────────────────────────

describe('listForContact', () => {
  it('returns empty list on error', async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              order: vi.fn(() => Promise.resolve({ data: null, error: { message: 'rls' } })),
            })),
          })),
        })),
      })),
    }
    const out = await listForContact(db, 'c-1')
    expect(out.devices).toEqual([])
    expect(out.error).toBeTruthy()
  })

  it('returns devices on success', async () => {
    const rows = [
      { id: 'd-1', device_type: 'chest_strap', identifier: 'AA:BB:CC:DD:EE:FF', label: 'Polar H10', manufacturer: 'polar', is_active: true, added_by_contact: false, created_at: '2026-05-08T16:00:00Z' },
    ]
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              order: vi.fn(() => Promise.resolve({ data: rows, error: null })),
            })),
          })),
        })),
      })),
    }
    const out = await listForContact(db, 'c-1')
    expect(out.devices).toEqual(rows)
    expect(out.error).toBe(null)
  })
})

// ── listForContacts ─────────────────────────────────────────────

describe('listForContacts', () => {
  it('returns empty list immediately when no ids provided', async () => {
    const db = { from: vi.fn() }
    const out = await listForContacts(db, [])
    expect(out.devices).toEqual([])
    expect(out.error).toBe(null)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('accepts a single id (non-array) and queries via .in()', async () => {
    const rows = [
      { id: 'd-1', contact_id: 'c-1', device_type: 'chest_strap', identifier: 'ble:AA:BB:CC:DD:EE:FF', label: null, manufacturer: null, is_active: true, added_by_contact: false, created_at: '2026-05-08T16:00:00Z' },
    ]
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn(() => ({
            order: vi.fn(() => ({
              order: vi.fn(() => Promise.resolve({ data: rows, error: null })),
            })),
          })),
        })),
      })),
    }
    const out = await listForContacts(db, 'c-1')
    expect(out.devices).toEqual(rows)
    expect(out.error).toBe(null)
  })

  it('queries with .in() for multiple contact ids', async () => {
    const rows = [
      { id: 'd-1', contact_id: 'c-1', device_type: 'chest_strap', identifier: 'ble:AA:BB:CC:DD:EE:FF', label: null, manufacturer: null, is_active: true, added_by_contact: false, created_at: '2026-05-08T16:00:00Z' },
      { id: 'd-2', contact_id: 'c-2', device_type: 'chest_strap', identifier: 'ant:12345', label: null, manufacturer: null, is_active: true, added_by_contact: false, created_at: '2026-05-08T16:00:00Z' },
    ]
    const inFn = vi.fn(() => ({
      order: vi.fn(() => ({
        order: vi.fn(() => Promise.resolve({ data: rows, error: null })),
      })),
    }))
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({ in: inFn })),
      })),
    }
    const out = await listForContacts(db, ['c-1', 'c-2'])
    expect(out.devices).toEqual(rows)
    expect(out.error).toBe(null)
    // Verify .in() was called with both ids
    expect(inFn).toHaveBeenCalledWith('contact_id', ['c-1', 'c-2'])
  })

  it('returns empty list and the error on DB failure', async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn(() => ({
            order: vi.fn(() => ({
              order: vi.fn(() => Promise.resolve({ data: null, error: { message: 'rls' } })),
            })),
          })),
        })),
      })),
    }
    const out = await listForContacts(db, ['c-1'])
    expect(out.devices).toEqual([])
    expect(out.error).toBeTruthy()
  })
})
