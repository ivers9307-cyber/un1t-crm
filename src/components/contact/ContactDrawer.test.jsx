// @vitest-environment jsdom
//
// WAITLIST.6 — the same Cold defect as ContactHeaderBand, in the pipeline
// slide-over. Cold writes contacts.pipeline_dismissed_at and only the derived
// classifier reads it; mig 594's `pipelines.mode` keeps that classifier off a
// manual board entirely, so on Hatch Street's waitlist board the item said
// nothing that column 4 ("Not interested") does not already say by hand.
//
// jsdom (not renderToStaticMarkup, the model the sibling component tests use):
// the drawer paints nothing but a skeleton until its command-centre fetch
// resolves in an effect, and effects do not run during server rendering — a
// static render would assert on a loading state and pass for the wrong reason.
// Nothing here measures layout; jsdom cannot see layout and must never be
// asked to.
//
// Asserted on the `actions` PersonActionBar receives: the kebab menu is closed
// until it is clicked, so no menu item is in the DOM either way.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'

vi.mock('@/components/PersonActionBar', () => ({
  default: ({ actions }) => <div data-testid="actions" data-actions={(actions || []).join(',')} />,
}))
// Not under test — the drawer's composer and timeline pull their own weight
// (templates, filters) and would make this a test about them.
vi.mock('@/components/ContactComposer', () => ({ default: () => null }))
vi.mock('@/components/contact/ContactTimeline', () => ({ default: () => null }))

const { default: ContactDrawer } = await import('./ContactDrawer.jsx')

const BUNDLE = {
  success: true,
  contact: {
    id: 'c-1',
    name: 'Ada Lovelace',
    location_id: 'l-1',
    pipeline_stage_slug: 'new_lead',
  },
  activities: [],
  notes: [],
  sequences: [],
  permissions: {},
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => BUNDLE })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function actionsFor(props) {
  render(
    <ContactDrawer contactId="c-1" locationId="l-1" onNavigate={() => {}} onClose={() => {}} {...props} />,
  )
  const el = await waitFor(() => screen.getByTestId('actions'))
  return (el.getAttribute('data-actions') || '').split(',')
}

describe('ContactDrawer — Cold on a derived board', () => {
  it('offers Cold when manual is false', async () => {
    expect(await actionsFor({ manual: false })).toContain('cold')
  })

  it('offers Cold when manual is not passed at all', async () => {
    // Stillorgan's acquisition board — and any caller that cannot resolve a
    // board — renders through this default. Nothing about it changes.
    expect(await actionsFor({})).toEqual(['task', 'sequence', 'cancel_form', 'cold'])
  })
})

describe('ContactDrawer — Cold is hidden on a manual board', () => {
  it('drops Cold when manual is true', async () => {
    expect(await actionsFor({ manual: true })).toEqual(['task', 'sequence', 'cancel_form'])
  })

  it('keeps every other action', async () => {
    const actions = await actionsFor({ manual: true })
    expect(actions).toContain('task')
    expect(actions).toContain('sequence')
    expect(actions).toContain('cancel_form')
  })
})
