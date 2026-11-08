// registration-questions — QUESTIONS.1: the questions an event asks at signup
// (race_events.registration_questions, mig 819) and the answers an entry
// gives (race_registrations.answers per ENTRY, team_members.answers per
// PERSON, keyed by question id).
//
// One pure module validates and normalises what the form sent against the
// event's questions, so the register route stores exactly what it returns
// and the widget renders exactly the issues it names (paths q_<id> for an
// entry question, member_<i>_<id> for person i, 0 = the captain; ids are
// minted `q-…` by the editor, so they never collide with the form's own
// member_<i>_name / member_<i>_email keys). Rosters
// and the CSV read answers back by id, so a question edited or removed after
// signups keeps old answers readable (a vanished id is simply skipped).

import { z } from 'zod'

export const MAX_QUESTIONS = 10
export const MAX_TEXT_ANSWER = 500
export const QUESTION_TYPES = ['text', 'choice', 'yes_no']

export const RegistrationQuestionSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(120),
  type: z.enum(QUESTION_TYPES),
  options: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  required: z.boolean().default(false),
  per: z.enum(['entry', 'person']).default('entry'),
}).strict().superRefine((q, ctx) => {
  if (q.type === 'choice' && (!q.options || q.options.length < 2)) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'A choice question needs at least two options.' })
  }
})

export const RegistrationQuestionsSchema = z.array(RegistrationQuestionSchema).max(MAX_QUESTIONS).superRefine((qs, ctx) => {
  const ids = new Set()
  for (const [i, q] of qs.entries()) {
    if (ids.has(q.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'Each question needs its own id.' })
    ids.add(q.id)
  }
})

/** The event's questions, [] when none or unreadable. */
export function resolveRegistrationQuestions(race) {
  const parsed = RegistrationQuestionsSchema.safeParse(race?.registration_questions)
  return parsed.success ? parsed.data : []
}

const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '')

/** One answer normalised to its stored value, or { error } for a bad one. */
function normalise(q, raw) {
  if (isBlank(raw)) return { value: undefined }
  if (q.type === 'yes_no') {
    if (raw === true || raw === 'yes' || raw === 'true') return { value: true }
    if (raw === false || raw === 'no' || raw === 'false') return { value: false }
    return { error: `Answer yes or no to "${q.label}"` }
  }
  if (q.type === 'choice') {
    const s = String(raw).trim()
    return (q.options || []).includes(s) ? { value: s } : { error: `Pick one of the options for "${q.label}"` }
  }
  const s = String(raw).trim()
  if (s.length > MAX_TEXT_ANSWER) return { error: `"${q.label}" must be ${MAX_TEXT_ANSWER} characters or fewer` }
  return { value: s }
}

/**
 * Validate and normalise the body's answers against the event's questions.
 * @param {Array} questions  resolveRegistrationQuestions(race)
 * @param {{ entry?: object, people?: Array<object|null> }|undefined} answers
 * @param {{ peopleCount: number }} opts  the roster size (captain first)
 * @returns {{ ok: true, entry: object|null, people: Array<object|null> } | { ok: false, issues: Array<{ path: string, message: string }> }}
 */
export function validateAnswers(questions, answers, { peopleCount }) {
  const qs = Array.isArray(questions) ? questions : []
  const n = Math.max(0, Number(peopleCount) || 0)
  const given = answers && typeof answers === 'object' ? answers : {}
  const entryIn = given.entry && typeof given.entry === 'object' ? given.entry : {}
  const peopleIn = Array.isArray(given.people) ? given.people : []
  const issues = []
  const entry = {}
  const people = Array.from({ length: n }, () => ({}))

  for (const q of qs) {
    if (q.per === 'person') {
      for (let i = 0; i < n; i++) {
        const raw = peopleIn[i] && typeof peopleIn[i] === 'object' ? peopleIn[i][q.id] : undefined
        const r = normalise(q, raw)
        if (r.error) issues.push({ path: `member_${i}_${q.id}`, message: r.error })
        else if (r.value === undefined) { if (q.required) issues.push({ path: `member_${i}_${q.id}`, message: `${q.label} is required for person ${i + 1}` }) }
        else people[i][q.id] = r.value
      }
    } else {
      const r = normalise(q, entryIn[q.id])
      if (r.error) issues.push({ path: `q_${q.id}`, message: r.error })
      else if (r.value === undefined) { if (q.required) issues.push({ path: `q_${q.id}`, message: `${q.label} is required` }) }
      else entry[q.id] = r.value
    }
  }
  if (issues.length > 0) return { ok: false, issues }
  const nullIfEmpty = (o) => (Object.keys(o).length === 0 ? null : o)
  return { ok: true, entry: nullIfEmpty(entry), people: people.map(nullIfEmpty) }
}

/** CSV headers, one per question, in order. */
export function answerColumns(questions) {
  return (Array.isArray(questions) ? questions : []).map((q) => ({ id: q.id, label: q.label }))
}

/** A stored answer as text: Yes/No for a boolean (whatever the question's
 * type is NOW: a type change after signups must not hide old answers), the
 * option, the text; '' for none. */
export function formatAnswer(question, value) {
  if (value == null || value === '') return ''
  if (value === true || value === 'true') return 'Yes'
  if (value === false || value === 'false') return 'No'
  return String(value)
}

/**
 * Label/value rows for a roster: the entry's answers and one person's, in
 * question order, blanks and vanished ids skipped.
 */
export function answersForDisplay(questions, entryAnswers, personAnswers) {
  const out = []
  for (const q of Array.isArray(questions) ? questions : []) {
    const raw = q.per === 'person' ? personAnswers?.[q.id] : entryAnswers?.[q.id]
    const text = formatAnswer(q, raw)
    if (text !== '') out.push({ label: q.label, value: text })
  }
  return out
}
