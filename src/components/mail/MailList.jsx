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

// MAIL-REFINE.1 (01) — the subject-first row. Task 6's one-line pass bought
// density but read like a texting app: sender + latest-message snippet, with
// two chips squeezing the subject out entirely. Email is filed by subject, so
// the row now leads with it:
//   • 'comfortable' = TWO lines — line 1 sender (semibold) + small muted
//     account tag + time; line 2 subject (semibold, truncates) + snippet in
//     subtle grey + 📎 when the conversation has files;
//   • 'compact'     = ONE line — sender · subject · time, no snippet.
// The chips are GONE: needs-reply is the amber left rail alone (the chip
// repeated it — the rail already said it), and the mailbox chip shrank to the
// small account tag ("accounts@"), rendered only when the caller can see 2+
// mailboxes at this studio. Unread = darker ink + a blue dot, like any mail
// client. No avatar, same as Task 6 — the sender NAME is what an operator
// scans for.

import { Inbox, Search, Archive, ArchiveRestore, Mail, MailOpen, Paperclip, AlertCircle } from 'lucide-react'
import { EmptyState, Loading } from '@/components/ui'
import { requesterLabel, relativeTime } from '@/lib/ticket-display'
import { isArchived, needsReply, isUnread, mailboxShortTag } from './mail-vocabulary'
import { DEFAULT_DENSITY } from './mail-preferences'

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
  // MAIL-ALLLOC.1 — All-mode section metadata (buildDigestSections /
  // buildSearchSections). When present, the list renders GROUPED: one sticky
  // studio header per section, that studio's rows underneath (filtered from
  // the same flat `conversations` array every mutation already updates, so
  // archive/read state needs no second code path), a "View all N" row past
  // the digest cap, a quiet empty for a clear studio and an inline error +
  // retry for an unreachable one. Absent for single-location callers, whose
  // list stays exactly as it was.
  sections = null,
  // A View-all row (or its section header, conceptually a tile) scopes into
  // that studio — the same move as clicking its tile.
  onScopeLocation,
  // The retry on an unavailable section refetches the whole digest.
  onRetrySection,
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
        {Array.isArray(sections) ? (
          // MAIL-ALLLOC.1 — All mode. ONE scroll (this container), never a
          // list inside a list: the sections are plain blocks whose headers
          // stick to the top of this same scroll.
          <div>
            {sections.map(s => (
              <MailSection
                key={s.locationId}
                section={s}
                // Rows come from the SAME flat array the keyboard walks and
                // every mutation updates — the sections only group them, so
                // an archived row leaves its section the moment it leaves
                // the list, with no second removal path to drift.
                rows={conversations.filter(c => c.location_id === s.locationId)}
                selectedId={selectedId}
                busyId={busyId}
                onSelect={onSelect}
                onArchive={onArchive}
                onMarkRead={onMarkRead}
                onMarkUnread={onMarkUnread}
                // Audit F5 — the per-section signal, not the global OR: one
                // studio's count trouble must not mark every studio's rows
                // untrustworthy (the list-level banner still says SOME read
                // state is missing).
                countsUnavailable={Boolean(s.countsPartial)}
                density={density}
                searchActive={searchActive}
                onScopeLocation={onScopeLocation}
                onRetrySection={onRetrySection}
              />
            ))}
          </div>
        ) : loading && conversations.length === 0 ? (
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
 * MAIL-ALLLOC.1 — one studio's block of the All-mode list.
 *
 * The header sticks (to the ONE outer scroll — the section itself never
 * scrolls), names the studio and says how much of it needs a reply. Under
 * it, in order of what is true:
 *   • unreachable → an inline error with a retry that refetches the digest —
 *     a failure must never wear an empty state's clothes, least of all here,
 *     where "no rows" reads as "that studio has no mail";
 *   • rows → exactly the same MailRow as everywhere else (no location pill —
 *     provenance lives in the header, the locked design's rule), then a
 *     "View all N →" row past the digest cap, which scopes into the studio;
 *   • nothing → a QUIET one-liner. The section is never hidden: a clear
 *     studio saying so is information, a missing section is a bug report.
 */
function MailSection({
  section, rows, selectedId, busyId, onSelect, onArchive, onMarkRead,
  onMarkUnread, countsUnavailable, density, searchActive,
  onScopeLocation, onRetrySection,
}) {
  const name = section.name || 'Unnamed studio'
  return (
    <section aria-label={name}>
      <div className="sticky top-0 z-10 flex items-baseline justify-between gap-2 border-b border-un1t-border bg-un1t-surface px-3 py-1">
        <span className="truncate text-[10px] font-bold uppercase tracking-widest text-un1t-subtle">
          {name}
        </span>
        {typeof section.needsReplyCount === 'number' && section.needsReplyCount > 0 && (
          <span className="shrink-0 text-[10px] font-semibold tabular-nums text-amber-700">
            {section.needsReplyCount} need{section.needsReplyCount === 1 ? 's' : ''} reply
          </span>
        )}
      </div>

      {section.unavailable ? (
        <div className="flex items-center justify-between gap-2 border-b border-un1t-border/60 bg-amber-500/10 px-3 py-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-amber-700">
            <AlertCircle size={12} className="shrink-0" />
            <span className="truncate">{name} couldn’t be reached</span>
          </span>
          <button
            type="button"
            onClick={() => onRetrySection?.(section.locationId)}
            className="shrink-0 rounded-md border border-un1t-border bg-un1t-bg px-2 py-0.5 text-[11px] text-un1t-subtle transition-colors hover:text-un1t-text"
          >
            Retry
          </button>
        </div>
      ) : rows.length > 0 ? (
        <>
          <ul>
            {rows.map(c => (
              <li key={c.id}>
                <MailRow
                  conversation={c}
                  selected={selectedId === c.id}
                  busy={busyId === c.id}
                  onSelect={onSelect}
                  onArchive={onArchive}
                  onMarkRead={onMarkRead}
                  onMarkUnread={onMarkUnread}
                  showMailbox={false}
                  mailbox={null}
                  countsUnavailable={countsUnavailable}
                  density={density}
                />
              </li>
            ))}
          </ul>
          {section.searchPartial && (
            <p className="border-b border-un1t-border/60 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-700" role="status">
              This search scanned only part of {name} — narrow it to see everything that matches.
            </p>
          )}
          {section.hasMore && (
            <button
              type="button"
              onClick={() => onScopeLocation?.(section.locationId)}
              className="w-full border-b border-un1t-border/60 px-3 py-1.5 text-center text-xs font-medium text-un1t-subtle transition-colors hover:text-un1t-text"
            >
              View all {section.viewTotal} in {name} →
            </button>
          )}
        </>
      ) : (
        <p className="border-b border-un1t-border/60 px-3 py-2 text-xs text-un1t-muted">
          {searchActive ? 'No matches here' : 'Nothing here'}
        </p>
      )}
    </section>
  )
}

/**
 * One conversation (MAIL-REFINE.1 design 01).
 *
 * comfortable — TWO LINES:
 *   line 1: [dot] sender (semibold) · count · account tag …… time
 *   line 2: subject (semibold, truncates) · 📎 · snippet (subtle grey)
 * compact — ONE LINE (the Task 6 grid, minus the chips):
 *   [dot] [sender, fixed] [subject] [time]
 *
 * NEEDS-REPLY IS THE AMBER RAIL, NOT A CHIP. The rail on the row's left edge
 * already said it; the chip repeated it and cost the subject its width. The
 * words survive as sr-only text so a screen reader still hears the state.
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
  // 'compact' is one line with no snippet; 'comfortable' is the two-line
  // subject-first row of the approved design.
  const comfortable = density !== 'compact'
  const preview = conversation.last_message_preview
  // The account tag renders ONLY when the caller can see 2+ mailboxes at this
  // studio — that decision is `showMailbox`, made by the surface, exactly as
  // it was for the chip this tag replaces.
  const accountTag = showMailbox ? mailboxShortTag(mailbox) : null
  const time = relativeTime(conversation.last_message_at || conversation.created_at)
  // Unread = darker ink. Read rows keep a medium weight (the sender/subject
  // are still the row's anchors); unread steps up to semibold + the blue dot.
  const ink = unread ? 'font-semibold' : 'font-medium'

  // Shared fragments so the two densities cannot drift apart on the facts
  // they both show.
  const countNode = !countsUnavailable && count > 1 && (
    <span data-testid="mail-row-count" className="shrink-0 text-[11px] font-normal text-un1t-muted">
      {count}
    </span>
  )
  const accountNode = accountTag && (
    <span
      data-testid="mail-row-account"
      className="max-w-[80px] shrink-0 truncate text-[10px] text-un1t-muted"
      title={mailbox?.address || undefined}
    >
      {accountTag}
    </span>
  )
  const archivedNode = archived && (
    <span className="shrink-0 rounded-full bg-slate-500/10 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">
      Archived
    </span>
  )
  /* MAIL-ATTACH.1 — the paperclip. `has_attachments` is stamped by the list
     route off loadConversationCounts' one message scan (a skipped-but-
     unstorable attachment still counts: the email genuinely arrived with a
     file). Always a `shrink-0` SIBLING of the truncating spans — never nested
     inside one, which is the LAYOUT-FIX.1 defect one element wide of here. */
  const clipNode = conversation.has_attachments && (
    <span
      data-testid="mail-row-attachment"
      className="inline-flex shrink-0 items-center text-un1t-muted"
      title="Has attachments"
    >
      <Paperclip size={12} aria-hidden="true" />
      <span className="sr-only">Has attachments</span>
    </span>
  )

  return (
    <div
      // MAIL-UNREAD.1 (Richard, 2 Sep: "highlight unopened emails") — an
      // unread row carries a faint blue wash on top of the bold + dot, the
      // Outlook treatment: catchable at a glance across a long list.
      // Selection/hover greys win over it, so the open row still reads open.
      className={`group relative border-b border-un1t-border/60 transition-colors hover:bg-un1t-surface focus-within:bg-un1t-surface ${
        selected ? 'bg-un1t-surface' : unread ? 'bg-blue-500/[0.06]' : ''
      }`}
      data-unread={unread || undefined}
    >
      {/* Needs-reply = the amber rail, ONLY. It hugs the row's left edge so a
          column of waiting conversations reads as one amber spine. Decorative
          to a screen reader (the sr-only text inside the button carries the
          words). */}
      {waiting && (
        <span
          data-testid="mail-row-rail"
          className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r-full bg-amber-500"
          aria-hidden="true"
        />
      )}

      {comfortable ? (
        <button
          type="button"
          onClick={() => onSelect?.(conversation)}
          aria-current={selected ? 'true' : undefined}
          className="flex w-full items-start gap-2.5 px-3 py-1.5 pr-16 text-left"
        >
          {/* The blue dot — unread's second half beside the darker ink. */}
          <span
            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread ? 'bg-channel-em' : 'bg-transparent'}`}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            {/* Line 1: sender · count · account tag …… time. The name is the
                only child allowed to shrink (min-w-0 + truncate — a flex
                child's default min-width is its content width, LAYOUT-FIX.1);
                everything else is short and shrink-0. */}
            <span className="flex items-baseline gap-1.5">
              {waiting && <span className="sr-only">Needs reply</span>}
              <span
                data-testid="mail-row-sender-name"
                className={`min-w-0 truncate text-sm text-un1t-text ${ink}`}
              >
                {name}
              </span>
              {countNode}
              {accountNode}
              {archivedNode}
              <span className="ml-auto shrink-0 pl-2 text-right text-[11px] tabular-nums text-un1t-muted">
                {time}
              </span>
            </span>
            {/* Line 2: subject leads in the row's own weight; the snippet
                trails in subtle grey and is the first thing to give
                (shrink-[6] vs the subject's default shrink of 1 — the same
                LAYOUT-FIX.1 priority mechanics as the one-line row). SIBLINGS
                with their own min-w-0 each, never nested. */}
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span
                data-testid="mail-row-subject"
                className={`min-w-0 shrink truncate text-sm text-un1t-text ${ink}`}
              >
                {conversation.subject || '(no subject)'}
              </span>
              {clipNode}
              {preview && (
                <span
                  data-testid="mail-row-preview"
                  className="min-w-0 shrink-[6] truncate text-sm text-un1t-subtle"
                >
                  {/* Our own last word is marked on the SNIPPET here — the
                      subject is the thread's name, not the last message's. */}
                  {outbound && <span className="text-un1t-muted">You: </span>}
                  {preview}
                </span>
              )}
            </span>
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onSelect?.(conversation)}
          aria-current={selected ? 'true' : undefined}
          className="grid w-full grid-cols-[auto_7rem_1fr_auto] items-center gap-x-2.5 px-3 py-1.5 pr-16 text-left"
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${unread ? 'bg-channel-em' : 'bg-transparent'}`}
            aria-hidden="true"
          />

          {/* Sender: a FIXED column so a page of names lines up on one edge.
              LAYOUT-FIX.1 — the count and tag are `shrink-0` SIBLINGS of the
              truncating name span, never inside it. */}
          <span className="flex min-w-0 items-center gap-1">
            {waiting && <span className="sr-only">Needs reply</span>}
            <span
              data-testid="mail-row-sender-name"
              className={`min-w-0 truncate text-sm text-un1t-text ${ink}`}
            >
              {name}
            </span>
            {countNode}
          </span>

          {/* Subject owns the middle track; no snippet at this density — that
              IS the density difference (DENSITIES' doc comment). */}
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {accountNode}
            {archivedNode}
            {clipNode}
            <span
              data-testid="mail-row-subject"
              className={`min-w-0 shrink truncate text-sm text-un1t-text ${ink}`}
            >
              {/* With no snippet to carry it, the outbound marker rides the
                  subject so a row can still never look like it is waiting on
                  us. */}
              {outbound && <span className="text-un1t-muted">You: </span>}
              {conversation.subject || '(no subject)'}
            </span>
          </span>

          {/* Date: right-aligned and tabular, so a column of them lines up
              digit-on-digit instead of each width drifting with its text. */}
          <span className="text-right text-[11px] tabular-nums text-un1t-muted">
            {time}
          </span>
        </button>
      )}

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
