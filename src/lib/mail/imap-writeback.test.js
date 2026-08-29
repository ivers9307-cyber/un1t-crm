// INBOX-SURFACE.A — tests for the ONLY module in this codebase that writes to
// a customer's IMAP mailbox.
//
// NOTHING HERE TOUCHES A NETWORK, A MAILBOX OR A DATABASE. Two fakes: an IMAP
// client injected through the `deps.createClient` seam, and a supabase client
// that answers the two reads the guard does.
//
// The tests are organised around the things that must never regress, and the
// first two matter more than all the rest put together:
//
//   • A MAILBOX THAT IS NOT ON THE INBOX SURFACE IS NEVER TOUCHED. Not marked,
//     not moved, not even CONNECTED to. The guard is the entire reason this
//     module is allowed to exist at all.
//   • NOTHING IS EVER DELETED. There is no \Deleted, no EXPUNGE and no
//     messageDelete on any path, on any outcome, including the failures.
//
// After those: that imap-connection.js's read-only default is untouched (this
// module narrows a promise, it does not remove one), that a failure is a
// verdict rather than a throw, and that the connection is released on every
// path — including the LOGIN failure that leaves imapflow's socket up, which
// is the one that repeats forever and locks an operator out of their own
// mailbox.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFile } from 'node:fs/promises'

