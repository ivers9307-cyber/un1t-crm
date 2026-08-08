// EMAIL-INBOUND-SHIM.1 — the Supabase Edge Function that fronts the Postmark
// inbound webhook so large attachments stop being rejected.
//
// Deploy:  supabase functions deploy postmark-inbound-shim --no-verify-jwt
// Postmark inbound URL:
//   https://<project-ref>.supabase.co/functions/v1/postmark-inbound-shim/<token>
//
// ══ THE PROBLEM ═════════════════════════════════════════════════════
// A Vercel function answers 413 FUNCTION_PAYLOAD_TOO_LARGE for any request
// body over ~4.5 MB, BEFORE the handler runs. Postmark base64-inlines inbound
// attachments in the JSON (~4/3 expansion) and accepts up to 35 MB of them, so
// anything past roughly 3.3 MB of attachment bytes never reached the webhook:
// Postmark saw a 413, retried, gave up, and the email was never filed at all.
// Gmail and Outlook both allow 25 MB attachments, so this rejected ordinary
// mail. It applied to every inbound email since the channel started — bodies
// included — attachments merely made it visible.
//
// ══ WHAT THIS IS, AND WHAT IT IS NOT ════════════════════════════════
// A BYTES-MOVER. It uploads each attachment's bytes straight into the private
// `email-attachments` bucket, replaces each `Content` with a reference, forwards
// the now-small JSON to the SAME Vercel route, and returns Postmark whatever
// that route returned — so Postmark's retry semantics are exactly what they
// were.
//
// IT DOES NOT FILE MAIL. Threading, mailbox routing, dedupe, ticket identity
// and the storage quota are subtle and hard-won, and they stay in exactly one
// place: src/app/api/webhooks/postmark-inbound/[token]/route.js and
// src/lib/email-attachments-server.js. Nothing here reads or writes a table.
//
// ══ THE WIRE CONTRACT LIVES IN JAVASCRIPT ═══════════════════════════
// src/lib/email-attachment-staging.js is the canonical, unit-tested definition
// of the key scheme and the marker. This file MIRRORS its writer half by hand,
// because a Deno function cannot import src/lib (different runtime, and the
// Supabase CLI bundles only this directory).
//
// THAT DUPLICATION IS TEST-GUARDED. src/lib/email-attachment-staging.contract.test.js
// reads THIS FILE off disk and asserts the constants below still match the JS
// module's. If you change a constant here or there, that test fails and names
// the other file. Do not "fix" it by editing only one side.
//
// ══ AUTH IS TWO HOPS, AND THE SHIM IS NOT A PROXY ═══════════════════
// Postmark cannot set custom headers on an inbound webhook, so the shared
// secret is in the URL path — the same pattern, and the same secret value, the
// Vercel route already uses.
//
// The incoming token is compared constant-time against this function's OWN
// env, and the forward is then built with this function's OWN primary token —
// never with whatever the caller sent. Passing the caller's token through
// would make this an open relay for probing the Vercel secret. Rotation works
// the same way it does on Vercel: PREVIOUS is accepted inbound, PRIMARY is
// always what goes out.
//
// Neither secret is ever logged, and the forward URL is only ever logged with
// its token replaced.
//
// ══ FAILURE MUST NOT LOSE MAIL ══════════════════════════════════════
// The governing rule of the route behind this now extends to the shim: if an
// upload fails, the message is FORWARDED ANYWAY with that attachment marked,
// so the route's existing `rehost_failed` path records a row an operator can
// see. A message is never dropped because a file could not be moved.
//
// ══ BUDGETS (150 MB memory, 2s CPU, 150s idle) ══════════════════════
// Worst case is Postmark's 35 MB inbound ceiling. Peak memory is the parsed
// payload (~35 MB of base64 strings) plus ONE decoded buffer at a time
// (≤ 25 MiB, because uploads are sequential, not concurrent) plus whatever the
// JSON parser holds transiently — roughly 95 MB against 150 MB.
//
// Two things keep that from being worse:
//   • `Content` is emptied on the parsed object AS EACH ATTACHMENT IS UPLOADED,
//     so the base64 strings become collectable during the loop rather than all
//     being held until the end;
//   • an attachment whose base64 length alone puts it past MAX_ATTACHMENT_BYTES
//     is refused WITHOUT DECODING — the one case that would otherwise allocate
//     a >25 MiB buffer never allocates one.
//
// CPU is one JSON.parse of ≤35 MB plus ≤26 MB of base64 decoding; the decode is
// atob() plus a byte-copy loop, which is the single hottest thing here. That is
// expected to land well inside 2s but it is not a comfortable margin, and it is
// the number to watch on the first genuinely large message.

