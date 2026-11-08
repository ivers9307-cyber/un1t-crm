// QUESTIONS.1 — the readers that must carry questions and answers, and the
// one public surface that must never carry answers.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8')

describe('registration questions reach every reader that needs them', () => {
  it.each([
    'src/app/api/events/[id]/teams/export/route.js',
    'src/app/api/host/events/[id]/attendees/export/route.js',
  ])('%s selects registration_questions on the event and passes the questions to the CSV', (file) => {
    const src = read(file)
    expect(src).toMatch(/\bregistration_questions\b/)
    expect(src).toMatch(/questions:/)
  })
  it('the attendee export and the staff teams route select answers on the registration and on team_members', () => {
    for (const f of ['src/lib/attendee-export.js', 'src/app/api/events/[id]/teams/route.js']) {
      const src = read(f)
      expect((src.match(/\banswers\b/g) || []).length, f).toBeGreaterThanOrEqual(2)
    }
  })
  it('the public event route never selects answers', () => {
    expect(read('src/app/api/public/events/[slug]/route.js')).not.toMatch(/\banswers\b/)
  })
})
