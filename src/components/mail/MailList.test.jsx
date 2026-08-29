// @vitest-environment jsdom
//
// MAIL-TRIAL.B — the conversation list, as an operator actually reads it.
//
// WHY THESE ARE RENDER TESTS. The trial is a comparison of two surfaces, and
// what is being compared is not the data — both screens run on the same rows —
// but what an operator sees and can reach. So the assertions here are about
// exactly that: is an unread conversation visibly heavier, is archive reachable
// without opening anything, and has the ticket lifecycle really gone rather
// than merely been renamed.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, within } from '@testing-library/react'
import MailList from './MailList.jsx'
import { mailView } from './mail-display'

afterEach(cleanup)

const BASE = {
  id: 'conv-1',
  mailbox_id: 'mb-1',
  requester_email: 'ella@member.ie',
  requester_name: 'Ella Byrne',
  subject: 'Membership freeze',
  last_message_preview: 'Can I freeze from Monday?',
  last_message_direction: 'inbound',
  last_message_at: '2026-08-26T09:00:00Z',
  status: 'open',
  needs_reply: true,
  archived: false,
  unread: true,
  message_count: 3,
}

const conv = (over = {}) => ({ ...BASE, ...over })

function renderList(props = {}) {
  return render(
    <MailList
      conversations={[conv()]}
      view={mailView('inbox')}
      onSelect={() => {}}
      onArchive={() => {}}
      onMarkRead={() => {}}
      {...props}
    />
  )
}

// The whole row — the select button AND its two actions are siblings inside
// one <li>, deliberately (a button inside a button is markup browsers resolve
// by dropping one of them), so the list item is the thing to scope to.
const row = (index = 0) => screen.getAllByRole('listitem')[index]

describe('MailList — read/unread is the primary weight', () => {
  it('renders an unread conversation in a heavier weight than a read one', () => {
    render(
      <MailList
        conversations={[
          conv({ id: 'unread-1', requester_name: 'Unread Person', unread: true }),
          conv({ id: 'read-1', requester_name: 'Read Person', unread: false }),
        ]}
        view={mailView('inbox')}
      />
    )
    expect(screen.getByText('Unread Person').className).toContain('font-semibold')
    // Not merely "less bold" — the read row must not carry the unread weight at
    // all, or the whole signal collapses on a busy inbox.
    expect(screen.getByText('Read Person').className).not.toContain('font-semibold')
  })

  it('offers "Mark read" on an unread conversation, and clears it without opening', () => {
    const onMarkRead = vi.fn()
    renderList({ conversations: [conv({ unread: true })], onMarkRead })
    screen.getByTitle('Mark read').click()
    expect(onMarkRead.mock.calls[0][0].id).toBe('conv-1')
  })

  // The row offers exactly ONE of the two, matching the state it is in — a row
  // showing both would be asking the operator to read its own unread weight
  // back to it. "Mark unread" only became offerable once the route could pair
  // it with markUnseen() over IMAP; a column-only version undoes itself within
  // about a quarter of an hour, with nothing on screen to explain why.
  it('offers Mark unread on a read row, and Mark read on an unread one — never both', () => {
    const onMarkUnread = vi.fn()
    renderList({ conversations: [conv({ unread: false })], onMarkUnread })
    expect(screen.queryByTitle('Mark read')).toBeNull()
    screen.getByTitle('Mark unread').click()
    expect(onMarkUnread.mock.calls[0][0].id).toBe('conv-1')

    cleanup()
    renderList({ conversations: [conv({ unread: true })] })
    expect(screen.queryByTitle('Mark unread')).toBeNull()
    expect(screen.getByTitle('Mark read')).toBeTruthy()
  })

  it('says so when read state could not be loaded, instead of showing everything as read', () => {
    renderList({ countsUnavailable: true, conversations: [conv({ unread: false })] })
    expect(screen.getByText(/Read state could not be loaded/)).toBeTruthy()
  })
})