// ── Contract constants — MIRRORED from src/lib/email-attachment-staging.js ──
// and from src/lib/email-attachment-quota.js. Guarded by
// src/lib/email-attachment-staging.contract.test.js.
const STAGED_PREFIX = 'inbound'
const STAGED_MARKER_KEY = '_un1t_staged'
const STAGED_MARKER_VERSION = 1
const EMAIL_ATTACHMENT_BUCKET = 'email-attachments'
const MAX_ATTACHMENT_BYTES = 26_214_400 // 25 MiB — the bucket's own file_size_limit
const MAX_ATTACHMENTS_PER_MESSAGE = 25
const HTML_BODY_MAX_CHARS = 300_000

// The route's own path. Stated here rather than made configurable so the
// forward target cannot be pointed somewhere else by an env var alone.
const FORWARD_PATH = '/api/webhooks/postmark-inbound'

// This function's own name, used only to recognise a request that stopped at
// the function root and carries no token.
const FUNCTION_NAME = 'postmark-inbound-shim'

// Vercel's hard ceiling. Only used to say something useful in the log when a
// payload is STILL too big after the attachments have been moved out.
const VERCEL_BODY_LIMIT_BYTES = 4_500_000

// A hung forward must not sit on the function's idle budget. Postmark's own
// read timeout is well under this; a timeout answers 504 and Postmark retries,
// which is exactly what a Postmark→Vercel timeout does today.
const FORWARD_TIMEOUT_MS = 30_000

// ── Types ───────────────────────────────────────────────────────────

interface PostmarkAttachment {
  Name?: string
  Content?: string
  ContentType?: string
  ContentLength?: number
  [key: string]: unknown
}

interface PostmarkInbound {
  MessageID?: string
  Attachments?: PostmarkAttachment[]
  HtmlBody?: string
  RawEmail?: string
  [key: string]: unknown
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Constant-time string compare. Mirrors safeEqual() in src/lib/webhook-auth.js,
 * including its behaviour on a length mismatch (false, without comparing).
 */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i += 1) diff |= ab[i] ^ bb[i]
  return diff === 0
}

