// src/lib/recon/imap-client.js
//
// RCOV.P1 — the only file that touches imapflow. Strictly read-only:
// [Gmail]/All Mail opened readOnly (covers archived mail, not just
// INBOX); no flags are ever written, nothing is marked read.
// Gmail's X-GM-RAW IMAP extension (imapflow: search({ gmraw })) gives
// full Gmail query syntax, which is why IMAP loses nothing vs the
// Gmail API here.
//
// imapflow@1.4.3 API verified against node_modules/imapflow/lib
// source before writing this file (search-compiler.js, imap-flow.js):
//   - search() query keys are matched via `term.toUpperCase()` in a
//     switch, case 'GMRAW' — so the lowercase `{ gmraw }` key used
//     below resolves correctly (case-insensitive).
//   - mailboxOpen(path, { readOnly: true }) is exactly the documented
//     signature (JSDoc: options.readOnly, default false).
//   - downloadMany(range, parts, options) returns an OBJECT keyed by
//     part id (e.g. `res['2'].content`), not an array — matches the
//     `res?.[part]` access below.
//   - bodyStructure nodes carry part/type/parameters/
//     dispositionParameters/size/childNodes exactly as walked in
//     documentParts().
import { ImapFlow } from 'imapflow'

const GMAIL_ALL_MAIL = '[Gmail]/All Mail'
const MAX_PART_BYTES = 8 * 1024 * 1024

export async function withMailbox({ email, password }, fn) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
  })
  await client.connect()
  try {
    await client.mailboxOpen(GMAIL_ALL_MAIL, { readOnly: true })
    return await fn(client)
  } finally {
    await client.logout().catch(() => {})
  }
}

// Live login + mailbox-open check for the add-inbox route. Returns an
// error envelope, never throws (route surfaces the message to the
// operator).
export async function verifyMailboxLogin({ email, password }) {
  try {
    await withMailbox({ email, password }, async () => true)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.responseText || e?.message || e) }
  }
}

export async function searchRaw(client, gmraw, cap = 8) {
  const uids = await client.search({ gmraw }, { uid: true })
  if (!Array.isArray(uids)) return []
  return uids.slice(-cap) // uid order is ascending; keep the newest tail
}

// Walk a bodyStructure tree for candidate document parts (pdf/images).
// Pure — unit-tested.
const DOC_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
])
export function documentParts(bodyStructure) {
  const out = []
  const walk = (node) => {
    if (!node) return
    const type = `${node.type || ''}`.toLowerCase()
    if (DOC_TYPES.has(type) && node.part) {
      out.push({
        part: node.part,
        contentType: type,
        filename: node.dispositionParameters?.filename || node.parameters?.name || null,
        size: node.size || null,
      })
    }
    for (const child of node.childNodes || []) walk(child)
  }
  walk(bodyStructure)
  return out
}

export async function fetchCandidate(client, uid) {
  const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true })
  if (!msg) return null
  return {
    uid,
    messageId: msg.envelope?.messageId || `uid:${uid}`,
    subject: msg.envelope?.subject || '',
    from: msg.envelope?.from?.[0]?.address || '',
    date: msg.envelope?.date || null,
    parts: documentParts(msg.bodyStructure),
  }
}

export async function downloadPart(client, uid, part, maxBytes = MAX_PART_BYTES) {
  const res = await client.downloadMany(uid, [part], { uid: true })
  const entry = res?.[part]
  if (!entry?.content) return null
  if (entry.content.length > maxBytes) return null
  return {
    bytes: entry.content,
    contentType: entry.meta?.contentType || null,
    filename: entry.meta?.filename || null,
  }
}
