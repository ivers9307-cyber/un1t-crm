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
let fakeTemplates = []
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
    // PERM-AUDIT.3 — role templates (mig 364) consulted at tier 2.5.
    if (table === 'location_role_permissions') {
      return {
        select: () => ({
          in: (_col, ids) => Promise.resolve({
            data: fakeTemplates.filter(t => ids.includes(t.location_id)),
            error: null,
          }),
        }),
      }
    }
    if (table === 'device_tokens') {
      return {
        // ANDROID-VIS.1 (mig 565) — expo_push_token is nullable now, so
        // the mock models `.not('expo_push_token','is',null)` faithfully
        // rather than accepting and ignoring it: a filter the fake honours
        // by accident is a filter the suite cannot prove.
        select: () => {
          let rows = () => fakeTokens
          const builder = {
            not: (col, op, val) => {
              if (col !== 'expo_push_token' || op !== 'is' || val !== null) {
                throw new Error(`unmodelled .not(${col}, ${op}, ${val})`)
              }
              const prev = rows
              rows = () => prev().filter(t => t.expo_push_token != null)
              return builder
            },
            in: (_col, ids) => Promise.resolve({
              data: rows().filter(t => ids.includes(t.user_id)),
              error: null,
            }),
          }
          return builder
        },
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
  fakeTemplates = []
  fakeTokens = []
  deletedTokenIds = []
  lastDbPath = []
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ status: 'ok' }] }),
  })
})

import { sendPush, resolvePushAllowedIds, resolveRoleRecipientIds } from './push.js'

describe('sendPush — ANDROID-VIS.1 token-less device rows (mig 565)', () => {
  it('never sends to a device row whose expo_push_token is NULL', async () => {
    // Since mig 565 a row can exist purely so the fleet report can see the
    // device (every Android device, until FCM credentials exist). Sending
    // `to: null` would come back as a per-ticket error and be counted as
    // `failed` — a lie about a send that was never possible.
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [{ profile_id: 'a', permissions: { mobile: { push_notifications: true } } }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: null }]

    const result = await sendPush(['a'], { title: 't', body: 'b' })
    expect(result).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 0 })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('still reaches the SAME user\'s other device that does have a token', async () => {
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [{ profile_id: 'a', permissions: { mobile: { push_notifications: true } } }]
    fakeTokens = [
      { id: 't1', user_id: 'a', expo_push_token: null },
      { id: 't2', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' },
    ]

    const result = await sendPush(['a'], { title: 't', body: 'b' })
    expect(result.sent).toBe(1)
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body).toHaveLength(1)
    expect(body[0].to).toBe('ExponentPushToken[x]')
  })
})

