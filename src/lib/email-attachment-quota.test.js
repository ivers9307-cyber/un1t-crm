// EMAIL-ATTACH.1 — the pure attachment/quota rules.
//
// THE HALF OF THIS FILE THAT IS A SECURITY TEST
// `Name` and `ContentType` arrive in an unauthenticated stranger's Postmark
// payload. The tests below are the ones that say a hostile filename can never
// reach a storage key, can never break the insert that files the email, and
// can never render as a different file than it is.

import { describe, it, expect } from 'vitest'
import {
  EMAIL_MAILBOX_QUOTA_BYTES,
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_FILENAME_MAX,
  attachmentExtension,
  attachmentObjectPath,
  exceedsQuota,
  formatBytes,
  quotaMessage,
  quotaStatus,
  safeAttachmentFilename,
  safeMimeType,
  SKIPPED_REASONS,
} from './email-attachment-quota'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const MSG = 'b0000000-0000-4000-8000-000000000002'

describe('safeAttachmentFilename — hostile input is DATA, never addressing', () => {
  it('keeps an ordinary filename intact', () => {
    expect(safeAttachmentFilename('Invoice March 2026.pdf')).toBe('Invoice March 2026.pdf')
  })

  it('strips NUL and other control characters', () => {
    // Postgres text cannot hold a NUL at all — left in, this would fail the
    // INSERT and take the whole attachment record with it.
    expect(safeAttachmentFilename('inv\u0000oice\u0007.pdf')).toBe('invoice.pdf')
  })

  it('strips bidirectional overrides — the exe-that-looks-like-png trick', () => {
    // U+202E renders "…gnp.exe" as "…exe.png". The bytes are still an exe.
    const spoofed = 'report\u202egnp.exe'
    const cleaned = safeAttachmentFilename(spoofed)
    expect(cleaned).toBe('reportgnp.exe')
    expect(cleaned).not.toContain('\u202e')
  })

  it('neutralises path separators and traversal', () => {
    expect(safeAttachmentFilename('../../etc/passwd')).not.toContain('/')
    expect(safeAttachmentFilename('..\\..\\windows\\system32')).not.toContain('\\')
    expect(safeAttachmentFilename('/absolute/path.pdf')).not.toMatch(/^\//)
  })

  it('falls back rather than returning an empty or dot-only name', () => {
    expect(safeAttachmentFilename('..')).toBe('attachment')
    expect(safeAttachmentFilename('   ')).toBe('attachment')
    expect(safeAttachmentFilename('\u0000')).toBe('attachment')
    expect(safeAttachmentFilename(null)).toBe('attachment')
    expect(safeAttachmentFilename(undefined)).toBe('attachment')
    expect(safeAttachmentFilename({ toString: () => 'x' })).toBe('attachment')
  })

  it('drops lone surrogates, which cannot be encoded as UTF-8', () => {
    const cleaned = safeAttachmentFilename('bad\ud800name.pdf')
    expect(cleaned).toBe('badname.pdf')
    expect([...cleaned].every(ch => {
      const cp = ch.codePointAt(0)
      return !(cp >= 0xd800 && cp <= 0xdfff)
    })).toBe(true)
  })

  it('keeps a valid surrogate pair (a real emoji filename survives)', () => {
    expect(safeAttachmentFilename('holiday 🏖 photo.jpg')).toBe('holiday 🏖 photo.jpg')
  })

  it('truncates by CODE POINT, so the cut can never manufacture a lone surrogate', () => {
    const long = '🏖'.repeat(400) + '.pdf'
    const cleaned = safeAttachmentFilename(long)
    expect([...cleaned]).toHaveLength(ATTACHMENT_FILENAME_MAX)
    expect([...cleaned].every(ch => {
      const cp = ch.codePointAt(0)
      return !(cp >= 0xd800 && cp <= 0xdfff)
    })).toBe(true)
    // The DB CHECK is length(filename) <= 255, and Postgres length() counts
    // characters — so 200 code points is inside it whatever the byte width.
    expect([...cleaned].length).toBeLessThanOrEqual(255)
  })

  it('collapses whitespace runs so an extension cannot be pushed out of view', () => {
    expect(safeAttachmentFilename('invoice' + ' '.repeat(80) + '.exe'))
      .toBe('invoice .exe')
  })
})

describe('safeMimeType', () => {
  it('lowercases and drops parameters', () => {
    expect(safeMimeType('APPLICATION/PDF; charset=utf-8')).toBe('application/pdf')
  })
  it('falls back for anything that is not type/subtype', () => {
    expect(safeMimeType('../../etc')).toBe('application/octet-stream')
    expect(safeMimeType('')).toBe('application/octet-stream')
    expect(safeMimeType(null)).toBe('application/octet-stream')
    expect(safeMimeType('application/pdf/../..')).toBe('application/octet-stream')
  })
})

describe('attachmentExtension', () => {
  it('maps the common cases the way an operator expects', () => {
    expect(attachmentExtension('image/jpeg')).toBe('jpg')
    expect(attachmentExtension('text/plain')).toBe('txt')
    expect(attachmentExtension('application/pdf')).toBe('pdf')
  })
  it('never emits a dot, a slash or a traversal token', () => {
    for (const mime of ['application/x-msdownload', '../../evil', 'a/..', 'x/./y', null]) {
      const ext = attachmentExtension(mime)
      expect(ext).toMatch(/^[a-z0-9]{1,8}$/)
    }
  })
})

describe('attachmentObjectPath — built from ids, never from the filename', () => {
  it('is <location>/<message>/<index>.<ext>', () => {
    expect(attachmentObjectPath({ locationId: LOC, messageId: MSG, index: 0, mime: 'application/pdf' }))
      .toBe(`${LOC}/${MSG}/0.pdf`)
  })

  it('is DETERMINISTIC — a re-processed delivery rewrites the same key', () => {
    const args = { locationId: LOC, messageId: MSG, index: 2, mime: 'image/png' }
    expect(attachmentObjectPath(args)).toBe(attachmentObjectPath(args))
  })

  it('refuses an id that is not a bare path segment', () => {
    expect(() => attachmentObjectPath({ locationId: '../..', messageId: MSG, index: 0 })).toThrow()
    expect(() => attachmentObjectPath({ locationId: LOC, messageId: 'a/b', index: 0 })).toThrow()
    expect(() => attachmentObjectPath({ locationId: LOC, messageId: '', index: 0 })).toThrow()
    expect(() => attachmentObjectPath({ locationId: LOC, messageId: MSG, index: -1 })).toThrow()
    expect(() => attachmentObjectPath({ locationId: LOC, messageId: MSG, index: 1.5 })).toThrow()
    expect(() => attachmentObjectPath()).toThrow()
  })

  it('cannot be steered by the filename at all — it does not take one', () => {
    const path = attachmentObjectPath({ locationId: LOC, messageId: MSG, index: 0, mime: 'application/pdf' })
    expect(path).not.toContain('..')
    expect(path.split('/')).toHaveLength(3)
  })
})

describe('exceedsQuota — judged on the POST-increment total', () => {
  it('allows a total exactly at the ceiling', () => {
    expect(exceedsQuota(EMAIL_MAILBOX_QUOTA_BYTES, EMAIL_MAILBOX_QUOTA_BYTES)).toBe(false)
  })
  it('refuses one byte over', () => {
    expect(exceedsQuota(EMAIL_MAILBOX_QUOTA_BYTES + 1, EMAIL_MAILBOX_QUOTA_BYTES)).toBe(true)
  })
  it('refuses when the total is unreadable — fail closed, never store unmetered', () => {
    expect(exceedsQuota(null)).toBe(true)
    expect(exceedsQuota(undefined)).toBe(true)
    expect(exceedsQuota(NaN)).toBe(true)
  })
  it('honours a per-row quota override', () => {
    expect(exceedsQuota(1500, 1000)).toBe(true)
    expect(exceedsQuota(900, 1000)).toBe(false)
  })
})

describe('quotaStatus thresholds', () => {
  const q = EMAIL_MAILBOX_QUOTA_BYTES
  it('is ok below 80%', () => {
    expect(quotaStatus(q * 0.79, q).level).toBe('ok')
    expect(quotaMessage(quotaStatus(q * 0.5, q))).toBe('')
  })
  it('warns at exactly 80%', () => {
    expect(quotaStatus(q * 0.8, q).level).toBe('warning')
  })
  it('is critical at exactly 95%', () => {
    expect(quotaStatus(q * 0.95, q).level).toBe('critical')
  })
  it('is full at exactly 100% and beyond', () => {
    expect(quotaStatus(q, q).level).toBe('full')
    expect(quotaStatus(q * 2, q).full).toBe(true)
  })
  it('clamps percent for display but keeps the true ratio', () => {
    const s = quotaStatus(q * 3, q)
    expect(s.percent).toBe(100)
    expect(s.ratio).toBeCloseTo(3)
    expect(s.remaining).toBe(0)
  })
  it('treats junk as empty rather than throwing', () => {
    expect(quotaStatus(null).level).toBe('ok')
    expect(quotaStatus(-5).used).toBe(0)
    expect(quotaStatus(100, 0).quota).toBe(EMAIL_MAILBOX_QUOTA_BYTES)
  })
  it('says something actionable at every warning level', () => {
    for (const used of [q * 0.85, q * 0.96, q]) {
      expect(quotaMessage(quotaStatus(used, q))).not.toBe('')
    }
  })
})

describe('formatBytes', () => {
  it('reads the way an operator expects', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(EMAIL_MAILBOX_QUOTA_BYTES)).toBe('5.0 GB')
    expect(formatBytes(MAX_ATTACHMENT_BYTES)).toBe('25 MB')
  })
  it('never renders NaN', () => {
    expect(formatBytes(null)).toBe('0 B')
    expect(formatBytes('nonsense')).toBe('0 B')
  })
})

describe('skipped reasons match the DB CHECK', () => {
  it('is exactly the vocabulary mig 496 allows', () => {
    expect([...SKIPPED_REASONS].sort())
      .toEqual(['pruned', 'quota', 'rehost_failed', 'too_large', 'too_many'])
  })
})
