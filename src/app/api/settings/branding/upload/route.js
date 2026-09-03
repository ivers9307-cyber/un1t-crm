import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'

// DECISION (SAAS-7 storage audit): the 'branding' bucket STAYS
// public-read in the multi-tenant world. Everything in it is public by
// nature — logos/favicons ({locationId}/{type}.{ext} written here),
// landing-page media, race art — all rendered on public marketing/event
// pages, in customer emails, and as the site favicon. Guessing a
// location-UUID path therefore reveals nothing that isn't already
// public, and every DB row / sent email stores the ABSOLUTE public URL,
// so moving to signed URLs would break historical emails and require a
// URL-indirection layer for near-zero gain. Writes stay gated (owner/
// master AT THE TARGET location, MIME whitelist + magic-byte sniff, size
// cap below) so no sensitive file type can land here. Revisit only if a non-public asset
// class is ever added to this bucket — put it in a private bucket
// instead.

// MAILFIX-BRANDGATE.1 — the raster sniffs, copied from /api/me/signature-photo
// (file.type is client-asserted, the bucket is public-read: without these an
// arbitrary payload can be parked on our public host wearing an image MIME).
// ICO gets its own ICONDIR magic; a PNG wearing the .ico MIME stays accepted
// because a PNG renamed favicon.ico is a favicon browsers render, and
// refusing it would break a re-upload that used to work.
const isPng = (b) => b.length > 8 && b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]))
const isWebp = (b) => b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP'
const isIco = (b) => b.length >= 6 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00

// SVG stays accepted (existing logos are SVG — re-upload must not break), but
// structurally checked: after the optional BOM, whitespace, XML declaration,
// comments and DOCTYPE, the first ELEMENT must be <svg. This is deliberately
// NOT sanitisation — its whole job is "this is not an arbitrary payload
// wearing image/svg+xml". Only the head is inspected: a real logo's prolog
// fits in 4KB with room to spare, and an unterminated prolog construct is a
// refusal, so the check can only err strict. Documented strict-refusal
// trade-offs, accepted rather than bugs: a UTF-16-encoded SVG is refused
// (decoded as UTF-8 it never yields a literal '<svg'; serializers emit
// UTF-8), so is a prolog longer than the 4096-byte head, and so is a
// DOCTYPE whose quoted literal contains '>' (the scanner reads the first
// unbracketed '>' as the close), and so is a namespace-prefixed root
// (`<svg:svg …>`, a Batik-era exporter form). Each refusal is a friendly 400
// telling the operator to re-export, never a silent mangle.
function looksLikeSvg(buffer) {
  let head = buffer.subarray(0, 4096).toString('utf8')
  if (head.charCodeAt(0) === 0xFEFF) head = head.slice(1) // UTF-8 BOM
  let i = 0
  while (i < head.length) {
    if (/\s/.test(head[i])) { i++; continue }
    if (head.startsWith('<?', i)) { // XML declaration / processing instruction
      const end = head.indexOf('?>', i)
      if (end === -1) return false
      i = end + 2
      continue
    }
    if (head.startsWith('<!--', i)) { // comment
      const end = head.indexOf('-->', i)
      if (end === -1) return false
      i = end + 3
      continue
    }
    if (head.startsWith('<!', i)) { // DOCTYPE, possibly with an [internal subset]
      let depth = 0
      let j = i + 2
      for (; j < head.length; j++) {
        const c = head[j]
        if (c === '[') depth++
        else if (c === ']') depth--
        else if (c === '>' && depth <= 0) break
      }
      if (j >= head.length) return false
      i = j + 1
      continue
    }
    // The first element decides. Lowercase only — XML is case-sensitive and
    // nothing renders <SVG> as an image.
    return /^<svg[\s/>]/.test(head.slice(i, i + 5))
  }
  return false
}