vi.mock('../log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { logError, logWarn } from '../log'
import { seal } from './secret-box'
import { withMailbox } from './imap-connection'
import { classifyImapFailure, operatorFacingDialError } from './imap-poll'
import {
  markSeen,
  markUnseen,
  archiveMessage,
  pickArchiveFolder,
  withWritableMailbox,
  classifyWritebackFailure,
  operatorFacingWriteError,
} from './imap-writeback'

/* ─────────────────────────────── fixtures ─────────────────────────────── */

const MAILBOX_ID = '11111111-2222-3333-4444-555555555555'
const NOW = Date.parse('2026-08-27T09:00:00.000Z')

function mailboxRow(overrides = {}) {
  return {
    id: MAILBOX_ID,
    location_id: 'loc-1',
    address: 'hatchstreet@un1t.com',
    active: true,
    ingress: 'imap',
    ...overrides,
  }
}

function credentialRow(overrides = {}) {
  return {
    mailbox_id: MAILBOX_ID,
    provider: 'gmail',
    auth_type: 'password',
    username: 'hatchstreet@un1t.com',
    secret_ciphertext: seal('not-a-real-app-password'),
    oauth_access_token_ciphertext: null,
    oauth_refresh_token_ciphertext: null,
    oauth_expires_at: null,
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_secure: true,
    archive_folder: null,
    ...overrides,
  }
}

/* ─────────────────────────────── the fake db ──────────────────────────── */

/**
 * Only the two reads the guard does. Deliberately narrow: a fake that answered
 * any table would let a future write slip in here untested.
 */
function makeDb({ mailbox = mailboxRow(), credential = credentialRow(), errors = {} } = {}) {
  const state = { reads: [] }
  return {
    state,
    from(table) {
      const filters = {}
      const api = {
        select() { return api },
        eq(col, val) { filters[col] = val; return api },
        async maybeSingle() {
          state.reads.push(table)
          if (table === 'email_mailboxes') {
            if (errors.mailbox) return { data: null, error: errors.mailbox }
            return { data: filters.id === MAILBOX_ID ? mailbox : null, error: null }
          }
          if (table === 'email_mailbox_credentials') {
            if (errors.credential) return { data: null, error: errors.credential }
            return { data: filters.mailbox_id === MAILBOX_ID ? credential : null, error: null }
          }
          throw new Error(`unexpected read on ${table}`)
        },
      }
      return api
    },
  }
}

/* ───────────────────────────── the fake IMAP ──────────────────────────── */

const GMAIL_FOLDERS = [
  { path: 'INBOX', specialUse: '\\Inbox' },
  { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
  { path: '[Gmail]/Trash', specialUse: '\\Trash' },
  { path: '[Gmail]/All Mail', specialUse: '\\All' },
]

const OUTLOOK_FOLDERS = [
  { path: 'Inbox', specialUse: '\\Inbox' },
  { path: 'Archive', specialUse: '\\Archive' },
  { path: 'Deleted Items', specialUse: '\\Trash' },
]

function fakeImap({
  folders = GMAIL_FOLDERS,
  searchResult = [7],
  failAt = null,
  flagsAddResult = true,
  flagsRemoveResult = true,
  moveResult = { uidMap: new Map() },
  listThrows = false,
  // 🔴 MODEL THE LIBRARY, NOT A CONVENIENT SUBSET. This fake previously had no
  // `capabilities` at all, which made every test here run against a client
  // shape ImapFlow never produces — and it is precisely why the suite's
  // "no \Deleted / no EXPUNGE" assertions passed while imapflow's own
  // non-MOVE fallback would have issued both. A default of MOVE+UIDPLUS
  // matches Gmail and Microsoft 365; pass [] to model the servers that do not.
  capabilities = ['MOVE', 'UIDPLUS'],
} = {}) {
  const calls = []
  const client = {
    calls,
    capabilities: new Map(capabilities.map(c => [c, true])),
    async connect() {
      calls.push(['connect'])
      if (failAt === 'connect') throw new Error('ECONNREFUSED imap.gmail.com:993')
      if (failAt === 'auth') {
        const err = new Error('Invalid credentials (Failure) [ALERT] Please log in via your web browser')
        err.authenticationFailed = true
        err.serverResponseCode = 'AUTHENTICATIONFAILED'
        throw err
      }
    },
    async mailboxOpen(path, opts) {
      calls.push(['mailboxOpen', path, opts])
      if (failAt === 'open') throw new Error('NO [NONEXISTENT] Unknown Mailbox')
      return { path, uidValidity: 12345n, uidNext: 900, readOnly: opts?.readOnly === true }
    },
    async search(query, opts) {
      calls.push(['search', query, opts])
      return searchResult
    },
    async list() {
      calls.push(['list'])
      if (listThrows) throw new Error('LIST timed out')
      return folders
    },
    async messageFlagsAdd(range, flags, opts) {
      calls.push(['messageFlagsAdd', range, flags, opts])
      if (failAt === 'store') throw new Error('NO STORE failed')
      return flagsAddResult
    },
    async messageFlagsRemove(range, flags, opts) {
      calls.push(['messageFlagsRemove', range, flags, opts])
      if (failAt === 'store') throw new Error('NO STORE failed')
      return flagsRemoveResult
    },
    async messageMove(range, destination, opts) {
      calls.push(['messageMove', range, destination, opts])
      if (failAt === 'move') throw new Error('NO [TRYCREATE] destination missing')
      return moveResult
    },
    async logout() { calls.push(['logout']) },
    close() { calls.push(['close']) },
  }
  return { client, deps: { createClient: (opts) => { calls.push(['createClient', opts]); return client } } }
}

/** Every command name the fake saw, so a test can assert on the whole trace. */
const names = (client) => client.calls.map(c => c[0])

beforeEach(() => {
  process.env.MAILBOX_SECRET_KEY = Buffer.alloc(32, 7).toString('base64')
  vi.clearAllMocks()
})

/* ═══════════════ 1. the guard — the reason this module exists ═════════ */

describe('the source guard', () => {
  // (RETIRE-TICKETS.1 — the surface refusal that led this block is gone with
  // the surface split, mig 578. The guard's remaining axes — ingress, active,
  // existence, readability — are pinned below, and the re-read property is
  // pinned on the ingress axis.)

  it('🔴 RE-READS the mailbox from the database — a caller cannot hand one in', async () => {
    // The whole point of a source-side guard: a future caller must not be able
    // to talk its way past it with a hand-built object or a row it read five
    // minutes ago. The DB row says postmark; the forged object claims imap —
    // the DB must win.
    const db = makeDb({ mailbox: mailboxRow({ ingress: 'postmark' }) })
    const { client, deps } = fakeImap()

    const forged = { id: MAILBOX_ID, ingress: 'imap', active: true }
    const out = await markSeen(db, forged, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'not_imap' })
    expect(client.calls).toEqual([])
  })

  it('refuses a mailbox that no longer exists', async () => {
    const db = makeDb({ mailbox: null })
    const { client, deps } = fakeImap()

    const out = await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'mailbox_not_found' })
    expect(client.calls).toEqual([])
  })

  it('🔴 an UNREADABLE mailbox row refuses too — it is not the same as a policy refusal', async () => {
    // Collapsing the two would make a database outage look like a policy
    // decision, and the operator would go looking at the wrong setting.
    const db = makeDb({ errors: { mailbox: { message: 'connection reset' } } })
    const { client, deps } = fakeImap()

    const out = await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'mailbox_unreadable' })
    expect(client.calls).toEqual([])
    expect(logError).toHaveBeenCalled()
  })

  it('refuses a postmark-ingress mailbox — there is no account to write to', async () => {
    const db = makeDb({ mailbox: mailboxRow({ ingress: 'postmark' }) })
    const { client, deps } = fakeImap()

    const out = await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'not_imap' })
    expect(client.calls).toEqual([])
  })

  it('refuses a deactivated mailbox — an operator has already said stop', async () => {
    const db = makeDb({ mailbox: mailboxRow({ active: false }) })
    const { client, deps } = fakeImap()

    const out = await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'mailbox_inactive' })
    expect(client.calls).toEqual([])
  })

  it('refuses with no mailbox id at all rather than reading the whole table', async () => {
    const db = makeDb()
    const out = await markSeen(db, null, { uid: 7, now: NOW })
    expect(out).toMatchObject({ ok: false, reason: 'invalid_mailbox' })
    expect(db.state.reads).toEqual([])
  })
})

