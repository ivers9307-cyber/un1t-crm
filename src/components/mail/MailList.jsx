'use client'

// MAIL-TRIAL.B — the conversation list.
//
// WHAT MAKES THIS A DIFFERENT THING FROM THE TICKET QUEUE, rather than the
// same list with different words. The trial only answers something if the two
// surfaces genuinely disagree about how email is worked:
//
//   • READ/UNREAD IS THE PRIMARY WEIGHT. An unread conversation is bold with a
//     solid dot; a read one recedes. The ticket queue's primary weight is
//     STATUS — which is a thing an operator has to maintain, whereas read
//     state maintains itself (and, via mig 575's seen_at, maintains itself
//     from the operator's own mail client).
//   • ARCHIVE IS ON THE ROW. The primary verb is one click from the list,
//     without opening the conversation — which is how a mail user clears an
//     inbox. On the ticket surface the lifecycle lives inside the thread, so
//     closing anything costs an open.
//   • ONE STATUS SIGNAL SURVIVES, and only one: needs-reply. "Has this member
//     been answered" is the single thing a mail client cannot tell you, so it
//     earns a chip; open/pending/solved do not appear at all.
//   • THE MESSAGE COUNT IS ON THE ROW, because the unit here is a
//     CONVERSATION. A ticket row describes an issue; a mail row describes an
//     exchange, and the count is what says so at a glance.
//
// Presentational: every action is a callback up to MailSurface.

// TASK 6 — the one-line row. A conversation used to spend ~88px on a 32px
// avatar tile plus three stacked text lines; about six fit on screen. It is
// now a single ~31px line — sender in a fixed column, subject and preview
// sharing the rest, date right-aligned and tabular — so eighteen fit. That
// density change is the entire point of this pass, and it is the reason the
// avatar is gone: at one line there is no room for a 32px tile, and initials
// were never the thing an operator scanned for anyway (the sender NAME was).

import { Inbox, Search, Archive, ArchiveRestore, Mail, MailOpen } from 'lucide-react'
import { EmptyState, Loading } from '@/components/ui'
import { requesterLabel, relativeTime, mailboxLabel } from '@/lib/ticket-display'
import { isArchived, needsReply, isUnread, DEFAULT_DENSITY } from './mail-display'

