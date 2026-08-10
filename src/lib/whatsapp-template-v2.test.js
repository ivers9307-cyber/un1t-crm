// WA template builder v2 — NAMED {{param}} parameters + FLOW-button
// send-time auto-attach. Pins:
//  - the named-variable extraction/example helpers (whatsapp-template-samples)
//  - buildTemplateComponents' named body path (parameter_name params) and the
//    FLOW button action parameter (omitting it → Meta 131009, proven live)
//  - the positional path staying byte-identical (every existing send rides it)
import { describe, it, expect, vi } from 'vitest'

// Mock the config module BEFORE importing whatsapp.js so module load never
// touches env/db (same idiom as whatsapp-block.test.js).
vi.mock('./whatsapp-config', () => ({
  META_API_URL: 'https://graph.facebook.com/v21.0',
  getWhatsAppConfig: vi.fn(async () => ({ phoneNumberId: 'pn1', accessToken: 'tok' })),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
}))

import {
  extractNamedVariables,
  buildNamedBodyExample,
  samplesFromNamedExample,
  missingSampleError,
} from './whatsapp-template-samples.js'
import { buildTemplateComponents } from './whatsapp.js'

describe('extractNamedVariables', () => {
  it('returns distinct names in first-appearance order', () => {
    expect(extractNamedVariables('Hi {{first_name}}, {{class_name}} at {{first_name}}'))
      .toEqual(['first_name', 'class_name'])
  })

  it('dedupes repeats', () => {
    expect(extractNamedVariables('{{a}} {{a}} {{a}}')).toEqual(['a'])
  })

  it('ignores numeric {{1}} placeholders', () => {
    expect(extractNamedVariables('Hi {{1}}, see {{2}}')).toEqual([])
    expect(extractNamedVariables('Hi {{1}}, see {{name}}')).toEqual(['name'])
  })

  it('ignores Uppercase-leading names (Meta named params are lowercase/underscore)', () => {
    expect(extractNamedVariables('Hi {{First_name}}')).toEqual([])
    expect(extractNamedVariables('Hi {{firstName}}')).toEqual([]) // camelCase has an uppercase char
  })

  it('tolerates whitespace inside braces and null/empty input', () => {
    expect(extractNamedVariables('Hi {{ first_name }}')).toEqual(['first_name'])
    expect(extractNamedVariables('')).toEqual([])
    expect(extractNamedVariables(null)).toEqual([])
  })
})

describe('buildNamedBodyExample / samplesFromNamedExample', () => {
  it('builds Meta named-params example shape from a samples map', () => {
    expect(buildNamedBodyExample('Hi {{first_name}} from {{gym}}', { first_name: 'Ann', gym: 'UN1T' }))
      .toEqual({
        body_text_named_params: [
          { param_name: 'first_name', example: 'Ann' },
          { param_name: 'gym', example: 'UN1T' },
        ],
      })
  })

  it('missing samples become empty strings', () => {
    expect(buildNamedBodyExample('Hi {{first_name}}', {}))
      .toEqual({ body_text_named_params: [{ param_name: 'first_name', example: '' }] })
  })

  it('returns null without named vars (positional or none)', () => {
    expect(buildNamedBodyExample('Hi {{1}}', { 1: 'Ann' })).toBeNull()
    expect(buildNamedBodyExample('No vars here')).toBeNull()
  })

  it('samplesFromNamedExample round-trips the built example back to the map', () => {
    const example = buildNamedBodyExample('Hi {{first_name}} from {{gym}}', { first_name: 'Ann', gym: 'UN1T' })
    expect(samplesFromNamedExample(example.body_text_named_params))
      .toEqual({ first_name: 'Ann', gym: 'UN1T' })
  })

  it('samplesFromNamedExample tolerates junk input', () => {
    expect(samplesFromNamedExample(null)).toEqual({})
    expect(samplesFromNamedExample([{ nope: true }, { param_name: 'x', example: null }]))
      .toEqual({ x: '' })
  })
})

describe('missingSampleError — named coverage', () => {
  it('errors on a missing named body sample', () => {
    expect(missingSampleError({ bodyText: 'Hi {{first_name}}', bodySamples: {} }))
      .toBe('Add a sample value for body variable {{first_name}}')
  })

  it('errors on a blank named header sample', () => {
    expect(missingSampleError({ headerText: 'Hello {{first_name}}', headerSamples: { first_name: '  ' } }))
      .toBe('Add a sample value for header variable {{first_name}}')
  })

  it('passes when every named variable has a sample', () => {
    expect(missingSampleError({
      bodyText: 'Hi {{first_name}} from {{gym}}',
      headerText: 'Yo {{first_name}}',
      bodySamples: { first_name: 'Ann', gym: 'UN1T' },
      headerSamples: { first_name: 'Ann' },
    })).toBeNull()
  })

  it('still validates numeric variables (existing behaviour intact)', () => {
    expect(missingSampleError({ bodyText: 'Hi {{1}}', bodySamples: {} }))
      .toBe('Add a sample value for body variable {{1}}')
    expect(missingSampleError({ bodyText: 'Hi {{1}}', bodySamples: { 1: 'Ann' } })).toBeNull()
  })
})