/* ═══════════════════ 2. the two writes, and only two ═════════════════ */

describe('markSeen', () => {
  it('issues STORE +FLAGS (\\Seen) in UID mode for exactly that message', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap()

    const out = await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: true, applied: true, uid: 7 })
    expect(client.calls).toContainEqual(['messageFlagsAdd', '7', ['\\Seen'], { uid: true }])
  })

  it('🔴 UID mode, never sequence numbers — a human expunging in Gmail shifts those', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap()

    await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    const store = client.calls.find(c => c[0] === 'messageFlagsAdd')
    expect(store[3]).toEqual({ uid: true })
  })

  it('🔴 a STORE that returns false is a FAILURE, not a benign no-op', async () => {
    // This test used to assert the opposite, and the opposite was wrong.
    // imapflow's commands/store.js returns `true` on success and `false` ONLY
    // from its catch — a UID range matching nothing still returns `true`. So
    // there is no "matched nothing" case to forgive here: `false` means Gmail
    // said NO (throttling, [LIMIT], a dropped socket) and the flag was NOT set.
    // Reporting that as success left the member's mail bold in the real mailbox
    // while the CRM showed it read — the exact double-triage the surface exists
    // to remove.
    const db = makeDb()
    const { deps } = fakeImap({ flagsAddResult: false })

    const out = await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'flag_failed' })
    expect(out.error).toMatch(/could not reach the mail server/i)
  })

  it('exports markUnseen, and it clears the flag rather than setting it', async () => {
    // This module deliberately shipped WITHOUT markUnseen at first, on the
    // reasoning that a CRM-only unread mark undoes itself. That reasoning was
    // right about the danger and wrong about the fix: the answer is the paired
    // IMAP write, not the missing button — without it the mail surface goes
    // into the trial with no defer verb at all while the ticket queue has
    // reopen, which biases the comparison it exists to settle.
    const db = makeDb()
    const { client, deps } = fakeImap()

    const out = await markUnseen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: true, applied: true })
    const [, range, flags, opts] = client.calls.find(c => c[0] === 'messageFlagsRemove')
    expect(range).toBe('7')
    expect(flags).toEqual(['\\Seen'])
    expect(opts).toEqual({ uid: true })
    // It must never reach for the ADD path, and never move anything.
    expect(names(client)).not.toContain('messageFlagsAdd')
    expect(names(client)).not.toContain('messageMove')
  })

  it('🔴 markUnseen obeys the SAME source guard — it is not a back door', async () => {
    const db = makeDb({ mailbox: mailboxRow({ ingress: 'postmark' }) })
    const { client, deps } = fakeImap()

    const out = await markUnseen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'not_imap' })
    expect(client.calls).toEqual([])
  })

  it('a STORE refusal on markUnseen is a failure, like every other write here', async () => {
    const db = makeDb()
    const { deps } = fakeImap({ flagsRemoveResult: false })

    const out = await markUnseen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'flag_failed' })
  })

  it('🔴 still exports NO way to delete, expunge or trash anything', async () => {
    // The module's central promise, asserted on the public surface. markUnseen
    // is a flag CLEAR — it destroys nothing and moves nothing — so it is not
    // the thing this guards against; a delete in any spelling is.
    const mod = await import('./imap-writeback')
    const exported = Object.keys(mod)
    expect(exported.some(k => /delete|expunge|trash|purge|remove(?!.*Flag)/i.test(k))).toBe(false)
    // And the source itself never ISSUES one. Comments are stripped first: this
    // file discusses messageDelete and EXPUNGE at length — it has to, because
    // imapflow reaches for both behind messageMove on a non-MOVE server — and a
    // check that cannot tell an explanation from a call would force the warning
    // to be deleted to stay green.
    const src = await readFile(new URL('./imap-writeback.js', import.meta.url), 'utf8')
    const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(code).not.toMatch(/messageDelete\s*\(/)
    expect(code).not.toMatch(/\bEXPUNGE\b/)
  })
})

