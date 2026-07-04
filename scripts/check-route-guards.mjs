#!/usr/bin/env node
// Route-guard presence lint (AUDIT-JUN10 follow-up).
//
// Fails CI when an /api route ships without an auth guard. This is the
// structural fix for the #408 class of bug — routes with ZERO auth
// (whatsapp broadcast send, conversation detail) sailed through review
// because nothing in the pipeline checks that a route guards itself.
// Middleware only proves "some valid session/JWT exists" — and champ-app
// customers hold valid JWTs on the same Supabase project — so every
// non-public route must resolve + authorize the caller itself.
//
// Model (token-presence heuristic, same spirit as check-mobile-parity):
//   /api/public/**    exempt by path — public by design (rate limits are
//                     reviewed per-route, not enforced here).
//   /api/webhooks/**  must call a verify*() signature/secret check.
//   /api/cron/**      must reference CRON_SECRET (Vercel cron bearer).
//   everything else   must call one of SESSION_GUARDS — either a direct
//                     resolver (getCurrentUser/withAuth) or one of the
//                     VERIFIED delegated-auth helpers listed below.
//   EXEMPT            path → mandatory reason, for routes whose lack of a
//                     guard is by design (capability-token URLs etc.).
//
// This is a tripwire, not a prover: it catches "forgot auth entirely"
// (the actual shipped bug class), not "called getCurrentUser but skipped
// the role check". Listing a helper in SESSION_GUARDS asserts you've READ
// it and it both authenticates AND authorizes — don't add names blind.

import fs from 'node:fs'
import path from 'node:path'

const API_ROOT = 'src/app/api'

// Direct resolvers + verified delegated-auth helpers. Each delegated
// entry names the file where it was verified to enforce auth:
//   authenticateApiKey   src/lib/api-auth.js (per-org API key, n8n surface)
//   requireApiKeyOrManager src/lib/api-auth.js (constant-time API key OR
//                        getCurrentUser + MANAGER_ROLES — the dual-auth
//                        n8n/operator surface, e.g. /api/stages)
//   loadInvoiceForUser   src/app/api/invoices-inbox/_helpers.js
//                        (getCurrentUser + master/owner-at-location, 401/403/404)
//   loadBookkeeper       src/app/api/invoices-inbox/_bulk-helpers.js
//                        (getCurrentUser + hasPermission('bookkeeper'))
//   verifyBridgeToken    src/lib/bridge-auth.js (sha256 bearer vs ble_bridges)
//   @/lib/studio-session studio-device PIN cookie (heartbeat validates via
//                        refreshStudioSession; signout only clears the cookie)
const SESSION_GUARDS = [
  'getCurrentUser(',
  'withAuth(',
  'requireApiKey(',
  'authenticateApiKey(',
  'requireApiKeyOrManager(',
  'loadInvoiceForUser(',
  // loadLineForUser authenticates AND authorizes: getCurrentUser →
  // hasPermission('accounting_hub') → active-location scoping → 404-not-403
  // line lookup — verified in src/app/api/accounting/coverage/[id]/_line.js.
  // Used by the four per-line coverage action routes (ignore/unignore/
  // rehunt/upload).
  'loadLineForUser(',
  'loadBookkeeper(',
  'verifyBridgeToken(',
  "@/lib/studio-session",
  // resolveCustomerContact validates the member's Supabase JWT (getUser) AND
  // resolves + scopes to their contacts row — verified in src/lib/customer-auth.js.
  // Used by the customer-authed direct Apple Health endpoints (members, not staff).
  'resolveCustomerContact(',
]

