// @vitest-environment jsdom
//
// MAIL-FOLLOWUPS.1 — the pre-confirm copy tells the operator what erasure
// does BEFORE they type DELETE. MAIL-GDPR.1 (#1606) added the mail tables to
// the scrub (tickets + messages anonymised in place, attachments hard-deleted,
// src/lib/contact-mail-erasure.js), but this box still listed WhatsApp alone,
// so the one screen that asks for consent to the erasure under-described it.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import ContactBulkDeleteModal from './ContactBulkDeleteModal.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

afterEach(() => cleanup())

describe('ContactBulkDeleteModal — pre-confirm copy', () => {
  it('names mail (conversations, messages, attachments) beside WhatsApp under "Will be redacted"', () => {
    render(
      <ContactBulkDeleteModal
        contacts={[{ id: 'c-1', name: 'Ada Member', email: 'ada@example.com' }]}
        onClose={() => {}}
        onDeleted={() => {}}
      />
    )
    const redacted = screen.getByText('Will be redacted:').closest('div')
    expect(redacted.textContent).toMatch(/WhatsApp conversations \+ messages/)
    expect(redacted.textContent).toMatch(/mail \(conversations, messages, attachments\)/)
    expect(redacted.textContent).toMatch(/attachments/)
    // The consent-bearing framing stays.
    expect(redacted.textContent).toMatch(/GDPR right-to-erasure/)
  })
})
