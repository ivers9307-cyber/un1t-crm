// @vitest-environment jsdom
//
// SEQ-URLBUTTON.1 — the sequence flow builder's WhatsApp step editor could not
// author a dynamic URL button's per-send value, and it WIPED the mapping every
// time the template select fired.
//
// Both halves of that are data loss the operator never sees: the gallery
// installer (/api/sequences/from-template) writes whatsapp_variables like
// { '2': 'pay_amount', url_button: 'pay_link_suffix' }, and merely re-opening
// the step and re-picking the same template reset it to {}. The step then
// sends with no button value, which Meta rejects with 132012 per message.
//
// jsdom cannot see layout (repo lesson), so nothing here asserts visibility —
// only the `variables` object before/after a selection change, the presence of
// the field in the rendered tree, and the validation copy.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import {
  NodeConfig, variablesAfterTemplateChange, STEP_RESERVED_VARIABLES,
} from './nodeEditing.jsx'
import { URL_BUTTON_MAPPING_KEY } from '@/lib/whatsapp-template-buttons'

afterEach(cleanup)

const DYNAMIC = {
  id: 'tpl-dyn',
  name: 'Overdue pay link',
  language: 'en',
  components: [
    { type: 'BODY', text: 'Hi {{1}}, {{2}} is outstanding.' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay now', url: 'https://pay.repset.ie/{{1}}', example: ['abc123'] }] },
  ],
}
const OTHER_DYNAMIC = {
  id: 'tpl-dyn-2',
  name: 'Second pay link',
  language: 'en',
  components: [
    { type: 'BODY', text: 'Hello {{1}}' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open', url: 'https://repset.ie/x/{{1}}', example: ['zz'] }] },
  ],
}
const PLAIN = {
  id: 'tpl-plain',
  name: 'Welcome',
  language: 'en',
  components: [
    { type: 'BODY', text: 'Hi {{1}}' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Book', url: 'https://repset.ie/book' }] },
  ],
}
const TEMPLATES = [DYNAMIC, OTHER_DYNAMIC, PLAIN]

const waNode = (config) => ({ id: 'n1', type: 'whatsapp', config })

function renderConfig(config, onPatch = vi.fn()) {
  const utils = render(<NodeConfig node={waNode(config)} onPatch={onPatch} templates={TEMPLATES} />)
  return { ...utils, onPatch }
}

const templateSelect = (container) => container.querySelector('select')
const urlButtonInput = (container) =>
  Array.from(container.querySelectorAll('input')).find(i => i.getAttribute('data-field') === URL_BUTTON_MAPPING_KEY)

// --- the pure rule ---------------------------------------------------------

describe('variablesAfterTemplateChange — re-picking the same template is not a reset', () => {
  const mapping = { 1: 'first_name', 2: 'pay_amount', [URL_BUTTON_MAPPING_KEY]: 'pay_link_suffix' }

  it('keeps the whole mapping when the template id has not changed', () => {
    expect(variablesAfterTemplateChange(mapping, 'tpl-dyn', DYNAMIC)).toEqual(mapping)
  })

  it('drops body variables but carries url_button to another dynamic-URL template', () => {
    expect(variablesAfterTemplateChange(mapping, 'tpl-dyn', OTHER_DYNAMIC))
      .toEqual({ [URL_BUTTON_MAPPING_KEY]: 'pay_link_suffix' })
  })

  it('drops url_button when the new template has no dynamic URL button', () => {
    expect(variablesAfterTemplateChange(mapping, 'tpl-dyn', PLAIN)).toEqual({})
  })

  it('drops everything when the template is cleared', () => {
    expect(variablesAfterTemplateChange(mapping, 'tpl-dyn', null)).toEqual({})
  })

  it('treats an empty-string template id and null as the same unset template', () => {
    expect(variablesAfterTemplateChange({}, '', null)).toEqual({})
  })

  it('never mutates the mapping it is given', () => {
    const input = { ...mapping }
    variablesAfterTemplateChange(input, 'tpl-dyn', PLAIN)
    expect(input).toEqual(mapping)
  })
})

// --- the select's patch ----------------------------------------------------

describe('WhatsApp step editor — template selection', () => {
  it('does NOT wipe the mapping when the same template is re-selected', () => {
    const variables = { 1: 'first_name', [URL_BUTTON_MAPPING_KEY]: 'pay_link_suffix' }
    const { container, onPatch } = renderConfig({ template_id: 'tpl-dyn', variables })
    fireEvent.change(templateSelect(container), { target: { value: 'tpl-dyn' } })
    expect(onPatch).toHaveBeenCalledWith({ template_id: 'tpl-dyn', variables })
  })

  it('resets body variables but keeps url_button when swapping to another dynamic-URL template', () => {
    const variables = { 1: 'first_name', [URL_BUTTON_MAPPING_KEY]: 'pay_link_suffix' }
    const { container, onPatch } = renderConfig({ template_id: 'tpl-dyn', variables })
    fireEvent.change(templateSelect(container), { target: { value: 'tpl-dyn-2' } })
    expect(onPatch).toHaveBeenCalledWith({
      template_id: 'tpl-dyn-2',
      variables: { [URL_BUTTON_MAPPING_KEY]: 'pay_link_suffix' },
    })
  })

  it('resets everything when swapping to a template with no dynamic URL button', () => {
    const variables = { 1: 'first_name', [URL_BUTTON_MAPPING_KEY]: 'pay_link_suffix' }
    const { container, onPatch } = renderConfig({ template_id: 'tpl-dyn', variables })
    fireEvent.change(templateSelect(container), { target: { value: 'tpl-plain' } })
    expect(onPatch).toHaveBeenCalledWith({ template_id: 'tpl-plain', variables: {} })
  })
})

// --- the new field ---------------------------------------------------------

describe('WhatsApp step editor — dynamic URL button field', () => {
  it('renders the field only when the selected template has a dynamic URL button', () => {
    const { container } = renderConfig({ template_id: 'tpl-dyn', variables: {} })
    expect(urlButtonInput(container)).toBeTruthy()
    cleanup()
    const plain = renderConfig({ template_id: 'tpl-plain', variables: {} })
    expect(urlButtonInput(plain.container)).toBeFalsy()
    cleanup()
    const none = renderConfig({ template_id: '', variables: {} })
    expect(urlButtonInput(none.container)).toBeFalsy()
  })

  it('names the button it fills in', () => {
    const { getByText } = renderConfig({ template_id: 'tpl-dyn', variables: {} })
    expect(getByText(/Link value for the .*Pay now.* button/)).toBeTruthy()
  })

  it('reads variables.url_button and writes it back on the same key', () => {
    const variables = { 1: 'first_name', [URL_BUTTON_MAPPING_KEY]: 'pay_link_suffix' }
    const { container, onPatch } = renderConfig({ template_id: 'tpl-dyn', variables })
    const input = urlButtonInput(container)
    expect(input.value).toBe('pay_link_suffix')
    fireEvent.change(input, { target: { value: 'summer2026' } })
    expect(onPatch).toHaveBeenCalledWith({
      variables: { 1: 'first_name', [URL_BUTTON_MAPPING_KEY]: 'summer2026' },
    })
  })

  it('shows the pre-publish send block while the value is missing, and not once it is set', () => {
    const { container } = renderConfig({ template_id: 'tpl-dyn', variables: {} })
    expect(container.textContent).toContain('Meta rejects every message without it')
    cleanup()
    const filled = renderConfig({ template_id: 'tpl-dyn', variables: { [URL_BUTTON_MAPPING_KEY]: 'pay_link_suffix' } })
    expect(filled.container.textContent).not.toContain('Meta rejects every message without it')
  })

  it('offers the contact fields and the two run-resolved reserved names, with descriptions', () => {
    const { container } = renderConfig({ template_id: 'tpl-dyn', variables: {} })
    const list = container.querySelector(`datalist#${urlButtonInput(container).getAttribute('list')}`)
    const values = Array.from(list.querySelectorAll('option')).map(o => o.value)
    expect(values).toContain('first_name')
    expect(values).toContain('pay_amount')
    expect(values).toContain('pay_link_suffix')
    const byValue = Object.fromEntries(
      Array.from(list.querySelectorAll('option')).map(o => [o.value, o.textContent]),
    )
    expect(byValue.pay_amount).toMatch(/amount owed/i)
    expect(byValue.pay_link_suffix).toMatch(/link suffix/i)
  })

  it('offers the same reserved names on the body-variable pickers', () => {
    const { container } = renderConfig({ template_id: 'tpl-dyn', variables: {} })
    const bodyInput = Array.from(container.querySelectorAll('input')).find(i => i.getAttribute('data-field') === '2')
    expect(bodyInput).toBeTruthy()
    const list = container.querySelector(`datalist#${bodyInput.getAttribute('list')}`)
    const values = Array.from(list.querySelectorAll('option')).map(o => o.value)
    expect(values).toEqual(expect.arrayContaining(['first_name', 'pay_amount', 'pay_link_suffix']))
  })

  it('exports the reserved names with the descriptions the operator reads', () => {
    expect(STEP_RESERVED_VARIABLES.map(r => r.value)).toEqual(['pay_amount', 'pay_link_suffix'])
    for (const r of STEP_RESERVED_VARIABLES) expect(r.description.length).toBeGreaterThan(0)
  })
})
