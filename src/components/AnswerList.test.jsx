// @vitest-environment jsdom
// QUESTIONS.1 — AnswerList: "Label: value" rows, nothing when empty.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AnswerList from './AnswerList.jsx'

describe('AnswerList', () => {
  it('renders each answer as label and value', () => {
    const html = renderToStaticMarkup(<AnswerList answers={[{ label: 'Dietary needs', value: 'vegan' }, { label: 'OK to be photographed?', value: 'Yes' }]} />)
    expect(html).toContain('Dietary needs')
    expect(html).toContain('vegan')
    expect(html).toContain('Yes')
  })
  it('renders nothing for no answers', () => {
    expect(renderToStaticMarkup(<AnswerList answers={[]} />)).toBe('')
    expect(renderToStaticMarkup(<AnswerList answers={null} />)).toBe('')
  })
})
