// @vitest-environment jsdom
// QUESTIONS.1 — RegistrationQuestionsEditor: rows of label / type / options /
// required / per entry|person, emitting the jsonb shape.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import RegistrationQuestionsEditor from './RegistrationQuestionsEditor.jsx'

function Host({ initial, onChange }) {
  const [value, setValue] = useState(initial)
  return <RegistrationQuestionsEditor value={value} onChange={(v) => { setValue(v); onChange(v) }} />
}
afterEach(cleanup)

describe('RegistrationQuestionsEditor', () => {
  it('adds a text question per entry by default, with a minted id', () => {
    const onChange = vi.fn()
    render(<Host initial={[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Add a question/ }))
    const q = onChange.mock.calls.at(-1)[0][0]
    expect(q).toMatchObject({ label: '', type: 'text', required: false, per: 'entry' })
    expect(q.id).toMatch(/^q-/)
  })
  it('a choice question takes comma-separated options; required and per-person toggle', () => {
    const onChange = vi.fn()
    render(<Host initial={[{ id: 'q-1', label: '', type: 'text', required: false, per: 'entry' }]} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Question 1 label/), { target: { value: 'T-shirt size' } })
    fireEvent.change(screen.getByLabelText(/Question 1 type/), { target: { value: 'choice' } })
    fireEvent.change(screen.getByLabelText(/Question 1 options/), { target: { value: 'S, M, L ,XL' } })
    fireEvent.click(screen.getByLabelText(/Question 1 required/))
    fireEvent.change(screen.getByLabelText(/Question 1 asked/), { target: { value: 'person' } })
    expect(onChange.mock.calls.at(-1)[0][0]).toEqual({ id: 'q-1', label: 'T-shirt size', type: 'choice', options: ['S', 'M', 'L', 'XL'], required: true, per: 'person' })
  })
  it('remove drops the row; ten is the limit', () => {
    const onChange = vi.fn()
    render(<Host initial={[{ id: 'q-1', label: 'A', type: 'text', required: false, per: 'entry' }]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Remove question 1/ }))
    expect(onChange.mock.calls.at(-1)[0]).toEqual([])
    cleanup()
    render(<Host initial={Array.from({ length: 10 }, (_, i) => ({ id: `q-${i}`, label: `Q${i}`, type: 'text', required: false, per: 'entry' }))} onChange={() => {}} />)
    expect(screen.queryByRole('button', { name: /Add a question/ })).toBeNull()
  })
})

// HOSTTHEME.1 — the host form's (dark) arm uses the theme tokens only.
describe('RegistrationQuestionsEditor dark arm (HOSTTHEME.1)', () => {
  it('renders no raw colour class and rows are wells', () => {
    const { container } = render(<RegistrationQuestionsEditor value={[{ id: 'q1', label: 'Diet', type: 'choice', options: ['a', 'b'], required: true, per: 'entry' }]} onChange={() => {}} dark />)
    const bad = []
    for (const el of container.querySelectorAll('[class]')) {
      for (const tok of String(el.getAttribute('class')).split(/\s+/).filter(Boolean)) {
        if (/^(?:[a-z-]+:)*(?:text|bg|border|divide|ring)-(?:white|black)/.test(tok) || /placeholder:text-white/.test(tok) || /^(?:[a-z-]+:)*(?:text|bg|border)-(?:red|amber|emerald|green|sky|blue|yellow)-\d/.test(tok) || /color-scheme:dark/.test(tok)) bad.push(tok)
      }
    }
    expect(bad).toEqual([])
    expect(container.querySelector('.bg-host-well')).toBeTruthy()
  })
  it('the light arm keeps the staff classes', () => {
    const { container } = render(<RegistrationQuestionsEditor value={[{ id: 'q1', label: 'Diet', type: 'choice', options: ['a', 'b'], required: true, per: 'entry' }]} onChange={() => {}} />)
    expect(container.querySelector('.bg-un1t-surface')).toBeTruthy()
    expect(container.innerHTML).not.toContain('host-')
  })
})
