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
            instead of re-finding the start of every row.
            LAYOUT-FIX.1 — the count used to sit INSIDE this truncating span,
            so a name alone (no count needed) could already fill all 112px
            and the count was clipped away by the very `truncate` meant for
            the name ("Elizabeth Fitzgerald" needs ~133px on its own). The
            fix is a small flex row: the name gets its own truncating child
            (`min-w-0` — a flex child's default min-width is its content
            width, so without this it never shrinks and `truncate` never
            fires) and the count is a SEPARATE `shrink-0` sibling, so it is
            never a candidate for the name's own clipping. */}
        <span className="flex min-w-0 items-center gap-1">
          <span
            data-testid="mail-row-sender-name"
            className={`min-w-0 truncate text-sm text-un1t-text ${unread ? 'font-semibold' : 'font-normal'}`}
          >
            {name}
          </span>
          {/* The count is what makes this a conversation rather than a
              message. Hidden at 1 — "1" on every row is noise, and a thread
              of one is just an email. `shrink-0` so it is never the thing
              that gives when the name is long — it is short and load-bearing,
              same reasoning as the chips below. */}
          {!countsUnavailable && count > 1 && (
            <span data-testid="mail-row-count" className="shrink-0 text-[11px] font-normal text-un1t-muted">
              {count}
            </span>
          )}
        </span>

        {/* Subject + preview share the rest of the line, in priority order:
            chips (short, load-bearing, `shrink-0`) > subject (the next claim
            on space, truncates rather than vanishing) > preview (only what
            is left, first to disappear under pressure).
            LAYOUT-FIX.1 — this used to be ONE flex row holding the chips
            plus a SINGLE nested span with the subject text and the preview
            span both inside it. That inner span had `truncate` but no
            `min-w-0`, so as a flex item its default `min-width: auto` meant
            it would never shrink below its own (subject + preview) content
            width — the surrounding `overflow-hidden` then just clipped the
            whole thing, chips-and-all, at whatever the track happened to be.
            Two structural changes fix it: (1) the mailbox chip's label can
            fall back to `mailbox.address`, up to ~124px against a ~119px
            track on its own — `max-w-[70px] truncate` caps how much of the
            track any one chip can claim; (2) subject and preview are now
            SIBLINGS, each with its own `min-w-0` so each can genuinely
            shrink independently. Priority between the two is a `shrink`
            differential, not equal shrinking: preview's `shrink-[6]` against
            subject's default `shrink` (1) means the standard CSS flex-shrink
            resolution (weighted by shrink-factor × basis, re-run against
            whatever is left each time a item freezes at its own floor)
            drains preview toward zero long before subject gives up any
            meaningful width, and only spills into subject once preview has
            nothing left to give. Below `lg` there usually isn't a spare
            pixel for it at all (~87px measured at `md`), so it is `hidden`
            below that breakpoint rather than rendering an unreadable sliver. */}
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
              className="max-w-[70px] shrink-0 truncate rounded-full bg-un1t-surface px-1.5 py-0.5 text-[10px] text-un1t-subtle ring-1 ring-inset ring-un1t-border"
              title={mailbox?.address || 'No mail account on this conversation'}
            >
              {mailboxLabel(mailbox)}
            </span>
          )}
          <span
            data-testid="mail-row-subject"
            className={`min-w-0 shrink truncate text-sm text-un1t-text ${unread ? 'font-medium' : 'font-normal'}`}
          >
            {outbound && <span className="text-un1t-muted">You: </span>}
            {conversation.subject || '(no subject)'}
          </span>
          {/* comfortable keeps the preview after an em-dash, as its own
              sibling element; compact drops it entirely — that IS the
              density difference (see DENSITIES' doc comment in
              mail-display.js). It must be a sibling of the subject, not
              nested inside it, or it is back to competing for the same
              `min-width: auto` floor that caused LAYOUT-FIX.1. */}
          {comfortable && preview && (
            <span
              data-testid="mail-row-preview"
              className="hidden min-w-0 shrink-[6] truncate text-sm text-un1t-subtle lg:inline-block"
            >
              {' '}— {preview}
            </span>
          )}
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
