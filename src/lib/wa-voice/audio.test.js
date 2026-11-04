import { test, expect } from 'vitest'
import { oggOpusDurationSecs, exceedsVoiceLimit } from './audio.js'
import { makeOgg, randomBytes } from './test-helpers.js'

test('reads the duration from the last Ogg page granule', () => {
  expect(oggOpusDurationSecs(makeOgg(48000 * 5))).toBe(5)
})
test('179 s is within the limit, 181 s is over', () => {
  expect(exceedsVoiceLimit(makeOgg(48000 * 179))).toEqual({ tooLong: false, durationSecs: 179 })
  expect(exceedsVoiceLimit(makeOgg(48000 * 181))).toEqual({ tooLong: true, durationSecs: 181 })
})
test('non-Ogg audio falls back to the 2 MB size bound (Review Focus 1)', () => {
  expect(exceedsVoiceLimit(randomBytes(1024 * 1024))).toEqual({ tooLong: false, durationSecs: null })
  expect(exceedsVoiceLimit(randomBytes(3 * 1024 * 1024))).toEqual({ tooLong: true, durationSecs: null })
})
test('a buffer cut mid-header reads as no duration, never throws', () => {
  const cut = makeOgg(48000 * 5, { pages: 1 }).slice(0, 10)
  expect(oggOpusDurationSecs(cut)).toBeNull()
  expect(() => exceedsVoiceLimit(cut)).not.toThrow()
})
test('a zero granule and empty or missing input read as null', () => {
  expect(oggOpusDurationSecs(makeOgg(0, { pages: 1 }))).toBeNull()
  expect(oggOpusDurationSecs(new Uint8Array(0))).toBeNull()
  expect(oggOpusDurationSecs(null)).toBeNull()
  expect(exceedsVoiceLimit(null)).toEqual({ tooLong: false, durationSecs: null })
})

test('the size bound applies even when the Ogg header claims a short note (security review)', () => {
  const short = makeOgg(48000 * 5)
  const padded = new Uint8Array(3 * 1024 * 1024)
  padded.set(short, padded.length - short.length)
  expect(exceedsVoiceLimit(padded).tooLong).toBe(true)
})

test('a truncated or implausible last capture pattern is skipped, not trusted', () => {
  const real = makeOgg(48000 * 200, { pages: 1 })
  const fakeTail = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 1, 2]) // 'OggS' cut short
  const a = new Uint8Array(real.length + fakeTail.length)
  a.set(real); a.set(fakeTail, real.length)
  expect(oggOpusDurationSecs(a)).toBe(200)
  const bad = makeOgg(48000 * 2, { pages: 1 }); bad[4] = 7 // version must be 0
  const b = new Uint8Array(real.length + bad.length)
  b.set(real); b.set(bad, real.length)
  expect(oggOpusDurationSecs(b)).toBe(200)
})
