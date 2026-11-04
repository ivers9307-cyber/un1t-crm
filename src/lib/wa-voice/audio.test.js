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
