// GAPS-P6 — the consent export CSV.
//
// This file is a subject-access-request artefact: what we hand a person (or a
// regulator) when they ask "what have you recorded about my consent". Two
// things therefore get pinned hard here.
//
// 1. FORMULA INJECTION. The cells carry operator- and customer-influenced
//    text (source strings, staff names, email addresses). Excel, LibreOffice
//    and Google Sheets all evaluate a cell whose first character is =, +, -
//    or @ — so a staff member named `=cmd|'/c calc'!A1` becomes code the
//    moment a compliance officer opens the file. Quoting alone does NOT stop
//    it: `"=1+1"` still evaluates. The neutraliser has to change the leading
//    character's meaning, and it has to run BEFORE the RFC-4180 quoting.
//
// 2. THE LEGACY VOCABULARY. Rows written before mig 516 say 'opted_out'. The
//    export must show them as opt-outs regardless of whether the backfill has
//    run — the whole defect is that a filter on one spelling silently loses
//    83 real withdrawals of consent.

import { describe, it, expect } from 'vitest'
import { buildConsentCsv, CONSENT_CSV_HEADER } from './consent-csv.js'

const CONTACT = { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' }

function parse(csv) {
  return csv.split('\r\n').filter((l) => l !== '')
}

describe('buildConsentCsv — shape', () => {
  it('emits the header even when there is no history', () => {
    const lines = parse(buildConsentCsv(CONTACT, []))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(CONSENT_CSV_HEADER.join(','))
  })

  it('carries the five facts the export exists for, plus the actor', () => {
    expect(CONSENT_CSV_HEADER).toEqual([
      'recorded_at',
      'channel',
      'action',
      'source',
      'location',
      'performed_by_name',
      'performed_by_email',
      'ip_address',
    ])
  })

  it('writes one row per consent event, in the order given', () => {
    const csv = buildConsentCsv(CONTACT, [
      {
        created_at: '2026-08-01T10:00:00.000Z', channel: 'email_marketing', action: 'opt_in',
        source: 'booking_form', location_name: 'Stillorgan',
        performed_by_name: null, performed_by_email: null, ip_address: '1.2.3.4',
      },
      {
        created_at: '2026-08-02T11:30:00.000Z', channel: 'email_marketing', action: 'opt_out',
        source: 'one_click_unsubscribe', location_name: 'Stillorgan',
        performed_by_name: 'Sam Staff', performed_by_email: 'sam@un1t.com', ip_address: null,
      },
    ])
    const lines = parse(csv)
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('2026-08-01T10:00:00.000Z,email_marketing,opt_in,booking_form,Stillorgan,,,1.2.3.4')
    expect(lines[2]).toBe('2026-08-02T11:30:00.000Z,email_marketing,opt_out,one_click_unsubscribe,Stillorgan,Sam Staff,sam@un1t.com,')
  })

  it('renders a missing location as blank rather than the word null', () => {
    // consent_log.location_id is nullable — every row written before mig 487
    // has none, and those are the majority of the table.
    const csv = buildConsentCsv(CONTACT, [
      { created_at: '2026-01-01T00:00:00Z', channel: 'sms_marketing', action: 'opt_out', source: 'admin_panel', location_name: null },
    ])
    expect(parse(csv)[1]).toBe('2026-01-01T00:00:00Z,sms_marketing,opt_out,admin_panel,,,,')
  })
})

describe('buildConsentCsv — the legacy vocabulary', () => {
  it('normalises opted_out / opted_in onto the canonical spelling', () => {
    const csv = buildConsentCsv(CONTACT, [
      { created_at: '2026-03-01T00:00:00Z', channel: 'whatsapp_marketing', action: 'opted_out', source: 'whatsapp_keyword' },
      { created_at: '2026-03-02T00:00:00Z', channel: 'whatsapp_marketing', action: 'opted_in', source: 'whatsapp_keyword' },
    ])
    const lines = parse(csv)
    expect(lines[1]).toContain(',opt_out,')
    expect(lines[2]).toContain(',opt_in,')
    expect(csv).not.toContain('opted_out')
    expect(csv).not.toContain('opted_in')
  })

  it('shows an unrecognised action verbatim instead of guessing a direction', () => {
    const csv = buildConsentCsv(CONTACT, [
      { created_at: '2026-03-01T00:00:00Z', channel: 'email_marketing', action: 'objection_lodged', source: 'admin_panel' },
    ])
    expect(parse(csv)[1]).toContain(',objection_lodged,')
  })
})

describe('buildConsentCsv — spreadsheet formula injection', () => {
  // One case per trigger character, in the field an attacker can most
  // plausibly reach: `source` is written by code, but `performed_by_name`
  // comes from a profile a person typed, and `ip_address` from a header.
  const PAYLOADS = [
    ['=', '=1+1'],
    ['+', '+1+1'],
    ['-', '-1+1'],
    ['@', '@SUM(A1:A9)'],
    ['tab', '\tSUM(A1)'],
    ['CR', '\rSUM(A1)'],
  ]

  it.each(PAYLOADS)('neutralises a leading %s in performed_by_name', (_label, payload) => {
    const csv = buildConsentCsv(CONTACT, [
      { created_at: '2026-01-01T00:00:00Z', channel: 'email_marketing', action: 'opt_out', source: 'admin_panel', performed_by_name: payload },
    ])
    const row = parse(csv)[1]
    // The neutralised cell must not begin with the trigger — whether it ends
    // up quoted (CR/tab force quoting) or bare.
    const cells = row.split(',')
    const nameCell = cells.slice(5).join(',')
    expect(nameCell.replace(/^"/, '').startsWith(payload[0])).toBe(false)
    expect(nameCell).toContain("'")
  })

  it('neutralises every injectable column, not just the ones we expect to be dirty', () => {
    const csv = buildConsentCsv(CONTACT, [{
      created_at: '=BAD()', channel: '=BAD()', action: '=BAD()', source: '=BAD()',
      location_name: '=BAD()', performed_by_name: '=BAD()', performed_by_email: '=BAD()', ip_address: '=BAD()',
    }])
    // No cell in the data row may start a formula. Split on the delimiter and
    // check each cell's first character after any opening quote.
    const dataRow = parse(csv)[1]
    for (const cell of dataRow.split(',')) {
      expect(/^"?[=+\-@]/.test(cell)).toBe(false)
    }
  })

  it('still quotes and escapes as RFC 4180 requires', () => {
    const csv = buildConsentCsv(CONTACT, [{
      created_at: '2026-01-01T00:00:00Z', channel: 'email_marketing', action: 'opt_out',
      source: 'admin_panel', performed_by_name: 'Doe, Jane "JD"',
    }])
    expect(parse(csv)[1]).toContain('"Doe, Jane ""JD"""')
  })

  it('does not let a newline in a field forge an extra row', () => {
    const csv = buildConsentCsv(CONTACT, [{
      created_at: '2026-01-01T00:00:00Z', channel: 'email_marketing', action: 'opt_out',
      source: 'admin_panel', performed_by_name: 'Real Name\r\n2026-01-01,email_marketing,opt_in,forged',
    }])
    // The embedded newline lives inside a quoted field, so the record count
    // is still header + 1 when parsed properly. Assert on the raw text: the
    // forged content must be inside quotes.
    expect(csv).toContain('"Real Name')
    expect(csv.split('"').length % 2).toBe(1) // balanced quotes
  })
})

describe('consentCsvFilename', () => {
  it('slugs the contact name and never emits path separators or quotes', async () => {
    const { consentCsvFilename } = await import('./consent-csv.js')
    expect(consentCsvFilename({ first_name: 'Ada', last_name: 'Lovelace', id: 'c1' }))
      .toBe('consent-log-ada-lovelace.csv')
    expect(consentCsvFilename({ first_name: '../../etc', last_name: 'pa"sswd', id: 'c1' }))
      .toBe('consent-log-etc-pa-sswd.csv')
    // No name at all → fall back to the id, never an empty filename.
    expect(consentCsvFilename({ id: 'abc-123' })).toBe('consent-log-abc-123.csv')
  })
})
