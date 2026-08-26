// @vitest-environment jsdom
//
// MAILBOX-CONNECT.6 — the per-account connection panel.
//
// What this file pins:
//   - connectionStatus() tells the three states apart. "Connected" and
//     "failing" rendering identically is the failure the whole panel exists to
//     prevent — a connector that cannot say whether it is working is the
//     standing audit finding this feature was built to retire.
//   - the presets carry the right hosts, ports and TLS pairing (465/true vs
//     587/false), because a wrong value here is a support ticket per operator.
//   - Microsoft is present, disabled, and says why.
//   - the required permanence disclosure appears before an operator can
//     connect, and the mail-client warning Phase 8 RETRACTED does not
//     (MAILBOX-COEXIST.1 — a stale warning is worse than none).
//   - nothing that looks like a credential ever reaches the screen.
//   - THE PANEL NEVER SAYS TWO CONTRADICTORY THINGS ABOUT ONE MAILBOX. A save
//     used to print "Connected. The login was checked against the mail server
//     before it was saved." unconditionally — including beside a "Paused" chip
//     and the stale error from the password that had just been replaced. The
//     route now clears that state (MAILBOX-CONNECT.8), so the ordinary case
//     resolves itself; this is the half that does not depend on the server
//     getting it right.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import MailboxConnectionSection, { PROVIDER_PRESETS, connectionStatus } from './MailboxConnectionSection'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const MAILBOX = {
  id: '11111111-1111-4111-8111-111111111111',
  address: 'stillorgan@un1t.com',
  label: 'Studio',
  active: true,
  ingress: 'postmark',
  egress: 'postmark',
}

const CONNECTION = {
  provider: 'gmail',
  auth_type: 'password',
  username: 'stillorgan@un1t.com',
  imap_host: 'imap.gmail.com',
  imap_port: 993,
  imap_secure: true,
  smtp_host: 'smtp.gmail.com',
  smtp_port: 465,
  smtp_secure: true,
  sent_folder: '[Gmail]/Sent Mail',
  created_at: '2026-08-20T09:00:00Z',
  updated_at: '2026-08-20T09:00:00Z',
}

const okInbox = {
  mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 3, last_uid: 900,
  last_run_at: '2026-08-26T09:00:00Z', last_ok_at: '2026-08-26T09:00:00Z',
  last_error: null, consecutive_failures: 0, paused_until: null,
}

function mockFetch(handler) {
  global.fetch = vi.fn(async (url, init = {}) => handler(String(url), init))
}

const jsonRes = (data, ok = true, status = 200) => ({
  ok, status, json: async () => (ok ? { success: true, data } : { success: false, ...data }),
})

/** Open the panel and wait for its first read to settle. */
async function openPanel(props = {}) {
  render(<MailboxConnectionSection locationId={LOC} mailbox={MAILBOX} {...props} />)
  fireEvent.click(screen.getByRole('button', { name: /mailbox connection/i }))
  await waitFor(() => expect(global.fetch).toHaveBeenCalled())
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); delete global.fetch })

