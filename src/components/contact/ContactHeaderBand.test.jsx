// WAITLIST.6 — the Cold action is a DERIVED-board affordance here too.
//
// Cold writes contacts.pipeline_dismissed_at and the ONLY reader of that stamp
// is the classifier, which mig 594's `pipelines.mode` fences out of a manual
// board. On Hatch Street's waitlist board "Not interested" is column 4, so the
// item was a second, invisible way to say what a hand move already says — and
// pressing it changed nothing an operator could see. WAITLIST.5 fixed DealCard
// and knowingly left this component; this is that follow-up.
//
// The default matters as much as the manual case: every caller that cannot
// resolve a board must keep TODAY's behaviour (Cold shown). Hiding an action
// because a lookup failed is worse than showing an inert one.
//
// Asserted on the `actions` PersonActionBar receives, not on rendered text:
// the menu is closed until a click, so the static markup holds no menu item
// either way and a text assertion would pass for the wrong reason.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/components/PersonActionBar', () => ({
  default: ({ actions }) => <div data-actions={(actions || []).join(',')} />,
}))
vi.mock('@/components/AutomationsExemptToggle', () => ({ default: () => null }))

const { default: ContactHeaderBand } = await import('./ContactHeaderBand.jsx')

const CONTACT = {
  id: 'c-1',
  name: 'Ada Lovelace',
  location_id: 'l-1',
  pipeline_stage_slug: 'new_lead',
}
const METRICS = { ltvCents: 0, arrearsCents: 0, attended: 0, deals: 1, currency: 'EUR' }

const actionsOf = (html) => {
  const m = html.match(/data-actions="([^"]*)"/)
  return m ? m[1].split(',') : null
}

// ROLEUI.2 — every gate on, so the Cold tables below test the board alone.
const ALL = { canTask: true, canSequence: true, canCancelForm: true, canCold: true }

const render = (props) => renderToStaticMarkup(
  <ContactHeaderBand contact={CONTACT} metrics={METRICS} actionGates={ALL} {...props} />,
)

// ROLEUI.2 — the kebab's Task / Sequence / cancellation form / Cold items had
// no gate: each is offered only where its route (or, for Task, activities RLS)
// would act at the contact's location. Message only deep-links to the
// composer, which gates its own channels.
describe('ContactHeaderBand — the kebab follows the routes it calls (ROLEUI.2)', () => {
  it('no gates passed: Message only (fails closed)', () => {
    expect(actionsOf(render({ actionGates: undefined }))).toEqual(['message'])
  })

  it('each item follows its own flag', () => {
    expect(actionsOf(render({ actionGates: { canTask: true } }))).toEqual(['message', 'task'])
    expect(actionsOf(render({ actionGates: { canSequence: true } }))).toEqual(['message', 'sequence'])
    expect(actionsOf(render({ actionGates: { canCancelForm: true } }))).toEqual(['message', 'cancel_form'])
    expect(actionsOf(render({ actionGates: { canCold: true } }))).toEqual(['message', 'cold'])
  })

  it('Cold stays off a manual board even when the caller may set it', () => {
    expect(actionsOf(render({ manual: true, actionGates: { canCold: true } }))).toEqual(['message'])
  })
})

describe('ContactHeaderBand — Cold on a derived board', () => {
  it('offers Cold when manual is false', () => {
    expect(actionsOf(render({ manual: false }))).toContain('cold')
  })

  it('offers Cold when manual is not passed at all', () => {
    // Stillorgan's acquisition board — and every caller that cannot resolve a
    // board — renders through this default. Nothing about it changes.
    expect(actionsOf(render({}))).toEqual(['message', 'task', 'sequence', 'cancel_form', 'cold'])
  })
})

describe('ContactHeaderBand — Cold is hidden on a manual board', () => {
  it('drops Cold when manual is true', () => {
    expect(actionsOf(render({ manual: true }))).toEqual(['message', 'task', 'sequence', 'cancel_form'])
  })

  it('keeps every other action', () => {
    const actions = actionsOf(render({ manual: true }))
    expect(actions).toContain('message')
    expect(actions).toContain('task')
    expect(actions).toContain('sequence')
    expect(actions).toContain('cancel_form')
  })
})