describe('MailList — archive is the primary verb, and it is on the row', () => {
  it('archives from the list without opening the conversation', () => {
    const onArchive = vi.fn()
    renderList({ onArchive })
    screen.getByTitle('Archive').click()
    // (conversation, archived) — the STATE being asked for, not a toggle.
    expect(onArchive).toHaveBeenCalledTimes(1)
    expect(onArchive.mock.calls[0][0].id).toBe('conv-1')
    expect(onArchive.mock.calls[0][1]).toBe(true)
  })

  it('offers the reverse on an archived conversation', () => {
    const onArchive = vi.fn()
    renderList({ conversations: [conv({ archived: true, status: 'closed' })], onArchive })
    screen.getByTitle('Move back to inbox').click()
    expect(onArchive.mock.calls[0][1]).toBe(false)
  })

  it('names the conversation in the action’s accessible label', () => {
    // Twenty rows means twenty "Archive" buttons; a screen reader listing them
    // identically gives no way to tell which conversation each one files away.
    renderList()
    expect(screen.getByLabelText(/Archive Ella Byrne/)).toBeTruthy()
  })
})

describe('MailList — one status signal survives, and only one', () => {
  it('chips a conversation that is waiting on a reply', () => {
    renderList({ conversations: [conv({ needs_reply: true })] })
    expect(screen.getByText('Needs reply')).toBeTruthy()
  })

  it('chips an archived one', () => {
    renderList({ conversations: [conv({ needs_reply: false, archived: true, status: 'closed' })] })
    expect(screen.getByText('Archived')).toBeTruthy()
  })

  // 🔴 The reskin test. If these words appear, the surface has kept the ticket
  // lifecycle and merely renamed the screen.
  it('never shows the ticket lifecycle words', () => {
    render(
      <MailList
        conversations={[
          conv({ id: 'a', status: 'open', needs_reply: true }),
          conv({ id: 'b', status: 'pending', needs_reply: false }),
          conv({ id: 'c', status: 'solved', needs_reply: false }),
        ]}
        view={mailView('inbox')}
      />
    )
    for (const word of ['Open', 'Pending', 'Solved', 'Closed', 'Unassigned', 'Assigned']) {
      expect(screen.queryByText(word)).toBeNull()
    }
  })
})

describe('MailList — the unit is a conversation', () => {
  it('shows the message count once there is more than one message', () => {
    renderList({ conversations: [conv({ message_count: 3 })] })
    expect(within(row()).getByText('3')).toBeTruthy()
  })

  it('hides it at one — a thread of one is just an email', () => {
    renderList({ conversations: [conv({ message_count: 1 })] })
    expect(within(row()).queryByText('1')).toBeNull()
  })

  it('does not claim a count when the scan could not answer', () => {
    renderList({ conversations: [conv({ message_count: null })], countsUnavailable: true })
    expect(within(row()).queryByText('3')).toBeNull()
  })

  it('marks our own last word, so a row cannot look like it is waiting on us', () => {
    renderList({ conversations: [conv({ last_message_direction: 'outbound', needs_reply: false })] })
    expect(screen.getByText('You:')).toBeTruthy()
  })
})

describe('MailList — empty states are per view', () => {
  it('says inbox zero on a clear inbox', () => {
    renderList({ conversations: [], view: mailView('inbox') })
    expect(screen.getByText('Inbox zero')).toBeTruthy()
  })

  it('says something different on an empty archive', () => {
    renderList({ conversations: [], view: mailView('archived') })
    expect(screen.getByText('Nothing archived yet')).toBeTruthy()
    // …and it must say the archive is not a delete, because that is the
    // question an operator actually has about it.
    expect(screen.getByText(/never deleted/)).toBeTruthy()
  })
})