describe('connectionStatus — the three states must be distinguishable', () => {
  it('reads as not connected when the mailbox is still on the standard route', () => {
    const s = connectionStatus({ ingress: 'postmark', connection: null, folders: [] })
    expect(s.tone).toBe('idle')
    expect(s.label).toBe('Not connected')
  })

  it('reads as not connected when a credential exists but ingress was never flipped', () => {
    // The poller only looks at mailboxes flagged `imap`, so a stored credential
    // on a postmark mailbox is genuinely not receiving — claiming otherwise
    // would be a green chip over a mailbox nothing reads.
    const s = connectionStatus({ ingress: 'postmark', connection: CONNECTION, folders: [] })
    expect(s.tone).toBe('idle')
  })

  it('reads as connected after a successful check', () => {
    const s = connectionStatus({ ingress: 'imap', connection: CONNECTION, folders: [okInbox] })
    expect(s.tone).toBe('ok')
    expect(s.label).toBe('Connected')
  })

  it('reads as FAILING when the last check errored, and carries the reason', () => {
    const s = connectionStatus({
      ingress: 'imap',
      connection: CONNECTION,
      folders: [{ ...okInbox, last_error: 'Invalid credentials (Failure)', consecutive_failures: 4 }],
    })
    expect(s.tone).toBe('failing')
    expect(s.label).toBe('Connection failing')
    expect(s.detail).toMatch(/Invalid credentials/)
  })

  it('reads as PAUSED — loudly — while backoff is holding it', () => {
    const s = connectionStatus({
      ingress: 'imap',
      connection: CONNECTION,
      folders: [{ ...okInbox, last_error: 'Invalid credentials', paused_until: '2026-08-26T12:00:00Z' }],
      now: Date.parse('2026-08-26T10:00:00Z'),
    })
    expect(s.tone).toBe('paused')
    expect(s.label).toBe('Paused')
  })

  it('treats an EXPIRED pause as no pause at all', () => {
    const s = connectionStatus({
      ingress: 'imap',
      connection: CONNECTION,
      folders: [{ ...okInbox, paused_until: '2026-08-26T08:00:00Z' }],
      now: Date.parse('2026-08-26T10:00:00Z'),
    })
    expect(s.tone).toBe('ok')
  })

  it('says "waiting for the first check" before the poller has ever run', () => {
    const s = connectionStatus({ ingress: 'imap', connection: CONNECTION, folders: [] })
    expect(s.tone).toBe('pending')
  })

  it('does NOT blame the mailbox when the health read itself failed', () => {
    // folders === null is "we could not read the poll history", which says
    // nothing about the connection. Reporting it as a fault would send an
    // operator hunting for a new app password they do not need.
    const s = connectionStatus({ ingress: 'imap', connection: CONNECTION, folders: null })
    expect(s.tone).toBe('ok')
    expect(s.detail).toMatch(/could not be read/i)
  })

  it('uses the light-theme chip recipe on every state', () => {
    const states = [
      connectionStatus({ ingress: 'postmark', connection: null, folders: [] }),
      connectionStatus({ ingress: 'imap', connection: CONNECTION, folders: [okInbox] }),
      connectionStatus({ ingress: 'imap', connection: CONNECTION, folders: [{ ...okInbox, last_error: 'x' }] }),
      connectionStatus({ ingress: 'imap', connection: CONNECTION, folders: [] }),
    ]
    for (const s of states) expect(s.chip).toMatch(/^bg-[a-z]+-500\/10 text-[a-z]+-700$/)
  })
})

describe('provider presets', () => {
  it('carries the Gmail values an operator would otherwise have to guess', () => {
    expect(PROVIDER_PRESETS.gmail.imap_host).toBe('imap.gmail.com')
    expect(PROVIDER_PRESETS.gmail.imap_port).toBe(993)
    expect(PROVIDER_PRESETS.gmail.smtp_host).toBe('smtp.gmail.com')
    expect(PROVIDER_PRESETS.gmail.smtp_port).toBe(465)
    expect(PROVIDER_PRESETS.gmail.sent_folder).toBe('[Gmail]/Sent Mail')
    expect(PROVIDER_PRESETS.gmail.supported).toBe(true)
  })

  it('pairs each SMTP port with the right TLS flag — 465 implicit, 587 STARTTLS', () => {
    // Pairing 587 with secure:true fails as an opaque connect timeout rather
    // than as a TLS error, which is why the preset sets the pair together.
    expect(PROVIDER_PRESETS.gmail.smtp_port).toBe(465)
    expect(PROVIDER_PRESETS.gmail.smtp_secure).toBe(true)
    expect(PROVIDER_PRESETS.microsoft.smtp_port).toBe(587)
    expect(PROVIDER_PRESETS.microsoft.smtp_secure).toBe(false)
  })

  it('keeps Microsoft in the list but marks it unsupported', () => {
    expect(PROVIDER_PRESETS.microsoft.supported).toBe(false)
  })
})