describe('archiveMessage', () => {
  it('MOVEs to the \\Archive folder the server advertises', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap({ folders: OUTLOOK_FOLDERS })

    const out = await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: true, applied: true, uid: 7, folder: 'Archive', via: 'special-use' })
    expect(client.calls).toContainEqual(['messageMove', '7', 'Archive', { uid: true }])
  })

  it('falls back to \\All for Gmail, which has no \\Archive at all', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap({ folders: GMAIL_FOLDERS })

    const out = await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: true, folder: '[Gmail]/All Mail', via: 'special-use' })
    expect(client.calls).toContainEqual(['messageMove', '7', '[Gmail]/All Mail', { uid: true }])
  })

  it('the operator’s configured folder beats discovery', async () => {
    const db = makeDb({ credential: credentialRow({ archive_folder: '[Gmail]/Sent Mail' }) })
    const { client, deps } = fakeImap({ folders: GMAIL_FOLDERS })

    const out = await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: true, folder: '[Gmail]/Sent Mail', via: 'configured' })
    expect(client.calls).toContainEqual(['messageMove', '7', '[Gmail]/Sent Mail', { uid: true }])
  })

  it('🔴 refuses a configured folder the server does not list, rather than MOVEing into it', async () => {
    // Some servers auto-create on MOVE, so a typo would silently grow a stray
    // folder and file a studio's mail into it.
    const db = makeDb({ credential: credentialRow({ archive_folder: 'Archiv' }) })
    const { client, deps } = fakeImap({ folders: OUTLOOK_FOLDERS })

    const out = await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'archive_folder_missing' })
    expect(out.error).toMatch(/Archiv/)
    expect(names(client)).not.toContain('messageMove')
  })

  it('refuses when the server advertises nowhere to archive to', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap({ folders: [{ path: 'INBOX', specialUse: '\\Inbox' }] })

    const out = await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'no_archive_folder' })
    expect(out.error).toMatch(/archive folder/i)
    expect(names(client)).not.toContain('messageMove')
  })

  it('a LIST that fails is a transport verdict, not "there is no archive folder"', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap({ listThrows: true })

    const out = await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'folder_list_failed' })
    expect(names(client)).not.toContain('messageMove')
  })

  it('🔴 a MOVE that returns false is a FAILURE, not a benign no-op', async () => {
    // Same correction as the STORE above. It matters more here: nothing
    // converges archive state, so an unarchived message reported as archived
    // stays wrong in the real mailbox for ever.
    const db = makeDb()
    const { deps } = fakeImap({ folders: OUTLOOK_FOLDERS, moveResult: false })

    const out = await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'move_failed' })
  })

  // ── the guard that keeps this module's central promise true ──
  it('🔴 REFUSES a server with no MOVE capability, rather than letting imapflow emulate it', async () => {
    // imapflow does not fail without RFC 6851 MOVE — commands/move.js emulates
    // it as COPY then, unconditionally, messageDelete = \Deleted + EXPUNGE.
    // A failed COPY still deletes, so the message is destroyed with no copy
    // anywhere; and without UIDPLUS the expunge is bare, reaping every
    // \Deleted message in the folder. This module promises it never deletes,
    // and that promise is only true because of this refusal.
    const db = makeDb()
    const { client, deps } = fakeImap({ folders: OUTLOOK_FOLDERS, capabilities: ['UIDPLUS'] })

    const out = await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'move_unsupported' })
    // The refusal has to happen BEFORE the command, not be judged after it.
    expect(names(client)).not.toContain('messageMove')
    // And the operator is told the CRM half stands, so they do not retry blindly.
    expect(out.error).toMatch(/archived here/i)
  })

  it('still archives normally on a server that does advertise MOVE', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap({ folders: OUTLOOK_FOLDERS })

    const out = await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: true, applied: true })
    expect(names(client)).toContain('messageMove')
  })
})