const MIME_SHAPE = /^[a-z0-9!#$&^_.+-]{1,60}\/[a-z0-9!#$&^_.+-]{1,60}$/

/** Mirrors safeMimeType() in src/lib/email-attachment-quota.js. */
function safeMimeType(value: unknown): string {
  if (typeof value !== 'string') return 'application/octet-stream'
  const essence = value.split(';')[0].trim().toLowerCase()
  if (!MIME_SHAPE.test(essence)) return 'application/octet-stream'
  return essence.slice(0, 100)
}

/**
 * Mirrors attachmentExtension() in src/lib/email-attachment-quota.js.
 *
 * The route deliberately does NOT pin this character when it validates a
 * staged path (see stagedPathMatches) — a drift between the two runtimes here
 * must not turn a correctly-stored file into `rehost_failed`.
 */
function attachmentExtension(mime: string): string {
  const sub = mime.slice(mime.indexOf('/') + 1).replace(/[^a-z0-9]/g, '')
  if (!sub) return 'bin'
  if (sub === 'jpeg') return 'jpg'
  if (sub === 'plain') return 'txt'
  return sub.slice(0, 8)
}

const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

/** Mirrors stagedAttachmentPath() in src/lib/email-attachment-staging.js. */
function stagedAttachmentPath(postmarkMessageId: string, index: number, extension: string): string | null {
  if (!PATH_SEGMENT.test(postmarkMessageId)) return null
  if (!Number.isInteger(index) || index < 0 || index > 9999) return null
  const ext = /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'bin'
  return `${STAGED_PREFIX}/${postmarkMessageId}/${index}.${ext}`
}

/**
 * base64 → bytes, or null when there is nothing usable.
 *
 * atob() throws on any character outside the alphabet, and MIME base64 is
 * frequently line-wrapped. The whitespace strip is the retry rather than the
 * first move on purpose: it allocates another copy of a string that can be
 * 35 MB, and the common case (Postmark's JSON is unwrapped) never pays for it.
 */
function decodeBase64(content: string): Uint8Array | null {
  let binary: string
  try {
    binary = atob(content)
  } catch {
    try {
      binary = atob(content.replace(/\s+/g, ''))
    } catch {
      return null
    }
  }
  if (binary.length === 0) return null
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Upload straight to Storage's REST API.
 *
 * Deliberately NOT @supabase/supabase-js: this function has zero third-party
 * imports, so a deploy can never fail on a registry fetch and a boot can never
 * fail on a resolver. `x-upsert: true` is what supabase-js sends for
 * `upsert: true`, and it is required here — the key is deterministic, so a
 * Postmark retry re-uploads the identical object to the identical key.
 */
async function uploadObject(
  supabaseUrl: string,
  serviceKey: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(
      `${supabaseUrl}/storage/v1/object/${EMAIL_ATTACHMENT_BUCKET}/${path}`,
      {
        method: 'POST',
        headers: {
          // BOTH HEADERS, AND `apikey` IS THE LOAD-BEARING ONE.
          //
          // This project issues NEW-FORMAT API keys, and the Edge runtime
          // injects SUPABASE_SERVICE_ROLE_KEY as an `sb_secret_...` value, not
          // a legacy JWT. Storage treats an Authorization: Bearer value as a
          // JWT, so a bearer-only request answers
          //   400 {"statusCode":"403","message":"Invalid Compact JWS"}
          // and then resolves the caller as anon — at which point RLS refuses
          // the write, because email-attachments has no permissive INSERT
          // policy for anon/authenticated (by design; it is service-role only).
          //
          // That failure is silent in the worst way: the shim's own rule is
          // that a failed upload still forwards the mail, so every message
          // arrived correctly with its attachment marked `rehost_failed`, and
          // nothing about inbound looked broken. Caught on the first real
          // delivery after cutover, 2026-08-07.
          //
          // Measured against this project rather than assumed: bearer-only
          // 400, apikey-only 200, apikey+bearer 200. Both are sent so a legacy
          // JWT key keeps working if the project is ever rolled back to one.
          apikey: serviceKey,
          authorization: `Bearer ${serviceKey}`,
          'content-type': contentType,
          'cache-control': 'max-age=3600',
          'x-upsert': 'true',
        },
        body: bytes,
      },
    )
    if (!res.ok) {
      // Read (and discard) the body so the connection is released.
      const detail = await res.text().catch(() => '')
      return { ok: false, error: `storage ${res.status} ${detail.slice(0, 200)}` }
    }
    // Drain the success body too — an unread body holds the connection open.
    await res.text().catch(() => '')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || 'upload threw' }
  }
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

// ── Handler ─────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return json({ success: false, error: 'method_not_allowed' }, 405)
  }

  const primary = Deno.env.get('POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN')
  const previous = Deno.env.get('POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN_PREVIOUS')
  const crmBaseUrl = Deno.env.get('CRM_WEBHOOK_BASE_URL')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  // Missing configuration is a 500, not a 404: a 404 would tell Postmark the
  // URL is wrong when the truth is that this deployment is unfinished, and the
  // difference is the whole triage.
  if (!primary || !crmBaseUrl || !supabaseUrl || !serviceKey) {
    console.error(
      '[postmark-shim] refusing to run — missing config:',
      [
        !primary && 'POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN',
        !crmBaseUrl && 'CRM_WEBHOOK_BASE_URL',
        !supabaseUrl && 'SUPABASE_URL',
        !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY',
      ].filter(Boolean).join(', '),
    )
    return json({ success: false, error: 'missing_secret' }, 500)
  }

  // Token-in-URL. Postmark's inbound webhook config only lets you set a URL,
  // not headers, so the shared secret is in the path — the same pattern the
  // Vercel route already uses.
  //
  // The LAST segment is the token. Read that way rather than by a fixed index
  // because the pathname the runtime hands us has been observed both with and
  // without the `/functions/v1` prefix; the last segment is the token in
  // either shape, and a request that stops at the function name has none.
  const segments = new URL(req.url).pathname.split('/').filter(Boolean)
  const last = segments.length ? segments[segments.length - 1] : ''
  const urlToken = last === FUNCTION_NAME ? '' : last

  const matched = urlToken && safeEqual(urlToken, primary)
    ? 'primary'
    : (urlToken && previous && safeEqual(urlToken, previous) ? 'previous' : null)
  if (!matched) {
    // 404, never 403 — the URL pattern must not be probeable. Mirrors the
    // Vercel route exactly. The token itself is NEVER logged.
    console.warn('[postmark-shim] rejected: token mismatch or missing')
    return json({ success: false, error: 'not_found' }, 404)
  }
  if (matched === 'previous') {
    console.warn(
      '[postmark-shim] accepted via POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN_PREVIOUS — ' +
      'finish rotating the Postmark inbound URL, then unset PREVIOUS.',
    )
  }

  // The forward ALWAYS carries this function's PRIMARY token, never the one
  // the caller sent.
  const forwardUrl = `${crmBaseUrl.replace(/\/+$/, '')}${FORWARD_PATH}/${primary}`
  const loggableForward = `${crmBaseUrl.replace(/\/+$/, '')}${FORWARD_PATH}/<token>`

  let body: PostmarkInbound
  try {
    body = await req.json()
  } catch {
    // Identical to what the Vercel route answers for the same input, so a
    // payload that is not JSON behaves exactly as it does today.
    return json({ success: false, error: 'invalid_json' }, 400)
  }

  const messageId = typeof body?.MessageID === 'string' ? body.MessageID : ''

  // ── Shrink the payload ────────────────────────────────────────────
  //
  // RawEmail is dropped outright. Nothing in the route reads it, and when
  // Postmark's "include raw email content" option is on it carries the FULL
  // MIME message — attachments and all — which would defeat this entire
  // function on its own.
  if (body.RawEmail !== undefined) {
    delete body.RawEmail
  }
  // HtmlBody is truncated to the same ceiling the route already truncates it to
  // before storing (truncateHtmlBody, HTML_BODY_MAX_CHARS), so nothing that
  // would have been kept is lost.
  if (typeof body.HtmlBody === 'string' && body.HtmlBody.length > HTML_BODY_MAX_CHARS) {
    body.HtmlBody = body.HtmlBody.slice(0, HTML_BODY_MAX_CHARS)
  }

  const attachments = Array.isArray(body.Attachments) ? body.Attachments : []
  let moved = 0
  let failed = 0
  let movedBytes = 0

  // Without a usable MessageID there is no deterministic key, so nothing is
  // staged and the payload is forwarded as it arrived. The route answers 400
  // `Missing MessageID` for exactly this input, which is what should happen.
  const canStage = PATH_SEGMENT.test(messageId)
  if (attachments.length > 0 && !canStage) {
    console.warn('[postmark-shim] no usable MessageID — forwarding unmodified')
  }

  if (canStage) {
    for (let index = 0; index < attachments.length; index += 1) {
      const att = attachments[index]
      if (!att || typeof att !== 'object') continue

      // Past the per-message cap the route records the file from
      // `ContentLength` under `too_many` without ever consulting a marker, so
      // there is nothing to move — but `Content` still has to go or the
      // payload stays fat for exactly the messages most likely to be fat.
      if (index >= MAX_ATTACHMENTS_PER_MESSAGE) {
        att.Content = ''
        continue
      }

      const content = typeof att.Content === 'string' ? att.Content : ''
      if (content.length === 0) {
        att.Content = ''
        continue
      }

      // Screened on the ENCODED length, BEFORE any decode. Unwrapped base64
      // decodes to exactly 3/4 of its length, and line wrapping only lowers
      // that ratio (~0.7305 at the usual 76-column wrap), so 0.72 × length is
      // a safe lower bound on the decoded size: if THAT is already over the
      // ceiling, the file is over the ceiling and there is no reason to
      // allocate it. This is the branch that stops a 30 MB attachment ever
      // becoming a 30 MB buffer inside a 150 MB function. Anything that passes
      // is still checked exactly, on the decoded length, below.
      if (content.length * 0.72 > MAX_ATTACHMENT_BYTES) {
        att.Content = ''
        att[STAGED_MARKER_KEY] = { v: STAGED_MARKER_VERSION, error: 'too_large' }
        failed += 1
        continue
      }

      const bytes = decodeBase64(content)
      // Free the base64 string NOW. Everything after this point holds the
      // decoded buffer only, which is what keeps peak memory to one attachment
      // rather than the whole payload plus the whole payload again.
      att.Content = ''

      if (!bytes) {
        // Undecodable or empty. NO marker: the route's inline path already
        // answers "nothing usable" for an empty Content, and it deliberately
        // writes no row (size_bytes > 0 is a CHECK). Behaviour is identical to
        // the pre-shim world.
        continue
      }

      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        att[STAGED_MARKER_KEY] = { v: STAGED_MARKER_VERSION, error: 'too_large' }
        failed += 1
        continue
      }

      const mime = safeMimeType(att.ContentType)
      const path = stagedAttachmentPath(messageId, index, attachmentExtension(mime))
      if (!path) {
        att[STAGED_MARKER_KEY] = { v: STAGED_MARKER_VERSION, error: 'upload_failed' }
        failed += 1
        continue
      }

      const uploaded = await uploadObject(supabaseUrl, serviceKey, path, bytes, mime)
      if (!uploaded.ok) {
        // THE MESSAGE IS FORWARDED ANYWAY. The route records `rehost_failed`
        // and staff see "invoice.pdf — not stored, upload failed" instead of
        // the file (and possibly the email) disappearing.
        console.error('[postmark-shim] upload failed for attachment', index, '—', uploaded.error)
        att[STAGED_MARKER_KEY] = { v: STAGED_MARKER_VERSION, error: 'upload_failed' }
        failed += 1
        continue
      }

      att[STAGED_MARKER_KEY] = { v: STAGED_MARKER_VERSION, path, bytes: bytes.length }
      moved += 1
      movedBytes += bytes.length
    }
  }

  // ── Forward ───────────────────────────────────────────────────────
  const forwardBody = JSON.stringify(body)
  if (forwardBody.length > VERCEL_BODY_LIMIT_BYTES) {
    // Not fatal here — the forward is still attempted, and Vercel's own 413
    // is the honest answer. Logged because the cause is now a body field
    // (TextBody, Headers) rather than attachments, and nothing else would say so.
    console.error(
      '[postmark-shim] payload is STILL over Vercel’s body limit after moving attachments:',
      `${forwardBody.length} bytes. Attachments are not the cause — check TextBody/Headers size.`,
    )
  }

  let upstream: Response
  try {
    upstream = await fetch(forwardUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Marks the hop for anyone reading Vercel logs. Carries no authority —
        // the route authenticates on the URL token and nothing else.
        'x-un1t-shim': 'postmark-inbound-shim',
      },
      body: forwardBody,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    })
  } catch (err) {
    // 502, so Postmark retries. The staged objects are LEFT: the retry
    // re-uploads to the identical deterministic key and overwrites them, so a
    // retry cannot accumulate copies.
    console.error('[postmark-shim] forward to', loggableForward, 'failed:', (err as Error)?.message)
    return json({ success: false, error: 'forward_failed' }, 502)
  }

  const text = await upstream.text()

  if (moved > 0 || failed > 0) {
    console.log(
      `[postmark-shim] ${moved} attachment(s) staged (${movedBytes} bytes), ` +
      `${failed} could not be moved; upstream ${upstream.status}`,
    )
  }

  // Whatever the route said, verbatim — status and body. Postmark's retry
  // semantics are therefore exactly what they were before this function
  // existed, which is the point.
  return new Response(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
    },
  })
})