describe('MailList — paging', () => {
  it('offers older conversations only when there is another page', () => {
    renderList({ hasMore: true })
    expect(screen.getByText('Older conversations')).toBeTruthy()
    cleanup()
    renderList({ hasMore: false })
    expect(screen.queryByText('Older conversations')).toBeNull()
  })
})

describe('MailList — the mailbox chip', () => {
  it('appears only when more than one account is on this screen', () => {
    renderList({ showMailbox: true, mailboxById: { 'mb-1': { id: 'mb-1', label: 'Studio', address: 'studio@x.com' } } })
    expect(screen.getByText('Studio')).toBeTruthy()
    cleanup()
    renderList({ showMailbox: false })
    expect(screen.queryByText('Studio')).toBeNull()
  })
})

// ── Task 6 — the one-line row ────────────────────────────────────────────
//
// The redesign's whole point is density: no avatar, one line, sender in a
// fixed column, chips inline, preview gated by density. These tests check
// the density gain itself, not just that the old behaviour survived it.
describe('MailList — one line, no avatar', () => {
  it('renders no avatar or initials — the density gain the whole redesign rests on', () => {
    renderList()
    // "Ella Byrne" → initials "EB". If an avatar tile still rendered, its
    // initials would be a visible text node nowhere else in this row.
    expect(screen.queryByText('EB')).toBeNull()
  })

  it('keeps sender, subject and preview in the same row element', () => {
    renderList({ density: 'comfortable' })
    const r = row()
    expect(within(r).getByText('Ella Byrne')).toBeTruthy()
    expect(within(r).getByText('Membership freeze')).toBeTruthy()
    expect(within(r).getByText(/Can I freeze from Monday\?/)).toBeTruthy()
  })

  it('hides the preview at compact density', () => {
    renderList({ density: 'compact' })
    expect(screen.queryByText(/Can I freeze from Monday\?/)).toBeNull()
  })

  it('shows the preview at comfortable density', () => {
    renderList({ density: 'comfortable' })
    expect(screen.getByText(/Can I freeze from Monday\?/)).toBeTruthy()
  })

  it('defaults to compact — hides the preview when no density prop is given at all', () => {
    renderList()
    expect(screen.queryByText(/Can I freeze from Monday\?/)).toBeNull()
  })

  it('renders needs-reply inline, ahead of the subject, on the same line', () => {
    renderList({ conversations: [conv({ needs_reply: true })] })
    const text = row().textContent
    expect(text).toContain('Needs reply')
    expect(text.indexOf('Needs reply')).toBeLessThan(text.indexOf('Membership freeze'))
  })
})