describe('pickArchiveFolder', () => {
  // 🔴 The guarantee has to hold on the CONFIGURED path too. Auto-discovery is
  // safe by construction (it only ever selects \Archive/\All or a known good
  // name), so the test below could pass while an operator who typed "Deleted
  // Items" into the archive-folder field turned Archive into a delete.
  it('🔴 REFUSES a configured folder that is Trash or Junk, by flag or by name', () => {
    const boxes = [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: 'Deleted Items', specialUse: '\\Trash' },
      { path: 'Junk Email', specialUse: '\\Junk' },
      { path: 'Bin' },
      { path: 'Archive', specialUse: '\\Archive' },
    ]
    for (const bad of ['Deleted Items', 'Junk Email', 'Bin']) {
      const out = pickArchiveFolder(boxes, bad)
      expect(out).toMatchObject({ ok: false, reason: 'archive_folder_forbidden' })
      expect(out.error).toMatch(/recoverable/i)
    }
    // A real archive folder still works when configured explicitly.
    expect(pickArchiveFolder(boxes, 'Archive')).toMatchObject({ ok: true, via: 'configured' })
  })

  it('🔴 NEVER answers Trash or Junk — that is a delete with extra steps', () => {
    const out = pickArchiveFolder([
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: 'Deleted Items', specialUse: '\\Trash' },
      { path: 'Junk Email', specialUse: '\\Junk' },
    ])
    expect(out).toMatchObject({ ok: false, reason: 'no_archive_folder' })
  })

  it('prefers \\Archive over \\All when a server has both', () => {
    const out = pickArchiveFolder([
      { path: 'All Mail', specialUse: '\\All' },
      { path: 'Archive', specialUse: '\\Archive' },
    ])
    expect(out).toMatchObject({ ok: true, path: 'Archive' })
  })

  it('falls back to a conventional NAME, but only one the server listed', () => {
    const out = pickArchiveFolder([{ path: 'INBOX' }, { path: 'INBOX.Archive' }])
    expect(out).toMatchObject({ ok: true, path: 'INBOX.Archive', via: 'name' })
  })

  it('tolerates a junk list rather than throwing', () => {
    expect(pickArchiveFolder(null)).toMatchObject({ ok: false })
    expect(pickArchiveFolder([null, {}, { path: '' }])).toMatchObject({ ok: false })
  })
})

/* ══════════════════ 3. nothing is ever deleted, anywhere ═════════════ */

