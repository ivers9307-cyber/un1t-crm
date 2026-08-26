// IMAP-CONN.3.1/3.2 — transport tests, against a FAKE client.
//
// Nothing here touches the network. `withMailbox` and `verifyConnection` take
// an optional `{ createClient }` seam for exactly this reason: the two
// properties that matter most about this module — that a mailbox is ALWAYS
// opened read-only, and that logout ALWAYS runs — are invariants about how the
// client is driven, and an invariant nobody can test is an invariant that
// quietly stops holding.
//
// The fake records every call so the assertions can be about the CONVERSATION
// with the server rather than about the return value.

import { describe, it, expect } from 'vitest'
import { withMailbox, verifyConnection, fetchSince } from './imap-connection'

const CONFIG = {
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: { user: 'hatchstreet@un1t.com', pass: 'not-a-real-app-password' },
}

/**
 * A stand-in for ImapFlow. `failAt` makes one step throw so the finally-block
 * behaviour can be checked from every direction.
 */
function fakeClient({ failAt = null, mailbox = {} } = {}) {
  const calls = []
  const client = {
    calls,
    options: null,
    async connect() {
      calls.push(['connect'])
      if (failAt === 'connect') throw new Error('ECONNREFUSED')
    },
    async mailboxOpen(path, opts) {
      calls.push(['mailboxOpen', path, opts])
      if (failAt === 'open') throw new Error('NO Mailbox does not exist')
      return { path, uidValidity: 12345n, uidNext: 900, exists: 42, readOnly: true, ...mailbox }
    },
    async logout() {
      calls.push(['logout'])
      if (failAt === 'logout') throw new Error('connection already closed')
      return true
    },
    // imapflow's forceful teardown. Recorded because it is the half of the
    // release guarantee that still holds when LOGOUT cannot run or fails.
    close() {
      calls.push(['close'])
    },
    // Never expected to be called — a write would break the read-only posture.
    async messageFlagsAdd() { calls.push(['messageFlagsAdd']); return true },
    async messageFlagsSet() { calls.push(['messageFlagsSet']); return true },
    async messageDelete() { calls.push(['messageDelete']); return true },
    async messageMove() { calls.push(['messageMove']); return true },
  }
  return client
}

/** A factory that records the options ImapFlow would have been constructed with. */
function seam(client) {
  const made = []
  return {
    made,
    deps: {
      createClient: (opts) => {
        made.push(opts)
        client.options = opts
        return client
      },
    },
  }
}

/* ────────────────────────────── withMailbox ───────────────────────────── */