// ── LAYOUT-FIX.1 — row layout structure ───────────────────────────────────
//
// 🔴 jsdom has NO layout engine. getByText(...) passes whether an element
// renders at 400px or at 0px — which is exactly why the 29 tests above this
// point all passed against a shipped row where the subject rendered at or
// near 0px, a long sender's count never painted, and "Comfortable" changed
// nothing on screen. These tests do NOT prove pixel widths and must never be
// read as doing so. What they CAN and DO assert is the DOM STRUCTURE a
// correct flex layout depends on — sibling vs. nested, `min-w-0` present on
// the elements that must be allowed to shrink, the count living outside the
// truncating name span — because that structure is exactly what regressed,
// and it is the only part of this a jsdom test can honestly speak to. The
// actual pixel behaviour (subject gets priority, preview shrinks away first,
// the count is never clipped) was checked by hand in a real browser against
// the measured 87px/119px tracks — see the commit message, not this file.
describe('MailList — row layout structure (LAYOUT-FIX.1)', () => {
  it('renders the subject and preview as SIBLINGS — never one nested inside the other', () => {
    renderList({ density: 'comfortable' })
    const subject = screen.getByTestId('mail-row-subject')
    const preview = screen.getByTestId('mail-row-preview')
    expect(subject.parentElement).toBe(preview.parentElement)
    expect(subject.contains(preview)).toBe(false)
    expect(preview.contains(subject)).toBe(false)
  })

  it('gives the subject a shrink-permitting min-w-0 — without it a flex child never shrinks below its own content width', () => {
    renderList()
    const subject = screen.getByTestId('mail-row-subject')
    expect(subject.className.split(/\s+/)).toContain('min-w-0')
  })

  it('gives the preview a shrink-permitting min-w-0 too, so it can shrink away rather than clip its container', () => {
    renderList({ density: 'comfortable' })
    const preview = screen.getByTestId('mail-row-preview')
    expect(preview.className.split(/\s+/)).toContain('min-w-0')
  })

  it('keeps the count OUT of the truncating sender-name element', () => {
    renderList({ conversations: [conv({ requester_name: 'Elizabeth Fitzgerald', message_count: 5 })] })
    const name = screen.getByTestId('mail-row-sender-name')
    const count = screen.getByTestId('mail-row-count')
    expect(name.textContent).not.toContain('5')
    expect(name.contains(count)).toBe(false)
    // Still the same cell, just siblings rather than parent/child — the
    // count must sit right next to the name, not float off elsewhere.
    expect(name.parentElement).toBe(count.parentElement)
  })

  it('renders a preview element at comfortable density and none at all at compact — the toggle must do something', () => {
    renderList({ density: 'comfortable' })
    expect(screen.getByTestId('mail-row-preview')).toBeTruthy()
    cleanup()
    renderList({ density: 'compact' })
    expect(screen.queryByTestId('mail-row-preview')).toBeNull()
  })

  it('still renders the needs-reply chip, the mailbox chip AND the subject together when all three hold', () => {
    renderList({
      conversations: [conv({ needs_reply: true })],
      showMailbox: true,
      mailboxById: { 'mb-1': { id: 'mb-1', address: 'a-very-long-studio-mailbox-address@example.com' } },
    })
    const r = row()
    expect(within(r).getByText('Needs reply')).toBeTruthy()
    expect(within(r).getByTestId('mail-row-subject')).toBeTruthy()
  })

  it('caps the mailbox chip so an unbounded address fallback cannot claim the whole track', () => {
    renderList({
      showMailbox: true,
      mailboxById: { 'mb-1': { id: 'mb-1', address: 'a-very-long-studio-mailbox-address@example.com' } },
    })
    const chip = screen.getByTitle('a-very-long-studio-mailbox-address@example.com')
    const classes = chip.className.split(/\s+/)
    expect(classes.some(c => c.startsWith('max-w-'))).toBe(true)
    expect(classes).toContain('truncate')
  })
})

