#!/usr/bin/env node
// check-secrets — Phase 0b of the Repset merge program.
//
// WHY: the two mobile apps (un1t-crm staff app + champ-app member app) are
// merging into ONE binary. After that, staff-app JS ships to every member
// phone — so nothing secret-shaped may live under mobile/** or shared/**.
// Precedent: a hardcoded review-login gate code shipped in a bundle and had
// to be burned (see memory: review-login-harden).
//
// WHAT: scans git-TRACKED files under mobile/ and shared/ (via `git ls-files`,
// so gitignored local keys like mobile/.env are deliberately NOT findings) for:
//   - PEM private-key blocks
//   - tracked key-material files by extension (.p8 .p12 .pem .keystore .jks)
//   - Stripe secret keys (sk_live_/sk_test_)
//   - AWS access key ids (AKIA…)
//   - Supabase SERVICE-ROLE JWTs — the payload's role claim is DECODED and
//     checked; the anon key (role "anon") is committed intentionally and must
//     never be flagged, so do not "fix" this into a match-all-JWTs rule
//   - GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
//   - hardcoded gate codes: 6-10 digit literals assigned to (or compared
//     against) identifiers matching /(code|secret|pin|password|token)/i,
//     excluding test/fixture files and obvious non-secret identifiers
//     (statusCode, charCode, maxTokens, …)
//
// FALSE POSITIVES: confirmed-intentional findings go in
// scripts/check-secrets-allowlist.txt (path or path:line per line) WITH a
// justification comment. Never allowlist an actual credential — rotate it.
//
// Runs in CI as `npm run check:secrets` (web-ci.yml). Matchers are exported
// for the fixture-driven tests in tests/check-secrets.test.js.
//
// NOTE: uses execFileSync with a fixed argv (no shell) — nothing
// user-controlled is interpolated into a command line.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Matchers (pure; exported for tests)
// ---------------------------------------------------------------------------

export const KEY_FILE_EXTENSIONS = ['.p8', '.p12', '.pem', '.keystore', '.jks']

// Extensions we never content-scan (binary; a NUL-byte check below catches
// anything this list misses).
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svgz',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.mp3', '.mp4', '.mov', '.wav', '.m4a',
  '.pdf', '.zip', '.jar', '.bin', '.wasm',
])

const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
const STRIPE_RE = /\bsk_(live|test)_[A-Za-z0-9]{16,}/g
const AWS_RE = /\bAKIA[0-9A-Z]{16}\b/g
const GITHUB_RE = /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g
// Three base64url segments, first one starting eyJ ('{"' in base64) — i.e. a
// JWT literal. The role check below decides whether it's a finding.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g