describe('rendering — never connected', () => {
  beforeEach(() => {
    mockFetch(async () => jsonRes({
      connection: null, ingress: 'postmark', egress: 'postmark', folders: [], address: MAILBOX.address,
    }))
  })

  it('shows the Not connected chip before anything is fetched', () => {
    render(<MailboxConnectionSection locationId={LOC} mailbox={MAILBOX} />)
    expect(screen.getByText('Not connected')).toBeTruthy()
    // Lazy: opening the settings page must not fire one health request per
    // account.
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('offers the connect form once opened', async () => {
    await openPanel()
    await waitFor(() => expect(screen.getByLabelText(/app password/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /check and connect/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /disconnect/i })).toBeNull()
  })

  it('shows the required permanence disclosure before the connect button', async () => {
    await openPanel()
    await waitFor(() => expect(screen.getByRole('button', { name: /check and connect/i })).toBeTruthy())
    // Ingested mail is permanent and survives contact erasure (spec §6). Still
    // true, still shown.
    expect(screen.getByText(/kept permanently/i)).toBeTruthy()
    expect(screen.getByText(/data-erasure request/i)).toBeTruthy()
  })

  // 🔴 MAILBOX-COEXIST.1 — THE RETRACTED CLAIM.
  //
  // This screen used to carry a second panel warning that replies sent from
  // Gmail or Outlook would not show up in the CRM, and telling the team to
  // reply from the CRM while that was the case. It was true of the
  // receive-only release, which polled INBOX only. Phase 8 polls the Sent
  // folder, so it stopped being true the moment that shipped.
  //
  // A retired warning is worse than one that was never written: it has a team
  // routing every reply through the CRM to dodge a problem that no longer
  // exists, and it gives them no way to tell which of the panels on this
  // screen still holds. This test is the guard against it coming back — by a
  // revert, a merge, or somebody restoring "the disclosure that got deleted".
  it('no longer claims mail-client replies are invisible — Phase 8 files them', async () => {
    await openPanel()
    await waitFor(() => expect(screen.getByRole('button', { name: /check and connect/i })).toBeTruthy())
    expect(screen.queryByText(/will not show up here/i)).toBeNull()
    expect(screen.queryByText(/reply from the CRM while/i)).toBeNull()
    // Broader than the exact sentence: any panel telling the operator their
    // own mail app is invisible to the CRM is now false, however it is worded.
    expect(screen.queryByText(/only mail arriving in the inbox is read/i)).toBeNull()
  })

  it('spells out how to get a Gmail app password, inline', async () => {
    await openPanel()
    await waitFor(() => expect(screen.getByText(/Getting a Gmail app password/i)).toBeTruthy())
    expect(screen.getByText(/2-Step Verification/i)).toBeTruthy()
    expect(screen.getByText(/myaccount.google.com\/apppasswords/)).toBeTruthy()
    expect(screen.getByText(/never the account password/i)).toBeTruthy()
  })

  it('lists Microsoft, disabled, with the reason', async () => {
    await openPanel()
    await waitFor(() => expect(screen.getByLabelText(/mail provider/i)).toBeTruthy())
    const option = screen.getByRole('option', { name: /Microsoft 365/i })
    expect(option.disabled).toBe(true)
    expect(option.textContent).toMatch(/not supported yet/i)
  })

  it('surfaces a refused login instead of pretending the account connected', async () => {
    mockFetch(async (url, init) => {
      if (init.method === 'PUT') {
        return jsonRes({ error: 'IMAP login failed: Invalid credentials (Failure)' }, false, 400)
      }
      return jsonRes({ connection: null, ingress: 'postmark', egress: 'postmark', folders: [], address: MAILBOX.address })
    })
    await openPanel()
    await waitFor(() => expect(screen.getByLabelText(/app password/i)).toBeTruthy())

    fireEvent.change(screen.getByLabelText(/app password/i), { target: { value: 'wrong-password' } })
    fireEvent.click(screen.getByRole('button', { name: /check and connect/i }))

    await waitFor(() => expect(screen.getByText(/IMAP login failed/i)).toBeTruthy())
    // Still on the form, still not connected.
    expect(screen.queryByRole('button', { name: /disconnect/i })).toBeNull()
  })

  it('sends the preset host and port with the password on submit', async () => {
    let sent = null
    mockFetch(async (url, init) => {
      if (init.method === 'PUT') {
        sent = JSON.parse(init.body)
        return jsonRes({ connection: CONNECTION, ingress: 'imap', egress: 'postmark', verified: true })
      }
      return jsonRes({ connection: null, ingress: 'postmark', egress: 'postmark', folders: [], address: MAILBOX.address })
    })
    await openPanel()
    await waitFor(() => expect(screen.getByLabelText(/app password/i)).toBeTruthy())

    fireEvent.change(screen.getByLabelText(/app password/i), { target: { value: 'not-a-real-app-password' } })
    fireEvent.click(screen.getByRole('button', { name: /check and connect/i }))

    await waitFor(() => expect(sent).toBeTruthy())
    expect(sent.provider).toBe('gmail')
    expect(sent.imap_host).toBe('imap.gmail.com')
    expect(sent.imap_port).toBe(993)
    expect(sent.smtp_host).toBe('smtp.gmail.com')
    expect(sent.sent_folder).toBe('[Gmail]/Sent Mail')
    expect(sent.password).toBe('not-a-real-app-password')
    // Defaults to the account's own address rather than making the operator
    // retype it.
    expect(sent.username).toBe(MAILBOX.address)
  })
})

describe('rendering — connected', () => {
  const connectedMailbox = { ...MAILBOX, ingress: 'imap' }

  beforeEach(() => {
    mockFetch(async (url, init) => {
      if (init.method === 'DELETE') {
        return jsonRes({ changed: true, connection: null, ingress: 'postmark', egress: 'postmark' })
      }
      return jsonRes({
        connection: CONNECTION, ingress: 'imap', egress: 'postmark',
        folders: [okInbox], address: MAILBOX.address,
      })
    })
  })

  it('shows the connection and the last successful check, and nothing resembling the password', async () => {
    render(<MailboxConnectionSection locationId={LOC} mailbox={connectedMailbox} />)
    fireEvent.click(screen.getByRole('button', { name: /mailbox connection/i }))

    await waitFor(() => expect(screen.getByText('imap.gmail.com:993')).toBeTruthy())
    expect(screen.getAllByText(MAILBOX.address).length).toBeGreaterThan(0)
    expect(screen.getByText(/Last successful check/i)).toBeTruthy()
    expect(screen.getByText(/never shown again/i)).toBeTruthy()
    // No password input while merely viewing a live connection, and no field
    // pre-filled with anything credential-shaped.
    expect(screen.queryByLabelText(/app password/i)).toBeNull()
  })

  it('offers Disconnect, and no connect form until Change is pressed', async () => {
    render(<MailboxConnectionSection locationId={LOC} mailbox={connectedMailbox} />)
    fireEvent.click(screen.getByRole('button', { name: /mailbox connection/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /disconnect/i })).toBeTruthy())

    expect(screen.queryByRole('button', { name: /check and save/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /change settings or password/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /check and save/i })).toBeTruthy())
    // The password field explains that blank keeps what is stored.
    expect(screen.getByPlaceholderText(/leave blank to keep the current password/i)).toBeTruthy()
  })

  it('confirms before disconnecting, and does nothing if the operator backs out', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<MailboxConnectionSection locationId={LOC} mailbox={connectedMailbox} />)
    fireEvent.click(screen.getByRole('button', { name: /mailbox connection/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /disconnect/i })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(global.fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    confirmSpy.mockRestore()
  })

  it('disconnects and tells the operator the password is gone', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onChanged = vi.fn()
    render(<MailboxConnectionSection locationId={LOC} mailbox={connectedMailbox} onChanged={onChanged} />)
    fireEvent.click(screen.getByRole('button', { name: /mailbox connection/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /disconnect/i })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }))
    await waitFor(() => expect(screen.getByText(/stored password has been deleted/i)).toBeTruthy())
    // The card reloads so the chip on the account row stops saying Connected.
    expect(onChanged).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})

