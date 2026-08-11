// Pure-helper tests for the CSV import (mig 095). Covers the
// parser, the auto-mapper, and the row validator. The DB-touching
// orchestration in the API routes is verified by manual smoke +
// the per-row outcome shape returned to the wizard.

import { describe, it, expect } from 'vitest'
import {
  parseCsv,
  autoMapHeaders,
  validateRow,
  deriveName,
  fieldsTouchedByMapping,
  buildCsvTemplate,
  pickRestorableSnapshot,
  IMPORT_FIELD_KEYS,
} from './contact-import.js'

describe('parseCsv', () => {
  it('parses a simple header + one body row', () => {
    const r = parseCsv('email,first_name\na@x.com,Alice')
    expect(r.headers).toEqual(['email', 'first_name'])
    expect(r.rows).toEqual([{ email: 'a@x.com', first_name: 'Alice' }])
  })

  it('handles CRLF line endings', () => {
    const r = parseCsv('email\r\na@x.com\r\nb@y.com\r\n')
    expect(r.rows.map(o => o.email)).toEqual(['a@x.com', 'b@y.com'])
  })

  it('handles quoted fields with commas', () => {
    const r = parseCsv('name,email\n"Smith, Alice",a@x.com')
    expect(r.rows[0].name).toBe('Smith, Alice')
  })

  it('handles escaped quotes inside quoted fields', () => {
    const r = parseCsv('label,email\n"VIP ""Gold""",a@x.com')
    expect(r.rows[0].label).toBe('VIP "Gold"')
  })

  it('pads missing trailing columns with empty strings', () => {
    const r = parseCsv('email,phone,name\na@x.com,+353871234567')
    expect(r.rows[0]).toEqual({ email: 'a@x.com', phone: '+353871234567', name: '' })
  })

  it('drops a trailing blank row from a newline-terminated file', () => {
    const r = parseCsv('email\na@x.com\n')
    expect(r.rows.length).toBe(1)
  })

  it('returns empty headers + rows on empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] })
    expect(parseCsv('   \n\n')).toEqual({ headers: [], rows: [] })
  })
})

describe('autoMapHeaders', () => {
  it('maps common spellings to the right field', () => {
    const m = autoMapHeaders(['Email Address', 'First Name', 'Mobile', 'Surname'])
    expect(m).toEqual({
      'Email Address': 'email',
      'First Name': 'first_name',
      'Mobile': 'phone',
      'Surname': 'last_name',
    })
  })

  it('case-insensitive + whitespace-tolerant', () => {
    const m = autoMapHeaders(['  EMAIL  ', 'Lead   Source', 'GLOFOX  ID'])
    expect(m['  EMAIL  ']).toBe('email')
    expect(m['Lead   Source']).toBe('lead_source')
    expect(m['GLOFOX  ID']).toBe('glofox_member_id')
  })

  it('returns null for unknown headers (operator maps manually)', () => {
    const m = autoMapHeaders(['Membership tier', 'Notes'])
    expect(m['Membership tier']).toBe(null)
    expect(m['Notes']).toBe(null)
  })
})