describe('sendPush — permission filtering (reads profile_locations, mig 058)', () => {
  it('returns zero counts when no userIds are passed', async () => {
    const result = await sendPush([], { title: 't', body: 'b' })
    expect(result).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 0 })
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

  it('requireMobileKey gates on an extra capability (AGENT-ACTIVITY.1 inbox access) beyond the category', async () => {
    // Category flag on, but no WhatsApp inbox access → no "chatting with Mia" ping.
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [{ profile_id: 'a', location_id: 'loc1', role: 'owner', permissions: { mobile: { push_notifications: true, notify_agent_activity: true, whatsapp: false } } }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'agent_activity' }, { requireMobileKey: 'whatsapp' })
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('requireMobileKey allows a user who holds the capability', async () => {
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [{ profile_id: 'a', location_id: 'loc1', role: 'owner', permissions: { mobile: { push_notifications: true, notify_agent_activity: true, whatsapp: true } } }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'agent_activity' }, { requireMobileKey: 'whatsapp' })
    expect(result.sent).toBe(1)
  })

  it('missing keys resolve to the ROLE default (owner: notify_lead defaults on → send)', async () => {
    // PERM-AUDIT.3 — a SPARSE blob (no explicit keys) falls through
    // to the role code default instead of the old "missing = send".
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [{ profile_id: 'a', location_id: 'loc1', role: 'owner', permissions: {} }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'lead' })
    expect(result.sent).toBe(1)
  })

  it('missing keys resolve to the ROLE default (staff: notify_lead defaults off → suppressed)', async () => {
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [{ profile_id: 'a', location_id: 'loc1', role: 'staff', permissions: {} }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'lead' })
    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('IGNORES stale profiles.permissions — only profile_locations gates (the mig-058 regression)', async () => {
    // The opt-out lives ONLY on the stale profiles.permissions; the live
    // profile_locations row is clean. Pre-fix this user was wrongly skipped.
    fakeProfiles = [{ id: 'a', active: true, permissions: { mobile: { notify_lead: false } } }]
    fakeLinks = [{ profile_id: 'a', location_id: 'loc1', role: 'manager', permissions: { mobile: { push_notifications: true } } }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]

    const result = await sendPush(['a'], { title: 't', body: 'b', category: 'lead' })
    expect(result.sent).toBe(1)
    expect(result.skipped).toBe(0)
  })

  it('role template (mig 364) flips a role default; per-user override still wins', async () => {
    fakeProfiles = [{ id: 'a', active: true }, { id: 'b', active: true }]
    // Both staff at loc1 (notify_lead default OFF). Template turns it ON.
    // User b additionally carries an explicit per-user opt-OUT.
    fakeTemplates = [{ location_id: 'loc1', role: 'staff', employment_type: 'all', permissions: { mobile: { notify_lead: true } } }]
    fakeLinks = [
      { profile_id: 'a', location_id: 'loc1', role: 'staff', permissions: {} },
      { profile_id: 'b', location_id: 'loc1', role: 'staff', permissions: { mobile: { notify_lead: false } } },
    ]
    fakeTokens = [
      { id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' },
      { id: 't2', user_id: 'b', expo_push_token: 'ExponentPushToken[y]' },
    ]

    const result = await sendPush(['a', 'b'], { title: 't', body: 'b', category: 'lead' })
    expect(result.sent).toBe(1)    // a — template on
    expect(result.skipped).toBe(1) // b — explicit user opt-out beats template
  })

  it('employment-type variant (mig 367) only applies to matching users', async () => {
    // Contractor variant turns notify_lead ON for staff at loc1. The
    // contractor gets it; the FTE stays at the staff default (off).
    fakeProfiles = [
      { id: 'a', active: true, employment_type: 'contractor' },
      { id: 'b', active: true, employment_type: 'fte' },
    ]
    fakeTemplates = [
      { location_id: 'loc1', role: 'staff', employment_type: 'contractor', permissions: { mobile: { notify_lead: true } } },
    ]
    fakeLinks = [
      { profile_id: 'a', location_id: 'loc1', role: 'staff', permissions: {} },
      { profile_id: 'b', location_id: 'loc1', role: 'staff', permissions: {} },
    ]
    fakeTokens = [
      { id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' },
      { id: 't2', user_id: 'b', expo_push_token: 'ExponentPushToken[y]' },
    ]

    const result = await sendPush(['a', 'b'], { title: 't', body: 'b', category: 'lead' })
    expect(result.sent).toBe(1)    // a — contractor variant on
    expect(result.skipped).toBe(1) // b — fte, staff default off
  })

  it('honours an opt-out set on ANY assignment (conservative, multi-location)', async () => {
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [
      { profile_id: 'a', location_id: 'loc1', role: 'owner', permissions: { mobile: { notify_lead: false } } },
      { profile_id: 'a', location_id: 'loc2', role: 'owner', permissions: { mobile: {} } },
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
    expect(result.failed).toBe(0) // DeviceNotRegistered is handled, not a pipeline failure
    expect(deletedTokenIds).toContain('t-bad')
  })
})

describe('sendPush — Expo failure handling (retry + failed count)', () => {
  // All the retry tests run on fake timers so the 500ms/2s backoff
  // doesn't slow the suite down.
  const allowUser = () => {
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = [{ profile_id: 'a', permissions: { mobile: { push_notifications: true } } }]
    fakeTokens = [{ id: 't1', user_id: 'a', expo_push_token: 'ExponentPushToken[x]' }]
  }
  const okResponse = { ok: true, json: async () => ({ data: [{ status: 'ok' }] }) }

  async function runWithFakeTimers(fn) {
    vi.useFakeTimers()
    try {
      const p = fn()
      await vi.runAllTimersAsync()
      return await p
    } finally {
      vi.useRealTimers()
    }
  }

  it('retries a 429 and succeeds on the second attempt', async () => {
    allowUser()
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValueOnce(okResponse)

    const result = await runWithFakeTimers(() => sendPush(['a'], { title: 't', body: 'b' }))
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(0)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('retries a fetch exception and a 500, then succeeds on the third attempt', async () => {
    allowUser()
    global.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValueOnce(okResponse)

    const result = await runWithFakeTimers(() => sendPush(['a'], { title: 't', body: 'b' }))
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(0)
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  it('gives up after 3 attempts and counts the batch as failed', async () => {
    allowUser()
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'))

    const result = await runWithFakeTimers(() => sendPush(['a'], { title: 't', body: 'b' }))
    expect(result.sent).toBe(0)
    expect(result.failed).toBe(1)
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry a non-429 4xx (bad request will not get better)', async () => {
    allowUser()
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' })

    const result = await sendPush(['a'], { title: 't', body: 'b' })
    expect(result.sent).toBe(0)
    expect(result.failed).toBe(1)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('counts an unparseable 2xx response as failed (was a silent no-op)', async () => {
    allowUser()
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('not json') } })

    const result = await runWithFakeTimers(() => sendPush(['a'], { title: 't', body: 'b' }))
    expect(result.sent).toBe(0)
    expect(result.failed).toBe(1)
    expect(global.fetch).toHaveBeenCalledTimes(3) // unparseable is retried — could be a proxy blip
  })

  it('counts non-DeviceNotRegistered ticket errors as failed without pruning', async () => {
    allowUser()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: 'error', details: { error: 'MessageTooBig' } }] }),
    })

    const result = await sendPush(['a'], { title: 't', body: 'b' })
    expect(result.sent).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.invalidated).toBe(0)
    expect(deletedTokenIds).toHaveLength(0)
  })
})

