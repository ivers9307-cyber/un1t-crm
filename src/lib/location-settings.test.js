// SETTINGSWIPE.1 — the one writer of locations.settings. Seven routes read the
// column, discarded the read error, and wrote `{ ...(loc?.settings || {}), key }`
// back: a failed read replaced EVERY key (Glofox credentials, UniFi, CAPI…)
// with the one slice being saved. These pin the contract that replaces them.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { mergeLocationSettings, settingsSaveFailure } from './location-settings.js'
import { fakeLocationsDb, BOOM, NO_ROW } from './location-settings.test-helpers.js'
import { logError } from '@/lib/log'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const setKey = (k, v) => (s) => ({ ...s, [k]: v })

beforeEach(() => vi.clearAllMocks())

describe('mergeLocationSettings — a failed read writes NOTHING', () => {
  it('read error → read_failed, logged, no update', async () => {
    const db = fakeLocationsDb({ reads: { data: null, error: BOOM } })
    const mutate = vi.fn(setKey('wa_card_sets', []))
    const r = await mergeLocationSettings(db, LOC, mutate, { scope: 't' })
    expect(r).toEqual({ ok: false, reason: 'read_failed' })
    expect(mutate).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
    expect(logError).toHaveBeenCalledWith('t', expect.stringContaining('read failed'), expect.objectContaining({ locationId: LOC }))
  })

  it('no row (PGRST116) → not_found, no update, not logged as an error', async () => {
    const db = fakeLocationsDb({ reads: { data: null, error: NO_ROW } })
    const r = await mergeLocationSettings(db, LOC, setKey('x', 1))
    expect(r).toEqual({ ok: false, reason: 'not_found' })
    expect(db.writes).toEqual([])
    expect(logError).not.toHaveBeenCalled()
  })

  it('D3: a stored settings value that is not an object is refused, never replaced', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: ['corrupt'] }, error: null } })
    const r = await mergeLocationSettings(db, LOC, setKey('x', 1))
    expect(r).toEqual({ ok: false, reason: 'read_failed' })
    expect(db.writes).toEqual([])
  })
})

describe('mergeLocationSettings — a good read merges ONE key', () => {
  it('keeps every sibling key and stamps updated_at (D4)', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: { glofox: { branch_id: 'b1' }, unifi: { host: 'h' } } }, error: null } })
    const r = await mergeLocationSettings(db, LOC, setKey('wa_card_sets', [{ id: 's1' }]))
    expect(r.ok).toBe(true)
    expect(r.unchanged).toBe(false)
    expect(db.writes).toHaveLength(1)
    const { patch } = db.writes[0]
    expect(patch.settings).toEqual({ glofox: { branch_id: 'b1' }, unifi: { host: 'h' }, wa_card_sets: [{ id: 's1' }] })
    expect(typeof patch.updated_at).toBe('string')
    expect(r.settings).toEqual(patch.settings)
  })

  it('null stored settings is an empty object', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: null }, error: null } })
    const r = await mergeLocationSettings(db, LOC, setKey('scoring', { participation_points: 50 }))
    expect(r.ok).toBe(true)
    expect(db.writes[0].patch.settings).toEqual({ scoring: { participation_points: 50 } })
  })

  it('mutate may delete a key', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: { status_page: { brand: 'x' }, glofox: {} } }, error: null } })
    await mergeLocationSettings(db, LOC, (s) => { delete s.status_page; return s })
    expect(db.writes[0].patch.settings).toEqual({ glofox: {} })
  })

  it('mutate returning null = no change: ok, unchanged, nothing written', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: { hyrox: {} } }, error: null } })
    const r = await mergeLocationSettings(db, LOC, () => null)
    expect(r).toEqual({ ok: true, unchanged: true, settings: { hyrox: {} } })
    expect(db.writes).toEqual([])
  })

  it('a mutate that returns a non-object is a programmer error (throws)', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: {} }, error: null } })
    await expect(mergeLocationSettings(db, LOC, () => undefined)).rejects.toThrow(/mutate must return/)
    expect(db.writes).toEqual([])
  })

  it('D5: alsoSet writes extra columns in the same UPDATE and can never override settings', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: { glofox: {} } }, error: null } })
    await mergeLocationSettings(db, LOC, setKey('social_enabled', true), {
      alsoSet: { glofox_auto_cancel_memberships: true, settings: { evil: true } },
    })
    const { patch } = db.writes[0]
    expect(patch.glofox_auto_cancel_memberships).toBe(true)
    expect(patch.settings).toEqual({ glofox: {}, social_enabled: true })
  })
})

describe('mergeLocationSettings — the write is judged', () => {
  it('write error → write_failed, logged', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: {} }, error: null }, write: { data: null, error: BOOM } })
    const r = await mergeLocationSettings(db, LOC, setKey('x', 1), { scope: 't' })
    expect(r).toEqual({ ok: false, reason: 'write_failed' })
    expect(logError).toHaveBeenCalledWith('t', expect.stringContaining('write failed'), expect.any(Object))
  })

  it('zero rows updated (PGRST116 on .single()) → not_found', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: {} }, error: null }, write: { data: null, error: NO_ROW } })
    expect(await mergeLocationSettings(db, LOC, setKey('x', 1))).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('settingsSaveFailure (D2)', () => {
  it('read_failed → 500 settings_unreadable, "nothing was saved"', async () => {
    const res = settingsSaveFailure({ ok: false, reason: 'read_failed' })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({
      success: false,
      code: 'settings_unreadable',
      error: "Could not read this location's settings just now, so nothing was saved. Try again.",
    })
  })
  it('not_found → 404', async () => {
    expect(settingsSaveFailure({ ok: false, reason: 'not_found' }).status).toBe(404)
  })
  it('write_failed → 500 settings_write_failed, no DB message', async () => {
    const res = settingsSaveFailure({ ok: false, reason: 'write_failed' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, code: 'settings_write_failed', error: 'Could not save just now. Try again.' })
  })
})
