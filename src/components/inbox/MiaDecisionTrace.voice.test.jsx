import { test, expect } from 'vitest'
import { REASON_LABELS } from './MiaDecisionTrace.jsx'

test('voice hand-off reasons have staff labels', () => {
  expect(REASON_LABELS.voice_unclear).toBe("Voice note Mia couldn't make out")
  expect(REASON_LABELS.voice_too_long).toBe('Voice note over 3 minutes')
  expect(REASON_LABELS.voice_unavailable).toBe('Voice note: transcription unavailable')
})