describe('after a save — the note may not contradict the chip', () => {
  const connectedMailbox = { ...MAILBOX, ingress: 'imap' }
  const pausedInbox = {
    ...okInbox,
    last_ok_at: '2026-08-25T09:00:00Z',
    last_error: 'Invalid credentials (Failure)',
    consecutive_failures: 6,
    // Far enough out that the pause is live whenever this test runs — the real
    // AUTH backoff tops out at 24 hours, and "the operator waits a day" is the
    // whole shape of the defect.
    paused_until: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
  }

  /** PUT succeeds; the GET after it answers with `folders`. */
  function saveThenReadBack(folders) {
    mockFetch(async (url, init) => {
      if (init.method === 'PUT') {
        return jsonRes({ connection: CONNECTION, ingress: 'imap', egress: 'postmark', verified: true })
      }
      return jsonRes({
        connection: CONNECTION, ingress: 'imap', egress: 'postmark', folders, address: MAILBOX.address,
      })
    })
  }

  async function saveNewPassword() {
    render(<MailboxConnectionSection locationId={LOC} mailbox={connectedMailbox} />)
    fireEvent.click(screen.getByRole('button', { name: /mailbox connection/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /change settings or password/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /change settings or password/i }))
    await waitFor(() => expect(screen.getByLabelText(/app password/i)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/app password/i), { target: { value: 'rotated-app-password' } })
    fireEvent.click(screen.getByRole('button', { name: /check and save/i }))
  }

  it('does NOT announce "Connected" while the panel still reads Paused', async () => {
    saveThenReadBack([pausedInbox])
    await saveNewPassword()

    await waitFor(() => expect(screen.getByText(/still reporting the problem/i)).toBeTruthy())
    // The two statements that used to sit one above the other.
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(screen.queryByText(/^Connected\. The login was checked/)).toBeNull()
  })

  it('does not announce it over a failing chip either', async () => {
    saveThenReadBack([{ ...okInbox, last_error: 'Invalid credentials (Failure)' }])
    await saveNewPassword()

    await waitFor(() => expect(screen.getByText('Connection failing')).toBeTruthy())
    expect(screen.queryByText(/^Connected\. The login was checked/)).toBeNull()
  })

  it('says Connected plainly when the reload agrees with it', async () => {
    // The other direction matters just as much: a save that really did fix the
    // mailbox must read as a fix, not as a hedge.
    saveThenReadBack([okInbox])
    await saveNewPassword()

    await waitFor(() => expect(screen.getByText(/^Connected\. The login was checked/)).toBeTruthy())
    expect(screen.queryByText(/still reporting the problem/i)).toBeNull()
  })
})