// 🔴 Task 2's Will problem: websearch_to_tsquery('english', 'Will') is an EMPTY
// query, so a search for a member named Will can genuinely find nothing while
// looking exactly like a search that never ran. Echoing the query back is the
// honest compensation — it tells the operator what was actually asked.
// ── the attachment paperclip ────────────────────────────────────────────
//
// email_ticket_attachments has no ticket_id, only message_id — the route's
// per-conversation `has_attachments` (via _helpers.js's loadConversationCounts
// embed) is the only source of truth this row can render off. Structural
// assertions only (jsdom has no layout engine): presence/absence of the icon
// node, not its rendered size.
describe('MailList — the attachment paperclip', () => {
  it('renders the paperclip when the conversation has an attachment', () => {
    renderList({ conversations: [conv({ has_attachments: true })] })
    expect(within(row()).getByTestId('mail-row-attachment')).toBeTruthy()
  })

  it('renders no paperclip when it does not', () => {
    renderList({ conversations: [conv({ has_attachments: false })] })
    expect(within(row()).queryByTestId('mail-row-attachment')).toBeNull()
  })

  it('renders no paperclip when the field is simply absent', () => {
    renderList({ conversations: [conv({ has_attachments: undefined })] })
    expect(within(row()).queryByTestId('mail-row-attachment')).toBeNull()
  })

  // A SKIPPED (unstorable) attachment still counts server-side — the icon
  // itself only ever reads the boolean the route already resolved that with.
  it('shows it the same way for a skipped-only attachment as a stored one', () => {
    renderList({ conversations: [conv({ has_attachments: true })] })
    expect(within(row()).getByTestId('mail-row-attachment')).toBeTruthy()
  })

  it('renders at comfortable density too', () => {
    renderList({ conversations: [conv({ has_attachments: true })], density: 'comfortable' })
    expect(within(row()).getByTestId('mail-row-attachment')).toBeTruthy()
  })

  it('renders at compact density too', () => {
    renderList({ conversations: [conv({ has_attachments: true })], density: 'compact' })
    expect(within(row()).getByTestId('mail-row-attachment')).toBeTruthy()
  })

  it('does not disturb the subject/preview sibling structure LAYOUT-FIX.1 depends on', () => {
    renderList({ conversations: [conv({ has_attachments: true })], density: 'comfortable' })
    const subject = screen.getByTestId('mail-row-subject')
    const preview = screen.getByTestId('mail-row-preview')
    expect(subject.parentElement).toBe(preview.parentElement)
    const clip = screen.getByTestId('mail-row-attachment')
    // A shrink-0 sibling in the same row, never nested inside the truncating
    // subject or preview spans — nesting it there would make it a candidate
    // for their own clipping, the exact defect LAYOUT-FIX.1 fixed once.
    expect(subject.contains(clip)).toBe(false)
    expect(preview.contains(clip)).toBe(false)
  })

  it('carries an accessible name, since the icon alone is decorative', () => {
    renderList({ conversations: [conv({ has_attachments: true })] })
    expect(within(row()).getByText(/attachment/i)).toBeTruthy()
  })
})

describe('MailList — search state', () => {
  it('says no mail matches when a search is active and empty, generically without a query', () => {
    renderList({ conversations: [], searchActive: true })
    expect(screen.getByText('No mail matches that search.')).toBeTruthy()
    // It must not read as an empty inbox — the ordinary empty-state copy.
    expect(screen.queryByText('Inbox zero')).toBeNull()
  })

  it('echoes the operator’s own query back on an empty search', () => {
    renderList({ conversations: [], searchActive: true, searchQuery: 'Will' })
    expect(screen.getByText('No mail matches “Will”.')).toBeTruthy()
  })

  it('still shows the ordinary empty state when no search is active', () => {
    renderList({ conversations: [], searchActive: false })
    expect(screen.getByText('Inbox zero')).toBeTruthy()
  })

  it('banners a truncated search scan', () => {
    renderList({ searchPartial: true })
    expect(screen.getByText(/scanned only part/)).toBeTruthy()
  })

  it('shows no truncation banner when the scan was not partial', () => {
    renderList({ searchPartial: false })
    expect(screen.queryByText(/scanned only part/)).toBeNull()
  })
})