// POST /api/settings/branding/upload — Upload a logo or favicon image
// (owner or master AT THE TARGET studio)
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const formData = await request.formData()
  const file = formData.get('file')
  const type = formData.get('type') // 'logo' or 'favicon' — whitelisted below
  const locationId = formData.get('location_id') || user.activeLocation?.id

  // No target, no write: without this a master with no active location would
  // build a literal 'undefined/' storage key. Also keeps the caller×target
  // matrix total — every request names exactly one studio.
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }

  // MAILFIX-BRANDGATE.1 — gate on the role AT THE TARGET STUDIO, never on
  // `user.role` (active-location-resolved, highest-role-anywhere fallback):
  // the old check let an owner at studio A who is plain STAFF at studio B
  // overwrite B's public logo/favicon. Same shape and order as
  // guardMailboxAdmin — membership first (assertLocationAccess is not
  // subsumed: guardMasterOrOwner never checks membership), then
  // owner-or-master at the target; the fuller reasoning lives on the PUT
  // twin in ../route.js.
  const locationGuard = assertLocationAccess(user, locationId)
  if (locationGuard) return locationGuard
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) {
    return NextResponse.json({ success: false, error: 'Only owners or master can upload branding' }, { status: 403 })
  }

  if (!file || !type) {
    return NextResponse.json({ success: false, error: 'file and type are required' }, { status: 400 })
  }

  // MAILFIX-BRANDGATE.2 — `type` is a raw formData string that becomes a
  // storage-key segment, and storage-js does not strip dot segments: WHATWG
  // URL resolution folds `..` before the request leaves the process, so
  // `type=../<other-studio-uuid>/logo` with the service-role key and
  // upsert:true would overwrite ANOTHER studio's live logo — the exact
  // cross-studio write the gate above closes, reachable through the sibling
  // field (and two `..` segments escape the bucket entirely). Whitelist the
  // only two values the settings UI has ever sent.
  if (type !== 'logo' && type !== 'favicon') {
    return NextResponse.json({ success: false, error: "type must be 'logo' or 'favicon'" }, { status: 400 })
  }

  // Validate file type
  const allowedTypes = ['image/png', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/webp']
  if (!allowedTypes.includes(file.type)) {
    return NextResponse.json({ success: false, error: 'File must be PNG, SVG, WebP, or ICO' }, { status: 400 })
  }

  // The client filename is deliberately NEVER read: the extension used to come
  // off file.name (the same traversal class as `type`), and it is now derived
  // from the sniffed MIME below, so a hostile name is inert rather than
  // refused — refusing it would 400 legitimate basenames like `logo..png`.

  // Validate file size (5MB max)
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ success: false, error: 'File must be under 5MB' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  // MAILFIX-BRANDGATE.1 — the bytes must match the claimed type (see the
  // helpers above for why, and for the deliberate PNG-as-.ico allowance).
  if (file.type === 'image/svg+xml') {
    if (!looksLikeSvg(buffer)) {
      return NextResponse.json({ success: false, error: 'That SVG does not look like an SVG — it must start with an <svg> element' }, { status: 400 })
    }
  } else {
    const sniffOk =
      (file.type === 'image/png' && isPng(buffer)) ||
      (file.type === 'image/webp' && isWebp(buffer)) ||
      ((file.type === 'image/x-icon' || file.type === 'image/vnd.microsoft.icon') && (isIco(buffer) || isPng(buffer)))
    if (!sniffOk) {
      return NextResponse.json({ success: false, error: 'That file does not look like a PNG, WebP or ICO image' }, { status: 400 })
    }
  }

  const db = createServerClient()

  // Build file path: branding/{location_id}/{type}.{ext}. The extension is
  // derived from the sniff-validated MIME type, NEVER from the client
  // filename (see the traversal note above) — every accepted request writes
  // one of exactly eight keys under its own {locationId}/ prefix. A PNG
  // wearing the .ico MIME keeps writing favicon.ico, same as it always has.
  const EXT_BY_MIME = {
    'image/png': 'png',
    'image/webp': 'webp',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/svg+xml': 'svg',
  }
  const ext = EXT_BY_MIME[file.type]
  // Unreachable while the allowlist above precedes this lookup — kept so a
  // reordered or relaxed allowlist can never mint a `.undefined` key.
  if (!ext) {
    return NextResponse.json({ success: false, error: 'Unsupported file type' }, { status: 400 })
  }
  const filePath = `${locationId}/${type}.${ext}`

  // Upload to Supabase Storage (upsert to overwrite existing)
  const { error: uploadError } = await db.storage
    .from('branding')
    .upload(filePath, buffer, {
      contentType: file.type,
      upsert: true,
    })

  if (uploadError) {
    return NextResponse.json({ success: false, error: uploadError.message }, { status: 400 })
  }

  // Get the public URL
  const { data: urlData } = db.storage.from('branding').getPublicUrl(filePath)
  const publicUrl = urlData.publicUrl + `?t=${Date.now()}` // cache-bust

  return NextResponse.json({ success: true, url: publicUrl })
}
