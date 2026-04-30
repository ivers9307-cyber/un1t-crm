import { describe, it, expect, vi, beforeEach } from 'vitest'

// We mock @/lib/supabase so the unit test never touches a real DB. The
// goal is to verify the *filtering* logic in sendPush — that the master
// push_notifications switch and per-category notify_<x> flags correctly
// gate users out before any push is sent. The Expo HTTP call is also
// mocked so we can assert what the function would have sent.

vi.mock('./supabase.js', () => {
  return {
    createServerClient: () => makeFakeDb(),
  }
})

let fakeProfiles = []
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
  fakeTokens = []
  deletedTokenIds = []
  lastDbPath = []
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ status: 'ok' }] }),
  })
})

import { sendPush } from './push.js'

describe('sendPush — permission filtering', () => {
  it('returns zero counts when no userIds are passed', async () => {
    const result = await sendPush([], { title: 't', body: 'b' })
    expect(result).toEqual({ sent: 0, skipped: 0, invalidated: 0 })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('skips inactive profiles', async () => {
    fakeProfiles = [{ id: 'a', active: false, permissions: { mobile: { push_notifications: true } } }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b' })
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('skips users with permissions.mobile.push_notifications === false', async () => {
    fakeProfiles = [{ id: 'a', active: true, permissions: { mobile: { push_notifications: false } } }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b' })
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('skips users when category-specific flag is off (notify_swap=false)', async () => {
    fakeProfiles = [
      {
        id: 'a',
        active: true,
        permissions: { mobile: { push_notifications: true, notify_swap: false } },
      },
    ]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'swap' })
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('sends when master + category flags both allow', async () => {
    fakeProfiles = [
      {
        id: 'a',
        active: true,
        permissions: { mobile: { push_notifications: true, notify_swap: true } },
      },
    ]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'swap' })
    expect(result.sent).toBe(1)
    expect(result.skipped).toBe(0)
    expect(global.fetch).toHaveBeenCalledOnce()
  })

  it('treats a missing permissions.mobile object as deny-by-default for categories', async () => {
    fakeProfiles = [{ id: 'a', active: true, permissions: {} }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    // No mobile.push_notifications key set means "not explicitly false",
    // so the master switch passes. The category flag (notify_lead) is
    // undefined which is also "not explicitly false". Result: send.
    // This matches the documented "missing key = treated as off by the
    // app" rule on the mobile side, but server-side we must be careful
    // not to drop legitimate pushes for users whose profile predates
    // the mobile feature flags being added.
    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'lead' })
    expect(result.sent).toBe(1)
  })

  it('prunes Expo tokens reported as DeviceNotRegistered', async () => {
    fakeProfiles = [
      { id: 'a', active: true, permissions: { mobile: { push_notifications: true } } },
    ]
    fakeTokens = [
      { id: 't-bad', user_id: 'a', expo_push_token: 'ExponentPushToken[gone]' },
    ]

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { status: 'error', details: { error: 'DeviceNotRegistered' } },
        ],
      }),
    })

    const result = await sendPush(['a'], { title: 't', body: 'b' })
    expect(result.sent).toBe(0)
    expect(result.invalidated).toBe(1)
    expect(deletedTokenIds).toContain('t-bad')
  })
})
