// Unit tests for src/lib/bca.js — config gating + validation + render.

import { describe, it, expect } from 'vitest'
import {
  isBcaSubmitEnabled,
  getBcaConfig,
  validateBcaConfig,
  renderBcaTemplate,
  nextBcaSlotSlug,
  DEFAULT_BCA_CONFIG,
  BCA_STORAGE,
  MIN_BCA_DOCUMENTS,
  MAX_BCA_DOCUMENTS,
} from './bca'

describe('isBcaSubmitEnabled', () => {
  it('returns false when location is null/undefined', () => {
    expect(isBcaSubmitEnabled(null)).toBe(false)
    expect(isBcaSubmitEnabled(undefined)).toBe(false)
  })
  it('returns false when features map is missing or empty', () => {
    expect(isBcaSubmitEnabled({})).toBe(false)
    expect(isBcaSubmitEnabled({ features: {} })).toBe(false)
  })
  it('returns false when the key is explicitly false', () => {
    expect(isBcaSubmitEnabled({ features: { bca_submit: false } })).toBe(false)
  })
  it('returns false when the key is non-boolean truthy (defensive)', () => {
    // Different from isFeatureEnabledAtLocation which defaults to "on".
    // BCA is opt-in only, so we require the literal `true`.
    expect(isBcaSubmitEnabled({ features: { bca_submit: 1 } })).toBe(false)
    expect(isBcaSubmitEnabled({ features: { bca_submit: 'true' } })).toBe(false)
  })
  it('returns true only on explicit true', () => {
    expect(isBcaSubmitEnabled({ features: { bca_submit: true } })).toBe(true)
  })
})

describe('getBcaConfig', () => {
  it('returns null when the feature is off', () => {
    expect(getBcaConfig(null)).toBeNull()
    expect(getBcaConfig({ features: {} })).toBeNull()
    expect(getBcaConfig({ features: { bca_submit: false } })).toBeNull()
  })
  it('returns full defaults when feature on but bca_config is null', () => {
    const c = getBcaConfig({ features: { bca_submit: true }, bca_config: null })
    expect(c).not.toBeNull()
    expect(c.documents).toHaveLength(10)
    expect(c.documents[0]).toEqual({ slug: 'doc_01', label: 'Document 1 (placeholder)' })
    expect(c.send_from).toBe('')
    expect(c.cc).toBe('')
    expect(c.subject_template).toBe(DEFAULT_BCA_CONFIG.subject_template)
  })
  it('merges partial stored config with defaults (including cc default empty)', () => {
    const c = getBcaConfig({
      features: { bca_submit: true },
      bca_config: { send_from: 'ops@example.com', send_to: 'bca@example.com' },
    })
    expect(c.send_from).toBe('ops@example.com')
    expect(c.send_to).toBe('bca@example.com')
    expect(c.cc).toBe('')  // not set → default empty
    expect(c.subject_template).toBe(DEFAULT_BCA_CONFIG.subject_template)  // default
    expect(c.documents).toHaveLength(10)  // default
  })
  it('preserves stored cc value', () => {
    const c = getBcaConfig({
      features: { bca_submit: true },
      bca_config: { cc: 'ops-team@example.com' },
    })
    expect(c.cc).toBe('ops-team@example.com')
  })
  it('repairs corrupted documents array (length 0 is below min)', () => {
    const c = getBcaConfig({
      features: { bca_submit: true },
      bca_config: { documents: [] },  // 0 entries → below MIN
    })
    expect(c.documents).toHaveLength(10)  // back to default
    expect(c.documents[0].slug).toBe('doc_01')
  })
  it('repairs corrupted documents array (above max)', () => {
    const c = getBcaConfig({
      features: { bca_submit: true },
      bca_config: { documents: Array.from({ length: 25 }, (_, i) => ({ slug: `doc_${String(i + 1).padStart(2, '0')}`, label: `L${i}` })) },
    })
    expect(c.documents).toHaveLength(10)  // back to default (above MAX_BCA_DOCUMENTS=20)
  })
  it('accepts a non-default document count within bounds', () => {
    const stored = Array.from({ length: 7 }, (_, i) => ({ slug: `doc_${String(i + 1).padStart(2, '0')}`, label: `L${i}` }))
    const c = getBcaConfig({
      features: { bca_submit: true },
      bca_config: { documents: stored },
    })
    expect(c.documents).toHaveLength(7)
    expect(c.documents[0].label).toBe('L0')
  })
  it('repairs corrupted slugs (regex mismatch)', () => {
    const c = getBcaConfig({
      features: { bca_submit: true },
      bca_config: { documents: Array.from({ length: 10 }, (_, i) => ({ slug: 'bad', label: `L${i}` })) },
    })
    expect(c.documents.map(d => d.slug)).toEqual([
      'doc_01','doc_02','doc_03','doc_04','doc_05','doc_06','doc_07','doc_08','doc_09','doc_10',
    ])
    // Labels survive — only slugs were the corruption.
    expect(c.documents[0].label).toBe('L0')
  })
  it('repairs missing labels (falls back to default placeholder)', () => {
    const c = getBcaConfig({
      features: { bca_submit: true },
      bca_config: { documents: Array.from({ length: 10 }, (_, i) => ({ slug: `doc_${String(i+1).padStart(2,'0')}`, label: '' })) },
    })
    expect(c.documents[0].label).toBe('Document 1 (placeholder)')
  })
})