describe('withMailbox', () => {
  it('connects, opens the folder READ-ONLY, runs fn, then logs out — in that order', () => {
    const client = fakeClient()
    const { deps } = seam(client)
    return withMailbox(CONFIG, 'INBOX', async () => 'result', deps).then((out) => {
      expect(out).toBe('result')
      expect(client.calls.map(c => c[0])).toEqual(['connect', 'mailboxOpen', 'logout', 'close'])
      expect(client.calls[1]).toEqual(['mailboxOpen', 'INBOX', { readOnly: true }])
    })
  })

  it('🔴 ALWAYS passes readOnly:true, whatever folder it is given', async () => {
    // §3.4. A connected mailbox is one a human still opens; if we ever issue
    // SELECT instead of EXAMINE, Gmail starts marking the operator's own mail
    // as read and the CRM's unread model stops being the source of truth.
    // Phase 8 will pass the Sent folder through this same door.
    for (const folder of ['INBOX', '[Gmail]/Sent Mail', 'Archive/2026']) {
      const client = fakeClient()
      const { deps } = seam(client)
      await withMailbox(CONFIG, folder, async () => true, deps)
      const open = client.calls.find(c => c[0] === 'mailboxOpen')
      expect(open[1]).toBe(folder)
      expect(open[2]).toEqual({ readOnly: true })
    }
  })

  it('🔴 logs out even when fn throws, and re-throws the ORIGINAL error', async () => {
    const client = fakeClient()
    const { deps } = seam(client)
    await expect(
      withMailbox(CONFIG, 'INBOX', async () => { throw new Error('fn exploded') }, deps)
    ).rejects.toThrow('fn exploded')
    expect(client.calls.map(c => c[0])).toContain('logout')
  })

  it('🔴 logs out even when mailboxOpen throws', async () => {
    const client = fakeClient({ failAt: 'open' })
    const { deps } = seam(client)
    await expect(withMailbox(CONFIG, 'INBOX', async () => true, deps)).rejects.toThrow(/Mailbox does not exist/)
    expect(client.calls.map(c => c[0])).toEqual(['connect', 'mailboxOpen', 'logout', 'close'])
  })

  it('a failing logout does not mask a successful poll', async () => {
    // An abandoned session is a real cost (Gmail caps concurrent IMAP
    // connections), but a logout that fails after the work is done must not
    // turn a good tick into a failed one.
    const client = fakeClient({ failAt: 'logout' })
    const { deps } = seam(client)
    await expect(withMailbox(CONFIG, 'INBOX', async () => 'ok', deps)).resolves.toBe('ok')
  })

  it('a failing logout does not replace the diagnosis when fn threw', async () => {
    const client = fakeClient({ failAt: 'logout' })
    const { deps } = seam(client)
    await expect(
      withMailbox(CONFIG, 'INBOX', async () => { throw new Error('the real problem') }, deps)
    ).rejects.toThrow('the real problem')
  })

  it('🔴 RELEASES THE CONNECTION when connect() fails at LOGIN', async () => {
    // The case this file's header is actually worried about. connect() is
    // where LOGIN happens, and imapflow does NOT close the socket when
    // authentication fails — it rejects out of beginSession() with the TCP
    // connection still up. A revoked Gmail app password fails there on every
    // five-minute tick, forever, so a connect outside the try/finally leaked
    // one live session per tick straight into Gmail's per-account connection
    // cap and locked the operator out of their own mailbox.
    const client = fakeClient()
    client.connect = async () => {
      client.calls.push(['connect'])
      const err = new Error('Invalid credentials (Failure)')
      err.authenticationFailed = true
      throw err
    }
    const { deps } = seam(client)
    await expect(withMailbox(CONFIG, 'INBOX', async () => true, deps))
      .rejects.toThrow('Invalid credentials (Failure)')
    expect(client.calls.map(c => c[0])).toEqual(['connect', 'logout', 'close'])
  })

  it('🔴 releases it on a transport failure too, and never opens the folder', async () => {
    const client = fakeClient({ failAt: 'connect' })
    const { deps } = seam(client)
    await expect(withMailbox(CONFIG, 'INBOX', async () => true, deps)).rejects.toThrow('ECONNREFUSED')
    // No session to log out of — imapflow has already torn the socket down —
    // but the attempt is cheap and the close() behind it is what guarantees it.
    expect(client.calls.map(c => c[0])).not.toContain('mailboxOpen')
    expect(client.calls.map(c => c[0])).toContain('close')
  })

  it('🔴 closes even when LOGOUT itself throws — the socket is what leaks', async () => {
    // A logout that fails on a live socket used to leave that socket holding a
    // slot against the connection cap with nothing to reclaim it.
    const client = fakeClient({ failAt: 'logout' })
    const { deps } = seam(client)
    await withMailbox(CONFIG, 'INBOX', async () => 'ok', deps)
    expect(client.calls.map(c => c[0])).toEqual(['connect', 'mailboxOpen', 'logout', 'close'])
  })

  it('🔴 the release path is never the thing that throws', async () => {
    // withMailbox is on the path to POSTing a message a member is waiting on an
    // answer to. Whatever the client turns out to be — an ImapFlow that closed
    // itself, a future test double, a mock with half the surface — tearing the
    // connection down must not manufacture a failure the poller then records as
    // `connect_failed` against a mailbox that polled perfectly.
    const bare = { async connect() {}, async mailboxOpen() { return {} } }
    await expect(
      withMailbox(CONFIG, 'INBOX', async () => 'ok', { createClient: () => bare })
    ).resolves.toBe('ok')

    // …and it still surfaces fn's own error rather than the release's.
    await expect(
      withMailbox(CONFIG, 'INBOX', async () => { throw new Error('the real problem') },
        { createClient: () => bare })
    ).rejects.toThrow('the real problem')
  })

  it('never writes a flag, moves or deletes anything', async () => {
    const client = fakeClient()
    const { deps } = seam(client)
    await withMailbox(CONFIG, 'INBOX', async () => true, deps)
    const written = client.calls.map(c => c[0])
      .filter(name => /^message(FlagsAdd|FlagsSet|Delete|Move)$/.test(name))
    expect(written).toEqual([])
  })

  it('hands fn the client AND the opened mailbox (uidValidity / uidNext)', async () => {
    // The poller needs both for cursor discipline (§3.3 re-anchor) and cold
    // start (§3.5). Taking them off the SELECT response saves a STATUS round
    // trip per mailbox per tick.
    const client = fakeClient()
    const { deps } = seam(client)
    const seen = await withMailbox(CONFIG, 'INBOX', async (c, mailbox) => ({ c, mailbox }), deps)
    expect(seen.c).toBe(client)
    expect(seen.mailbox).toMatchObject({ path: 'INBOX', uidValidity: 12345n, uidNext: 900 })
  })

  it('passes host/port/TLS through per-mailbox rather than hardcoding Gmail', async () => {
    // The whole point of not reusing src/lib/recon/imap-client.js: this is a
    // SaaS capability and provider config lives per mailbox (§2.1).
    const client = fakeClient()
    const { made, deps } = seam(client)
    await withMailbox(
      { host: 'mail.customer.co.uk', port: 143, secure: false, auth: { user: 'u', pass: 'p' } },
      'INBOX', async () => true, deps,
    )
    expect(made[0]).toMatchObject({ host: 'mail.customer.co.uk', port: 143, secure: false })
  })

  it('defaults to 993 + implicit TLS, and never turns logging on', async () => {
    const client = fakeClient()
    const { made, deps } = seam(client)
    await withMailbox({ host: 'h', auth: { user: 'u', pass: 'p' } }, 'INBOX', async () => true, deps)
    expect(made[0].port).toBe(993)
    expect(made[0].secure).toBe(true)
    // logger:false is a security control, not a preference — imapflow's
    // default logger prints the LOGIN command, password included (§6).
    expect(made[0].logger).toBe(false)
  })

  it('passes an OAuth auth object through verbatim (the §2.1 seam)', async () => {
    // imapflow accepts { user, accessToken } on the same option as
    // { user, pass }, so nothing in this file changes when OAuth ships.
    const client = fakeClient()
    const { made, deps } = seam(client)
    const auth = { user: 'u@x.com', accessToken: 'ya29.token' }
    await withMailbox({ host: 'h', auth }, 'INBOX', async () => true, deps)
    expect(made[0].auth).toBe(auth)
  })
})

