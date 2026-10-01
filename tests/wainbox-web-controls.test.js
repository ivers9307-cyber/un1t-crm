// C126 INBOXCONTROLS.1 — the web WhatsApp inbox shows Handled-by and
// Add to Contacts only when the thread GET says the web-only routes behind
// them would act (`canUseWebControls`: web `whatsapp` at the thread's studio).
// WAInbox has no component harness (see wainbox-template-picker.test.js), so
// this pins the source; the flag itself is pinned in
// src/app/api/whatsapp/conversations/[id]/route.web-controls.test.js and the
// control's error surfacing in src/components/inbox/HandledByControl.errors.test.jsx.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const INBOX = readFileSync(fileURLToPath(new URL('../src/components/WAInbox.jsx', import.meta.url)), 'utf8')

describe('web WhatsApp inbox: web-only thread controls (C126)', () => {
  it('reads the flag from the thread GET, strictly (absent = off)', () => {
    expect(INBOX).toContain('setCanUseWebControls(data.canUseWebControls === true)')
    expect(INBOX).toContain('useState(false)')
  })

  it('renders Handled-by only with the flag', () => {
    expect(INBOX).toMatch(/\{conversation && canUseWebControls && \(\s*<HandledByControl/)
    expect((INBOX.match(/<HandledByControl/g) || []).length).toBe(1)
  })

  it('offers Add to Contacts (menu item and form) only with the flag', () => {
    expect(INBOX).toMatch(/isUnknown \? \(canUseWebControls && \(\s*<button/)
    expect(INBOX).toContain('{showAddContact && isUnknown && canUseWebControls && (')
    // The menu item, the form's comment and its heading: no other way in.
    expect((INBOX.match(/Add to Contacts/g) || []).length).toBe(3)
    expect(INBOX.split('setShowAddContact(!showAddContact)').length - 1).toBe(1)
  })
})
