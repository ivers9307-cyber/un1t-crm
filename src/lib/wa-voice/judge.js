// VOICENOTE.1 — is a Scribe transcript clear enough for Mia to answer?
//
// The bar is deliberately high: a mis-heard voice note answered confidently is
// the failure this feature must not create, and doubt always means a hand-off
// to staff. Tune the two logprob thresholds in the calibration step (spec
// "Calibration and go-live"). Pure.

import { parseConsentKeyword } from '@/lib/whatsapp-consent-keywords'

export const MIN_MEAN_LOGPROB = -0.5
const MIN_LANGUAGE_PROBABILITY = 0.6
const VERY_UNSURE_LOGPROB = -1.5
const MAX_VERY_UNSURE_SHARE = 0.3
const MIN_WORDS = 2

export function judgeTranscript({ text, languageProbability, words } = {}) {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return 'unclear'
  if (t.split(/\s+/).filter(Boolean).length < MIN_WORDS) return 'unclear'
  // A spoken "stop"/"start" must never reach Mia or the consent parser as the
  // customer's words. Scribe punctuates, so compare without edge punctuation.
  if (parseConsentKeyword(t) || parseConsentKeyword(t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))) return 'unclear'
  if (!(typeof languageProbability === 'number' && languageProbability >= MIN_LANGUAGE_PROBABILITY)) return 'unclear'

  const scored = (Array.isArray(words) ? words : [])
    .filter((x) => x && x.type === 'word')
    .map((x) => x.logprob)
  // With no confidence per word there is nothing to judge, so it is not clear.
  if (!scored.length || scored.some((lp) => typeof lp !== 'number' || !Number.isFinite(lp))) return 'unclear'
  const mean = scored.reduce((a, b) => a + b, 0) / scored.length
  if (mean < MIN_MEAN_LOGPROB) return 'unclear'
  const unsure = scored.filter((lp) => lp < VERY_UNSURE_LOGPROB).length
  if (unsure / scored.length > MAX_VERY_UNSURE_SHARE) return 'unclear'
  return 'ok'
}