describe('rendering — failing', () => {
  it('shows the error the poller recorded rather than a green chip', async () => {
    mockFetch(async () => jsonRes({
      connection: CONNECTION,
      ingress: 'imap',
      egress: 'postmark',
      folders: [{ ...okInbox, last_error: 'Invalid credentials (Failure)', consecutive_failures: 6 }],
      address: MAILBOX.address,
    }))
    render(<MailboxConnectionSection locationId={LOC} mailbox={{ ...MAILBOX, ingress: 'imap' }} />)
    fireEvent.click(screen.getByRole('button', { name: /mailbox connection/i }))

    await waitFor(() => expect(screen.getByText('Connection failing')).toBeTruthy())
    expect(screen.getByText(/Invalid credentials/)).toBeTruthy()
  })

  it('says a read failed rather than reporting the account as disconnected', async () => {
    // A failed GET must not render the first-connect form over a live
    // connection — that invites an owner to re-paste a working credential.
    mockFetch(async () => ({ ok: false, status: 500, json: async () => ({ success: false, error: 'boom' }) }))
    render(<MailboxConnectionSection locationId={LOC} mailbox={{ ...MAILBOX, ingress: 'imap' }} />)
    fireEvent.click(screen.getByRole('button', { name: /mailbox connection/i }))

    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
  })
})
