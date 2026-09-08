// WAITLIST.5 — the Cold action is offered on a DERIVED board only.
//
// Cold writes contacts.pipeline_dismissed_at, and the only reader of that stamp
// is the classifier, which never runs on a manual board (pipelines.mode, mig
// 594). On Hatch Street's waitlist board "Not interested" is column 4, so the
// button was a second, invisible way to say the same thing — and pressing it
// produced no visible change at all.
//
// Asserted on the `actions` PersonActionBar receives rather than on rendered
// text: the menu is closed until a click, so static markup contains no menu
// item either way and a markup assertion would pass for the wrong reason.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('./PersonActionBar', () => ({
  default: ({ actions }) => <div data-actions={(actions || []).join(',')} />,
}))

const { default: DealCard } = await import('./DealCard.jsx')

const DEAL = {
  id: 'd-1',
  title: 'Ada',
  contacts: { id: 'c-1', name: 'Ada Lovelace', pipeline_stage_slug: 'new_lead' },
}

const actionsOf = (html) => {
  const m = html.match(/data-actions="([^"]*)"/)
  return m ? m[1].split(',') : null
}

const render = (props) => renderToStaticMarkup(
  <DealCard deal={DEAL} locationId="l-1" stageName="New Enquiry" {...props} />,
)

describe('DealCard — Cold on a derived board', () => {
  it('offers Cold when manual is false', () => {
    expect(actionsOf(render({ manual: false }))).toContain('cold')
  })

  it('offers Cold when manual is not passed at all', () => {
    // Stillorgan's acquisition board renders through this default; nothing
    // about it changes.
    expect(actionsOf(render({}))).toEqual(['message', 'task', 'sequence', 'cold'])
  })
})

describe('DealCard — Cold is hidden on a manual board', () => {
  it('drops Cold from the menu when manual is true', () => {
    expect(actionsOf(render({ manual: true }))).toEqual(['message', 'task', 'sequence'])
  })

  it('keeps the other three actions', () => {
    const actions = actionsOf(render({ manual: true }))
    expect(actions).toContain('message')
    expect(actions).toContain('task')
    expect(actions).toContain('sequence')
  })
})
