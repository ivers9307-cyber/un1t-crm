// ROLEUI.2 — the Timeline's Note / Activity / Sequence buttons had no gate:
// every viewer saw them, and POST …/notes (`contacts`), the activities insert
// (RLS: a member of the contact's studio) and the sequence enrol (`email`)
// refused whoever their rule excludes. Each button now follows its own flag
// (contactWorkGates, judged at the contact's location); missing flags hide it.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))
vi.mock('./SequencePicker', () => ({ default: () => null }))

const { default: ContactActions } = await import('./ContactActions.jsx')

const render = (props) => renderToStaticMarkup(<ContactActions contactId="c-1" locationId="l-1" {...props} />)
const has = (html, label) => html.includes(`</svg> ${label}</button>`)

describe('ContactActions — each button follows its route (ROLEUI.2)', () => {
  it('all three when every flag is on', () => {
    const html = render({ canNote: true, canTask: true, canSequence: true })
    expect([has(html, 'Note'), has(html, 'Activity'), has(html, 'Sequence')]).toEqual([true, true, true])
  })

  it('each flag alone shows only its button', () => {
    expect([has(render({ canNote: true }), 'Note'), has(render({ canNote: true }), 'Activity')]).toEqual([true, false])
    expect([has(render({ canTask: true }), 'Activity'), has(render({ canTask: true }), 'Sequence')]).toEqual([true, false])
    expect([has(render({ canSequence: true }), 'Sequence'), has(render({ canSequence: true }), 'Note')]).toEqual([true, false])
  })

  it('no flags (a crossover viewer): nothing renders', () => {
    expect(render({})).toBe('')
  })
})