/* ──────────────────────────── verifyConnection ────────────────────────── */

describe('verifyConnection', () => {
  it('returns { ok: true } on a clean connect + open', async () => {
    const client = fakeClient()
    const { deps } = seam(client)
    expect(await verifyConnection(CONFIG, 'INBOX', deps)).toEqual({ ok: true })
  })

  it('defaults to INBOX', async () => {
    const client = fakeClient()
    const { deps } = seam(client)
    await verifyConnection(CONFIG, undefined, deps)
    expect(client.calls.find(c => c[0] === 'mailboxOpen')[1]).toBe('INBOX')
  })

  it('opens read-only on the verify path too', async () => {
    // The connect screen must not mark a customer's newest mail as read just
    // because someone pressed "Test connection".
    const client = fakeClient()
    const { deps } = seam(client)
    await verifyConnection(CONFIG, 'INBOX', deps)
    expect(client.calls.find(c => c[0] === 'mailboxOpen')[2]).toEqual({ readOnly: true })
  })

  it('NEVER throws — a bad password is a verdict, not a 500', async () => {
    const client = fakeClient({ failAt: 'connect' })
    const { deps } = seam(client)
    const verdict = await verifyConnection(CONFIG, 'INBOX', deps)
    expect(verdict.ok).toBe(false)
    expect(verdict.error).toContain('ECONNREFUSED')
  })

  it('surfaces the server’s own message so the operator can act on it', async () => {
    const client = fakeClient({ failAt: 'open' })
    const { deps } = seam(client)
    const verdict = await verifyConnection(CONFIG, 'Nope', deps)
    expect(verdict.error).toContain('Mailbox does not exist')
  })

  it('prefers responseText, which is where IMAP puts the real reason', async () => {
    const client = fakeClient()
    client.connect = async () => {
      const err = new Error('Command failed')
      err.responseText = 'Invalid credentials (Failure)'
      throw err
    }
    const { deps } = seam(client)
    expect((await verifyConnection(CONFIG, 'INBOX', deps)).error).toBe('Invalid credentials (Failure)')
  })

  it('🔴 REDACTS the password out of the error it returns', async () => {
    // last_error is read back by the settings route and rendered in the UI.
    // A password in a screenshot is a credential leak (§6).
    const client = fakeClient()
    client.connect = async () => { throw new Error(`LOGIN "u" "${CONFIG.auth.pass}" failed`) }
    const { deps } = seam(client)
    const verdict = await verifyConnection(CONFIG, 'INBOX', deps)
    expect(verdict.error).not.toContain(CONFIG.auth.pass)
    expect(verdict.error).toContain('[redacted]')
  })

  it('redacts an OAuth access token too', async () => {
    const client = fakeClient()
    const auth = { user: 'u@x.com', accessToken: 'ya29.super-secret-token' }
    client.connect = async () => { throw new Error(`AUTHENTICATE XOAUTH2 ${auth.accessToken}`) }
    const { deps } = seam(client)
    const verdict = await verifyConnection({ host: 'h', auth }, 'INBOX', deps)
    expect(verdict.error).not.toContain('ya29.super-secret-token')
  })

  it('caps the error — it lands in a text column read on every card render', async () => {
    const client = fakeClient()
    client.connect = async () => { throw new Error('x'.repeat(5000)) }
    const { deps } = seam(client)
    const verdict = await verifyConnection(CONFIG, 'INBOX', deps)
    expect(verdict.error.length).toBeLessThanOrEqual(500)
  })

  it('still logs out on the failure path', async () => {
    const client = fakeClient({ failAt: 'open' })
    const { deps } = seam(client)
    await verifyConnection(CONFIG, 'INBOX', deps)
    expect(client.calls.map(c => c[0])).toContain('logout')
  })

  it('🔴 releases the connection when the operator typed a bad password', async () => {
    // "Test connection" is the single most likely place to fail at LOGIN, and
    // an operator retrying it a dozen times must not spend a dozen slots.
    const client = fakeClient()
    client.connect = async () => {
      client.calls.push(['connect'])
      throw new Error('Invalid credentials (Failure)')
    }
    const { deps } = seam(client)
    expect((await verifyConnection(CONFIG, 'INBOX', deps)).ok).toBe(false)
    expect(client.calls.map(c => c[0])).toContain('close')
  })
})

