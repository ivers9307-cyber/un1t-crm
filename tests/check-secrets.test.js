// Tests for scripts/check-secrets.mjs — the Phase 0b (Repset merge) secret
// scanner that gates mobile/** and shared/**. Once the two mobile apps merge
// into one binary, staff-app JS ships to every member phone, so nothing
// secret-shaped may live under those dirs.
//
// Fixtures are constructed IN-TEST (JWTs assembled from JSON payloads,
// key-shaped strings built with .repeat) — never paste a real-looking live
// key into this file.
import { describe, it, expect } from 'vitest'
import {
  findPemBlocks,
  findStripeKeys,
  findAwsKeys,
  findGithubTokens,
  findServiceRoleJwts,
  findGateCodes,
  isKeyFilePath,
  isGateRuleExempt,
  parseAllowlist,
  scanFileText,
} from '../scripts/check-secrets.mjs'

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url')
// Assemble a syntactically valid JWT from a payload object. The header's
// JSON encodes to a string starting with eyJ, like every real JWT.
const makeJwt = (payload) =>
  `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify(payload))}.${'x'.repeat(24)}`

describe('findPemBlocks', () => {
  it('flags PEM private key headers of every flavour', () => {
    expect(findPemBlocks('-----BEGIN PRIVATE KEY-----')).toHaveLength(1)
    expect(findPemBlocks('-----BEGIN RSA PRIVATE KEY-----')).toHaveLength(1)
    expect(findPemBlocks('-----BEGIN EC PRIVATE KEY-----')).toHaveLength(1)
    expect(findPemBlocks('-----BEGIN OPENSSH PRIVATE KEY-----')).toHaveLength(1)
  })
  it('ignores public certificates and public keys', () => {
    expect(findPemBlocks('-----BEGIN CERTIFICATE-----')).toHaveLength(0)
    expect(findPemBlocks('-----BEGIN PUBLIC KEY-----')).toHaveLength(0)
  })
})

describe('findStripeKeys', () => {
  it('flags sk_live_ and sk_test_ keys of realistic length', () => {
    expect(findStripeKeys(`key = "sk_live_${'a1B2'.repeat(6)}"`)).toHaveLength(1)
    expect(findStripeKeys(`key = "sk_test_${'a1B2'.repeat(6)}"`)).toHaveLength(1)
  })
  it('ignores short lookalikes and publishable keys', () => {
    expect(findStripeKeys('sk_live_short')).toHaveLength(0)
    expect(findStripeKeys(`pk_live_${'a1B2'.repeat(6)}`)).toHaveLength(0)
  })
})

describe('findAwsKeys', () => {
  it('flags AKIA access key ids (exactly 16 trailing chars)', () => {
    expect(findAwsKeys(`AKIA${'ABCD1234'.repeat(2)}`)).toHaveLength(1)
  })
  it('ignores too-short and embedded-in-longer-word forms', () => {
    expect(findAwsKeys('AKIAABC')).toHaveLength(0)
    expect(findAwsKeys(`XAKIA${'ABCD1234'.repeat(2)}`)).toHaveLength(0) // no word boundary before AKIA
  })
})

describe('findGithubTokens', () => {
  it('flags ghp/gho/ghu/ghs/ghr tokens', () => {
    for (const p of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
      expect(findGithubTokens(`${p}_${'aZ09'.repeat(9)}`)).toHaveLength(1)
    }
  })
  it('ignores short strings and other gh_ prefixes', () => {
    expect(findGithubTokens('ghp_tooshort')).toHaveLength(0)
    expect(findGithubTokens(`ghx_${'aZ09'.repeat(9)}`)).toHaveLength(0)
  })
})

describe('findServiceRoleJwts', () => {
  it('flags a JWT whose payload role is service_role', () => {
    const jwt = makeJwt({ iss: 'supabase', ref: 'examplerefxyz', role: 'service_role', iat: 1 })
    expect(findServiceRoleJwts(`const KEY = '${jwt}'`)).toHaveLength(1)
  })
  it('does NOT flag the anon key — committed intentionally', () => {
    const jwt = makeJwt({ iss: 'supabase', ref: 'examplerefxyz', role: 'anon', iat: 1 })
    expect(findServiceRoleJwts(`const KEY = '${jwt}'`)).toHaveLength(0)
  })
  it('ignores two-segment eyJ tokens (e.g. the check-in QR fixture) and undecodable payloads', () => {
    expect(findServiceRoleJwts('eyJlIjoiYWJjIiwiciI6IjEifQ.c2lnbmF0dXJl')).toHaveLength(0)
    expect(findServiceRoleJwts(`eyJab.${'!'.repeat(20)}.zz`)).toHaveLength(0)
    // Garbage base64 payload must not throw.
    expect(() => findServiceRoleJwts(`eyJabcdefgh.eyJabcdefgh.signaturepart`)).not.toThrow()
  })
})

