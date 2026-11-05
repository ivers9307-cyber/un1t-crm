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
  it('keeps an open row listed even when it no longer matches', () => {
    const keepIds = new Set(['a'])
    expect(ids({ query: 'zzz', keepIds })).toEqual(['a'])
    expect(ids({ query: 'zzz' })).toEqual([])
  })
  it('a blank value searches the default text', () => {
    const fs = [{ id: 'p', label: 'Plain', paths: ['p_text'], placeholder: 'Hi from the default' },
      { id: 'q', label: 'Other', paths: ['q_text'], placeholder: (c) => `Default ${c.n}` }]
    const run = (query, settings) => filterMessages(fs, { query, settings, overridden: [], ctx: { n: 'Zed' } }).map((f) => f.id)
    expect(run('from the default', {})).toEqual(['p'])
    expect(run('default zed', { p_text: '  ' })).toEqual(['q'])
    expect(run('from the default', { p_text: 'Custom words' })).toEqual([])
  })
})