describe('validateRow', () => {
  const mapping = {
    'Email': 'email',
    'First Name': 'first_name',
    'Last Name': 'last_name',
    'Phone': 'phone',
    'Lead Source': 'lead_source',
    'Tags': 'tags',
  }

  it('happy path — valid row produces a normalised payload', () => {
    const r = validateRow({
      'Email': 'Alice@Example.COM',
      'First Name': 'Alice',
      'Last Name': 'Smith',
      'Phone': '+353871234567',
      'Lead Source': 'website',
      'Tags': 'vip, paid',
    }, mapping)
    expect(r.ok).toBe(true)
    expect(r.payload.email).toBe('alice@example.com')   // lowercased
    expect(r.payload.first_name).toBe('Alice')
    expect(r.payload.tags).toEqual(['vip', 'paid'])
    expect(r.payload.lead_source).toBe('website')
  })

  it('rejects an invalid email', () => {
    const r = validateRow({ 'Email': 'not-an-email' }, { 'Email': 'email' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/email/i)
  })

  it('rejects an unknown lead_source value', () => {
    const r = validateRow({
      'Email': 'a@x.com',
      'Lead Source': 'pigeon_carrier',
    }, mapping)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/lead_source/i)
  })

  it('drops empty cells (operator uploads partial data)', () => {
    const r = validateRow({
      'Email': 'a@x.com',
      'First Name': '   ',
      'Last Name': '',
    }, mapping)
    expect(r.ok).toBe(true)
    expect(r.payload).not.toHaveProperty('first_name')
    expect(r.payload).not.toHaveProperty('last_name')
  })

  it('merges batch tags with row tags + dedupes', () => {
    const r = validateRow(
      { 'Email': 'a@x.com', 'Tags': 'vip, returning' },
      mapping,
      { batchTags: ['lead_magnet_jan26', 'returning'] },
    )
    expect(r.ok).toBe(true)
    expect(r.payload.tags).toEqual(['vip', 'returning', 'lead_magnet_jan26'])
  })

  it('batch-only tags work even when the CSV has no Tags column', () => {
    const r = validateRow(
      { 'Email': 'a@x.com' },
      { 'Email': 'email' },
      { batchTags: ['cold_jan26'] },
    )
    expect(r.ok).toBe(true)
    expect(r.payload.tags).toEqual(['cold_jan26'])
  })

  it('email is required (no email → error)', () => {
    const r = validateRow({ 'First Name': 'Alice' }, { 'First Name': 'first_name' })
    expect(r.ok).toBe(false)
  })
})

describe('deriveName', () => {
  it('joins first + last with a space', () => {
    expect(deriveName('Alice', 'Smith')).toBe('Alice Smith')
  })
  it('returns the non-empty side when one is missing', () => {
    expect(deriveName('Alice', null)).toBe('Alice')
    expect(deriveName(null, 'Smith')).toBe('Smith')
  })
  it('falls back to the email when both names are empty', () => {
    expect(deriveName('', '', 'a@x.com')).toBe('a@x.com')
  })
  it('final fallback is "Imported contact"', () => {
    expect(deriveName(null, null, null)).toBe('Imported contact')
  })
})

describe('fieldsTouchedByMapping', () => {
  it('returns the unique set of mapped contact-field keys', () => {
    const m = { 'A': 'email', 'B': 'first_name', 'C': 'first_name', 'D': null, 'E': 'tags' }
    expect(new Set(fieldsTouchedByMapping(m))).toEqual(new Set(['email', 'first_name', 'tags']))
  })
  it('ignores unknown contact-field keys defensively', () => {
    const m = { 'A': 'email', 'B': 'made_up_field' }
    expect(fieldsTouchedByMapping(m)).toEqual(['email'])
  })
})

describe('buildCsvTemplate', () => {
  it('returns one header row matching IMPORT_FIELDS, no body', () => {
    const t = buildCsvTemplate()
    const lines = t.split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    // Headers are the human labels, NOT the field keys.
    expect(t).toMatch(/Email/)
    expect(t).toMatch(/First name/)
    expect(t).toMatch(/Lead source/)
  })

  it('every IMPORT_FIELDS key is recognised by autoMapHeaders', () => {
    // The template is the source of truth — operators downloading
    // it should be able to fill it in unchanged and have every
    // column auto-map. Catches a regression where we add a field
    // to IMPORT_FIELDS but forget to add the spelling to AUTO_MAP.
    const headers = buildCsvTemplate().trim().split(',')
    const mapped = autoMapHeaders(headers)
    for (const h of headers) {
      expect(mapped[h], `template header '${h}' should auto-map`).toBeTruthy()
    }
    expect(new Set(Object.values(mapped))).toEqual(new Set(IMPORT_FIELD_KEYS))
  })
})