describe('findGateCodes', () => {
  it('flags 6-10 digit literals assigned to secret-shaped identifiers', () => {
    expect(findGateCodes(`const GATE_CODE = '483920'`)).toHaveLength(1)
    expect(findGateCodes('pin: 1234567')).toHaveLength(1)
    expect(findGateCodes('let adminPassword = "0012345678"')).toHaveLength(1)
    expect(findGateCodes('this.secret = 999999')).toHaveLength(1)
  })
  it('flags hardcoded comparisons too (the burned review-login shape)', () => {
    expect(findGateCodes(`if (code === '123456') unlock()`)).toHaveLength(1)
  })
  it('ignores non-secret identifiers and out-of-range lengths', () => {
    expect(findGateCodes('statusCode = 200')).toHaveLength(0) // 3 digits
    expect(findGateCodes('const errorCode = 4045678')).toHaveLength(0) // excluded ident
    expect(findGateCodes(`countryCode = '353001'`)).toHaveLength(0)
    expect(findGateCodes('charCode: 128512')).toHaveLength(0)
    expect(findGateCodes('timeoutMs = 300000')).toHaveLength(0) // no secret keyword
    expect(findGateCodes(`const pin = '12345'`)).toHaveLength(0) // 5 digits
    expect(findGateCodes(`const pin = '12345678901'`)).toHaveLength(0) // 11 digits
    expect(findGateCodes('maxTokens = 128000')).toHaveLength(0)
    expect(findGateCodes('barcode = 501234567')).toHaveLength(0)
  })
  it('does not match digits inside longer numbers or decimals', () => {
    expect(findGateCodes('tokenBudget = 1234567.89')).toHaveLength(0)
    expect(findGateCodes('secretRatio = 123456789012')).toHaveLength(0)
  })
})

describe('isKeyFilePath', () => {
  it('flags tracked key-material extensions, case-insensitively', () => {
    for (const p of ['mobile/keys/k.p8', 'shared/a.p12', 'mobile/certs/c.pem', 'mobile/x.keystore', 'mobile/y.jks', 'mobile/z.PEM']) {
      expect(isKeyFilePath(p), p).toBe(true)
    }
  })
  it('ignores other extensions', () => {
    expect(isKeyFilePath('mobile/app.config.js')).toBe(false)
    expect(isKeyFilePath('mobile/readme.pemx')).toBe(false)
  })
})

describe('isGateRuleExempt', () => {
  it('exempts test and fixture paths from the gate-code rule only', () => {
    expect(isGateRuleExempt('mobile/lib/foo.test.js')).toBe(true)
    expect(isGateRuleExempt('shared/bar.spec.jsx')).toBe(true)
    expect(isGateRuleExempt('mobile/__tests__/baz.js')).toBe(true)
    expect(isGateRuleExempt('shared/__fixtures__/qux.js')).toBe(true)
    expect(isGateRuleExempt('mobile/lib/foo.js')).toBe(false)
  })
  it('scanFileText still applies the other rules inside test files', () => {
    const jwt = makeJwt({ role: 'service_role' })
    const findings = scanFileText('mobile/lib/foo.test.js', `const K='${jwt}'\nconst PIN='123456'`)
    expect(findings.map((f) => f.rule)).toEqual(['service-role-jwt'])
  })
})

describe('scanFileText', () => {
  it('reports rule ids and 1-based line numbers', () => {
    const text = ['const ok = 1', `const STRIPE = 'sk_live_${'a1B2'.repeat(6)}'`, '', '-----BEGIN RSA PRIVATE KEY-----'].join('\n')
    const findings = scanFileText('mobile/lib/pay.js', text)
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({ path: 'mobile/lib/pay.js', line: 2, rule: 'stripe-secret-key' })
    expect(findings[1]).toMatchObject({ line: 4, rule: 'pem-private-key' })
  })
  it('returns nothing for clean text', () => {
    expect(scanFileText('shared/util.js', 'export const anon = true')).toHaveLength(0)
  })
})

describe('parseAllowlist', () => {
  it('ignores comments and blanks; keeps path and path:line entries', () => {
    const set = parseAllowlist('# header\n\nmobile/certs/certificate.pem\nmobile/a.js:12\n  # indented comment\n')
    expect(set.has('mobile/certs/certificate.pem')).toBe(true)
    expect(set.has('mobile/a.js:12')).toBe(true)
    expect(set.size).toBe(2)
  })
})
