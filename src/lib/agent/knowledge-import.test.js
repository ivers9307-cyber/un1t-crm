// KNOWLEDGE-IMPORT.1 — shape Glofox timetable events into knowledge
// entries (one per class type). Descriptions come from the event (or
// its program_obj) and are often HTML — strip to plain text the agent
// can relay verbatim. Pure.
import { describe, it, expect } from 'vitest'
import { shapeClassKnowledgeFromEvents } from './knowledge-import'

describe('shapeClassKnowledgeFromEvents', () => {
  it('dedupes by class name and lifts the description', () => {
    const out = shapeClassKnowledgeFromEvents([
      { name: 'ARENA', description: 'High-energy conditioning.' },
      { name: 'ARENA', description: 'High-energy conditioning.' },
      { name: 'HYROX', description: '', program_obj: { description: 'Race-prep training.' } },
    ])
    expect(out).toEqual([
      { title: 'ARENA', content: 'High-energy conditioning.' },
      { title: 'HYROX', content: 'Race-prep training.' },
    ])
  })
  it('strips HTML and collapses whitespace', () => {
    const out = shapeClassKnowledgeFromEvents([
      { name: 'FUS1ON - HYBRID', description: '<p>Strength &amp; conditioning,<br/>  45 mins.</p>' },
    ])
    expect(out[0].content).toBe('Strength & conditioning, 45 mins.')
  })
  it('keeps classes with no description as empty drafts', () => {
    const out = shapeClassKnowledgeFromEvents([{ name: 'MYSTERY' }])
    expect(out).toEqual([{ title: 'MYSTERY', content: '' }])
  })
  it('ignores junk rows and caps content length', () => {
    const out = shapeClassKnowledgeFromEvents([
      null, { name: '  ' },
      { name: 'LONG', description: 'x'.repeat(5000) },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].content.length).toBeLessThanOrEqual(4000)
  })
})
