// MCPBEARER.1 guard: an OAuth-issued token (a Bearer JWT carrying `client_id`)
// opens /api/mcp ONLY. Two places refuse it everywhere else: src/proxy.js on
// every /api path but /api/mcp, and getCurrentUser() (src/lib/auth.js) on every
// path, so a route the proxy leaves public cannot be reached with one either.
// The single resolver that accepts one is getCurrentUserForMcp(), and only the
// MCP door (verifyMcpToken in src/lib/mcp/auth.js) may call it. This guard:
//
//  1. fails any file outside the allow-list that names getCurrentUserForMcp;
//  2. pins the refusal inside getUserFromBearer (the opt-in defaults to off);
//  3. pins that getCurrentUser() resolves with allowOAuthToken: false.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..')
const ALLOWED = new Set([
  'src/lib/auth.js',
  'src/lib/auth.getCurrentUser.test.js',
  'src/lib/mcp/auth.js',
  'src/lib/mcp/auth.test.js',
  'tests/oauth-token-reach-guard.test.js',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

describe('OAuth-issued tokens reach /api/mcp only (MCPBEARER.1)', () => {
  it('only the MCP door names getCurrentUserForMcp', () => {
    const offenders = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tests')), ...walk(join(ROOT, 'shared'))]
      .map((f) => relative(ROOT, f))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => readFileSync(join(ROOT, rel), 'utf8').includes('getCurrentUserForMcp'))
    expect(offenders).toEqual([])
  })

  const auth = readFileSync(join(ROOT, 'src/lib/auth.js'), 'utf8')

  it('getUserFromBearer refuses a client_id token unless the caller opts in, and the opt-in defaults off', () => {
    expect(auth).toMatch(/async function getUserFromBearer\(\{ allowOAuthToken = false \} = \{\}\)/)
    expect(auth).toMatch(/if \(!allowOAuthToken && jwtClientId\(token\)\) return null/)
  })

  it('getCurrentUser() resolves with allowOAuthToken: false', () => {
    expect(auth).toMatch(/export const getCurrentUser = cache\(function getCurrentUser\(\) \{\s*return resolveCurrentUser\(\{ allowOAuthToken: false \}\)/)
  })
})