describe('pickRestorableSnapshot — the rollback column allowlist', () => {
  // ROLLBACK-ALLOW.1. `POST /api/contacts/imports/[id]/rollback` used to
  // write `before_snapshot` into `contacts` verbatim. The snapshot is
  // built by the import runner from `fieldsTouchedByMapping(mapping)`
  // (+ tags), so today it only ever carries import fields — but nothing
  // structurally stopped a future writer, or a snapshot taken under an
  // older schema, from putting an arbitrary column in there and having
  // rollback write it back unfiltered. These tests pin the allowlist to
  // its real source (IMPORT_FIELD_KEYS) and pin the "tell someone"
  // behaviour for a key that falls outside it.

  it('restores the four keys live snapshots actually carry', () => {
    const { patch, unknownKeys } = pickRestorableSnapshot({
      email: 'old@x.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      tags: ['vip'],
    })
    expect(patch).toEqual({
      email: 'old@x.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      tags: ['vip'],
    })
    expect(unknownKeys).toEqual([])
  })

  it('accepts every import field — the allowlist IS the import surface', () => {
    const snapshot = Object.fromEntries(IMPORT_FIELD_KEYS.map(k => [k, 'v']))
    const { patch, unknownKeys } = pickRestorableSnapshot(snapshot)
    expect(Object.keys(patch).sort()).toEqual([...IMPORT_FIELD_KEYS].sort())
    expect(unknownKeys).toEqual([])
  })

  it('REFUSES email_status — restoring it would bypass mig 528', () => {
    // Mig 528's BEFORE UPDATE OF email trigger clears a stale
    // bounced/complained stamp when the address changes, and rollback
    // changes the address. An email_status in the snapshot written back
    // in the same UPDATE would make the trigger's NEW-guard false and
    // silently reinstate a stamp from a different mailbox — permanently,
    // with no symptom. The interaction is intended; this keeps it intact.
    const { patch, unknownKeys } = pickRestorableSnapshot({
      email: 'old@x.com',
      email_status: 'bounced',
    })
    expect(patch).toEqual({ email: 'old@x.com' })
    expect(patch.email_status).toBeUndefined()
    expect(unknownKeys).toEqual(['email_status'])
  })

  it('refuses identity + tenancy columns', () => {
    const { patch, unknownKeys } = pickRestorableSnapshot({
      id: 'other-contact',
      location_id: 'other-location',
      created_via_import_id: 'other-import',
      pipeline_stage_slug: 'member',
      email: 'old@x.com',
    })
    expect(patch).toEqual({ email: 'old@x.com' })
    expect(unknownKeys.sort()).toEqual(
      ['created_via_import_id', 'id', 'location_id', 'pipeline_stage_slug'],
    )
  })

  it('REPORTS unexpected keys rather than dropping them silently', () => {
    // A snapshot key nobody can restore is worth knowing about — it means
    // a writer and this allowlist have drifted apart.
    const { unknownKeys } = pickRestorableSnapshot({ some_future_column: 1 })
    expect(unknownKeys).toEqual(['some_future_column'])
  })

  it('preserves falsy and null values — a snapshot null is a real prior value', () => {
    const { patch } = pickRestorableSnapshot({ phone: null, label: '', first_name: 'Ada' })
    expect(patch).toEqual({ phone: null, label: '', first_name: 'Ada' })
    expect('phone' in patch).toBe(true)
  })

  it('survives a null / non-object / array snapshot without throwing', () => {
    for (const bad of [null, undefined, 'nope', 42, ['email']]) {
      expect(pickRestorableSnapshot(bad)).toEqual({ patch: {}, unknownKeys: [] })
    }
  })

  it('does not mutate the snapshot it was handed', () => {
    const snapshot = { email: 'old@x.com', email_status: 'bounced' }
    pickRestorableSnapshot(snapshot)
    expect(snapshot).toEqual({ email: 'old@x.com', email_status: 'bounced' })
  })
})
