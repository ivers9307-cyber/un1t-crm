// QUESTIONS.1 — the questions schema, answer validation/normalisation, and
// the display and CSV helpers.
import { describe, it, expect } from 'vitest'
import {
  RegistrationQuestionsSchema, MAX_QUESTIONS, resolveRegistrationQuestions, validateAnswers,
  answerColumns, formatAnswer, answersForDisplay,
} from './registration-questions.js'

const diet = { id: 'q-diet', label: 'Dietary needs', type: 'text', required: false, per: 'person' }
const level = { id: 'q-level', label: 'Experience', type: 'choice', options: ['Beginner', 'Intermediate', 'Advanced'], required: true, per: 'person' }
const photos = { id: 'q-photos', label: 'OK to be photographed?', type: 'yes_no', required: true, per: 'entry' }
const Q = [diet, level, photos]

describe('RegistrationQuestionsSchema', () => {
  it('accepts the three kinds; defaults required=false and per=entry', () => {
    const r = RegistrationQuestionsSchema.safeParse([{ id: 'a', label: 'Name of your dog', type: 'text' }])
    expect(r.success).toBe(true)
    expect(r.data[0]).toMatchObject({ required: false, per: 'entry' })
  })
  it('a choice needs at least two options; ids are unique; at most ten', () => {
    expect(RegistrationQuestionsSchema.safeParse([{ id: 'a', label: 'Size', type: 'choice', options: ['M'] }]).success).toBe(false)
    expect(RegistrationQuestionsSchema.safeParse([{ id: 'a', label: 'A', type: 'text' }, { id: 'a', label: 'B', type: 'text' }]).success).toBe(false)
    expect(RegistrationQuestionsSchema.safeParse(Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({ id: `q${i}`, label: 'x', type: 'text' }))).success).toBe(false)
  })
  it('resolveRegistrationQuestions is [] for null or junk', () => {
    expect(resolveRegistrationQuestions({ registration_questions: null })).toEqual([])
    expect(resolveRegistrationQuestions({ registration_questions: [{ bad: true }] })).toEqual([])
    expect(resolveRegistrationQuestions({ registration_questions: Q })).toHaveLength(3)
  })
})

describe('validateAnswers', () => {
  it('normalises good answers for the entry and every person', () => {
    const r = validateAnswers(Q, {
      entry: { 'q-photos': 'yes' },
      people: [{ 'q-diet': '  vegan ', 'q-level': 'Beginner' }, { 'q-level': 'Advanced' }],
    }, { peopleCount: 2 })
    expect(r).toEqual({
      ok: true,
      entry: { 'q-photos': true },
      people: [{ 'q-diet': 'vegan', 'q-level': 'Beginner' }, { 'q-level': 'Advanced' }],
    })
  })
  it('a required person question missing for one member names that member\'s field', () => {
    const r = validateAnswers(Q, { entry: { 'q-photos': false }, people: [{ 'q-level': 'Beginner' }, {}] }, { peopleCount: 2 })
    expect(r.ok).toBe(false)
    expect(r.issues).toEqual([{ path: 'member_1_q-level', message: 'Experience is required for person 2' }])
  })
  it('a required entry question missing names q_<id>', () => {
    const r = validateAnswers(Q, { entry: {}, people: [{ 'q-level': 'Beginner' }] }, { peopleCount: 1 })
    expect(r.issues).toEqual([{ path: 'q_q-photos', message: 'OK to be photographed? is required' }])
  })
  it('a choice answer that is not an option is refused, never stored', () => {
    const r = validateAnswers(Q, { entry: { 'q-photos': true }, people: [{ 'q-level': 'Elite' }] }, { peopleCount: 1 })
    expect(r.ok).toBe(false)
    expect(r.issues[0]).toMatchObject({ path: 'member_0_q-level' })
  })
  it('text is trimmed and capped at 500; yes_no takes booleans and yes/no strings', () => {
    const long = 'x'.repeat(501)
    const r = validateAnswers([{ ...diet, per: 'entry' }, photos], { entry: { 'q-diet': long, 'q-photos': 'no' } }, { peopleCount: 1 })
    expect(r.ok).toBe(false)
    expect(r.issues[0]).toMatchObject({ path: 'q_q-diet' })
    const ok = validateAnswers([photos], { entry: { 'q-photos': 'no' } }, { peopleCount: 1 })
    expect(ok).toEqual({ ok: true, entry: { 'q-photos': false }, people: [null] })
  })
  it('unknown ids are dropped; empty answer sets are null; no questions means nulls', () => {
    const r = validateAnswers([diet], { entry: { stray: 1 }, people: [{ stray: 2 }] }, { peopleCount: 1 })
    expect(r).toEqual({ ok: true, entry: null, people: [null] })
    expect(validateAnswers([], { entry: { a: 1 } }, { peopleCount: 3 })).toEqual({ ok: true, entry: null, people: [null, null, null] })
    expect(validateAnswers([diet], undefined, { peopleCount: 1 })).toEqual({ ok: true, entry: null, people: [null] })
  })
})

describe('display and CSV helpers', () => {
  it('answerColumns lists the questions in order', () => {
    expect(answerColumns(Q)).toEqual([{ id: 'q-diet', label: 'Dietary needs' }, { id: 'q-level', label: 'Experience' }, { id: 'q-photos', label: 'OK to be photographed?' }])
  })
  it('formatAnswer renders Yes/No, text and options, blank for none', () => {
    expect(formatAnswer(photos, true)).toBe('Yes')
    expect(formatAnswer(photos, false)).toBe('No')
    expect(formatAnswer(diet, 'vegan')).toBe('vegan')
    expect(formatAnswer(level, undefined)).toBe('')
  })
  it('a stored answer outlives a type change: a boolean reads Yes/No under any type, a string shows as text under yes_no', () => {
    expect(formatAnswer(diet, true)).toBe('Yes')
    expect(formatAnswer(photos, 'vegan')).toBe('vegan')
  })
  it('answersForDisplay merges entry and person answers, skips blanks, ignores a removed question\'s answer', () => {
    const rows = answersForDisplay(Q, { 'q-photos': true, 'q-gone': 'old' }, { 'q-level': 'Beginner' })
    expect(rows).toEqual([{ label: 'Experience', value: 'Beginner' }, { label: 'OK to be photographed?', value: 'Yes' }])
    expect(answersForDisplay(Q, null, null)).toEqual([])
  })
})