// Webhooks authenticate the SENDER (HMAC / shared secret / provider
// signature). Matches verifyMetaSignature, verifySharedSecret,
// verifyTwilioSignature, verifyPostmarkRequest, verifyWebhookSignature,
// verifyXeroSignature, verifyGlofoxSignature, verifyUnifi*Request, etc.
const WEBHOOK_GUARD = /verify[A-Z][A-Za-z]*\(/

const CRON_GUARD = 'CRON_SECRET'

// Routes that are unguarded BY DESIGN. Reason is mandatory — it tells the
// next reader whether the entry is a real design decision or debt. A stale
// path here (file deleted/moved) fails the lint so the map can't rot.
const EXEMPT = {
  'src/app/api/openapi.json/route.js':
    'Spec read for any logged-in user — the middleware session gate is the auth (no tenant data; champ-app JWTs reading the spec is acceptable).',
  'src/app/api/unsubscribe/[token]/route.js':
    'Capability-token URL (per-contact unsubscribe token) + rate-limited — public by design, RFC 8058 one-click target.',
  'src/app/api/preferences/[token]/route.js':
    'Capability-token URL (per-contact preference token) + rate-limited — public by design.',
  'src/app/api/preferences/hr-emails/route.js':
    'Public one-click HR-email unsubscribe (flips a single boolean off) — public by design.',
  'src/app/api/webhooks/sequence/[token]/route.js':
    'URL token (32-hex, unguessable, per-sequence) + optional constant-time X-Webhook-Secret + 100/min rate limit — the token IS the credential.',
  'src/app/api/webhooks/strava/route.js':
    'Strava does not sign webhook POSTs; GET handshake verifies via STRAVA_WEBHOOK_VERIFY_TOKEN, POST acts only on known owner_ids + fetches with our own token',
  'src/app/api/whatsapp/flow/route.js':
    'WhatsApp Flow data-exchange endpoint — RSA/AES encryption is the credential (only Meta, holding our registered public key, can produce a request we can decrypt; 421 on failure). No tenant data is read before decrypt.',
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name === 'route.js') out.push(p)
  }
  return out
}

function classify(file) {
  const rel = file.split(path.sep).join('/')
  if (rel.includes('/api/public/')) return { ok: true, kind: 'public' }
  if (EXEMPT[rel]) return { ok: true, kind: 'exempt' }
  const src = fs.readFileSync(file, 'utf8')
  if (rel.includes('/api/webhooks/')) {
    return { ok: WEBHOOK_GUARD.test(src), kind: 'webhook' }
  }
  if (rel.includes('/api/cron/')) {
    return { ok: src.includes(CRON_GUARD), kind: 'cron' }
  }
  return { ok: SESSION_GUARDS.some((t) => src.includes(t)), kind: 'session' }
}

const files = walk(API_ROOT)
const failures = []
const counts = { public: 0, exempt: 0, webhook: 0, cron: 0, session: 0 }

for (const file of files) {
  const res = classify(file)
  counts[res.kind]++
  if (!res.ok) failures.push({ file, kind: res.kind })
}

// Stale-exemption check — an EXEMPT path whose file is gone means the map
// is rotting (route moved/deleted but the exemption lingered).
const stale = Object.keys(EXEMPT).filter((p) => !fs.existsSync(p))

if (failures.length === 0 && stale.length === 0) {
  console.log(
    `✓ route guards: ${files.length} routes — ` +
    `${counts.session} session-guarded, ${counts.cron} cron, ` +
    `${counts.webhook} webhook, ${counts.public} public, ${counts.exempt} exempt`
  )
  process.exit(0)
}

for (const f of failures) {
  console.error(`✗ UNGUARDED ${f.kind.toUpperCase()} ROUTE: ${f.file}`)
}
if (failures.length) {
  console.error(`
${failures.length} route(s) have no detectable auth guard. Fix by either:
  1. Adding a guard — getCurrentUser() + role/location checks (the standard
     route skeleton in CLAUDE.md), withAuth(), or authenticateApiKey() for
     the external API surface; verify*() for webhooks; CRON_SECRET for cron.
  2. Delegating to a shared auth helper — then ADD ITS NAME to
     SESSION_GUARDS in scripts/check-route-guards.mjs with a comment naming
     the file you verified it in. Only list helpers that BOTH authenticate
     and authorize.
  3. If the route is genuinely public by design (capability-token URL),
     adding it to EXEMPT with a reason — and a rate limit in the route.
`)
}
for (const p of stale) {
  console.error(`✗ STALE EXEMPTION (file no longer exists): ${p}`)
}
process.exit(1)
