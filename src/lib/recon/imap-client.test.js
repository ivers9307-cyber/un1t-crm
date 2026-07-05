// RCOV.P1 — imap-client.js test coverage.
//
// Only the PURE part is unit-tested here: documentParts(), the
// bodyStructure-tree walker. Everything else in imap-client.js touches
// imapflow/the network and is exercised live via the add-inbox route's
// verifyMailboxLogin() (manual/integration, not unit-tested).
import { describe, it, expect } from 'vitest'
import { documentParts } from './imap-client'

describe('documentParts', () => {
  it('finds pdf and nested image parts in a multipart tree, excludes the text part', () => {
    // multipart/mixed
    //   ├─ text/plain                          (part '1' — excluded)
    //   ├─ application/pdf, part '2'           (dispositionParameters.filename)
    //   └─ multipart/mixed, part '3'
    //        └─ image/jpeg, part '3.1'          (deeper nesting)
    const bodyStructure = {
      type: 'multipart/mixed',
      part: '',
      childNodes: [
        { type: 'text/plain', part: '1', size: 120 },
        {
          type: 'application/pdf',
          part: '2',
          size: 45210,
          dispositionParameters: { filename: 'invoice-123.pdf' },
        },
        {
          type: 'multipart/mixed',
          part: '3',
          childNodes: [
            {
              type: 'image/jpeg',
              part: '3.1',
              size: 88410,
              dispositionParameters: { filename: 'receipt.jpg' },
            },
          ],
        },
      ],
    }

    const parts = documentParts(bodyStructure)

    expect(parts).toHaveLength(2)
    const pdf = parts.find((p) => p.part === '2')
    expect(pdf).toMatchObject({ part: '2', contentType: 'application/pdf', filename: 'invoice-123.pdf', size: 45210 })
    const img = parts.find((p) => p.part === '3.1')
    expect(img).toMatchObject({ part: '3.1', contentType: 'image/jpeg', filename: 'receipt.jpg', size: 88410 })
    // text/plain must not be treated as a candidate document
    expect(parts.find((p) => p.part === '1')).toBeUndefined()
  })

  it('falls back to parameters.name when dispositionParameters is absent', () => {
    const bodyStructure = {
      type: 'multipart/mixed',
      part: '',
      childNodes: [
        {
          type: 'application/pdf',
          part: '2',
          size: 1000,
          parameters: { name: 'statement.pdf' },
        },
      ],
    }

    const parts = documentParts(bodyStructure)

    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ part: '2', contentType: 'application/pdf', filename: 'statement.pdf' })
  })

  it('returns [] for a structure with no candidate attachment types', () => {
    const bodyStructure = {
      type: 'multipart/alternative',
      part: '',
      childNodes: [
        { type: 'text/plain', part: '1' },
        { type: 'text/html', part: '2' },
      ],
    }

    expect(documentParts(bodyStructure)).toEqual([])
  })

  it('returns [] for null or undefined input', () => {
    expect(documentParts(null)).toEqual([])
    expect(documentParts(undefined)).toEqual([])
  })
})
