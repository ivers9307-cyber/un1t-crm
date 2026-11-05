import { describe, it, expect } from 'vitest'
import { filterMessages } from './messages-filter'

const fields = [
  { id: 'a', label: 'Greeting text', help: 'Sent first', paths: ['no_credits_handoff_text'] },
  { id: 'b', label: 'Credits message', help: 'When out of credits', paths: ['booking_flow_text'] },
  { id: 'c', label: (ctx) => `Hello ${ctx.n}`, paths: ['hello_text'] },
]
const base = { settings: { no_credits_handoff_text: 'Welcome to the gym' }, overridden: ['no_credits_handoff_text'], ctx: { n: 'Zed' } }
const ids = (o) => filterMessages(fields, { ...base, ...o }).map((f) => f.id)

describe('filterMessages', () => {
  it('empty or blank query matches all', () => {
    expect(ids({ query: '' })).toEqual(['a', 'b', 'c'])
    expect(ids({ query: '   ' })).toEqual(['a', 'b', 'c'])
  })
  it('matches label, help and value, case-insensitive and trimmed', () => {
    expect(ids({ query: ' CREDITS ' })).toEqual(['b'])
    expect(ids({ query: 'sent first' })).toEqual(['a'])
    expect(ids({ query: 'welcome TO' })).toEqual(['a'])
    expect(ids({ query: 'zed' })).toEqual(['c'])
  })
  it('changed only keeps overridden fields', () => {
    expect(ids({ changedOnly: true })).toEqual(['a'])
  })
  it('both together', () => {
    expect(ids({ changedOnly: true, query: 'credits' })).toEqual([])
    expect(ids({ changedOnly: true, query: 'gym' })).toEqual(['a'])
  })
})
