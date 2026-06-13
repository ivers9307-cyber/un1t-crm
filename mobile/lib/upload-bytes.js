// Read a local file (an expo-image-picker / expo-document-picker cache
// URI) into an ArrayBuffer for a direct-to-storage upload.
//
// WHY THIS EXISTS — the Supabase-in-React-Native upload gotcha. The
// obvious pattern, `const blob = await (await fetch(uri)).blob()` then
// `supabase.storage.uploadToSignedUrl(path, token, blob, …)`, stores a
// ZERO-BYTE object on device even though `blob.size` is correct — RN's
// Blob from fetch doesn't transmit its bytes through the upload XHR.
// Confirmed live (2026-06-13): a valid 1.85 MB JPG uploaded, then the
// finalise route's magic-byte gate rejected it ("Only a PDF or photo…")
// because the stored object had no readable bytes. upload-sign returned
// 200, finalise returned 400 — i.e. the bytes, not the MIME, were the
// problem. Fix: upload an ArrayBuffer, never a Blob.
//
// Primary path: the native file-system module reads straight to bytes
// (expo-file-system is in the binary as a transitive dep, so this works
// over OTA with no rebuild). Fallback: blob → data URL → base64 → bytes,
// pure RN, in case the native read is unavailable.
//
// expo-file-system is loaded with a lazy `import()` inside the function
// (not a top-level import) so it stays OUT of the static module graph —
// otherwise unit-testing the api wrappers that import this file makes
// vitest try to parse the native package and fail.

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP = (() => {
  const t = new Uint8Array(256)
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i
  return t
})()

function base64ToArrayBuffer(b64) {
  const len = b64.length
  let bufferLength = (len * 3) >> 2
  if (b64[len - 1] === '=') { bufferLength--; if (b64[len - 2] === '=') bufferLength-- }
  const bytes = new Uint8Array(bufferLength)
  let p = 0
  for (let i = 0; i < len; i += 4) {
    const e0 = B64_LOOKUP[b64.charCodeAt(i)]
    const e1 = B64_LOOKUP[b64.charCodeAt(i + 1)]
    const e2 = B64_LOOKUP[b64.charCodeAt(i + 2)]
    const e3 = B64_LOOKUP[b64.charCodeAt(i + 3)]
    bytes[p++] = (e0 << 2) | (e1 >> 4)
    if (p < bufferLength) bytes[p++] = ((e1 & 15) << 4) | (e2 >> 2)
    if (p < bufferLength) bytes[p++] = ((e2 & 3) << 6) | (e3 & 63)
  }
  return bytes.buffer
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Read the file at `uri` into an ArrayBuffer of its real bytes.
 * Throws if the file can't be read by either path.
 */
export async function readFileAsArrayBuffer(uri) {
  // Primary — native read straight to bytes (lazy import; see header).
  try {
    const { File: FsFile } = await import('expo-file-system')
    const bytes = await new FsFile(uri).bytes() // Uint8Array<ArrayBuffer>
    if (bytes && bytes.byteLength > 0) {
      // Copy out exactly this view's bytes (defensive against a non-zero
      // byteOffset / shared buffer) so the upload body is the file alone.
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    }
  } catch {
    // fall through to the pure-RN path
  }

  // Fallback — blob → data URL → base64 → bytes.
  const blob = await (await fetch(uri)).blob()
  const dataUrl = await blobToDataUrl(blob)
  const comma = String(dataUrl).indexOf(',')
  const b64 = comma >= 0 ? String(dataUrl).slice(comma + 1) : ''
  if (!b64) throw new Error('The file appears to be empty.')
  return base64ToArrayBuffer(b64)
}