describe('validateBcaConfig', () => {
  function valid(overrides = {}) {
    return {
      send_from: 'ops@ccfautos.com',
      send_to: 'bca@example.com',
      subject_template: 'BCA — {{uk_reg}}',
      body_template: 'Hi, please find attached.',
      documents: Array.from({ length: 10 }, (_, i) => ({
        slug: `doc_${String(i + 1).padStart(2, '0')}`,
        label: `Label ${i + 1}`,
      })),
      ...overrides,
    }
  }

  it('accepts a clean payload + trims emails/subject', () => {
    const r = validateBcaConfig(valid({
      send_from: '  ops@ccfautos.com  ',
      subject_template: '  Hello  ',
    }))
    expect(r.ok).toBe(true)
    expect(r.value.send_from).toBe('ops@ccfautos.com')
    expect(r.value.subject_template).toBe('Hello')
  })

  it('rejects missing send_from', () => {
    const r = validateBcaConfig(valid({ send_from: '' }))
    expect(r.ok).toBe(false)
    expect(r.errors.send_from).toMatch(/required/)
  })

  it('rejects malformed emails', () => {
    expect(validateBcaConfig(valid({ send_from: 'not-an-email' })).ok).toBe(false)
    expect(validateBcaConfig(valid({ send_to: 'bca@' })).ok).toBe(false)
  })

  it('rejects subject with newlines', () => {
    const r = validateBcaConfig(valid({ subject_template: 'A\nB' }))
    expect(r.ok).toBe(false)
    expect(r.errors.subject_template).toMatch(/newline/)
  })

  it('rejects empty body', () => {
    expect(validateBcaConfig(valid({ body_template: '' })).ok).toBe(false)
    expect(validateBcaConfig(valid({ body_template: '   \n  ' })).ok).toBe(false)
  })

  it('keeps body whitespace intact when valid', () => {
    const r = validateBcaConfig(valid({ body_template: 'Line A\n\nLine B' }))
    expect(r.ok).toBe(true)
    expect(r.value.body_template).toBe('Line A\n\nLine B')
  })

  it('rejects empty document list (below min)', () => {
    const r = validateBcaConfig(valid({ documents: [] }))
    expect(r.ok).toBe(false)
    expect(r.errors.documents).toMatch(/between/)
  })
  it('rejects over-MAX document list', () => {
    const docs = Array.from({ length: 21 }, (_, i) => ({ slug: `doc_${String(i+1).padStart(2,'0')}`, label: 'x' }))
    const r = validateBcaConfig(valid({ documents: docs }))
    expect(r.ok).toBe(false)
    expect(r.errors.documents).toMatch(/between/)
  })
  it('accepts a non-default valid count (8 docs)', () => {
    const docs = Array.from({ length: 8 }, (_, i) => ({ slug: `doc_${String(i+1).padStart(2,'0')}`, label: `L${i}` }))
    const r = validateBcaConfig(valid({ documents: docs }))
    expect(r.ok).toBe(true)
    expect(r.value.documents).toHaveLength(8)
  })
  it('accepts cc when empty (means: no CC line)', () => {
    const r = validateBcaConfig(valid({ cc: '' }))
    expect(r.ok).toBe(true)
    expect(r.value.cc).toBe('')
  })
  it('accepts cc when missing entirely', () => {
    const payload = valid()
    delete payload.cc
    const r = validateBcaConfig(payload)
    expect(r.ok).toBe(true)
    expect(r.value.cc).toBe('')
  })
  it('accepts a valid cc address + trims it', () => {
    const r = validateBcaConfig(valid({ cc: '  ops@example.com  ' }))
    expect(r.ok).toBe(true)
    expect(r.value.cc).toBe('ops@example.com')
  })
  it('rejects a malformed cc address', () => {
    const r = validateBcaConfig(valid({ cc: 'not-an-email' }))
    expect(r.ok).toBe(false)
    expect(r.errors.cc).toMatch(/email/)
  })

  it('rejects malformed slug', () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({ slug: i === 4 ? 'bad' : `doc_${String(i+1).padStart(2,'0')}`, label: 'x' }))
    const r = validateBcaConfig(valid({ documents: docs }))
    expect(r.ok).toBe(false)
    expect(r.errors.documents).toMatch(/slug/i)
  })

  it('rejects duplicate slugs', () => {
    const docs = Array.from({ length: 10 }, () => ({ slug: 'doc_01', label: 'x' }))
    const r = validateBcaConfig(valid({ documents: docs }))
    expect(r.ok).toBe(false)
    expect(r.errors.documents).toMatch(/duplicate/i)
  })

  it('rejects empty label', () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      slug: `doc_${String(i+1).padStart(2,'0')}`,
      label: i === 2 ? '' : 'x',
    }))
    const r = validateBcaConfig(valid({ documents: docs }))
    expect(r.ok).toBe(false)
    expect(r.errors.documents).toMatch(/Slot 3/)
  })

  it('rejects label > 80 chars', () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      slug: `doc_${String(i+1).padStart(2,'0')}`,
      label: i === 0 ? 'x'.repeat(81) : 'x',
    }))
    const r = validateBcaConfig(valid({ documents: docs }))
    expect(r.ok).toBe(false)
  })
})