describe('resolvePushAllowedIds', () => {
  it('reads profile_locations and ignores stale profiles.permissions', async () => {
    fakeProfiles = [{ id: 'a', active: true, permissions: { mobile: { notify_lead: false } } }]
    fakeLinks = [{ profile_id: 'a', location_id: 'loc1', role: 'owner', permissions: { mobile: {} } }]
    const allowed = await resolvePushAllowedIds(makeFakeDb(), ['a'], 'lead')
    expect(allowed.has('a')).toBe(true)
  })

  it('suppresses an inactive user regardless of permissions', async () => {
    fakeProfiles = [{ id: 'a', active: false }]
    fakeLinks = [{ profile_id: 'a', location_id: 'loc1', role: 'owner', permissions: { mobile: {} } }]
    const allowed = await resolvePushAllowedIds(makeFakeDb(), ['a'], 'lead')
    expect(allowed.has('a')).toBe(false)
  })

  it('allows a user with NO assignments (master has no profile_locations rows)', async () => {
    fakeProfiles = [{ id: 'a', active: true }]
    fakeLinks = []
    const allowed = await resolvePushAllowedIds(makeFakeDb(), ['a'], 'lead')
    expect(allowed.has('a')).toBe(true)
  })

  it('returns an empty set for no ids', async () => {
    const allowed = await resolvePushAllowedIds(makeFakeDb(), [], 'lead')
    expect(allowed.size).toBe(0)
  })
})

