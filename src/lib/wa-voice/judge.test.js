import { test, expect } from 'vitest'
import { judgeTranscript, MIN_MEAN_LOGPROB } from './judge.js'
import { parseConsentKeyword } from '@/lib/whatsapp-consent-keywords'

const w = (lp) => ({ type: 'word', text: 'x', logprob: lp })

test('threshold constant', () => {
  expect(MIN_MEAN_LOGPROB).toBe(-0.5)
})
test('a clear transcript is ok', () => {
  expect(judgeTranscript({ text: 'Can I book the seven am class', languageProbability: 0.98, words: Array(7).fill(w(-0.1)) })).toBe('ok')
})
test('fewer than 2 words is unclear', () => {
  expect(judgeTranscript({ text: 'Hi', languageProbability: 0.99, words: [w(-0.05)] })).toBe('unclear')
  expect(judgeTranscript({ text: '', languageProbability: 0.99, words: [] })).toBe('unclear')
})
test('low language probability is unclear', () => {
  expect(judgeTranscript({ text: 'Can I book', languageProbability: 0.4, words: Array(3).fill(w(-0.1)) })).toBe('unclear')
})
test('low mean logprob is unclear', () => {
  expect(judgeTranscript({ text: 'Can I book', languageProbability: 0.9, words: Array(3).fill(w(-0.8)) })).toBe('unclear')
})
test('more than 30% very unsure words is unclear', () => {
  expect(judgeTranscript({ text: 'a b c d e f g h i j', languageProbability: 0.9, words: [...Array(6).fill(w(-0.1)), ...Array(4).fill(w(-2))] })).toBe('unclear')
})
test('no word logprobs means confidence cannot be judged (Review Focus 4)', () => {
  expect(judgeTranscript({ text: 'Can I book', languageProbability: 0.9, words: [] })).toBe('unclear')
  expect(judgeTranscript({ text: 'Can I book', languageProbability: 0.9, words: [{ type: 'word', text: 'Can' }, { type: 'word', text: 'I' }] })).toBe('unclear')
})
test('spacing and audio events are not counted as words', () => {
  const words = [w(-0.1), { type: 'spacing', text: ' ', logprob: -5 }, w(-0.1), { type: 'audio_event', text: '(laughs)', logprob: -5 }, w(-0.1)]
  expect(judgeTranscript({ text: 'Can I book', languageProbability: 0.9, words })).toBe('ok')
})
test('a consent keyword is never ok (Review Focus 5)', () => {
  expect(judgeTranscript({ text: 'Stop', languageProbability: 0.99, words: [w(-0.01)] })).toBe('unclear')
  expect(judgeTranscript({ text: ' Stop all. ', languageProbability: 0.99, words: Array(2).fill(w(-0.01)) })).toBe('unclear')
  expect(judgeTranscript({ text: 'stop please', languageProbability: 0.99, words: Array(2).fill(w(-0.01)) }))
    .toBe(parseConsentKeyword('stop please') ? 'unclear' : 'ok')
})
