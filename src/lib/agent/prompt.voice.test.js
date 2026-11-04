import { test, expect } from 'vitest'
import { buildCustomerSystemPromptParts, VOICE_NOTES_PROMPT_SECTION } from './prompt.js'
import { VOICE_TRANSCRIPT_MARKER } from '@shared/voice-note'
import { PENDING_VOICE_PLACEHOLDER } from './core.js'

test('the voice-notes rule is in the stable prompt, right after the base prompt', () => {
  const { stable } = buildCustomerSystemPromptParts({ businessName: 'UN1T', locationName: 'Stillorgan', today: '2026-11-04' })
  expect(stable).toContain(VOICE_NOTES_PROMPT_SECTION)
  expect(VOICE_NOTES_PROMPT_SECTION.startsWith('## Voice notes\n')).toBe(true)
  // It names the exact marker and placeholder the history formatter writes.
  expect(VOICE_NOTES_PROMPT_SECTION).toContain(`"${VOICE_TRANSCRIPT_MARKER.trim()}"`)
  expect(VOICE_NOTES_PROMPT_SECTION).toContain(`"${PENDING_VOICE_PLACEHOLDER}"`)
  expect(VOICE_NOTES_PROMPT_SECTION).toContain('never say it was a voice note')
})
