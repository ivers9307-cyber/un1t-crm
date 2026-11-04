// VOICENOTE.1 — how long a voice note is, read before paying to transcribe it.
//
// WhatsApp voice notes are Ogg/Opus. An Ogg page header starts with the
// capture pattern 'OggS'; bytes 6..13 are the 64-bit little-endian granule
// position, which for Opus counts 48 kHz samples. The last page's granule is
// the stream's length. (Pre-skip is ignored: it is a few ms.) Anything that is
// not Ogg (a forwarded .mp3/.m4a) has no readable duration; every file is also
// bounded by size. Pure; never throws.

export const VOICE_LIMIT_SECS = 180
export const VOICE_SIZE_LIMIT_BYTES = 2 * 1024 * 1024
const OPUS_RATE = 48000
const HEADER_LEN = 27

export function oggOpusDurationSecs(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_LEN) return null
  for (let i = bytes.length - 4; i >= 0; i--) {
    if (bytes[i] !== 0x4f || bytes[i + 1] !== 0x67 || bytes[i + 2] !== 0x67 || bytes[i + 3] !== 0x53) continue
    // Only a plausible page counts: the whole header and its segment table fit,
    // and the version byte is 0. Anything else is skipped, not trusted.
    if (i + HEADER_LEN > bytes.length) continue
    if (bytes[i + 4] !== 0) continue
    if (i + HEADER_LEN + bytes[i + 26] > bytes.length) continue
    const view = new DataView(bytes.buffer, bytes.byteOffset + i, HEADER_LEN)
    const granule = view.getBigInt64(6, true)
    if (granule <= 0n) return null // -1 = no packet ends on this page; 0 = empty
    return Number(granule) / OPUS_RATE
  }
  return null
}

// The declared duration can only make the decision stricter: the header is
// sender-written, so the size bound applies to every file (a 3-minute WhatsApp
// Opus note is well under 1 MB).
export function exceedsVoiceLimit(bytes) {
  const durationSecs = oggOpusDurationSecs(bytes)
  const size = bytes instanceof Uint8Array ? bytes.length : 0
  const tooLong = size > VOICE_SIZE_LIMIT_BYTES || (durationSecs != null && durationSecs > VOICE_LIMIT_SECS)
  return { tooLong, durationSecs }
}