/* ─────────────────────────────── fetchSince ───────────────────────────── */

/** A client whose fetch() yields the given messages for any range. */
function fetchingClient(messages) {
  const calls = []
  return {
    calls,
    fetch(range, query, options) {
      calls.push({ range, query, options })
      return (async function* () { for (const m of messages) yield m })()
    },
  }
}

const msg = (uid) => ({ uid, envelope: { subject: `m${uid}` }, bodyStructure: {}, headers: Buffer.from('') })

describe('fetchSince', () => {
  it('asks for a UID range starting one past the cursor, in UID mode', async () => {
    const client = fetchingClient([msg(101)])
    await fetchSince(client, { sinceUid: 100, cap: 10 })
    expect(client.calls[0].range).toBe('101:*')
    expect(client.calls[0].options).toEqual({ uid: true })
    expect(client.calls[0].query.uid).toBe(true)
  })

  it('🔴 fetches References explicitly — imapflow’s ENVELOPE does not carry it', async () => {
    // Without References, a reply deep in a chain threads onto nothing and
    // opens a duplicate ticket.
    const client = fetchingClient([])
    await fetchSince(client, { sinceUid: 0 })
    expect(client.calls[0].query.headers).toEqual(['message-id', 'in-reply-to', 'references'])
  })

  it('asks for envelope + bodyStructure, and does NOT download the source', async () => {
    // bodyStructure-first, selective part download: a 40MB message must not
    // exhaust the function (the MAX_PART_BYTES pattern in the risk table).
    const client = fetchingClient([])
    await fetchSince(client, { sinceUid: 0 })
    expect(client.calls[0].query).toMatchObject({
      envelope: true, bodyStructure: true, internalDate: true, size: true,
    })
    expect(client.calls[0].query.source).toBeUndefined()
  })

  it('returns the new messages, oldest first', async () => {
    const client = fetchingClient([msg(101), msg(102), msg(103)])
    const out = await fetchSince(client, { sinceUid: 100, cap: 10 })
    expect(out.map(m => m.uid)).toEqual([101, 102, 103])
  })

  it('🔴 drops the message an empty `N:*` range always volunteers', async () => {
    // RFC 3501 §6.4.8: when no message has a UID >= N the server answers with
    // the HIGHEST existing UID anyway. Trusting the range would re-ingest the
    // newest message on every single tick, forever.
    const client = fetchingClient([msg(100)])
    expect(await fetchSince(client, { sinceUid: 100, cap: 10 })).toEqual([])
  })

  it('drops anything at or below the cursor even mid-batch', async () => {
    const client = fetchingClient([msg(99), msg(100), msg(101)])
    const out = await fetchSince(client, { sinceUid: 100, cap: 10 })
    expect(out.map(m => m.uid)).toEqual([101])
  })

  it('🔴 the cap takes the OLDEST, never the newest', async () => {
    // Taking the newest would advance the watermark past everything skipped —
    // silent, permanent mail loss on any backlog.
    const backlog = Array.from({ length: 500 }, (_, i) => msg(i + 1))
    const out = await fetchSince(fetchingClient(backlog), { sinceUid: 0, cap: 50 })
    expect(out).toHaveLength(50)
    expect(out[0].uid).toBe(1)
    expect(out[49].uid).toBe(50)
  })

  it('stops iterating once the cap is reached', async () => {
    // Not just a slice: the iterator must not be drained, or a 20k-message
    // backlog is pulled into memory to throw away.
    let yielded = 0
    const client = {
      fetch() {
        return (async function* () {
          for (let uid = 1; uid <= 1000; uid++) { yielded++; yield msg(uid) }
        })()
      },
    }
    const out = await fetchSince(client, { sinceUid: 0, cap: 5 })
    expect(out).toHaveLength(5)
    expect(yielded).toBe(5)
  })

  it('sorts ascending even if a server answers out of order', async () => {
    const client = fetchingClient([msg(103), msg(101), msg(102)])
    const out = await fetchSince(client, { sinceUid: 100, cap: 10 })
    expect(out.map(m => m.uid)).toEqual([101, 102, 103])
  })

  it('defaults the cap rather than failing on a junk one', async () => {
    // A bad cap only costs a differently-sized batch — the harmless direction.
    const client = fetchingClient(Array.from({ length: 80 }, (_, i) => msg(i + 1)))
    expect(await fetchSince(client, { sinceUid: 0, cap: 'lots' })).toHaveLength(50)
    expect(await fetchSince(client, { sinceUid: 0, cap: 0 })).toHaveLength(50)
    expect(await fetchSince(client, { sinceUid: 0 })).toHaveLength(50)
  })

  it('🔴 REFUSES an unusable cursor rather than backfilling the whole mailbox', async () => {
    // "No backfill, ever" (§3.5). A NaN cursor coerced to 0 would fetch `1:*`
    // and file years of correspondence as fresh tickets with push
    // notifications. This is the narrow case where failing closed is right:
    // proceeding is actively harmful and irreversible.
    const client = fetchingClient([msg(1)])
    await expect(fetchSince(client, { sinceUid: undefined })).rejects.toThrow(/unusable cursor/)
    await expect(fetchSince(client, { sinceUid: null })).rejects.toThrow(/unusable cursor/)
    await expect(fetchSince(client, { sinceUid: NaN })).rejects.toThrow(/unusable cursor/)
    await expect(fetchSince(client, { sinceUid: '100' })).rejects.toThrow(/unusable cursor/)
    await expect(fetchSince(client, { sinceUid: -1 })).rejects.toThrow(/unusable cursor/)
    await expect(fetchSince(client, {})).rejects.toThrow(/unusable cursor/)
    await expect(fetchSince(client)).rejects.toThrow(/unusable cursor/)
    // Nothing was asked of the server.
    expect(client.calls).toEqual([])
  })

  it('accepts sinceUid 0 — that is a mailbox anchored while empty', async () => {
    const client = fetchingClient([msg(1)])
    const out = await fetchSince(client, { sinceUid: 0, cap: 10 })
    expect(client.calls[0].range).toBe('1:*')
    expect(out.map(m => m.uid)).toEqual([1])
  })

  it('tolerates a message with no usable uid', async () => {
    const client = fetchingClient([{ uid: undefined }, msg(101)])
    expect((await fetchSince(client, { sinceUid: 100, cap: 10 })).map(m => m.uid)).toEqual([101])
  })
})