describe('🔴 delete is not in scope, on any path', () => {
  const forbidden = /^(messageDelete|messageFlagsSet|messageFlagsRemove|expunge)$/

  it('no delete-shaped command on the happy paths', async () => {
    for (const op of [markSeen, archiveMessage]) {
      const db = makeDb()
      const { client, deps } = fakeImap({ folders: OUTLOOK_FOLDERS })
      await op(db, MAILBOX_ID, { uid: 7, now: NOW, deps })
      expect(names(client).filter(n => forbidden.test(n))).toEqual([])
    }
  })

  it('no \\Deleted flag is ever added, and no destination is ever a Trash folder', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap({ folders: [...OUTLOOK_FOLDERS] })
    await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })
    await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    const flagged = client.calls.filter(c => c[0] === 'messageFlagsAdd').flatMap(c => c[2])
    expect(flagged).toEqual(['\\Seen'])

    const destinations = client.calls.filter(c => c[0] === 'messageMove').map(c => c[2])
    expect(destinations).toEqual(['Archive'])
    expect(destinations.some(d => /trash|deleted|junk|spam/i.test(d))).toBe(false)
  })

  it('the module exports no delete door', async () => {
    const mod = await import('./imap-writeback')
    expect(Object.keys(mod).some(k => /delete|trash|expunge|purge/i.test(k))).toBe(false)
  })
})

/* ════════════ 4. read-only stays the default for everyone else ═══════ */

describe('the read-only posture', () => {
  it('🔴 the WRITE path opens the folder read-WRITE, and says so explicitly', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap()

    await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(client.calls).toContainEqual(['mailboxOpen', 'INBOX', { readOnly: false }])
  })

  it('🔴 withMailbox() — every EXISTING caller — is untouched and still read-only', async () => {
    // This module narrows a promise; it does not remove one. If someone ever
    // "simplifies" by flipping withMailbox's default, this fails here rather
    // than in production on a mailbox nobody is trialling anything on.
    const { client, deps } = fakeImap()
    await withMailbox(
      { host: 'imap.gmail.com', auth: { user: 'u', pass: 'p' } }, 'INBOX', async () => true, deps,
    )
    expect(client.calls).toContainEqual(['mailboxOpen', 'INBOX', { readOnly: true }])
    expect(names(client).filter(n => /^message/.test(n))).toEqual([])
  })

  it('the write path only ever opens INBOX — never All Mail, which holds Sent', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap({ folders: OUTLOOK_FOLDERS })
    await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })
    const opened = client.calls.filter(c => c[0] === 'mailboxOpen').map(c => c[1])
    expect(opened).toEqual(['INBOX'])
  })
})

/* ═══════════ 5. the connection is always released, and never logs ════ */

describe('withWritableMailbox', () => {
  const CONFIG = { host: 'imap.example.test', auth: { user: 'u', pass: 'secret-pass' } }

  it('connects, opens read-write, runs fn, then logs out — in that order', async () => {
    const { client, deps } = fakeImap()
    const out = await withWritableMailbox(CONFIG, 'INBOX', async () => 'done', deps)
    expect(out).toBe('done')
    expect(names(client)).toEqual(['createClient', 'connect', 'mailboxOpen', 'logout', 'close'])
  })

  it('🔴 RELEASES THE CONNECTION when connect() fails at LOGIN', async () => {
    // imapflow does not close the socket when authentication fails, and a
    // revoked app password fails at LOGIN on every attempt forever — which is
    // precisely the sustained-failure case that exhausts a provider's
    // per-account connection cap and locks the operator out of their own
    // mailbox. connect() is inside the try for exactly this.
    const { client, deps } = fakeImap({ failAt: 'auth' })
    await expect(withWritableMailbox(CONFIG, 'INBOX', async () => true, deps)).rejects.toThrow()
    expect(names(client)).toContain('logout')
    expect(names(client)).toContain('close')
  })

  it('releases it when fn throws, and re-throws the ORIGINAL error', async () => {
    const { client, deps } = fakeImap()
    await expect(
      withWritableMailbox(CONFIG, 'INBOX', async () => { throw new Error('the real problem') }, deps),
    ).rejects.toThrow('the real problem')
    expect(names(client)).toContain('logout')
  })

  it('🔴 the release path is never the thing that throws', async () => {
    const { client, deps } = fakeImap()
    client.logout = async () => { throw new Error('logout blew up') }
    client.close = () => { throw new Error('close blew up') }
    await expect(withWritableMailbox(CONFIG, 'INBOX', async () => 'ok', deps)).resolves.toBe('ok')
  })

  it('🔴 NEVER turns logging on — the LOGIN command carries the mailbox password', async () => {
    const { client, deps } = fakeImap()
    await withWritableMailbox(CONFIG, 'INBOX', async () => true, deps)
    const opts = client.calls.find(c => c[0] === 'createClient')[1]
    expect(opts.logger).toBe(false)
    expect(opts.disableAutoIdle).toBe(true)
  })

  it('passes host/port/TLS through per-mailbox, defaulting to 993 + implicit TLS', async () => {
    const { client, deps } = fakeImap()
    await withWritableMailbox(CONFIG, 'INBOX', async () => true, deps)
    const opts = client.calls.find(c => c[0] === 'createClient')[1]
    expect(opts).toMatchObject({ host: 'imap.example.test', port: 993, secure: true })

    const second = fakeImap()
    await withWritableMailbox({ ...CONFIG, port: 143, secure: false }, 'INBOX', async () => true, second.deps)
    expect(second.client.calls.find(c => c[0] === 'createClient')[1])
      .toMatchObject({ port: 143, secure: false })
  })
})