describe('renderBcaTemplate', () => {
  const car = {
    uk_reg: 'AB12 XYZ',
    vin: 'WBA123',
    make: 'Tesla',
    model: 'Model 3',
    vehicle_year: 2023,
    buyer_name: null,            // legitimately missing
    xero_invoice_number: 'INV-1',
  }
  it('substitutes known merge tags', () => {
    expect(renderBcaTemplate('VAT for {{uk_reg}}', car)).toBe('VAT for AB12 XYZ')
  })
  it('renders missing values as empty string', () => {
    expect(renderBcaTemplate('Buyer: {{buyer_name}}.', car)).toBe('Buyer: .')
  })
  it('leaves unknown tags untouched', () => {
    expect(renderBcaTemplate('Hi {{foo_bar}}', car)).toBe('Hi {{foo_bar}}')
  })
  it('handles non-string template input', () => {
    expect(renderBcaTemplate(null, car)).toBe('')
    expect(renderBcaTemplate(undefined, car)).toBe('')
  })
  it('handles null car gracefully', () => {
    expect(renderBcaTemplate('Hi {{uk_reg}}', null)).toBe('Hi {{uk_reg}}')
  })
})

describe('nextBcaSlotSlug', () => {
  it('returns doc_01 for an empty list', () => {
    expect(nextBcaSlotSlug([])).toBe('doc_01')
    expect(nextBcaSlotSlug(null)).toBe('doc_01')
  })
  it('returns the first gap in a sparse list', () => {
    expect(nextBcaSlotSlug([
      { slug: 'doc_01' }, { slug: 'doc_02' }, { slug: 'doc_04' },
    ])).toBe('doc_03')
  })
  it('returns the next slug after the highest used when contiguous', () => {
    const docs = Array.from({ length: 5 }, (_, i) => ({ slug: `doc_${String(i + 1).padStart(2, '0')}` }))
    expect(nextBcaSlotSlug(docs)).toBe('doc_06')
  })
  it('returns null when all 99 slots are taken', () => {
    const docs = Array.from({ length: 99 }, (_, i) => ({ slug: `doc_${String(i + 1).padStart(2, '0')}` }))
    expect(nextBcaSlotSlug(docs)).toBeNull()
  })
})

describe('MIN/MAX bounds', () => {
  it('exports sane bounds', () => {
    expect(MIN_BCA_DOCUMENTS).toBe(1)
    expect(MAX_BCA_DOCUMENTS).toBe(20)
  })
})

describe('BCA_STORAGE path helpers', () => {
  it('builds the staging path', () => {
    expect(BCA_STORAGE.staging('LOC', 'CAR', 'doc_01', 'pdf')).toBe('LOC/CAR/_staging/doc_01.pdf')
  })
  it('builds the submission path', () => {
    expect(BCA_STORAGE.submission('LOC', 'CAR', 'SUB', 'doc_01', 'jpg')).toBe('LOC/CAR/SUB/doc_01.jpg')
  })
  it('builds the merged-pdf path', () => {
    expect(BCA_STORAGE.mergedPdf('LOC', 'CAR', 'SUB')).toBe('LOC/CAR/SUB/merged.pdf')
  })
})