export default function MailList({
  conversations = [],
  loading = false,
  selectedId,
  onSelect,
  onArchive,
  onMarkRead,
  onMarkUnread,
  busyId = null,
  view,
  locationName,
  showMailbox = false,
  mailboxById = {},
  // Paging is a keyset cursor, so "Older" is a button rather than a page
  // number: on a live inbox the rows move between requests and a page number
  // would mean something different each time it was pressed.
  hasMore = false,
  onLoadMore,
  loadingMore = false,
  // The per-conversation counts could not be read (or the page outgrew one
  // scan). Said out loud, because the alternative is rendering every row as
  // read — a confident wrong answer on the one signal this list is built on.
  countsUnavailable = false,
  // MAIL-DENSITY.1 — 'compact' (default) drops the preview text to hold one
  // line; 'comfortable' keeps it. The list itself never reads or writes the
  // stored preference (that's the surface's job, Task 4) — it only renders
  // whatever it is handed.
  density = DEFAULT_DENSITY,
  // Is a search query currently scoping this list? Changes what an empty
  // result means: a search that matched nothing is not the same situation as
  // an inbox that is genuinely clear, and showing the ordinary empty-inbox
  // copy over a search would read as "there is no mail" rather than "this
  // search found none".
  searchActive = false,
  // 🔴 Task 2's problem, echoed here: websearch_to_tsquery('english', 'Will')
  // is an EMPTY query, so a search for a member named Will can find nothing
  // while looking exactly like a search that never really ran. Echoing the
  // operator's own words back is the honest compensation — it proves the
  // search was heard, even when it came back empty.
  searchQuery,
  // The scan behind this list was truncated (too many candidate rows to
  // finish in one pass). The results shown are real, but they may not be
  // ALL of them — worth saying, because "not here" and "not found yet" are
  // different claims to make to an operator triaging an inbox.
  searchPartial = false,
}) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-2 border-b border-un1t-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-un1t-subtle">
          {view?.label || 'Mail'}
          {conversations.length > 0 && (
            <span className="ml-1.5 font-normal text-un1t-muted">{conversations.length}</span>
          )}
        </span>
        {locationName && (
          <span className="truncate text-[11px] text-un1t-muted">{locationName}</span>
        )}
      </div>

      {countsUnavailable && (
        <p className="border-b border-un1t-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700" role="status">
          Read state could not be loaded for this page — rows may look read when they are not.
        </p>
      )}

      {searchPartial && (
        <p className="border-b border-un1t-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700" role="status">
          This search scanned only part of the mailbox — narrow the search to see everything that matches.
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && conversations.length === 0 ? (
          <Loading label="Loading mail…" />
        ) : conversations.length === 0 ? (
          searchActive ? (
            <EmptyState
              icon={<Search size={26} />}
              title={searchQuery ? `No mail matches “${searchQuery}”.` : 'No mail matches that search.'}
              description="Try different words, or clear the search to see the whole inbox."
              padding="md"
            />
          ) : (
            <EmptyState
              icon={<Inbox size={26} />}
              title={view?.emptyTitle || 'Nothing here'}
              description={view?.emptyDescription}
              padding="md"
            />
          )
        ) : (
          <>
            <ul>
              {conversations.map(c => (
                <li key={c.id}>
                  <MailRow
                    conversation={c}
                    selected={selectedId === c.id}
                    busy={busyId === c.id}
                    onSelect={onSelect}
                    onArchive={onArchive}
                    onMarkRead={onMarkRead}
                    onMarkUnread={onMarkUnread}
                    showMailbox={showMailbox}
                    mailbox={mailboxById[c.mailbox_id] || null}
                    countsUnavailable={countsUnavailable}
                    density={density}
                  />
                </li>
              ))}
            </ul>
            {hasMore && (
              <div className="px-3 py-3">
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={loadingMore}
                  className="w-full rounded-md border border-un1t-border px-3 py-1.5 text-xs text-un1t-subtle transition-colors hover:text-un1t-text disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Older conversations'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}

/**
 * One conversation, ONE LINE: [unread dot] [sender, fixed] [subject +
 * preview, flex] [date, right] — a 4-column grid, not the old flex column of
 * three stacked text lines behind a 32px avatar.
 *
 * THE ROW IS A BUTTON WITH SIBLINGS, NOT A BUTTON CONTAINING BUTTONS. Archive
 * has to be reachable without opening the conversation — that is the whole
 * point of putting it here — and a button inside a button is invalid markup
 * that browsers resolve by dropping one of them, usually the one you wanted.
 * So the select target and the actions are siblings inside a positioned
 * wrapper.
 *
 * The actions are visible on hover and on keyboard focus, and NOT on touch
 * hover alone — `focus-within` is what keeps them reachable by tab, and they
 * stay rendered (never `hidden`) so a screen reader always finds them.
 */
function MailRow({
  conversation, selected, busy, onSelect, onArchive, onMarkRead, onMarkUnread,
  showMailbox, mailbox, countsUnavailable, density,
}) {
  const name = requesterLabel(conversation)
  const unread = isUnread(conversation)
  const archived = isArchived(conversation)
  const waiting = needsReply(conversation)
  const count = conversation.message_count
  const outbound = conversation.last_message_direction === 'outbound'
  // 'compact' drops the preview outright to hold one line; 'comfortable'
  // keeps it, after the subject, behind an em-dash.
  const comfortable = density !== 'compact'
  const preview = conversation.last_message_preview

  return (
    <div
      className={`group relative border-b border-un1t-border/60 transition-colors hover:bg-un1t-surface focus-within:bg-un1t-surface ${
        selected ? 'bg-un1t-surface' : ''
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect?.(conversation)}
        aria-current={selected ? 'true' : undefined}
        className="grid w-full grid-cols-[auto_7rem_1fr_auto] items-center gap-x-2.5 px-3 py-1.5 pr-16 text-left"
      >
        {/* Unread is a dot AND weight. The old row also spent a solid accent
            edge and a whole second line on it; at one line the dot plus the
            sender's font-weight carries the whole signal. */}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${unread ? 'bg-channel-em' : 'bg-transparent'}`}
          aria-hidden="true"
        />

        {/* Sender: a FIXED column, not a share of the flex row — so a page of
            names lines up on one edge and the eye scans straight down it
            instead of re-finding the start of every row. */}
        <span className={`min-w-0 truncate text-sm text-un1t-text ${unread ? 'font-semibold' : 'font-normal'}`}>
          {name}
          {/* The count is what makes this a conversation rather than a
              message. Hidden at 1 — "1" on every row is noise, and a thread
              of one is just an email. */}
          {!countsUnavailable && count > 1 && (
            <span className="ml-1 text-[11px] font-normal text-un1t-muted">{count}</span>
          )}
        </span>

        {/* Subject + preview share the rest of the line. The two status
            chips this surface keeps — and the mailbox chip — sit INLINE
            here, ahead of the subject: they used to own a whole row of their
            own, and at one line there is no spare row to give them. */}
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {waiting && (
            <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
              Needs reply
            </span>
          )}
          {archived && (
            <span className="shrink-0 rounded-full bg-slate-500/10 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">
              Archived
            </span>
          )}
          {showMailbox && (
            <span
              className="shrink-0 rounded-full bg-un1t-surface px-1.5 py-0.5 text-[10px] text-un1t-subtle ring-1 ring-inset ring-un1t-border"
              title={mailbox?.address || 'No mail account on this conversation'}
            >
              {mailboxLabel(mailbox)}
            </span>
          )}
          <span className={`truncate text-sm text-un1t-text ${unread ? 'font-medium' : 'font-normal'}`}>
            {outbound && <span className="text-un1t-muted">You: </span>}
            {conversation.subject || '(no subject)'}
            {/* comfortable keeps the preview after an em-dash; compact drops
                it entirely — that IS the density difference (see
                DENSITIES' doc comment in mail-display.js). */}
            {comfortable && preview && (
              <span className="text-un1t-subtle"> — {preview}</span>
            )}
          </span>
        </span>

        {/* Date: right-aligned and tabular, so a column of them lines up
            digit-on-digit instead of each width drifting with its text. */}
        <span className="text-right text-[11px] tabular-nums text-un1t-muted">
          {relativeTime(conversation.last_message_at || conversation.created_at)}
        </span>
      </button>

      {/* Row actions. Archive first because it is the primary verb of this
          surface — the thing an operator does dozens of times a day and the
          reason the list is not a queue.
          MARK UNREAD is the defer verb, and it is a PAIRED write: the CRM's
          read state mirrors the IMAP \Seen flag and the poller converges it
          both ways, so the route clears the flag in the real mailbox too via
          markUnseen(). A column-only version would undo itself within about a
          quarter of an hour with nothing on screen to explain why — which is
          why this row had no such button until that pairing existed. */}
      <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <RowAction
          onClick={() => (unread ? onMarkRead?.(conversation) : onMarkUnread?.(conversation))}
          disabled={busy}
          icon={unread ? MailOpen : Mail}
          label={`Mark ${name}'s conversation ${unread ? 'read' : 'unread'}`}
          title={unread ? 'Mark read' : 'Mark unread'}
        />
        <RowAction
          onClick={() => onArchive?.(conversation, !archived)}
          disabled={busy}
          icon={archived ? ArchiveRestore : Archive}
          label={archived ? `Move ${name}'s conversation back to the inbox` : `Archive ${name}'s conversation`}
          title={archived ? 'Move back to inbox' : 'Archive'}
        />
      </div>
    </div>
  )
}

// type="button" is not optional anywhere in this tree — these sit on a page
// that also renders the composer's <form>, and a bare <button> defaults to
// submit (CLAUDE.md).
function RowAction({ onClick, disabled, icon: Icon, label, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      className="rounded-md border border-un1t-border bg-un1t-bg p-1.5 text-un1t-subtle transition-colors hover:text-un1t-text disabled:opacity-50"
    >
      <Icon size={13} aria-hidden="true" />
    </button>
  )
}