/* ═════════════ 6. a failure is a verdict, never a 500 ════════════════ */

describe('failures never throw', () => {
  it('a revoked app password comes back as an auth verdict an operator can act on', async () => {
    const db = makeDb()
    const { deps } = fakeImap({ failAt: 'auth' })

    const out = await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'auth_failed' })
    expect(out.error).toMatch(/app password/i)
  })

  it('an unreachable host is a transport verdict with a different next action', async () => {
    const db = makeDb()
    const { deps } = fakeImap({ failAt: 'connect' })

    const out = await archiveMessage(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'write_failed' })
    expect(out.error).toMatch(/Could not reach the mail server/i)
  })

  it('🔴 the operator NEVER gets the remote server’s own words (MAILBOX-CONNECT.8)', async () => {
    // Echoing responseText turns an Archive button into a port scanner: a
    // mailbox pointed at an internal host must report exactly what an
    // unreachable public one reports. The detail goes to the log instead.
    const db = makeDb()
    const { deps } = fakeImap({ failAt: 'auth' })

    const out = await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out.error).not.toMatch(/web browser|ALERT|AUTHENTICATIONFAILED/i)
    expect(logError).toHaveBeenCalledWith(
      'imap-writeback', expect.stringMatching(/IMAP write failed/i),
      expect.objectContaining({ kind: 'auth' }),
    )
  })

  it('a store that throws mid-command is still a verdict, and the socket is still released', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap({ failAt: 'store' })

    const out = await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'write_failed' })
    expect(names(client)).toContain('logout')
  })

  it('a missing credential refuses before anything is opened', async () => {
    const db = makeDb({ credential: null })
    const { client, deps } = fakeImap()

    const out = await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'no_credential' })
    expect(client.calls).toEqual([])
  })

  it('an unreadable credential row refuses too', async () => {
    const db = makeDb({ errors: { credential: { message: 'connection reset' } } })
    const { client, deps } = fakeImap()

    const out = await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'credential_lookup_failed' })
    expect(client.calls).toEqual([])
  })
})

/* ═════════════════ 7. which message — the caller's seam ══════════════ */

