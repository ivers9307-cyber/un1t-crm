// RADAR-OUTREACH.1 — pure-helper coverage for the radar WhatsApp
// utility-template outreach. The send orchestrator (sendRadarOutreach)
// is DB- + network-touching and exercised via the action routes; this
// file locks the pure parsing / gating / component-building logic.

import { describe, it, expect } from 'vitest'
import {
  extractTemplateBody,
  isSendableUtilityTemplate,
  buildBodyComponents,
} from './radar-outreach.js'

const body = (text) => [{ type: 'BODY', text }]

describe('extractTemplateBody', () => {
  it('pulls the body text out of the components array', () => {
    const r = extractTemplateBody(body('Hi there, see you soon.'))
    expect(r.bodyText).toBe('Hi there, see you soon.')
    expect(r.varCount).toBe(0)
  })

  it('counts a single numeric placeholder', () => {
    expect(extractTemplateBody(body('Hi {{1}}, we miss you.')).varCount).toBe(1)
  })

  it('counts distinct numeric placeholders, de-duping repeats', () => {
    expect(extractTemplateBody(body('{{1}} {{2}} {{1}}')).varCount).toBe(2)
  })

  it('flags a named placeholder rather than counting it', () => {
    const r = extractTemplateBody(body('Hi {{first_name}}, welcome.'))
    expect(r.hasNamedVars).toBe(true)
    expect(r.varCount).toBe(0)
  })

  it('flags a non-text (media) header', () => {
    const comps = [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Your pass is ready.' },
    ]
    expect(extractTemplateBody(comps).hasMediaHeader).toBe(true)
  })

  it('does not flag a plain TEXT header', () => {
    const comps = [
      { type: 'HEADER', format: 'TEXT', text: 'UN1T' },
      { type: 'BODY', text: 'Hello.' },
    ]
    expect(extractTemplateBody(comps).hasMediaHeader).toBe(false)
  })

  it('handles a missing / non-array components value', () => {
    expect(extractTemplateBody(null)).toEqual({
      bodyText: '', varCount: 0, hasMediaHeader: false, hasNamedVars: false,
    })
    expect(extractTemplateBody(undefined).bodyText).toBe('')
  })
})

describe('isSendableUtilityTemplate', () => {
  const base = {
    status: 'APPROVED',
    category: 'UTILITY',
    components: body('Hi {{1}}, we miss you at UN1T.'),
  }

  it('accepts an approved utility template with one variable', () => {
    expect(isSendableUtilityTemplate(base)).toBe(true)
  })

  it('accepts an approved utility template with no variables', () => {
    expect(isSendableUtilityTemplate({ ...base, components: body('See you soon.') })).toBe(true)
  })

  it('rejects a template that is not approved', () => {
    expect(isSendableUtilityTemplate({ ...base, status: 'PENDING' })).toBe(false)
  })

  it('rejects a marketing-category template', () => {
    expect(isSendableUtilityTemplate({ ...base, category: 'MARKETING' })).toBe(false)
  })

  it('rejects a template with more than one variable', () => {
    expect(isSendableUtilityTemplate({ ...base, components: body('{{1}} and {{2}}') })).toBe(false)
  })

  it('rejects a template with a named variable', () => {
    expect(isSendableUtilityTemplate({ ...base, components: body('Hi {{name}}') })).toBe(false)
  })

  it('rejects a template with a media header', () => {
    expect(isSendableUtilityTemplate({
      ...base,
      components: [{ type: 'HEADER', format: 'IMAGE' }, ...body('Hi {{1}}')],
    })).toBe(false)
  })

  it('rejects null defensively', () => {
    expect(isSendableUtilityTemplate(null)).toBe(false)
  })
})

describe('buildBodyComponents', () => {
  it('returns nothing for a zero-variable template', () => {
    expect(buildBodyComponents(0, 'Richard')).toEqual([])
  })

  it('fills the single variable with the first name', () => {
    expect(buildBodyComponents(1, 'Richard')).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Richard' }] },
    ])
  })

  it('falls back to a friendly default when the name is blank', () => {
    expect(buildBodyComponents(1, '   ')[0].parameters[0].text).toBe('there')
    expect(buildBodyComponents(1, null)[0].parameters[0].text).toBe('there')
  })
})

// RADAR-THREAD.1 — radar outreach must land in the conversation thread
// (every other outbound WA path already records; radar was the gap).
// The recorded body is the REAL rendered text — the agent reads its
// context from this thread, so "[Template: x]" placeholders are useless.
import { renderRadarBody } from './radar-outreach'

describe('renderRadarBody', () => {
  const template = {
    components: [
      { type: 'BODY', text: 'Hi {{1}}, fancy a free consultation this week, {{1}}?' },
    ],
  }
  it('substitutes every body variable with the first name', () => {
    expect(renderRadarBody(template, 'Richard'))
      .toBe('Hi Richard, fancy a free consultation this week, Richard?')
  })
  it('falls back to a placeholder when the template has no body', () => {
    expect(renderRadarBody({ components: [] }, 'Richard')).toBe(null)
  })
})
