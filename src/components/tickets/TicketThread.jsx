'use client'

// EMAIL-TICKET.4 — the thread pane: the ticket's header, its correspondence in
// order, and the lifecycle control.
//
// THE ONE THING THIS FILE MUST NEVER GET WRONG
// An internal note is stored with direction='outbound' — same as a real sent
// reply. It is rendered here as a full-width amber panel with the words
// "Internal note — not sent to the member" on it, so it can never be mistaken
// for correspondence the member received, and a real reply can never be
// mistaken for a private note. messageKind() (lib/ticket-display.js) makes the
// call; this file only paints it. Notes are PLAIN TEXT — they never go
// through the HTML path below, whatever the payload says.
//
// HTML RENDERING (EMAIL-TICKET.5)
// This file receives `html_document`: a COMPLETE document, already sanitised
// server-side by src/lib/email-html.js and ready to be handed to an iframe's
// srcdoc. It never sees raw html_body, never sanitises anything, and never
// imports the sanitiser — that would ship sanitize-html and its postcss tree
// to the browser and invite someone to sanitise client-side, where it proves
// nothing. React's raw-HTML escape hatch is not used here or anywhere in src/.
//
// The two security-critical literals below (the sandbox attribute and the
// show-images swap) are asserted against this file's source in
// src/lib/email-html.test.js, because a quiet edit to either removes a whole
// layer of protection without breaking anything visible.
//
// ATTACHMENTS (EMAIL-ATTACH-PREVIEW.1)
// A message's files render as CHIPS — icon, name, size — and nothing else. No
// attachment's bytes are ever rendered inside the thread: clicking a chip opens
// ./AttachmentPreview, which is where the one open file lives, and the chip's
// own download button is the path that has to work for every type. Which types
// may be previewed at all is the SERVER's answer (`preview_kind` on the
// attachment row); this file never forms that judgement.
//
// IT IS AN EMAIL INBOX, SO IT HAS TO READ LIKE ONE (EMAIL-PARTICIPANTS.8)
// On 2026-08-12 a ticket whose requester_email was a council's rates office
// was forwarded internally to a named officer, who replied. Every message
// afterwards was with her — and this pane still showed the rates office in the
// header, with nothing anywhere saying a new person had joined. The operator
// answered the wrong name, opened a second ticket, and sent the same reply
// twice. Tasks 2-7 fixed who a reply REACHES; none of that is visible, so none
// of it would have stopped this. Three things here are the visible half:
//   • the header names the LIVE audience (ThreadParticipants), not the address
//     the first message happened to arrive from;
//   • every message can show its real envelope (MessageEnvelope), so a reply
//     from a different person at the same organisation cannot look identical
//     to one from the requester;
//   • the message somebody first appears on is marked (JoinMarkers), so the
//     change of counterparty has a place on the page rather than being
//     something you work out by comparing addresses.
// None of it is stored: it is derived from the messages already on screen.

import { Fragment, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Lock, AlertCircle, MailCheck, ImageOff, Maximize2, Minimize2,
  ShieldAlert, Download, FileWarning, Check, MailX, ShieldX, Forward, UserPlus,
  ExternalLink, Paperclip,
} from 'lucide-react'
import { Loading } from '@/components/ui'
import { formatBytes, SKIPPED_REASON_LABEL } from '@/lib/email-attachment-quota'
import AttachmentPreview, { AttachmentIcon } from './AttachmentPreview'
import {
  requesterLabel,
  initialsOf,
  messageKind,
  messageTimestamp,
  relativeTime,
  deliveryMeta,
  deliveryTimestamp,
  mailboxLabel,
  messageEnvelope,
  threadSignature,
  canForwardMessage,
  forwardedMarker,
  sendOriginMeta,
} from '@/lib/ticket-display'
// MAIL-REFINE.1 (02) — the flat-thread helpers live beside the rest of the
// Mail vocabulary. Pure module (no 'use client', no DOM) so this import adds
// no weight; the layering is fine because Mail is the only surface that
// mounts this pane (RETIRE-TICKETS.1).
import {
  defaultExpandedMessageId,
  messageSnippet,
  collapsedSenderLabel,
} from '@/components/mail/mail-vocabulary'
// MAIL-DOCK.1 — the frame's height is context-sized now (dock/full/legacy
// default), and the operator's Expand choice persists. Both decisions live
// in the pure preferences module; this file only reads them.
import {
  frameHeightClass,
  readBodyExpanded,
  writeBodyExpanded,
} from '@/components/mail/mail-preferences'
import { joinPointsByMessage } from '@/lib/email-tickets'
// EMAIL-CONTACT-CHIP.1 — the house funnel/off-funnel taxonomy (FUNNEL.1),
// reused ONLY for the chip's colour/intent grouping. There is no single
// canonical slug→label lib in this codebase for the TEXT (three independent
// hand-rolled maps already exist: PersonHeader.jsx, AudienceBuilder.jsx,
// PipelineReclassifyTab.jsx — see the comment on stageChipLabel below), so
// this file adds a fourth only for the one thing that IS a real shared
// registry: which slugs are member-ish vs still-a-lead.
import { FUNNEL_STAGE_SLUGS, RETURNING_STAGE_SLUGS, OFF_FUNNEL_STAGE_SLUGS } from '@/lib/pipeline-classifier'
import TicketReplyBox from './TicketReplyBox'

// member-ish (green): the off-funnel "steady state" slugs (minus the two that
// are really a lead who went cold/quiet, not a member) plus 'converted' —
// the funnel's own hand-off into membership, funnel or returning.
const STAGE_CHIP_MEMBER_ISH = new Set([
  ...OFF_FUNNEL_STAGE_SLUGS.filter((s) => s !== 'cold_lead' && s !== 'dormant'),
  'converted',
  'returning_converted',
])
// lead-ish (amber): still moving through a funnel toward that hand-off.
const STAGE_CHIP_LEAD_ISH = new Set([
  ...FUNNEL_STAGE_SLUGS.filter((s) => s !== 'converted'),
  ...RETURNING_STAGE_SLUGS.filter((s) => s !== 'returning_converted'),
])
// Everything else (cold_lead, dormant, an unrecognised/legacy slug): neutral.
// Chip recipe per CLAUDE.md: bg-<c>-500/10 text-<c>-700 (never -300/-400).
const STAGE_CHIP_CLASS = {
  member: 'bg-emerald-500/10 text-emerald-700',
  lead: 'bg-amber-500/10 text-amber-700',
  neutral: 'bg-gray-500/10 text-gray-700',
}

function stageChipClass(slug) {
  if (STAGE_CHIP_MEMBER_ISH.has(slug)) return STAGE_CHIP_CLASS.member
  if (STAGE_CHIP_LEAD_ISH.has(slug)) return STAGE_CHIP_CLASS.lead
  return STAGE_CHIP_CLASS.neutral
}

