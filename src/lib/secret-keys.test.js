// SECFIX.3a — the one JS copy of mig 647's secret-key rule, and the deep
// masker every browser-bound location / connection row goes through.
// Fictional values only (the repo is public): every secret starts SYNTH-.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  SECRET_KEY_PATTERN, SECRET_KEY_EXACT, SECRET_MASK, SECRET_WALK_MAX_DEPTH,
  isSecretKeyName, maskSecretKeysDeep,
} from './secret-keys.js'
import {
  KNOWN_SECRET_NAMES, KNOWN_NOT_SECRET_NAMES, KNOWN_MASKED_LOOKALIKES,
} from '../../tests/helpers/audit-secret-keys.js'

const MIG_647 = readFileSync(
  path.resolve(import.meta.dirname, '../../supabase/migrations/647_audit_redact_secrets.sql'),
  'utf8',
)

describe('the rule is mig 647\'s, character for character', () => {
  it('the regex text is the one private.audit_is_secret_key() applies', () => {
    const m = MIG_647.match(/lower\(p_key\) ~ '([^']+)'/)
    expect(m).not.toBeNull()
    expect(m[1]).toBe(SECRET_KEY_PATTERN)
  })

  it('the exact names are the migration\'s in-list', () => {
    const m = MIG_647.match(/lower\(p_key\) in \(([^)]+)\)/)
    expect(m).not.toBeNull()
    const names = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
    expect(names).toEqual([...SECRET_KEY_EXACT])
  })

  it('agrees with every name the audit census pinned', () => {
    for (const n of KNOWN_SECRET_NAMES) expect([n, isSecretKeyName(n)]).toEqual([n, true])
    for (const n of KNOWN_MASKED_LOOKALIKES) expect([n, isSecretKeyName(n)]).toEqual([n, true])
    for (const n of KNOWN_NOT_SECRET_NAMES) expect([n, isSecretKeyName(n)]).toEqual([n, false])
    expect(isSecretKeyName('Glofox_Api_Token')).toBe(true) // lowercased first
    expect(isSecretKeyName(null)).toBe(false)
  })
})

describe('maskSecretKeysDeep', () => {
  it('masks every secret-named key at any depth, arrays included, and nothing else', () => {
    const doc = {
      host: 'u.example',
      glofox: { branch_id: 'b1', api_key: 'SYNTH-1', nested: { deeper: { webhookSecret: 'SYNTH-2', label: 'x' } } },
      cards: [{ label: 'Cards', access_token: 'SYNTH-3' }, 'plain'],
      bca_config: { send_from: 'a@example.com' },
      tokens: ['SYNTH-4'],
      pin: 1234,
    }
    const out = maskSecretKeysDeep(doc)
    expect(out).toEqual({
      host: 'u.example',
      glofox: { branch_id: 'b1', api_key: SECRET_MASK, nested: { deeper: { webhookSecret: SECRET_MASK, label: 'x' } } },
      cards: [{ label: 'Cards', access_token: SECRET_MASK }, 'plain'],
      bca_config: SECRET_MASK,
      tokens: SECRET_MASK,
      pin: SECRET_MASK,
    })
    expect(JSON.stringify(out)).not.toMatch(/SYNTH-|1234/)
  })

  it('keeps absence visible: null, "", whitespace and booleans are left as they are', () => {
    const doc = { api_key: null, api_token: '', webhook_secret: '  ', has_token: false, hasApiToken: true }
    expect(maskSecretKeysDeep(doc)).toBe(doc)
  })

  it('returns the SAME object when nothing is masked, and never mutates its input', () => {
    const plain = { a: { b: [1, { c: 'd' }] } }
    expect(maskSecretKeysDeep(plain)).toBe(plain)
    const doc = Object.freeze({ keep: Object.freeze({ x: 1 }), s: Object.freeze({ api_token: 'SYNTH-5' }) })
    const out = maskSecretKeysDeep(doc)
    expect(doc.s.api_token).toBe('SYNTH-5')
    expect(out.keep).toBe(doc.keep) // untouched branches are shared, not copied
  })

  it(`stops at depth ${SECRET_WALK_MAX_DEPTH}: a container that deep is masked whole`, () => {
    let deep = { api_token: 'SYNTH-DEEP', note: 'x' }
    for (let i = 0; i < SECRET_WALK_MAX_DEPTH + 3; i += 1) deep = { level: deep }
    const out = maskSecretKeysDeep(deep)
    expect(JSON.stringify(out)).not.toMatch(/SYNTH-/)
    let node = out
    let depth = 0
    while (node && typeof node === 'object') { node = node.level; depth += 1 }
    expect(node).toBe(SECRET_MASK)
    expect(depth).toBe(SECRET_WALK_MAX_DEPTH)
  })

  it('passes non-containers through', () => {
    expect(maskSecretKeysDeep(null)).toBeNull()
    expect(maskSecretKeysDeep('api_token')).toBe('api_token')
    expect(maskSecretKeysDeep(7)).toBe(7)
  })
})