describe('resolving the message', () => {
  it('a caller with a UID skips the search entirely', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap()

    await markSeen(db, MAILBOX_ID, { uid: 7, now: NOW, deps })

    expect(names(client)).not.toContain('search')
  })

  it('a caller with only an rfc_message_id searches the header for it', async () => {
    // The inbox surface holds an email_inbox_messages row, and nothing writes
    // an IMAP UID onto one — the row is written by the inbound webhook route,
    // which has never heard of IMAP. rfc_message_id is the seam.
    const db = makeDb()
    const { client, deps } = fakeImap({ searchResult: [42] })

    const out = await markSeen(db, MAILBOX_ID, { rfcMessageId: 'abc@mail.example', now: NOW, deps })

    expect(out).toMatchObject({ ok: true, uid: 42 })
    expect(client.calls).toContainEqual([
      'search', { header: { 'message-id': 'abc@mail.example' } }, { uid: true },
    ])
  })

  it('strips the angle brackets, so either stored form works', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap({ searchResult: [42] })
    await markSeen(db, MAILBOX_ID, { rfcMessageId: '<abc@mail.example>', now: NOW, deps })
    expect(client.calls.find(c => c[0] === 'search')[1])
      .toEqual({ header: { 'message-id': 'abc@mail.example' } })
  })

  it('a message no longer in the folder is a verdict, not a write against nothing', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap({ searchResult: [] })

    const out = await markSeen(db, MAILBOX_ID, { rfcMessageId: 'abc@mail.example', now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'not_in_mailbox' })
    expect(names(client)).not.toContain('messageFlagsAdd')
  })

  it('🔴 a FAILED search is not the same answer as an empty one', async () => {
    // imapflow's search() returns `false` for a NO/BAD, for a parse error, and
    // for a session that is not in SELECTED state. Coercing that to [] made a
    // transient Gmail `NO [LIMIT]` indistinguishable from "the message is not
    // here" — and applyWriteback deliberately counts not_in_mailbox as SUCCESS,
    // so the operator was told the mailbox had been changed by a search that
    // never ran. An empty array is an answer; `false` is the absence of one.
    const db = makeDb()
    const { client, deps } = fakeImap({ searchResult: false })

    const out = await markSeen(db, MAILBOX_ID, { rfcMessageId: 'abc@mail.example', now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'search_failed' })
    expect(out.reason).not.toBe('not_in_mailbox')
    expect(names(client)).not.toContain('messageFlagsAdd')
  })

  it('🔴 TWO matches is a refusal, not a pick', async () => {
    // Archiving "the first one" would move a message the operator did not
    // choose, out of a folder they can no longer see it in.
    const db = makeDb()
    const { client, deps } = fakeImap({ searchResult: [42, 43], folders: OUTLOOK_FOLDERS })

    const out = await archiveMessage(db, MAILBOX_ID, { rfcMessageId: 'abc@mail.example', now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'ambiguous_message' })
    expect(names(client)).not.toContain('messageMove')
  })

  it('neither a uid nor an id is a verdict rather than a whole-folder operation', async () => {
    const db = makeDb()
    const { client, deps } = fakeImap()

    const out = await markSeen(db, MAILBOX_ID, { now: NOW, deps })

    expect(out).toMatchObject({ ok: false, reason: 'no_message_reference' })
    expect(names(client)).not.toContain('messageFlagsAdd')
  })
})

/* ═════════ 8. the deliberate duplication is pinned, not hoped for ════ */

describe('the failure classifier is a PINNED copy of the poller’s', () => {
  // These two functions are duplicated from imap-poll.js on purpose: importing
  // them would drag the sent-lane writer, the attachment server and the
  // inbound mapper into every request-scoped API route that wants to mark one
  // message read. The comment in the source says they must not drift; this is
  // what makes that true rather than aspirational.
  const cases = [
    { authenticationFailed: true },
    { serverResponseCode: 'AUTHENTICATIONFAILED' },
    { serverResponseCode: 'EXPIRED' },
    { message: 'Invalid credentials (Failure)' },
    { message: 'Application-specific password required' },
    { responseText: 'Web login required' },
    { message: 'ECONNREFUSED' },
    { message: 'Socket timeout' },
    {},
    null,
  ]

  it('classifies every case identically', () => {
    for (const err of cases) {
      expect(classifyWritebackFailure(err)).toBe(classifyImapFailure(err))
    }
  })

  it('gives the auth category the same operator sentence', () => {
    expect(operatorFacingWriteError('auth')).toBe(operatorFacingDialError('auth'))
  })

  it('the transport sentences differ ON PURPOSE — one of them says nothing was changed', () => {
    expect(operatorFacingWriteError('transport')).not.toBe(operatorFacingDialError('transport'))
    expect(operatorFacingWriteError('transport')).toMatch(/not made in the mailbox/i)
  })
})