describe('buildTemplateComponents — NAMED body parameters', () => {
  const tpl = { components: [{ type: 'BODY', text: 'Hi {{first_name}}, see you at {{location_name}}' }] }

  it('resolves named params from the contact (param name IS the field) with parameter_name', () => {
    const comps = buildTemplateComponents(tpl, { first_name: 'Ann' }, {}, null, { companyName: 'UN1T' })
    const body = comps.find(c => c.type === 'body')
    expect(body.parameters).toEqual([
      { type: 'text', parameter_name: 'first_name', text: 'Ann' },
      { type: 'text', parameter_name: 'location_name', text: 'UN1T' },
    ])
  })

  it('a variableMapping override wins over the param-name default', () => {
    const comps = buildTemplateComponents(tpl, { first_name: 'Ann', name: 'Ann Byrne' }, { first_name: 'name' }, null, { companyName: 'UN1T' })
    const body = comps.find(c => c.type === 'body')
    expect(body.parameters[0]).toEqual({ type: 'text', parameter_name: 'first_name', text: 'Ann Byrne' })
  })

  it('blank values become a single space (Meta rejects empty strings)', () => {
    const bare = { components: [{ type: 'BODY', text: 'Hi {{first_name}}' }] }
    const comps = buildTemplateComponents(bare, { name: '' }, {}, null, {})
    expect(comps[0].parameters[0].text).toBe(' ')
  })
})

describe('buildTemplateComponents — FLOW button auto-attach', () => {
  const flowTpl = {
    components: [
      { type: 'BODY', text: 'Book your first visit' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'x' }, { type: 'FLOW', text: 'Book', flow_id: 'F1' }] },
    ],
  }

  it('attaches the per-contact flow_token at the FLOW button index when locationId is supplied', () => {
    const comps = buildTemplateComponents(flowTpl, { id: 'c1' }, {}, null, { locationId: 'l1' })
    expect(comps.find(c => c.type === 'button')).toEqual({
      type: 'button',
      sub_type: 'flow',
      index: '1',
      parameters: [{ type: 'action', action: { flow_token: 'c1.l1' } }],
    })
  })

  it('without locationId no button component is attached (welcome path appends its own)', () => {
    const comps = buildTemplateComponents(flowTpl, { id: 'c1' }, {}, null, {})
    expect(comps.find(c => c.type === 'button')).toBeUndefined()
  })

  it('an explicit opts.flowToken wins over the derived token', () => {
    const comps = buildTemplateComponents(flowTpl, { id: 'c1' }, {}, null, { locationId: 'l1', flowToken: 'custom.tok' })
    expect(comps.find(c => c.type === 'button').parameters[0].action.flow_token).toBe('custom.tok')
  })

  it('templates without a FLOW button never get a button component', () => {
    const plain = {
      components: [
        { type: 'BODY', text: 'Hi' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'x' }] },
      ],
    }
    const comps = buildTemplateComponents(plain, { id: 'c1' }, {}, null, { locationId: 'l1' })
    expect(comps.find(c => c.type === 'button')).toBeUndefined()
  })
})

describe('buildTemplateComponents — positional path unchanged', () => {
  it('{{n}} templates still yield positional text params with NO parameter_name', () => {
    const tpl = { components: [{ type: 'BODY', text: 'Hi {{1}}' }] }
    const comps = buildTemplateComponents(tpl, { first_name: 'Ann' }, { 1: 'first_name' }, null, {})
    expect(comps).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Ann' }] }])
  })
})

describe('buildTemplateComponents — dynamic URL button (WA-TPL-URL)', () => {
  const urlTpl = {
    components: [
      { type: 'BODY', text: 'Your offer is ready' },
      { type: 'BUTTONS', buttons: [
        { type: 'QUICK_REPLY', text: 'No thanks' },
        { type: 'URL', text: 'Get the offer', url: 'https://un1t.com/offer?c={{1}}', example: ['summer'] },
      ] },
    ],
  }

  it('attaches the url parameter at the button index, from the reserved mapping key', () => {
    const comps = buildTemplateComponents(urlTpl, { id: 'c1' }, { url_button: 'summer2026' }, null, {})
    expect(comps.find(c => c.type === 'button')).toEqual({
      type: 'button',
      sub_type: 'url',
      index: '1',
      parameters: [{ type: 'text', text: 'summer2026' }],
    })
  })

  it('resolves a contact field just like a body variable', () => {
    const comps = buildTemplateComponents(urlTpl, { id: 'c1', email: 'a@b.com' }, { url_button: 'email' }, null, {})
    expect(comps.find(c => c.type === 'button').parameters[0].text).toBe('a@b.com')
  })

  it('attaches nothing when no value is mapped (the send gate refuses this upstream)', () => {
    expect(buildTemplateComponents(urlTpl, { id: 'c1' }, {}, null, {}).find(c => c.type === 'button')).toBeUndefined()
  })

  it('leaves a fixed-URL template alone', () => {
    const fixed = { components: [{ type: 'BODY', text: 'Hi' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Book', url: 'https://un1t.com/book' }] }] }
    expect(buildTemplateComponents(fixed, { id: 'c1' }, { url_button: 'x' }, null, {}).find(c => c.type === 'button')).toBeUndefined()
  })

  it('a FLOW button and a dynamic URL button can coexist, each at its own index', () => {
    const both = {
      components: [
        { type: 'BODY', text: 'Hi' },
        { type: 'BUTTONS', buttons: [
          { type: 'FLOW', text: 'Book', flow_id: 'F1' },
          { type: 'URL', text: 'Offer', url: 'https://un1t.com/o?c={{1}}', example: ['x'] },
        ] },
      ],
    }
    const comps = buildTemplateComponents(both, { id: 'c1' }, { url_button: 'v' }, null, { locationId: 'l1' })
    const buttons = comps.filter(c => c.type === 'button')
    expect(buttons.map(b => [b.sub_type, b.index])).toEqual([['flow', '0'], ['url', '1']])
  })
})
