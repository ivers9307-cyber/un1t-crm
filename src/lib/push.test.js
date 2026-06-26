import { describe, it, expect, vi, beforeEach } from 'vitest'

// We mock @/lib/supabase so the unit test never touches a real DB. The
// goal is to verify the *filtering* logic in sendPush — that the master
// push_notifications switch and per-category notify_<x> flags correctly
// gate users out before any push is sent. Post mig 058 those flags live on
// profile_locations.permissions (NOT the stale profiles.permissions). The
// Expo HTTP call is also mocked so we can assert what would have been sent.

vi.mock('./supabase.js', () => {
  return {
    createServerClient: () => makeFakeDb(),
  }
})

let fakeProfiles = []
let fakeLinks = []
let fakeTokens = []
let deletedTokenIds = []
let lastDbPath = []

function makeFakeDb() {
  function from(table) {
    if (table === 'profiles') {
      return {
        select: () => ({
          in: (_col, ids) => Promise.resolve({
            data: fakeProfiles.filter(p => ids.includes(p.id)),
            error: null,
          }),
        }),
      }
    }
    if (table === 'profile_locations') {
      return {
        select: () => ({
          in: (_col, ids) => Promise.resolve({
            data: fakeLinks.filter(l => ids.includes(l.profile_id)),
            error: null,
          }),
        }),
      }
    }
    if (table === 'device_tokens') {
      return {
        select: () => ({
          in: (_col, ids) => Promise.resolve({
            data: fakeTokens.filter(t => ids.includes(t.user_id)),
            error: null,
          }),
        }),
        delete: () => ({
          in: (_col, ids) => {
            deletedTokenIds.push(...ids)
            return Promise.resolve({ data: null, error: null })
          },
        }),
      }
    }
    lastDbPath.push(table)
    return {}
  }
  return { from }
}

beforeEach(() => {
  fakeProfiles = []
  fakeLinks = []
  fakeTokens = []
  deletedTokenIds = []
  lastDbPath = []
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ status: 'ok' }] }),
  })
})

import { sendPush, resolvePushAllowedIds } from './push.js'

describe('sendPush — permission filtering (reads profile_locations, mig 058)', () => {
  it('returns zero counts when no userIds are passed', async () => {
    const result = await sendPush([], { title: 't', body: 'b' })
    expect(result).toEqual({ sent: 0, skipped: 0, invalidated: 0 })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('skips inactive profiles', async () => {
    fakeProfiles = [{ id: 'a', active: false }]
    fakeLinks = [{ profile_id: 'a', permissions: { mobile: { push_notifications: true } } }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b' })
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('skips users with profile_locations push_notifications === false', async () => {
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [{ profile_id: 'a', permissions: { mobile: { push_notifications: false } } }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b' })
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('skips users when category flag is off (notify_swap=false)', async () => {
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [{ profile_id: 'a', permissions: { mobile: { push_notifications: true, notify_swap: false } } }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'swap' })
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('sends when master + category flags both allow', async () => {
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [{ profile_id: 'a', permissions: { mobile: { push_notifications: true, notify_swap: true } } }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'swap' })
    expect(result.sent).toBe(1)
    expect(result.skipped).toBe(0)
    expect(global.fetch).toHaveBeenCalledOnce()
  })

  it('treats a missing permissions.mobile object as send (not explicitly off)', async () => {
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [{ profile_id: 'a', permissions: {} }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'lead' })
    expect(result.sent).toBe(1)
  })

  it('IGNORES stale profiles.permissions — only profile_locations gates (the mig-058 regression)', async () => {
    // The opt-out lives ONLY on the stale profiles.permissions; the live
    // profile_locations row is clean. Pre-fix this user was wrongly skipped.
    fakeProfiles = [{ id: 'a', active: true, permissions: { mobile: { notify_lead: false } } }]
    fakeLinks = [{ profile_id: 'a', permissions: { mobile: { push_notifications: true } } }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'lead' })
    expect(result.sent).toBe(1)
    expect(result.skipped).toBe(0)
  })

  it('honours an opt-out set on ANY assignment (conservative, multi-location)', async () => {
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [
      { profile_id: 'a', permissions: { mobile: { notify_lead: false } } },
      { profile_id: 'a', permissions: { mobile: {} } },
    ]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'lead' })
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('prunes Expo tokens reported as DeviceNotRegistered', async () => {
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [{ profile_id: 'a', permissions: { mobile: { push_notifications: true } } }]
    fakeTokens = [{ id: 't-bad', user_id: 'a', expo_push_token: 'ExponentPushToken[gone]' }]

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
      }),
    })

    const result = await sendPush(['a'], { title: 't', body: 'b' })
    expect(result.sent).toBe(0)
    expect(result.invalidated).toBe(1)
    expect(deletedTokenIds).toContain('t-bad')
  })
})

describe('resolvePushAllowedIds', () => {
  it('reads profile_locations and ignores stale profiles.permissions', async () => {
    fakeProfiles = [{ id: 'a', active: true, permissions: { mobile: { notify_lead: false } } }]
    fakeLinks = [{ profile_id: 'a', permissions: { mobile: {} } }]
    const allowed = await resolvePushAllowedIds(makeFakeDb(), ['a'], 'lead')
    expect(allowed.has('a')).toBe(true)
  })

  it('suppresses an inactive user regardless of permissions', async () => {
    fakeProfiles = [{ id: 'a', active: false }]
    fakeLinks = [{ profile_id: 'a', permissions: { mobile: {} } }]
    const allowed = await resolvePushAllowedIds(makeFakeDb(), ['a'], 'lead')
    expect(allowed.has('a')).toBe(false)
  })

  it('returns an empty set for no ids', async () => {
    const allowed = await resolvePushAllowedIds(makeFakeDb(), [], 'lead')
    expect(allowed.size).toBe(0)
  })
})
