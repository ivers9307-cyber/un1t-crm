// @vitest-environment jsdom
//
// MAIL-FOLLOWUPS.1 — the pre-confirm copy tells the operator what erasure
// does BEFORE they type DELETE. MAIL-GDPR.1 (#1606) added the mail tables to
// the scrub (tickets + messages anonymised in place, attachments hard-deleted,
// src/lib/contact-mail-erasure.js), but this box still listed WhatsApp alone,
// so the one screen that asks for consent to the erasure under-described it.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import ContactBulkDeleteModal from './ContactBulkDeleteModal.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

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

  // MAIL-GDPR.2 — the scrub now archives the redacted mail conversations, so
  // the consent copy says so: an operator should not be surprised when a
  // thread they were mid-reply on leaves Inbox.
  it('says the mail conversations are also archived', () => {
    render(
      <ContactBulkDeleteModal
        contacts={[{ id: 'c-1', name: 'Ada Member', email: 'ada@example.com' }]}
        onClose={() => {}}
        onDeleted={() => {}}
      />
    )
    const redacted = screen.getByText('Will be redacted:').closest('div')
    expect(redacted.textContent).toMatch(/mail conversations are (also )?archived/i)
  })
})

// ROLESWEEP.1c — bulk-delete judges MANAGER_ROLES at each row's location, so a
// row can be skipped for the caller's ROLE at that contact's studio
// (reason 'Role') as well as for belonging to a studio they are not in
// ('Different location'). A Role skip is not fixed by switching studio, so it
// must not sit under the "switch active location" advice.
describe('ContactBulkDeleteModal — skipped rows', () => {
  async function submitWith(forbidden) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { requested: forbidden.length, deleted: 0, blocked: [], forbidden, missing: [] },
      }),
    })))
    render(
      <ContactBulkDeleteModal
        contacts={forbidden.map((f) => ({ id: f.id, name: f.name }))}
        onClose={() => {}}
        onDeleted={() => {}}
      />
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByRole('button', { name: /^Delete \d+ contact/ }))
    await screen.findByText('Bulk delete complete')
  }

  it('groups a Role skip on its own, saying the caller\'s role at that studio does not allow it', async () => {
    await submitWith([
      { id: 'c-1', name: 'Ada Member', reason: 'Different location' },
      { id: 'c-2', name: 'Bo Member', reason: 'Role' },
    ])
    const roleSection = screen.getByText(/Skipped: your role at their studio \(1\)/).closest('div').parentElement
    expect(roleSection.textContent).toMatch(/Bo Member/)
    expect(roleSection.textContent).not.toMatch(/Ada Member/)
    expect(roleSection.textContent).toMatch(/role at the contact's studio does not allow deleting contacts/i)
    expect(roleSection.textContent).not.toMatch(/switch/i)

    const locSection = screen.getByText(/wrong location \(1\)/).closest('div').parentElement
    expect(locSection.textContent).toMatch(/Ada Member/)
    expect(locSection.textContent).not.toMatch(/Bo Member/)
  })

  it('shows no "wrong location" section when every skip is a Role skip', async () => {
    await submitWith([{ id: 'c-2', name: 'Bo Member', reason: 'Role' }])
    expect(screen.queryByText(/wrong location/)).toBeNull()
    expect(screen.queryByText(/Switch active location/)).toBeNull()
    expect(screen.getByText(/Skipped: your role at their studio \(1\)/)).toBeTruthy()
  })
})