// Algorithmic title-case off the raw slug ('new_lead' -> 'New lead') rather
// than a maintained slug→label object: the closest thing this codebase has to
// a canonical registry is the funnel/off-funnel SLUG LISTS above, which name
// no display copy at all, and three separate components already hand-roll
// their own label map (drift risk this file declines to add a fourth
// instance of). Never renders the raw slug — the one thing the spec forbids.
function stageChipLabel(slug) {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export default function TicketThread({
  hasSelection,
  ticket,
  messages = [],
  // MAIL-REFINE.2 — [{id, subject, merged_at}] per conversation merged into
  // this one; the divider above each absorbed group is keyed off it.
  mergedSources = [],
  onOpenMergedInto,
  // EMAIL-CC.1 — { to, mode } as the server derived it, or null. Handed
  // straight to the composer, which must never re-derive it from `messages`:
  // a second implementation is a second chance to include a bcc address.
  replyRecipients = null,
  // EMAIL-ATTACH.1 — the attachment query failed. The thread below is complete;
  // the FILE lists on it are not, and saying nothing would render as "no files".
  attachmentsUnavailable = false,
  loading = false,
  error,
  onBack,
  // (RETIRE-TICKETS.2 — the onStatusChange/onAssign/onMerge prop family left
  // with the deleted controls fallback; their routes are gone.)
  onSend,
  sending = false,
  // EMAIL-PARTICIPANTS.7 — takes ONE address off the reply audience, stickily.
  // Owned by the inbox like every other mutation here: the audience is derived
  // server-side and re-read, so reflecting a removal is a thread refresh, and
  // this pane has no refresh of its own. Its failures land in `error` above.
  onRemoveRecipient,
  // …and puts one back. Same path, same guards; the participants route is the
  // only thing that writes the exclusion either way.
  onRestoreRecipient,
  participantSaving = false,
  // EMAIL-FORWARD.1 — opens the forward composer for ONE message. Owned by the
  // inbox (like compose), because a forward is a modal over the whole surface
  // rather than something a bubble can render inside itself.
  onForward,

  // ── MAIL-TRIAL.B — three slots, so a SECOND surface can reuse this pane ──
  //
  // The Mail surface (/communications/mail) is an inbox-shaped alternative to
  // the ticket queue, running against the same rows for the trial. Everything
  // below the header — the thread, the HTML sandbox, attachments, the delivery
  // marker, the mail-client marker, join markers, the composer — is identical
  // on both and must stay ONE implementation: this file already carries two
  // security-critical literals that src/lib/email-html.test.js asserts against
  // its own source, and a copy of it would be a copy with nothing asserting
  // those. (This codebase has been bitten by exactly that: two restatements of
  // deliveryMeta drifted inside a week.)
  //
  // What genuinely differs is the ticket-only CHROME, so that is what became a
  // slot. Each prop is a node to render in that position, or null/undefined
  // for nothing. MAIL-ARCH.2 removed the last `undefined → ticket chrome`
  // fallbacks (the statusMeta lifecycle chip, the priority chip, the "Select a
  // ticket" empty state): MailThread is the only mounter and always passes
  // its own node for every slot, the ticket queue that rendered the fallbacks
  // is deleted (RETIRE-TICKETS.1), nothing writes `priority` (every row in
  // prod is 'normal', which priorityMeta already mapped to no chip), and a
  // fallback nobody can reach is the dead code this sweep exists to remove.
  //
  // The names are deliberately about POSITION, not about either surface —
  // this file must not learn which screen is asking.
  statusChip,   // beside the subject: the caller's own chip (Mail: Spam / Archived / Needs reply)
  controls,     // under the header: status + owner + duplicate rows
  // MAIL-REFINE.1 (03) — between the header and the correspondence: the
  // caller's own notice strip (Mail puts its related-conversations nudge
  // here). Same undefined/null/node contract as the other slots; the ticket
  // chrome never had anything in this position, so undefined renders nothing.
  banner,
  emptyState,   // with no selection: the caller's own empty state
  // Forwarded verbatim to the composer — the one sentence in there written in
  // the ticket lifecycle's vocabulary. See TicketReplyBox.jsx.
  archivedHint,
  // MAIL-DOCK.1 — which window the thread is rendering into ('dock' |
  // 'full'). Only the email frames read it (via frameHeightClass); absent,
  // they keep the exact heights they had before the dock existed, which is
  // what every render without the prop still gets.
  frameSize,
  // MAIL-DOCK.1 — the composer opens as a slim pill until clicked (or until
  // a saved draft auto-expands it). Default false: every pre-dock caller and
  // test keeps the always-open composer byte-for-byte.
  replyStartCollapsed = false,
  // MAIL-DOCK.1 audit A1 — any overlay that owns Escape must be visible to
  // MailSurface's keyboard guard, or the same keydown that closes the
  // attachment preview also closes the whole reader card (the house Modal
  // has no focus trap and stops no propagation).
  onOverlayOpenChange,
}) {
  const endRef = useRef(null)
  // EMAIL-ATTACH-RACE.1 — scroll on a NEW message, not on every re-read.
  // The thread now re-reads itself every few seconds while it is settling, so
  // keying this on `messages` (a fresh array each time) would yank an operator
  // back to the bottom mid-read. An attachment row landing on a message that
  // is already on screen is precisely the case where nothing should move.
  const threadKey = threadSignature(messages)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [threadKey])

  // EMAIL-ATTACH-PREVIEW.1 — the attachment overlay is owned HERE, not by the
  // message that holds the file: exactly one may be open at a time, it must
  // cover the whole pane rather than a bubble, and switching tickets has to
  // close it. Only the row is held; the signed URL is minted by the overlay
  // when it opens and lives no longer than it does.
  const [openAttachment, setOpenAttachment] = useState(null)
  useEffect(() => {
    onOverlayOpenChange?.(!!openAttachment)
    return () => onOverlayOpenChange?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report open-state changes only
  }, [openAttachment])
  const ticketId = ticket?.id
  useEffect(() => { setOpenAttachment(null) }, [ticketId])

  // MAIL-REFINE.1 (02) — which messages are open. Only the NEWEST message
  // expands by default (defaultExpandedMessageId); everything older collapses
  // to a single line until tapped. `overrides` holds only what the operator
  // has explicitly toggled, keyed by message id, so a poll delivering a new
  // message naturally collapses the previous newest (it loses its default)
  // without touching anything the operator opened by hand. Reset on ticket
  // switch — message ids are globally unique, but a stale map is still a
  // stale map.
  const [expandOverrides, setExpandOverrides] = useState({})
  useEffect(() => { setExpandOverrides({}) }, [ticketId])
  const newestId = defaultExpandedMessageId(messages)
  const isMessageExpanded = (id) => expandOverrides[id] ?? (id === newestId)
  const toggleMessage = (id) =>
    setExpandOverrides(prev => ({ ...prev, [id]: !(prev[id] ?? (id === newestId)) }))

  // EMAIL-CONTACT-CHIP.2 — "Add to contacts" on an unlinked thread. Every
  // other mutation on this pane (status, assign, merge, participants) is a
  // callback prop the INBOX owns, because the actual write has to happen
  // exactly once no matter which of the two surfaces is rendering this file.
  // A callback here would need BOTH TicketInbox and MailSurface — owned by
  // other agents on this branch — to wire it up, so this one mutation is
  // self-contained instead: it POSTs its own route and holds the result in
  // local state, same shape as openAttachment above (reset on ticket change,
  // never mixed with another ticket's result).
  const [linkedContact, setLinkedContact] = useState(null)
  const [linkingContact, setLinkingContact] = useState(false)
  const [linkContactError, setLinkContactError] = useState(null)
  useEffect(() => {
    setLinkedContact(null)
    setLinkingContact(false)
    setLinkContactError(null)
  }, [ticketId])

  async function handleLinkContact() {
    if (!ticketId || linkingContact) return
    setLinkingContact(true)
    setLinkContactError(null)
    try {
      const res = await fetch(`/api/email/tickets/${ticketId}/link-contact`, { method: 'POST' })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.success) {
        setLinkContactError(body?.error || 'Could not add this contact. Try again.')
        return
      }
      setLinkedContact(body.data?.contact || null)
    } catch {
      setLinkContactError('Could not add this contact. Try again.')
    } finally {
      setLinkingContact(false)
    }
  }

  if (!hasSelection) return emptyState ?? null

  const name = requesterLabel(ticket)
  // EMAIL-CONTACT-CHIP.2 — the ticket's own embed wins; local state only fills
  // in right after a successful link, before the next full fetch replaces
  // `ticket` with the server's own copy (which will carry `contact` too).
  const effectiveContact = ticket?.contact?.id ? ticket.contact : linkedContact
  // EMAIL-FORWARD.1 — so a forward's bubble can name the message it passed on.
  // Built once per render rather than inside the map, which would be quadratic
  // on a thread at the 200-message cap.
  const messagesById = new Map(messages.map(m => [m.id, m]))
  // MAIL-REFINE.2 — the "Merged in" divider renders ONCE per absorbed
  // conversation, above its first message in display order. Provenance is on
  // the rows (merged_from_ticket_id, mig 536); the subject comes from
  // mergedSources and degrades to generic wording when unresolvable.
  const mergedSubjectById = new Map((mergedSources || []).map(t => [t.id, t.subject]))
  const mergedDividerAt = new Map()
  for (const m of messages) {
    const from = m.merged_from_ticket_id
    if (from && !mergedDividerAt.has(from)) mergedDividerAt.set(from, m.id)
  }
  const mergedCountBySource = new Map()
  for (const m of messages) {
    if (m.merged_from_ticket_id) {
      mergedCountBySource.set(m.merged_from_ticket_id,
        (mergedCountBySource.get(m.merged_from_ticket_id) || 0) + 1)
    }
  }
  // EMAIL-PARTICIPANTS.8 — message id → the addresses first seen on it. Pure,
  // derived, and computed once per render for the same reason as the map above.
  const joinPoints = joinPointsByMessage(messages)

  return (
    <>
      {/* Header */}
      <div className="border-b border-un1t-border px-4 py-3">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to the queue"
            className="mt-0.5 text-un1t-subtle hover:text-un1t-text md:hidden"
          >
            <ArrowLeft size={18} />
          </button>

          <span className="hidden h-9 w-9 shrink-0 place-items-center rounded-[11px] border border-un1t-border bg-un1t-surface text-[13px] font-semibold text-un1t-text sm:grid">
            {initialsOf(name)}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-un1t-text">
                {ticket?.subject || '(no subject)'}
              </h2>
              {statusChip}
            </div>

            <ThreadParticipants
              ticket={ticket}
              name={name}
              replyRecipients={replyRecipients}
            />

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-un1t-muted">
              {ticket?.mailbox ? (
                <span title={ticket.mailbox.address || undefined}>
                  To {mailboxLabel(ticket.mailbox)}
                </span>
              ) : (
                // mailbox_id is ON DELETE SET NULL, so a deleted address
                // orphans its correspondence rather than hiding it.
                <span>No mailbox on this ticket</span>
              )}
              {effectiveContact?.id ? (
                <>
                  <Link href={`/contacts/${effectiveContact.id}`} className="text-un1t-accent hover:underline">
                    View contact
                  </Link>
                  {/* EMAIL-CONTACT-CHIP.1 — human label, never the raw slug;
                      absent entirely on a null/unrecognised stage. Reads
                      'glofox_membership_status' NEVER: prod never contains
                      'active' there (a recorded trap) — pipeline_stage_slug is
                      the one the funnel classifier actually maintains. */}
                  {effectiveContact.pipeline_stage_slug && (
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${stageChipClass(effectiveContact.pipeline_stage_slug)}`}>
                      {stageChipLabel(effectiveContact.pipeline_stage_slug)}
                    </span>
                  )}
                </>
              ) : ticket?.requester_email ? (
                <button
                  type="button"
                  onClick={handleLinkContact}
                  disabled={linkingContact}
                  className="text-un1t-accent hover:underline disabled:cursor-default disabled:opacity-50"
                >
                  {linkingContact ? 'Adding…' : 'Add to contacts'}
                </button>
              ) : (
                <span>Not linked to a contact</span>
              )}
              {linkContactError && (
                <span className="text-red-700" role="alert">{linkContactError}</span>
              )}
            </div>
          </div>
        </div>

        {/* RETIRE-TICKETS.2 — the `controls` slot survives; its FALLBACK is
            gone. The fallback was the ticket queue's chrome (four-state
            lifecycle, assignment, duplicate folding) rendered when no slot
            was passed — and since RETIRE-TICKETS.1 deleted that queue, the
            only mounter (MailThread) always passes its own controls, the
            handlers' routes are deleted, and a fallback nobody can reach is
            exactly the dead code this sweep exists to remove. Merge lives on
            as DATA (tombstones, scopeToUnmerged, the merge route) — offering
            it on Mail again means building a Mail affordance, not reviving
            this block. */}
        {controls}
      </div>

      {/* The caller's notice strip (Mail's related-conversations nudge) —
          between the header and the correspondence, never inside either. */}
      {banner}

      {/* Thread — MAIL-REFINE.1 (02): flat full-width messages separated by
          hairlines, not chat bubbles. Each message owns its padding and its
          bottom border; the container only scrolls. */}
      <div className="flex-1 overflow-y-auto bg-un1t-bg">
        {loading && messages.length === 0 ? (
          <Loading label="Loading thread…" />
        ) : messages.length === 0 ? (
          // Only claim the thread is empty when we actually loaded it — the
          // error banner below owns the "we could not read it" case.
          !error && (
            <p className="py-6 text-center text-xs text-un1t-muted">
              No messages on this ticket yet.
            </p>
          )
        ) : (
          messages.map(m => (
            // The marker is a sibling of the message, not part of it: someone
            // joining is a fact about the THREAD that happens to be datable to
            // a message, and putting it inside the message would attribute it
            // to whoever wrote that message.
            <Fragment key={m.id}>
              {[...mergedDividerAt.entries()]
                .filter(([, firstId]) => firstId === m.id)
                .map(([sourceId]) => (
                  <div
                    key={`merged-${sourceId}`}
                    data-testid="merged-in-divider"
                    className="flex items-center gap-2 border-b border-un1t-border bg-un1t-surface px-4 py-2 text-[11px] text-un1t-subtle"
                  >
                    <span aria-hidden="true">⛓</span>
                    <span className="min-w-0 truncate">
                      Merged in{mergedSubjectById.get(sourceId)
                        ? <>: <span className="font-semibold text-un1t-text">“{mergedSubjectById.get(sourceId)}”</span></>
                        : ' from another conversation'}
                      {' · '}
                      {mergedCountBySource.get(sourceId)} message{mergedCountBySource.get(sourceId) === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
              <JoinMarkers addresses={joinPoints.get(m.id)} />
              <ThreadMessage
                message={m}
                ticket={ticket}
                ticketId={ticketId}
                expanded={isMessageExpanded(m.id)}
                onToggle={() => toggleMessage(m.id)}
                onOpenAttachment={setOpenAttachment}
                onForward={onForward}
                messagesById={messagesById}
                frameSize={frameSize}
              />
            </Fragment>
          ))
        )}
        <div ref={endRef} />
      </div>

      <AttachmentPreview
        ticketId={ticketId}
        attachment={openAttachment}
        onClose={() => setOpenAttachment(null)}
      />

      {attachmentsUnavailable && <AttachmentsUnavailableNotice />}

      {error && (
        <p
          className="flex items-center gap-1.5 border-t border-un1t-border bg-red-500/10 px-4 py-2 text-xs text-red-700"
          role="alert"
        >
          <AlertCircle size={12} className="shrink-0" />
          {error}
        </p>
      )}

      {/* NO COMPOSER ON A TOMBSTONE (EMAIL-MERGE.6).
          The reply route gates on loadTicketForUser, which deliberately does
          not care whether a ticket has been merged — so a reply sent from here
          WOULD reach the member and would then be filed on a ticket
          scopeToUnmerged hides from every queue and count. That is the
          duplicate-reply failure this whole feature exists to end, wearing the
          feature's own hat, and merging now LEAVES the operator on this ticket
          (so the undo stays reachable), which puts them in front of that box.
          The correspondence lives on the survivor; so does replying to it. */}
      {ticket?.merged_into_id ? (
        <p className="border-t border-un1t-border px-4 py-3 text-xs text-un1t-muted">
          This ticket was merged, so it is read-only.{' '}
          {onOpenMergedInto ? (
            // MAIL-REFINE.2 — the pointer is a VERB, not a sentence: mobile
            // got a tappable banner, web's dead-end text was the gap.
            <button
              type="button"
              className="font-semibold text-un1t-text underline"
              onClick={() => onOpenMergedInto(ticket.merged_into_id)}
            >
              Open the conversation it lives in now →
            </button>
          ) : (
            'Open the ticket it was merged into to reply.'
          )}
        </p>
      ) : (
        /* Keyed on the ticket so switching tickets REMOUNTS the composer.
           Its draft text, reply/note mode, added Cc/Bcc and attached files are
           all local state — carried across a switch, member A's half-written
           reply (and Bcc chips) would send to member B's requester
           (TICKET-COMPOSER-LEAK.1, pinned in TicketThread.composer-reset.test.jsx).
           The inbox already clears the server-derived replyRecipients on
           switch; this is the same rule for the operator-typed half. */
        <TicketReplyBox
          key={ticketId}
          ticket={ticket}
          startCollapsed={replyStartCollapsed}
          replyRecipients={replyRecipients}
          onSend={onSend}
          onRemoveRecipient={onRemoveRecipient}
          onRestoreRecipient={onRestoreRecipient}
          participantSaving={participantSaving}
          sending={sending}
          archivedHint={archivedHint}
        />
      )}
    </>
  )
}

// The show-images swap, and the ONLY thing this file does to the sanitised
// document. Both halves are renames of values the server already proved to be
// absolute http(s) URLs and already HTML-escaped:
//   ` data-original-src="` → ` src="`   (a blocked <img>)
//   `x-un1t-blocked:`      → ``         (a blocked CSS url())
// See src/lib/email-html.js. Anything cleverer than a rename here — a parse, a
// regex over the whole document — is a change to the security model.
const UNBLOCK_IMG_FROM = ' data-original-src="'
const UNBLOCK_IMG_TO = ' src="'
const UNBLOCK_CSS_PREFIX = 'x-un1t-blocked:'

function showImagesIn(doc) {
  return String(doc)
    .split(UNBLOCK_IMG_FROM).join(UNBLOCK_IMG_TO)
    .split(UNBLOCK_CSS_PREFIX).join('')
}

/**
 * A stranger's HTML, in a box it cannot get out of.
 *
 * THE SANDBOX ATTRIBUTE IS LAYER 1 AND IT IS WRITTEN OUT LITERALLY BELOW so a
 * reviewer sees it at the point of use. It grants NEITHER `allow-scripts` (so
 * nothing executes, even if the sanitiser were bypassed) NOR
 * `allow-same-origin` (so the frame is an opaque origin that cannot touch this
 * page's DOM, its cookies or the Supabase session). `allow-popups` and its
 * escape are the entire remaining grant, and only so a link an operator clicks
 * actually opens — with no scripts in the frame, nothing can open one by
 * itself.
 *
 * A consequence worth knowing: with no scripts the frame cannot report its own
 * height, so it gets a fixed box that scrolls — vertically, and horizontally
 * for the 600px-wide tables marketing email is built from. The email scrolls
 * inside its box; it never widens the CRM.
 *
 * MAIL-DOCK.1 — the box is sized to the WINDOW it renders in (`frameSize`:
 * dock/full, absent = the pre-dock heights), and the operator's Expand choice
 * persists across messages and sessions (readBodyExpanded/writeBodyExpanded —
 * try/caught both directions in the lib). The lazy initial state is safe
 * because this frame only ever mounts after a client-side fetch delivers a
 * message; nothing about the SANDBOX changes, and nothing here may ever
 * change it — heights move, the sandbox never (email-html.test.js reads the
 * attribute below as code).
 */
function EmailFrame({ html, blockedImages = 0, label, onAccent = false, frameSize }) {
  const [showImages, setShowImages] = useState(false)
  const [expanded, setExpanded] = useState(() => readBodyExpanded())

  function toggleExpanded() {
    // Audit A6 — the storage write stays OUTSIDE the updater: StrictMode
    // re-invokes updaters, and a side effect inside one runs twice.
    const next = !expanded
    setExpanded(next)
    writeBodyExpanded(next)
  }

  // An outbound message's controls sit on the accent bubble, where the
  // subtle-grey idiom is unreadable.
  const actionClass = onAccent ? 'text-white/90 hover:text-white' : 'text-un1t-accent hover:underline'
  const quietClass = onAccent ? 'text-white/80 hover:text-white' : 'text-un1t-subtle hover:text-un1t-text'
  const noteClass = onAccent ? 'text-white/70' : 'text-un1t-muted'

  return (
    <div className="mt-1.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {blockedImages > 0 && (
          <button
            type="button"
            onClick={() => setShowImages(v => !v)}
            className={`flex items-center gap-1 text-[11px] ${actionClass}`}
          >
            <ImageOff size={11} className="shrink-0" aria-hidden="true" />
            {showImages ? 'Hide images' : `Show images (${blockedImages})`}
          </button>
        )}
        <button
          type="button"
          onClick={toggleExpanded}
          className={`flex items-center gap-1 text-[11px] ${quietClass}`}
        >
          {expanded
            ? <><Minimize2 size={11} className="shrink-0" aria-hidden="true" />Collapse</>
            : <><Maximize2 size={11} className="shrink-0" aria-hidden="true" />Expand</>}
        </button>
        {blockedImages > 0 && !showImages && (
          // Said plainly, because it is a privacy decision made on the
          // member's behalf: a remote image in an email is usually a tracking
          // pixel, and loading it reports the read to a stranger.
          <span className={`text-[11px] ${noteClass}`}>
            Remote images blocked — loading them tells the sender you read this
          </span>
        )}
      </div>
      <iframe
        srcDoc={showImages ? showImagesIn(html) : html}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        loading="lazy"
        title={label}
        className={`w-full rounded-lg border border-un1t-border bg-white ${frameHeightClass(frameSize, expanded)}`}
      />
    </div>
  )
}

/** "HTML could not be displayed safely" — shown INSTEAD of the HTML, never beside it. */
function UnsafeHtmlNotice() {
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-700">
      <ShieldAlert size={11} className="shrink-0" aria-hidden="true" />
      HTML could not be displayed safely — showing the plain-text version.
    </p>
  )
}

/** The formatted version was skipped to keep a pathologically long thread openable. */
function HtmlOmittedNotice() {
  return (
    <p className="mt-1.5 text-[11px] text-un1t-muted">
      Formatted version not loaded — this thread is unusually long.
    </p>
  )
}

/**
 * The files that came with a message (EMAIL-ATTACH.1, restyled as chips in
 * EMAIL-ATTACH-PREVIEW.1).
 *
 * ONE CHIP PER FILE — icon, name, size — which is the resting state every mail
 * client uses and the one Richard asked for. Clicking the chip OPENS it
 * (AttachmentPreview); the small button on the right DOWNLOADS it without
 * opening anything, so the one-click download this row used to be is still one
 * click. Nothing is rendered inline in the thread: a member sending four 2 MB
 * photos must not turn the correspondence into something you scroll past.
 *
 * A NOT-STORED ATTACHMENT IS SHOWN, NOT HIDDEN. That is the whole reason
 * email_ticket_attachments allows a row with no bytes: an oversized or
 * over-quota file that simply vanished from the thread would have staff telling
 * a member "you never sent it". The row keeps the name and the size, so the
 * honest answer — "we have a record of it but not the file, please resend" — is
 * the one on screen. Its reason stays ON THE CHIP, in words, rather than behind
 * a click: there are no bytes, so its chip opens nothing, and an operator must
 * never have to click a file to discover it is not there.
 *
 * The bytes themselves are never in this payload. Both actions ask the server
 * for a short-lived signed URL, which is also where the access check lives.
 */
function Attachments({ ticketId, attachments, onAccent = false, onOpen }) {
  const [busy, setBusy] = useState(null)
  const [failed, setFailed] = useState(null)

  if (!attachments || attachments.length === 0) return null

  const chip = onAccent
    ? 'border-white/25 bg-white/10 text-white hover:bg-white/20'
    : 'border-un1t-border bg-un1t-surface text-un1t-text hover:border-un1t-accent'
  const quiet = onAccent ? 'text-white/70' : 'text-un1t-muted'

  async function download(att) {
    setBusy(att.id)
    setFailed(null)
    try {
      const res = await fetch(`/api/email/tickets/${ticketId}/attachments/${att.id}`)
      const j = await res.json()
      if (!res.ok || !j.success || !j.data?.url) {
        setFailed(j.error || 'That file could not be opened.')
        return
      }
      // noopener/noreferrer: the signed URL points at Supabase Storage, which
      // is a different origin, and the opened tab must not hold a handle back
      // to the CRM. It carries Content-Disposition: attachment, so this saves
      // the file rather than rendering it — which is what makes it the safe
      // fallback for every type that is not previewable.
      window.open(j.data.url, '_blank', 'noopener,noreferrer')
    } catch {
      setFailed('That file could not be opened.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map(att => {
        if (!att.stored) {
          return (
            <span
              key={att.id}
              className={`flex max-w-full items-center gap-1.5 rounded-lg border border-dashed px-2 py-1 text-[11px] ${
                onAccent ? 'border-white/30 text-white/80' : 'border-amber-500/60 text-amber-700'
              }`}
            >
              <FileWarning size={12} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{att.filename}</span>
              <span className={quiet}>{formatBytes(att.size_bytes)}</span>
              <span className="shrink-0">
                {SKIPPED_REASON_LABEL[att.skipped_reason] || 'Not stored'}
              </span>
            </span>
          )
        }
        return (
          <span
            key={att.id}
            className={`flex max-w-[15rem] items-center gap-1 rounded-lg border pl-2 pr-1 text-[11px] transition-colors ${chip}`}
          >
            <button
              type="button"
              onClick={() => onOpen?.(att)}
              title={`${att.filename} · ${formatBytes(att.size_bytes)}`}
              className="flex min-w-0 items-center gap-1.5 py-1 text-left"
            >
              <AttachmentIcon
                mimeType={att.mime_type}
                filename={att.filename}
                size={12}
                className="shrink-0"
                aria-hidden="true"
              />
              <span className="truncate">{att.filename}</span>
              <span className={`shrink-0 ${quiet}`}>{formatBytes(att.size_bytes)}</span>
            </button>
            <button
              type="button"
              onClick={() => download(att)}
              disabled={busy === att.id}
              aria-label={`Download ${att.filename}`}
              title="Download"
              className={`shrink-0 rounded p-1 disabled:opacity-60 ${onAccent ? 'hover:bg-white/20' : 'hover:bg-un1t-bg'}`}
            >
              <Download size={11} aria-hidden="true" />
            </button>
          </span>
        )
      })}
      {failed && (
        <p className={`w-full text-[11px] ${onAccent ? 'text-white/80' : 'text-red-700'}`} role="alert">
          {failed}
        </p>
      )}
    </div>
  )
}

/**
 * The QUIET half of EMAIL-DELIVERY.1 — one short phrase on the meta line the
 * bubble already has, in the same muted ramp. Confirming that the normal thing
 * happened normally must never compete for attention with the panel below,
 * which is the whole reason that feature exists. There is deliberately NO
 * counterpart for a message with no event yet: that renders as the bare
 * "Sent to …" it always did.
 *
 * 🔴 IT RENDERS `delivery.label`, AND IT USED TO RENDER THE WORD "Delivered".
 * That was correct while `delivered` was the only quiet outcome. MAILBOX-
 * CONNECT.7 then added a second one — "Not tracked", for a send over the
 * mailbox's own SMTP, which no provider event can EVER confirm — and this
 * component still printed "Delivered" for it, so the one row in the thread
 * that can never be confirmed was the row asserting confirmation hardest. The
 * lib had been careful and the component threw the care away. Read the label;
 * do not restate it here.
 *
 * The tick is reserved for a genuine confirmation, so an operator can scan for
 * it. Anything else says its piece in words, with the lib's sentence as the
 * title — that sentence is the only place the REASON nothing was confirmed is
 * written down.
 */
function DeliveryMarker({ delivery, message }) {
  const confirmed = delivery.status === 'delivered'
  const stamp = deliveryTimestamp(message)
  const title = confirmed
    ? (stamp ? `Delivered ${stamp}` : 'Delivered')
    : (delivery.detail || delivery.label)
  return (
    <span className="inline-flex items-center gap-0.5" title={title}>
      {confirmed && <Check size={11} className="shrink-0" aria-hidden="true" />}
      {delivery.label}
    </span>
  )
}

/**
 * "Sent from the mail client" (MAILBOX-COEXIST.1).
 *
 * Its own line above the envelope, in the shape ForwardedMarker already
 * established, because it changes how the whole bubble reads: this reply is in
 * the CRM's record but was never in the CRM's hands, so there is no author to
 * ask, no delivery to chase and no draft to look back at. On the muted meta
 * line it would be one clause among four and skim past.
 */
function SendOriginMarker({ origin, onAccent = false }) {
  if (!origin) return null
  return (
    <p
      className={`mb-1 flex items-center gap-1.5 text-[11px] ${onAccent ? 'text-white/75' : 'text-un1t-muted'}`}
      title={origin.detail}
    >
      <ExternalLink size={11} className="shrink-0" aria-hidden="true" />
      {origin.label}
    </p>
  )
}

/**
 * The LOUD half. A failed reply gets its own panel OUTSIDE the bubble, full
 * width, in a colour nothing else in the thread uses.
 *
 * Why not a chip on the bubble: the bubble is a dark accent block whose whole
 * visual language says "we answered them". A small marker on it reads as
 * decoration on a message that looks handled. This breaks the rhythm of the
 * thread instead — which is the accurate signal, because the operator's mental
 * model ("I replied, that's done") is exactly what is wrong.
 *
 * Three lines, in the order an operator needs them: WHAT happened, WHAT TO DO,
 * and then the provider's own words — which is where "mailbox full" and "no
 * such address" actually differ, and why the raw text is shown rather than
 * summarised away.
 */
function DeliveryFailureNotice({ delivery, stamp }) {
  const alarm = delivery.tone === 'alarm'
  const Icon = alarm ? MailX : ShieldX
  const box = alarm
    ? 'border-red-500/60 bg-red-500/10 text-red-700'
    : 'border-amber-500/60 bg-amber-500/10 text-amber-700'

  return (
    <div className={`rounded-xl border px-4 py-3 ${box}`}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
        <Icon size={12} className="shrink-0" aria-hidden="true" />
        {delivery.headline}
      </p>
      <p className="mt-1 text-xs">{delivery.advice}</p>
      {delivery.detail && (
        // The provider's exact words, not our paraphrase of them.
        <p className="mt-1.5 break-words text-[11px] opacity-90">{delivery.detail}</p>
      )}
      {stamp && <p className="mt-1.5 text-[11px] opacity-75">Reported {stamp}</p>}
    </div>
  )
}

/**
 * WHO THE TICKET IS ACTUALLY WITH (EMAIL-PARTICIPANTS.8).
 *
 * This line used to be the requester: `requester_name || requester_email`,
 * plus the address, on every ticket unconditionally. That is the person the
 * FIRST message came from and nothing more. When a shared mailbox hands a
 * thread to a named person — a rates office forwarding to an officer,
 * 2026-08-12 — every message afterwards is with somebody this header never
 * named, and an operator reading it answers the wrong person.
 *
 * So it shows the LIVE audience: `replyRecipients.to`, exactly as the server
 * derived it from the whole thread and exactly as the composer below will send
 * to. It is never re-derived here. A second implementation of the audience is
 * a second chance to disagree with the one that actually sends — the same rule
 * that keeps the composer off `messages`.
 *
 * "OPENED BY …" APPEARS ONLY WHEN THE TWO HAVE DIVERGED, i.e. when the
 * requester is not the first person on that list. On an ordinary ticket they
 * are the same address and the line would be noise on every ticket — which is
 * exactly how the one ticket that needed it would get skipped over.
 *
 * With no derived audience (the server could not work one out — an own-address
 * lookup blip) this falls back to the requester line it replaced. That is the
 * honest answer at that point, and it is what the header always showed.
 *
 * THE FALLBACK STOPS AT `empty` (EMAIL-PARTICIPANTS.12). "We could not derive
 * anybody" and "the operator took everybody off" are different answers and
 * only the first one is a gap the requester fills. Falling back on the second
 * printed the person who had just been removed at the top of the pane, named
 * as who the ticket is with, directly above a composer saying nobody is left
 * and a route that 400s the send. TicketReplyBox.jsx has forbidden exactly
 * that since EMAIL-PARTICIPANTS.7 — never name somebody who will not be
 * mailed — and this header was contradicting it one component up. It says the
 * true thing instead, in the composer's own words, and the removed addresses
 * stay visible where they are restorable: on the composer's own chips.
 */
function ThreadParticipants({ ticket, name, replyRecipients }) {
  const people = (Array.isArray(replyRecipients?.to) ? replyRecipients.to : []).filter(Boolean)
  const requester = ticket?.requester_email || ''

  if (replyRecipients?.empty) {
    return (
      <p className="mt-0.5 truncate text-xs text-un1t-subtle">
        Nobody is left on this thread — every recipient was removed.
      </p>
    )
  }

  if (people.length === 0) {
    return (
      <p className="mt-0.5 truncate text-xs text-un1t-subtle">
        {name}
        {requester && requester !== name && (
          <span className="text-un1t-muted"> · {requester}</span>
        )}
      </p>
    )
  }

  // Compared normalised, because these two come from different places: one is
  // a stored column, the other is derived off message headers a stranger's
  // mail client wrote. A case difference is not a change of counterparty, and
  // announcing it as one is the same noise the condition exists to avoid.
  const norm = (a) => String(a || '').trim().toLowerCase()
  const diverged = !!requester && norm(people[0]) !== norm(requester)

  // THE REQUESTER'S NAME GOES ON THEIR ADDRESS, not on a line of its own.
  // A human name is what an operator actually scans this header for, so
  // dropping it for raw addresses reads worse — but a name floating above the
  // participants is the wrong name in the most prominent place the moment the
  // thread moves to somebody else, which is the bug this task exists for.
  // Mail-client form ("Ada Lovelace <ada@x.com>") attributes it to exactly one
  // participant and leaves everyone else as the address they are. It is the
  // only name we hold: requester_name is a column, the rest are bare addresses
  // off message headers.
  const requesterName = ticket?.requester_name || ''
  const withName = (address) => (
    requesterName && norm(address) === norm(requester)
      ? `${requesterName} <${address}>`
      : address
  )
  const onThread = people.map(withName).join(', ')

  return (
    <>
      {/* Label and addresses in ONE text run, deliberately: the composer below
          renders this same joined list as its "sends to" summary, and a line
          that is only the addresses is indistinguishable from it — on screen
          and to a test. The words are what make this the header's answer. */}
      {/* `title` because this line truncates: a wide audience clips at the
          pane edge, and a clipped participant is an invisible one — the whole
          failure this header exists to prevent, reintroduced by CSS. */}
      <p className="mt-0.5 truncate text-xs text-un1t-subtle" title={onThread}>
        On this thread: {onThread}
      </p>
      {diverged && (
        <p className="truncate text-[11px] text-un1t-muted">Opened by {withName(requester)}</p>
      )}
    </>
  )
}

/**
 * "<address> joined this thread" (EMAIL-PARTICIPANTS.8).
 *
 * A thread EVENT, rendered between the bubbles rather than inside one: someone
 * joining is a fact about the conversation that happens to be datable to a
 * message, and putting it in the bubble would read as something its author
 * did. Centred and quiet for the same reason — it is punctuation in the
 * thread, not correspondence.
 *
 * The addresses come from joinPointsByMessage(), which never reads
 * `bcc_emails`: a Bcc'd person is not visibly on the thread, and a marker
 * naming them would leak the Bcc to everyone reading the ticket.
 */
function JoinMarkers({ addresses }) {
  if (!addresses || addresses.length === 0) return null
  return (
    <div className="space-y-1 px-4 py-1.5">
      {addresses.map(address => (
        <p
          key={address}
          className="flex items-center justify-center gap-1.5 text-[11px] text-un1t-muted"
        >
          <UserPlus size={11} className="shrink-0" aria-hidden="true" />
          {address} joined this thread
        </p>
      ))}
    </div>
  )
}

/**
 * A message's real envelope, COLLAPSED BY DEFAULT (EMAIL-PARTICIPANTS.8,
 * replacing EMAIL-CC.1's always-open recipient lines).
 *
 * The lines themselves come from messageEnvelope() (src/lib/ticket-display.js),
 * which is where the rules about what an envelope contains live — including
 * why the To is unconditional, and the sentence attached to a Bcc. This
 * component decides only how they are shown.
 *
 * Collapsed, because an envelope permanently open on every bubble is what
 * every mail client learned not to do — three lines of addresses above two
 * lines of message, and an operator stops reading either. One click and it is
 * the real header.
 *
 * BCC IS THE EXCEPTION AND STAYS AT THE TOP LEVEL, never behind the toggle. It
 * is the highest-consequence line on a message in this system — there is a
 * whole invariant about a Bcc address never re-entering a recipient list — so
 * putting it one click further away is the wrong direction even with the lock
 * and the sentence retained. It is also rare, so on an ordinary message this
 * costs nothing and keeps the thing that matters in front of the operator.
 *
 * The split is on `staffOnly`, which messageEnvelope() already sets, rather
 * than on the literal key 'bcc': the flag means "this line is not what the
 * recipients saw", and any future line carrying it wants the same treatment.
 *
 * Bcc lives here and nowhere else: never on the header's participant list,
 * never a join marker. On the accent bubble the muted ramp is unreadable,
 * hence the two colour sets.
 */
function MessageEnvelope({ message, onAccent = false }) {
  const [open, setOpen] = useState(false)
  const lines = messageEnvelope(message)
  if (lines.length === 0) return null

  const collapsible = lines.filter(l => !l.staffOnly)
  const alwaysOn = lines.filter(l => l.staffOnly)

  const label = onAccent ? 'text-white/60' : 'text-un1t-muted'
  const body = onAccent ? 'text-white/85' : 'text-un1t-subtle'
  const toggle = onAccent ? 'text-white/80 hover:text-white' : 'text-un1t-subtle hover:text-un1t-text'

  const renderLine = (line) => (
    <p key={line.key} className={`flex flex-wrap items-baseline gap-x-1.5 text-[11px] ${body}`}>
      <span className={`inline-flex items-center gap-1 font-medium uppercase tracking-wide ${label}`}>
        {line.staffOnly && <Lock size={9} className="shrink-0" aria-hidden="true" />}
        {line.label}
      </span>
      <span className="break-all">{line.addresses.join(', ')}</span>
      {line.note && <span className={label}>· {line.note}</span>}
    </p>
  )

  return (
    <div className="mb-1">
      {collapsible.length > 0 && (
        <>
          {/* NAMED BY ITS MESSAGE, not just "Details". A twenty-message thread
              renders twenty of these, and a screen reader listing twenty
              identically-named buttons gives no way to tell which message each
              one opens — on the surface whose entire purpose is making it
              obvious WHICH message came from whom. The visible label stays
              short; the accessible name carries the sender. */}
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            aria-expanded={open}
            aria-label={`${open ? 'Hide details for' : 'Details for'} the message from ${message?.from_email || 'an unknown sender'}`}
            className={`text-[11px] ${toggle}`}
          >
            {open ? 'Hide details' : 'Details'}
          </button>
          {open && <div className="mt-1 space-y-0.5">{collapsible.map(renderLine)}</div>}
        </>
      )}
      {/* After the collapsible group so an expanded envelope reads in header
          order — From, To, Cc, then Bcc — and before the body either way. */}
      {alwaysOn.length > 0 && (
        <div className={`space-y-0.5 ${collapsible.length > 0 ? 'mt-1' : ''}`}>
          {alwaysOn.map(renderLine)}
        </div>
      )}
    </div>
  )
}

/** The attachment list itself could not be loaded — say so, don't imply none. */
function AttachmentsUnavailableNotice() {
  return (
    <p className="flex items-center gap-1.5 border-t border-un1t-border bg-amber-500/10 px-4 py-2 text-xs text-amber-700">
      <FileWarning size={12} className="shrink-0" aria-hidden="true" />
      Attachments could not be loaded for this ticket. Messages sent with files may look as though
      they had none.
    </p>
  )
}

/**
 * "Forward" on one message (EMAIL-FORWARD.1).
 *
 * Per-message rather than one control on the thread, because a forward is OF a
 * message — a button at the bottom of the pane would have to ask "which one?",
 * and the answer to that is the click that just happened.
 *
 * NEVER RENDERED ON AN INTERNAL NOTE. canForwardMessage() says so and the
 * route refuses one anyway; the two are deliberately independent, because this
 * is the affordance and that is the gate.
 */
function ForwardAction({ message, onForward, onAccent = false }) {
  if (!onForward || !canForwardMessage(message)) return null
  return (
    <button
      type="button"
      onClick={() => onForward(message)}
      className={`inline-flex items-center gap-1 text-[11px] ${
        onAccent ? 'text-white/80 hover:text-white' : 'text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      <Forward size={11} className="shrink-0" aria-hidden="true" />
      Forward
    </button>
  )
}

/** "Forwarded the message from …" — only on a message that IS a forward. */
function ForwardedMarker({ label, onAccent = false }) {
  if (!label) return null
  return (
    <p className={`mb-1 flex items-center gap-1.5 text-[11px] ${onAccent ? 'text-white/75' : 'text-un1t-muted'}`}>
      <Forward size={11} className="shrink-0" aria-hidden="true" />
      {label}
    </p>
  )
}

/**
 * The initial avatar on a flat message's header row (MAIL-REFINE.1 02). Staff
 * side (replies, notes) is the dark "me" tile; the counterparty is light with
 * a hairline ring. Decorative — the sender's name is always beside it.
 */
function MessageAvatar({ me, label }) {
  return (
    <span
      aria-hidden="true"
      className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
        me ? 'bg-un1t-accent text-white' : 'bg-un1t-surface text-un1t-subtle ring-1 ring-inset ring-un1t-border'
      }`}
    >
      {initialsOf(label)}
    </span>
  )
}

/**
 * One message, flattened (MAIL-REFINE.1 02): full width, a one-line header
 * (avatar · sender · address · time), hairline underneath — email, not chat.
 * No right-alignment and no bubble for outbound; the dark avatar and the
 * "Sent to …" meta line carry "we said this".
 *
 * ALL BUT THE NEWEST MESSAGE ARRIVE COLLAPSED (`expanded` is decided by the
 * parent): a single line — avatar, sender, snippet, time — on the un1t-surface
 * tint, expanding (and collapsing again) on click. Two things deliberately
 * refuse to collapse away:
 *   • an internal note keeps its amber styling in BOTH states, so a private
 *     line can never be skimmed as correspondence (the one thing this file
 *     must never get wrong — see the file header);
 *   • a delivery FAILURE renders even when its message is collapsed. The loud
 *     panel exists because "I replied, that's done" is exactly the wrong
 *     mental model, and a collapsed row must not make it quietly right again.
 */
function ThreadMessage({ message, ticket, ticketId, expanded, onToggle, onOpenAttachment, onForward, messagesById, frameSize }) {
  const kind = messageKind(message)
  const stamp = messageTimestamp(message.sent_at || message.created_at)
  const body = message.text_body || '(no text content)'
  // Notes never take the HTML path, whatever the payload contains: the route
  // does not emit a document for them, and this guard says so twice.
  const html = kind === 'note' ? null : message.html_document || null
  const forwarded = forwardedMarker(message, messagesById)
  const isNote = kind === 'note'
  const me = kind !== 'inbound'
  const senderLabel = collapsedSenderLabel(message, ticket)
  const avatarLabel = kind === 'outbound' ? (message.author_name || 'Me') : senderLabel
  // EMAIL-DELIVERY.1 — null for "sent, no event yet", which is most messages
  // and every message written before mig 498. Nothing is rendered for it.
  const delivery = kind === 'outbound' ? deliveryMeta(message) : null
  const failure = delivery && delivery.tone !== 'quiet' && (
    <div className="border-b border-un1t-border/60 px-4 py-2">
      <DeliveryFailureNotice delivery={delivery} stamp={deliveryTimestamp(message)} />
    </div>
  )

  if (!expanded) {
    const snippet = messageSnippet(message)
    return (
      <>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded="false"
          aria-label={`Expand the message from ${senderLabel}${stamp ? `, ${stamp}` : ''}`}
          className={`flex w-full items-center gap-2.5 border-b border-un1t-border px-4 py-2 text-left ${
            isNote ? 'bg-amber-500/10' : 'bg-un1t-surface'
          }`}
        >
          <MessageAvatar me={me} label={avatarLabel} />
          {isNote && <Lock size={11} className="shrink-0 text-amber-700" aria-hidden="true" />}
          <span className={`min-w-0 flex-1 truncate text-xs ${isNote ? 'text-amber-700' : 'text-un1t-subtle'}`}>
            <span className={`font-semibold ${isNote ? 'text-amber-700' : 'text-un1t-text'}`}>{senderLabel}</span>
            {isNote && <span className="font-semibold"> · STAFF-ONLY</span>}
            {snippet && <> — {snippet}</>}
          </span>
          {(message.attachments?.length > 0) && (
            <Paperclip size={11} className="shrink-0 text-un1t-muted" aria-hidden="true" />
          )}
          <span className="shrink-0 text-[11px] tabular-nums text-un1t-muted">
            {relativeTime(message.sent_at || message.created_at)}
          </span>
        </button>
        {failure}
      </>
    )
  }

  if (isNote) {
    return (
      <div className="border-b border-un1t-border bg-amber-500/10 px-4 py-3">
        {/* The label line doubles as the collapse control — same click that
            opened it. It stays the first thing on the block either way. */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded="true"
          aria-label={`Collapse the note by ${senderLabel}${stamp ? `, ${stamp}` : ''}`}
          className="mb-1.5 flex w-full items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-amber-700"
        >
          <Lock size={12} className="shrink-0" aria-hidden="true" />
          Internal note — not sent to the member
          <span className="ml-auto shrink-0 font-normal normal-case tracking-normal">{stamp}</span>
        </button>
        <p className="whitespace-pre-wrap break-words text-sm text-un1t-text">{body}</p>
        <p className="mt-1.5 text-[11px] text-un1t-subtle">
          {/* Who left it. On a shared queue an anonymous note is a note you
              cannot ask anyone about. author_name is NULL for anything written
              before mig 493, so the address is still the fallback. */}
          {message.author_name
            ? `Note by ${message.author_name}`
            : (message.from_email || 'Staff')}
        </p>
      </div>
    )
  }

  if (kind === 'outbound') {
    // MAILBOX-COEXIST.1 — null for everything composed in the CRM, which is
    // every outbound row this thread had before Phase 8 polled a Sent folder.
    const origin = sendOriginMeta(message)
    return (
      <>
        <div className="border-b border-un1t-border px-4 py-3">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded="true"
            aria-label={`Collapse the reply from ${message.author_name || 'the studio'}${stamp ? `, ${stamp}` : ''}`}
            className="flex w-full items-center gap-2 text-left"
          >
            <MessageAvatar me label={avatarLabel} />
            <span className="min-w-0 truncate text-[13px] font-semibold text-un1t-text">
              {message.author_name || 'You'}
            </span>
            {message.from_email && (
              <span className="min-w-0 truncate text-[11px] text-un1t-muted">{message.from_email}</span>
            )}
            <span className="ml-auto shrink-0 text-[11px] text-un1t-muted">{stamp}</span>
          </button>
          {/* The recipient + delivery facts, quiet, directly under the header
              — the flat layout's replacement for the bubble's meta line. */}
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-un1t-muted">
            <MailCheck size={12} className="shrink-0" aria-hidden="true" />
            Sent to {message.to_email || 'the member'}
            {message.author_name && ` · Replied by ${message.author_name}`}
            {delivery?.tone === 'quiet' && <>{' · '}<DeliveryMarker delivery={delivery} message={message} /></>}
          </p>
          {/* Above the recipients, because "this was a forward" changes how
              the To line reads: those addresses are a third party, not the
              member. Origin above both: it changes how EVERYTHING under it
              reads, including the absent "Replied by" in the line above —
              a mail-client reply has no CRM author to name, and without this
              marker that gap looks like missing data rather than a fact. */}
          <div className="mt-1.5">
            <SendOriginMarker origin={origin} />
            <ForwardedMarker label={forwarded} />
            <MessageEnvelope message={message} />
            {html ? (
              <EmailFrame
                html={html}
                blockedImages={message.html_blocked_images}
                label={`Reply sent to ${message.to_email || 'the member'}`}
                frameSize={frameSize}
              />
            ) : (
              <p className="whitespace-pre-wrap break-words text-sm text-un1t-text">{body}</p>
            )}
            {message.html_unsafe && <UnsafeHtmlNotice />}
            {message.html_omitted && <HtmlOmittedNotice />}
            <Attachments ticketId={ticketId} attachments={message.attachments} onOpen={onOpenAttachment} />
            <div className="mt-1.5">
              <ForwardAction message={message} onForward={onForward} />
            </div>
          </div>
        </div>
        {failure}
      </>
    )
  }

  return (
    <div className="border-b border-un1t-border px-4 py-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded="true"
        aria-label={`Collapse the message from ${message.from_email || 'the member'}${stamp ? `, ${stamp}` : ''}`}
        className="flex w-full items-center gap-2 text-left"
      >
        <MessageAvatar me={false} label={senderLabel} />
        <span className="min-w-0 truncate text-[13px] font-semibold text-un1t-text">{senderLabel}</span>
        {message.from_email && senderLabel !== message.from_email && (
          <span className="min-w-0 truncate text-[11px] text-un1t-muted">{message.from_email}</span>
        )}
        <span className="ml-auto shrink-0 text-[11px] text-un1t-muted">{stamp}</span>
      </button>
      <div className="mt-1.5">
        {/* THE MEMBER'S OWN Cc. This is the point of capturing it inbound: a
            reply that reaches only the sender, when they copied two
            colleagues, drops those colleagues out of their own conversation. */}
        <MessageEnvelope message={message} />
        {html ? (
          <EmailFrame
            html={html}
            blockedImages={message.html_blocked_images}
            label={`Email from ${message.from_email || 'the member'}`}
            frameSize={frameSize}
          />
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm text-un1t-text">{body}</p>
        )}
        {message.html_unsafe && <UnsafeHtmlNotice />}
        {message.html_omitted && <HtmlOmittedNotice />}
        <Attachments ticketId={ticketId} attachments={message.attachments} onOpen={onOpenAttachment} />
        <div className="mt-1.5">
          <ForwardAction message={message} onForward={onForward} />
        </div>
      </div>
    </div>
  )
}
