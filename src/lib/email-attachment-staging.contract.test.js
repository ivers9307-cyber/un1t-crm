// EMAIL-INBOUND-SHIM.1 — the drift guard for the one duplication this feature
// could not avoid.
//
// WHY THIS FILE EXISTS
// The Edge Function is Deno and the Supabase CLI bundles only its own
// directory, so it cannot import src/lib. The writer half of the wire contract
// — the object-key scheme, the marker key, the limits — is therefore
// hand-mirrored in TypeScript. If the two sides drift, the failure is SILENT
// AND EXPENSIVE: the shim writes objects at one key and the route validates
// against another, so every attachment on every inbound email is recorded
// `rehost_failed` while its bytes sit in the bucket, metered by nothing.
//
// This suite reads the .ts source off disk and asserts the literals still
// agree. It cannot execute Deno — see the header of that file for what is and
// is not covered — but it does catch the one class of change that a reviewer
// looking at a JS diff would have no reason to connect to a TypeScript file.
//
// WHAT TO DO WHEN IT FAILS: change BOTH files, not just the one you were
// editing.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STAGED_MARKER_KEY, STAGED_MARKER_VERSION, STAGED_PREFIX } from './email-attachment-staging'
import {
  EMAIL_ATTACHMENT_BUCKET,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from './email-attachment-quota'
import { HTML_BODY_MAX_CHARS } from './email-inbox'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHIM_PATH = path.join(HERE, '../../supabase/functions/postmark-inbound-shim/index.ts')

const source = fs.readFileSync(SHIM_PATH, 'utf8')

/** The value of a `const NAME = <literal>` declaration in the Deno source. */
function declared(name) {
  const match = source.match(new RegExp(`^const ${name} = (.+?)(?: \\/\\/.*)?$`, 'm'))
  return match ? match[1].trim() : null
}

/** A numeric const, with JS numeric separators normalised away. */
function declaredNumber(name) {
  const raw = declared(name)
  return raw === null ? null : Number(raw.replace(/_/g, ''))
}

describe('the Edge Function mirrors the JS contract', () => {
  it('is where the deploy step expects it', () => {
    // `supabase functions deploy postmark-inbound-shim` resolves the entrypoint
    // by directory name; a rename here is a silent deploy of nothing.
    expect(fs.existsSync(SHIM_PATH)).toBe(true)
  })

  it('uses the same object-key prefix', () => {
    expect(declared('STAGED_PREFIX')).toBe(`'${STAGED_PREFIX}'`)
  })

  it('uses the same marker key and version', () => {
    expect(declared('STAGED_MARKER_KEY')).toBe(`'${STAGED_MARKER_KEY}'`)
    expect(declaredNumber('STAGED_MARKER_VERSION')).toBe(STAGED_MARKER_VERSION)
  })

  it('writes into the same bucket', () => {
    expect(declared('EMAIL_ATTACHMENT_BUCKET')).toBe(`'${EMAIL_ATTACHMENT_BUCKET}'`)
  })

  it('screens on the same per-file and per-message ceilings', () => {
    // A shim ceiling ABOVE the route's would upload files the route then
    // refuses, leaving bytes nothing points at; one BELOW would mark files
    // too_large that the bucket would happily have taken.
    expect(declaredNumber('MAX_ATTACHMENT_BYTES')).toBe(MAX_ATTACHMENT_BYTES)
    expect(declaredNumber('MAX_ATTACHMENTS_PER_MESSAGE')).toBe(MAX_ATTACHMENTS_PER_MESSAGE)
  })

  it('truncates HtmlBody at exactly the ceiling the route already truncates to', () => {
    // This is what makes the shim's truncation LOSSLESS: anything past this is
    // discarded by truncateHtmlBody before the row is written anyway. A larger
    // value here would forward bytes for nothing; a smaller one would throw
    // away content the route would have stored.
    expect(declaredNumber('HTML_BODY_MAX_CHARS')).toBe(HTML_BODY_MAX_CHARS)
  })

  it('forwards to the route this repo actually serves', () => {
    expect(declared('FORWARD_PATH')).toBe("'/api/webhooks/postmark-inbound'")
    expect(fs.existsSync(path.join(HERE, '../app/api/webhooks/postmark-inbound/[token]/route.js')))
      .toBe(true)
  })
})

describe('the Edge Function keeps its deployment-critical properties', () => {
  it('has NO third-party imports', () => {
    // Zero imports is deliberate: a deploy can then never fail on a registry
    // fetch and a cold boot can never fail on a module resolver. If this ever
    // needs to change, it is a decision, not a drive-by.
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/from ['"](npm:|jsr:|https:)/)
  })

  it('never puts a secret in a log line', () => {
    // The token is in the URL, so the forward URL is a secret. Every console.*
    // call must use the redacted form.
    const logged = [...source.matchAll(/console\.(log|warn|error)\(([\s\S]*?)\n/g)]
      .map(m => m[2])
      .join('\n')
    expect(logged).not.toMatch(/forwardUrl/)
    expect(logged).not.toMatch(/serviceKey|primary\b|previous\b|urlToken/)
  })

  it('forwards with its OWN token, never the caller’s', () => {
    // Passing the caller's token through would make this an open relay for
    // probing the Vercel secret.
    expect(source).toMatch(/const forwardUrl = .*\$\{primary\}/)
    expect(source).not.toMatch(/const forwardUrl = .*\$\{urlToken\}/)
  })

  it('upserts, because the key is deterministic across a Postmark retry', () => {
    expect(source).toMatch(/'x-upsert': 'true'/)
  })

  it('relays the upstream status verbatim, so Postmark’s retry semantics hold', () => {
    expect(source).toMatch(/status: upstream\.status/)
  })
})
