// Smoke test — imports every new file added for mobile support and
// confirms they parse, their imports resolve, and they export the
// expected shape. Catches "missing import" / "typo in named export" /
// "broken Zod schema" issues short of a full Next.js build.
//
// Not a behavioural test — push.test.js covers behaviour. This file
// exists so a 1.5s `npm test` run flags structural breakage instantly.

import { describe, it, expect } from 'vitest'

describe('mobile additions — module shape smoke test', () => {
  it('src/lib/push.js exports sendPush + sendPushToRolesAtLocation', async () => {
    const mod = await import('./push.js')
    expect(typeof mod.sendPush).toBe('function')
    expect(typeof mod.sendPushToRolesAtLocation).toBe('function')
  })

  it('src/lib/auth.js still exports its previous surface AND parses the bearer-aware version', async () => {
    const mod = await import('./auth.js')
    expect(typeof mod.createAuthClient).toBe('function')
    expect(typeof mod.getCurrentUser).toBe('function')
    expect(typeof mod.getUserLocationIds).toBe('function')
    expect(typeof mod.assertLocationAccess).toBe('function')
  })

  it('/api/mobile/me route module exports a GET handler', async () => {
    const mod = await import('../app/api/mobile/me/route.js')
    expect(typeof mod.GET).toBe('function')
    expect(mod.runtime).toBe('nodejs')
  })

  it('/api/mobile/device-tokens route exports POST + DELETE', async () => {
    const mod = await import('../app/api/mobile/device-tokens/route.js')
    expect(typeof mod.POST).toBe('function')
    expect(typeof mod.DELETE).toBe('function')
    expect(mod.runtime).toBe('nodejs')
  })
})