// MAIL-ALLLOC.1 — the All-mode grouped list.
describe('MailList — All-mode sections', () => {
  const LOC_A = 'a0000000-0000-4000-8000-000000000001'
  const LOC_B = 'b0000000-0000-4000-8000-000000000002'

  const section = (over = {}) => ({
    locationId: LOC_A,
    name: 'Hatch Street',
    unavailable: false,
    needsReplyCount: 0,
    viewTotal: 1,
    conversations: [],
    hasMore: false,
    countsPartial: false,
    searchPartial: false,
    ...over,
  })

  it('groups rows under their own studio header, in section order', () => {
    renderList({
      sections: [
        section({ needsReplyCount: 3 }),
        section({ locationId: LOC_B, name: 'Stillorgan' }),
      ],
      conversations: [
        conv({ id: 'c-b', location_id: LOC_B, requester_name: 'Stillorgan Person' }),
        conv({ id: 'c-a', location_id: LOC_A, requester_name: 'Hatch Person' }),
      ],
    })
    const hatch = screen.getByRole('region', { name: 'Hatch Street' })
    const still = screen.getByRole('region', { name: 'Stillorgan' })
    expect(within(hatch).getByText('Hatch Person')).toBeTruthy()
    expect(within(hatch).queryByText('Stillorgan Person')).toBeNull()
    expect(within(still).getByText('Stillorgan Person')).toBeTruthy()
    // The header carries the studio's needs-reply count.
    expect(within(hatch).getByText('3 need reply')).toBeTruthy()
  })

  it('offers "View all N" only past the cap, and it scopes to that studio', () => {
    const onScopeLocation = vi.fn()
    renderList({
      sections: [
        section({ hasMore: true, viewTotal: 38 }),
        section({ locationId: LOC_B, name: 'Stillorgan', hasMore: false, viewTotal: 1 }),
      ],
      conversations: [
        conv({ id: 'c-a', location_id: LOC_A }),
        conv({ id: 'c-b', location_id: LOC_B }),
      ],
      onScopeLocation,
    })
    const viewAll = screen.getByRole('button', { name: 'View all 38 in Hatch Street →' })
    viewAll.click()
    expect(onScopeLocation).toHaveBeenCalledWith(LOC_A)
    expect(screen.queryByText(/View all 1 in Stillorgan/)).toBeNull()
  })

  it('keeps an empty section visible with a quiet empty — hiding reads as missing mail', () => {
    renderList({
      sections: [section({ viewTotal: 0 })],
      conversations: [],
    })
    const hatch = screen.getByRole('region', { name: 'Hatch Street' })
    expect(within(hatch).getByText('Nothing here')).toBeTruthy()
  })

  it('renders an unreachable studio as an inline error with a retry, not an empty', () => {
    const onRetrySection = vi.fn()
    renderList({
      sections: [
        section({ unavailable: true, needsReplyCount: null, viewTotal: null }),
        section({ locationId: LOC_B, name: 'Stillorgan' }),
      ],
      conversations: [conv({ id: 'c-b', location_id: LOC_B, requester_name: 'Still Person' })],
      onRetrySection,
    })
    const hatch = screen.getByRole('region', { name: 'Hatch Street' })
    expect(within(hatch).getByText(/couldn’t be reached/)).toBeTruthy()
    expect(within(hatch).queryByText('Nothing here')).toBeNull()
    within(hatch).getByRole('button', { name: 'Retry' }).click()
    expect(onRetrySection).toHaveBeenCalledWith(LOC_A)
    // The other studio still renders its mail.
    expect(screen.getByText('Still Person')).toBeTruthy()
  })

  it('never renders a location pill on a row — provenance lives in the header', () => {
    renderList({
      sections: [section()],
      conversations: [conv({ id: 'c-a', location_id: LOC_A })],
      // Even if a caller passes the single-scope mailbox props, section rows
      // stay clean.
      showMailbox: true,
      mailboxById: { 'mb-1': { id: 'mb-1', label: 'Studio', address: 's@x.ie' } },
    })
    expect(screen.queryByText('Hatch Street', { selector: 'li *' })).toBeNull()
    expect(screen.queryByText('Studio')).toBeNull()
  })

  it('says a search-empty section differently, and carries a per-studio truncation note', () => {
    renderList({
      sections: [
        section({ searchPartial: false }),
        section({
          locationId: LOC_B, name: 'Stillorgan', searchPartial: true,
          conversations: [conv({ id: 'c-b', location_id: LOC_B })],
        }),
      ],
      conversations: [conv({ id: 'c-b', location_id: LOC_B })],
      searchActive: true,
    })
    const hatch = screen.getByRole('region', { name: 'Hatch Street' })
    expect(within(hatch).getByText('No matches here')).toBeTruthy()
    const still = screen.getByRole('region', { name: 'Stillorgan' })
    expect(within(still).getByText(/scanned only part of Stillorgan/)).toBeTruthy()
  })
})
