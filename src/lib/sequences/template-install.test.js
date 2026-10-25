import { describe, it, expect } from 'vitest'
import { resolveWhatsappTemplateIds, missingWhatsappTemplateNames } from './template-install.js'

describe('resolveWhatsappTemplateIds (DUNNING.6)', () => {
  const rows = [
    { id: 'w-1', name: 'outstanding_payment_', status: 'APPROVED' },
    { id: 'w-2', name: 'promo', status: 'APPROVED' },
    { id: 'w-3', name: 'pending_one', status: 'PENDING' },
  ]
  it('resolves a whatsapp step by template name to the APPROVED row id', () => {
    const out = resolveWhatsappTemplateIds([{ step_type: 'whatsapp', whatsapp_template_name: 'outstanding_payment_' }], rows)
    expect(out[0].whatsapp_template_id).toBe('w-1')
    expect(out[0].whatsapp_template_name).toBeUndefined()
  })
  it('leaves the id null when the name is missing at this location or not APPROVED (pre-publish validation flags it)', () => {
    const out = resolveWhatsappTemplateIds([
      { step_type: 'whatsapp', whatsapp_template_name: 'nope' },
      { step_type: 'whatsapp', whatsapp_template_name: 'pending_one' },
    ], rows)
    expect(out.map((s) => s.whatsapp_template_id)).toEqual([null, null])
  })
  it('an explicit whatsapp_template_id wins; non-whatsapp steps pass through untouched', () => {
    const out = resolveWhatsappTemplateIds([
      { step_type: 'whatsapp', whatsapp_template_id: 'explicit', whatsapp_template_name: 'outstanding_payment_' },
      { step_type: 'email', subject: 'x' },
    ], rows)
    expect(out[0].whatsapp_template_id).toBe('explicit')
    expect(out[1]).toEqual({ step_type: 'email', subject: 'x' })
  })
  it('tolerates empty input', () => {
    expect(resolveWhatsappTemplateIds([], rows)).toEqual([])
    expect(resolveWhatsappTemplateIds(null, rows)).toEqual([])
    expect(resolveWhatsappTemplateIds([{ step_type: 'whatsapp', whatsapp_template_name: 'x' }], null)[0].whatsapp_template_id).toBeNull()
  })
})

describe('PAYLINK.8 — missingWhatsappTemplateNames', () => {
  const rows = [{ id: 'a', name: 'outstanding_payment_', status: 'APPROVED' }, { id: 'b', name: 'outstanding_payment_link_', status: 'PENDING' }]
  it('names the gallery templates that are not APPROVED here, once each', () => {
    const steps = [
      { step_type: 'whatsapp', whatsapp_template_name: 'outstanding_payment_link_' },
      { step_type: 'email' },
      { step_type: 'whatsapp', whatsapp_template_name: 'outstanding_payment_link_' },
      { step_type: 'whatsapp', whatsapp_template_name: 'outstanding_payment_' },
    ]
    expect(missingWhatsappTemplateNames(steps, rows)).toEqual(['outstanding_payment_link_'])
  })
  it('is empty when every named template is approved, or nothing is named', () => {
    expect(missingWhatsappTemplateNames([{ step_type: 'whatsapp', whatsapp_template_name: 'outstanding_payment_' }], rows)).toEqual([])
    expect(missingWhatsappTemplateNames([{ step_type: 'email' }], rows)).toEqual([])
    expect(missingWhatsappTemplateNames([], null)).toEqual([])
  })
  it('a step that already carries a whatsapp_template_id is not missing even if its name is unknown here', () => {
    expect(missingWhatsappTemplateNames([{ step_type: 'whatsapp', whatsapp_template_name: 'zzz', whatsapp_template_id: 'x' }], rows)).toEqual([])
  })
})