// PUSH-LOC.1 — the notification's location decides the per-category gate.
describe('resolvePushAllowedIds — per-location gating', () => {
  // Richard's live case: owner at Stillorgan (role default notify_whatsapp
  // ON) + staff at SourceIt (role default OFF). The staff row must not eat
  // Stillorgan's WhatsApp pushes.
  const richardLinks = () => {
    fakeProfiles = [{ id: 'r', active: true }]
    fakeLinks = [
      { profile_id: 'r', location_id: 'stillorgan', role: 'owner', permissions: null },
      { profile_id: 'r', location_id: 'sourceit', role: 'staff', permissions: null },
    ]
  }

  it('allows a Stillorgan WhatsApp push despite a staff role elsewhere', async () => {
    richardLinks()
    const allowed = await resolvePushAllowedIds(makeFakeDb(), ['r'], 'whatsapp', { locationId: 'stillorgan' })
    expect(allowed.has('r')).toBe(true)
  })

  it('still suppresses a push AT the location whose role default is off', async () => {
    richardLinks()
    const allowed = await resolvePushAllowedIds(makeFakeDb(), ['r'], 'whatsapp', { locationId: 'sourceit' })
    expect(allowed.has('r')).toBe(false)
  })

  it('without a locationId the conservative any-assignment rule still applies', async () => {
    richardLinks()
    const allowed = await resolvePushAllowedIds(makeFakeDb(), ['r'], 'whatsapp')
    expect(allowed.has('r')).toBe(false)
  })

  it('a user with NO assignment at the given location falls back to all assignments', async () => {
    fakeProfiles = [{ id: 'r', active: true }]
    fakeLinks = [{ profile_id: 'r', location_id: 'sourceit', role: 'staff', permissions: null }]
    const allowed = await resolvePushAllowedIds(makeFakeDb(), ['r'], 'whatsapp', { locationId: 'stillorgan' })
    expect(allowed.has('r')).toBe(false)
  })

  it('an explicit per-user override at the location wins over its role default', async () => {
    fakeProfiles = [{ id: 'r', active: true }]
    fakeLinks = [
      { profile_id: 'r', location_id: 'sourceit', role: 'staff', permissions: { mobile: { notify_whatsapp: true } } },
    ]
    const allowed = await resolvePushAllowedIds(makeFakeDb(), ['r'], 'whatsapp', { locationId: 'sourceit' })
    expect(allowed.has('r')).toBe(true)
  })
})

describe('resolveRoleRecipientIds — per-location role + master inclusion (PUSH-ROLES.1)', () => {
  const db = {
    from: () => ({
      select: () => ({
        eq: async () => ({
          data: [
            { profile_id: 'richard', role: 'owner', profiles: { id: 'richard', role: 'master', active: true } },
            { profile_id: 'garrett', role: 'owner', profiles: { id: 'garrett', role: 'owner', active: true } },
            { profile_id: 'james', role: 'staff', profiles: { id: 'james', role: 'staff', active: true } },
            { profile_id: 'gone', role: 'owner', profiles: { id: 'gone', role: 'owner', active: false } },
            { profile_id: 'demoted', role: 'staff', profiles: { id: 'demoted', role: 'owner', active: true } },
          ],
          error: null,
        }),
      }),
    }),
  }

  it('judges the PER-LOCATION role, not the stale global profiles.role', async () => {
    const ids = await resolveRoleRecipientIds(db, 'loc1', ['owner', 'manager'])
    expect(ids).toContain('garrett')
    expect(ids).not.toContain('demoted')
    expect(ids).not.toContain('james')
    expect(ids).not.toContain('gone')
  })

  it('always includes active masters assigned to the location (they hold every decision right)', async () => {
    const ids = await resolveRoleRecipientIds(db, 'loc1', ['owner', 'manager'])
    expect(ids).toContain('richard')
  })
})