// Gate-code rule: identifier [:=/===] 6-10 digit literal (quoted or bare).
// Comparisons are included on purpose — the burned review-login precedent is
// exactly `if (code === '…')`. Bare numbers must not be a slice of a longer
// number or a decimal.
const GATE_RE =
  /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|={1,3})\s*(?:(['"`])(\d{6,10})\2|(\d{6,10})(?![\d.]))/g
const GATE_IDENT_RE = /(code|secret|pin|password|token)/i
// Identifiers that contain a gate keyword but are obviously not secrets.
const NON_SECRET_IDENT_RE =
  /((status|error|http|exit|response|result|char|key|country|currency|language|locale|region|area|dial|zip|postal|color|colour|bar|qr|time)_?code|max_?tokens?|num_?tokens?)$/i

const matchAll = (re, text) => {
  const out = []
  re.lastIndex = 0
  for (let m; (m = re.exec(text)); ) out.push({ index: m.index, match: m })
  return out
}

export const findPemBlocks = (text) => matchAll(PEM_RE, text)
export const findStripeKeys = (text) => matchAll(STRIPE_RE, text)
export const findAwsKeys = (text) => matchAll(AWS_RE, text)
export const findGithubTokens = (text) => matchAll(GITHUB_RE, text)

// Decode a JWT's payload segment; null when it isn't decodable utf8.
const decodeJwtPayload = (token) => {
  const seg = token.split('.')[1]
  try {
    return Buffer.from(seg, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

export const findServiceRoleJwts = (text) =>
  matchAll(JWT_RE, text).filter((hit) => {
    const payload = decodeJwtPayload(hit.match[0])
    return payload !== null && payload.includes('service_role')
  })

export const findGateCodes = (text) =>
  matchAll(GATE_RE, text).filter(({ match }) => {
    const ident = match[1]
    return GATE_IDENT_RE.test(ident) && !NON_SECRET_IDENT_RE.test(ident)
  })

export const isKeyFilePath = (relPath) =>
  KEY_FILE_EXTENSIONS.includes(path.extname(relPath).toLowerCase())

// Test/fixture files are exempt from the GATE-CODE rule only — fixture pins
// are fine; a service-role key in a test file is still a leak.
export const isGateRuleExempt = (relPath) =>
  /\.(test|spec)\.[jt]sx?$/.test(relPath) ||
  relPath.split('/').some((seg) => seg === '__tests__' || seg === '__fixtures__')

const CONTENT_RULES = [
  { rule: 'pem-private-key', find: findPemBlocks },
  { rule: 'stripe-secret-key', find: findStripeKeys },
  { rule: 'aws-access-key-id', find: findAwsKeys },
  { rule: 'service-role-jwt', find: findServiceRoleJwts },
  { rule: 'github-token', find: findGithubTokens },
  { rule: 'gate-code', find: findGateCodes, exempt: isGateRuleExempt },
]

const lineOf = (text, index) => {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

// Findings echo enough to locate the hit, never the whole secret.
const redact = (s) => (s.length <= 12 ? s : `${s.slice(0, 10)}…`)

export function scanFileText(relPath, text) {
  const findings = []
  for (const { rule, find, exempt } of CONTENT_RULES) {
    if (exempt?.(relPath)) continue
    for (const hit of find(text)) {
      findings.push({ path: relPath, line: lineOf(text, hit.index), rule, detail: redact(hit.match[0]) })
    }
  }
  findings.sort((a, b) => a.line - b.line)
  return findings
}

export function parseAllowlist(text) {
  return new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  )
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: scriptDir,
    encoding: 'utf8',
  }).trim()

  const files = execFileSync('git', ['ls-files', '-z', '--', 'mobile', 'shared'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)

  const allowlistPath = path.join(scriptDir, 'check-secrets-allowlist.txt')
  const allowlist = existsSync(allowlistPath)
    ? parseAllowlist(readFileSync(allowlistPath, 'utf8'))
    : new Set()
  const usedEntries = new Set()

  const findings = []
  for (const relPath of files) {
    if (isKeyFilePath(relPath)) {
      findings.push({
        path: relPath,
        line: 0,
        rule: 'key-material-file',
        detail: `tracked key-material file (${path.extname(relPath).toLowerCase()})`,
      })
      continue // key files are the finding; no content scan needed
    }
    if (BINARY_EXTENSIONS.has(path.extname(relPath).toLowerCase())) continue
    let text
    try {
      text = readFileSync(path.join(repoRoot, relPath), 'utf8')
    } catch {
      continue // deleted-but-staged etc.
    }
    if (text.includes('\0')) continue // binary content the extension list missed
    findings.push(...scanFileText(relPath, text))
  }

  const active = []
  for (const f of findings) {
    const fileKey = f.path
    const lineKey = `${f.path}:${f.line}`
    const matched = allowlist.has(fileKey) ? fileKey : allowlist.has(lineKey) ? lineKey : null
    if (matched) usedEntries.add(matched)
    else active.push(f)
  }

  const suppressed = findings.length - active.length
  const stale = [...allowlist].filter((e) => !usedEntries.has(e))

  if (suppressed > 0) {
    console.log(`check-secrets: ${suppressed} allowlisted finding(s) suppressed (see scripts/check-secrets-allowlist.txt)`)
  }
  for (const e of stale) {
    console.warn(`check-secrets: WARNING stale allowlist entry (matched nothing): ${e}`)
  }

  if (active.length === 0) {
    console.log(`check-secrets: OK — ${files.length} tracked files under mobile/ + shared/, no secret-shaped findings.`)
    return
  }

  console.error(`check-secrets: ${active.length} secret-shaped finding(s) in mobile/ + shared/:\n`)
  for (const f of active) {
    console.error(`  ${f.path}${f.line ? `:${f.line}` : ''}  [${f.rule}]  ${f.detail}`)
  }
  console.error(
    '\nNothing secret-shaped may ship in the mobile bundle (Repset Phase 0b).\n' +
      'If a finding is a REAL credential: remove it, rotate it, and load it from env/EAS secrets.\n' +
      'If it is a confirmed false positive: add `path` or `path:line` to\n' +
      'scripts/check-secrets-allowlist.txt with a justification comment.',
  )
  process.exitCode = 1
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
