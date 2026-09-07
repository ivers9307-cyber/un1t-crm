'use client'

// EMAIL-TICKET.4 — the composer.
//
// TWO MODES, AND THEY MUST NEVER BLUR INTO EACH OTHER:
//   Reply         — sends an email to the requester and moves the conversation to
//                   pending.
//   Internal note — writes staff-only text onto the thread. NOTHING is sent,
//                   the conversation does not move, the member never sees it.
//
// The mode is stated three times over — the selected pill, the colour of the
// composer, and the sentence under it naming exactly who receives what — on
// the principle that someone must never believe a note went to the customer,
// or that a reply stayed private. The submit button says which one it is too;
// it never just says "Send".
//
// SIGNATURE (MAIL-READER.1, reversing EMAIL-TICKET.5's preview). The server
// still appends the sender's signature to every real reply. It is NOT
// previewed here any more. The preview was a dashed box reprinting the whole
// signature — three or four lines of a docked 78vh card, above a composer,
// above the email — saying something the writer already knows and cannot
// change from here. It is configured on the account page and previewed THERE,
// beside the field that edits it, which is the one place a preview earns its
// space. ComposeForm, ForwardForm and ContactComposer dropped it for the same
// reason on the same day.
//
// THE CARD SHOWS THE EMAIL, NOT THE CHROME (MAIL-READER.1). The expanded form
// is capped at 40% of the reader card and scrolls inside that cap, so the
// thread above it can never be squeezed to a single line by a composer with a
// lot of recipients. The footer is ONE row: attachments left, Send right. The
// sentence naming every recipient moved onto the Send button's tooltip and an
// sr-only description — it is still exact and still announced, it just stopped
// repeating the chips two inches above it. What stayed VISIBLE is only what
// changes what the button does: the note-mode warning, and the reasons a
// disabled Send is disabled.
//
// RECIPIENTS (EMAIL-CC.1). THERE IS NO REPLY / REPLY-ALL CHOICE, deliberately
// (Richard, 2026-08-07). The server derives everybody on the thread and always
// includes them; this box shows them as locked chips and its button says which
// one is about to happen — "Reply" on a one-person thread, "Reply All (4
// people)" on a wider one. Offering both buttons is precisely the affordance
// that lets someone drop a participant by clicking the wrong one, so neither
// this component nor the route has a way to express it.
//
// REMOVING ONE, THOUGH, IS EXPLICIT (EMAIL-PARTICIPANTS.7). The audience is
// derived from the WHOLE thread now, so it can include people an operator has
// a real reason to take off — and a derived set nobody can edit is its own
// trap. The × on each locked chip is that edit and the ONLY one: no free-form
// box to type a new address (Richard). Subtracting from a derived set cannot
// reach anyone the thread did not already include; adding to it can, and that
// is what compose and forward are for. The removal is sticky, stored per
// conversation by the participants route, and it is the SERVER's answer that
// repaints the chips — this box never edits the list it renders.
//
// ONE LIST, NOT TWO. The × lives on the RecipientEditor chips that were
// already showing the audience, rather than a second row of the same
// addresses above the textarea. Two copies of "who this reaches", one of them
// removable, is a question an operator should never have to answer.
//
// AN EMPTIED AUDIENCE IS A REAL STATE, and the composer says so in the reply
// route's own words rather than falling back to the requester — see lockedTo.
//
// AND EVERY REMOVAL IS VISIBLE AND UNDOABLE. A removed address does not
// disappear: it drops into its own group under the To box, struck through,
// unfilled and labelled as not on the reply, with a restore beside it. Two
// reasons, and the second is the one that matters more. An operator who
// removed the wrong person from a five-person thread had no way to see they
// had done it, because the only evidence was an address that was no longer
// there. And an operator who removed EVERYBODY was told to "restore one to
// reply" by a composer offering nothing to restore with — a one-way door out
// of ever answering that conversation. Restore is not an exception to remove-only:
// it can only ever put back an address the thread already carried.
//
// Cc and Bcc ADD people and live behind the editor's own toggle. An internal
// note has no recipients at all — the editor is not rendered in note mode, and
// the route refuses a note that carries any.
//
// ATTACHMENTS (EMAIL-OUTBOUND-ATTACH.1) follow the same two-modes rule as
// everything else here: a reply can carry files, an internal note cannot,
// because a note is sent to nobody and there is nothing for a file to ride on.
// The picker is therefore hidden in note mode — and if files are already
// attached, switching to note mode does NOT silently drop them: it says so and
// blocks the note until they are removed. The route refuses the combination
// too, so the rule is stated in both places.

import { useState, useEffect, useId, useRef } from 'react'
import { Send, Lock, Users, AlertCircle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui'
import { isArchivedStatus, statusMeta, replyActionLabel } from '@/lib/mail/conversation-display'
// The cap the reply route refuses on, imported rather than typed into the
// sentence below: the route interpolates this same constant into its 400, and
// two hand-written 25s are two places to forget when it moves.
import { MAX_RECIPIENTS } from '@/lib/email-recipients'
import RecipientEditor, { EMPTY_RECIPIENTS } from './RecipientEditor'
import AttachmentPicker, { readyDrafts, hasPendingUploads } from './AttachmentPicker'
// MAIL-TRIAL draft persistence — see that file's header comment for why the
// draft is keyed per conversation id rather than anything shared: ConversationThread's
// `key={conversationId}` remount is TICKET-COMPOSER-LEAK.1's guard against a
// cross-conversation send, and this store rides on exactly that key rather than
// creating a second one.
import { readReplyDraft, writeReplyDraft, clearReplyDraft } from '@/components/mail/reply-drafts'
import { replyPillLabel } from '@/components/mail/mail-vocabulary'
import { resolveViewerId } from '@/components/mail/viewer-id'

const MAX_LENGTH = 10000

export default function ReplyBox({
  conversation,
  replyRecipients = null,
  onSend,
  onRemoveRecipient,
  onRestoreRecipient,
  // A remove/restore is in flight. Separate from `sending` because it disables
  // a different, much smaller thing: the chip buttons, and nothing else.
  participantSaving = false,
  sending = false,
  // MAIL-TRIAL.B — the ONE sentence in this composer written in the conversation
  // lifecycle's own vocabulary. The Mail surface reuses this box whole (see
  // ConversationThread.jsx's slot comment for why forking it is not an option) and
  // calls the same state "Archived", so a line reading "This conversation is closed"
  // would be the composer contradicting every other word on that screen.
  // `undefined` keeps the sentence exactly as it was; a node replaces it;
  // `null` drops it.
  archivedHint,
  // MAIL-DOCK.1 — start as the mockup's slim pill ("Reply to Helen…" · Note ·
  // Reply ↵) instead of the full form, until (a) the operator clicks it, or
  // (b) draft hydration finds a non-empty draft, which auto-expands. Default
  // false: every existing caller keeps the always-open composer unchanged.
  // Collapse state is component-local and resets per conversation via the
  // `key={conversationId}` remount ConversationThread already does — the same remount
  // that is TICKET-COMPOSER-LEAK.1's guard, which this must never weaken.
  startCollapsed = false,
  // MAIL-READER.1 (05) — READING MODE. The parent (ConversationThread) owns
  // it; this box only reports the two events that drive it and reads back the
  // one thing that changes here.
  //
  // `reading` widens the cap from 40% to 46% of the card: with the header
  // folded to a single line the thread and the draft are meant to share what
  // is left roughly half and half. It is a CLASS, not a measurement — jsdom
  // has no layout engine, so the recipe is all a test can pin (a recorded
  // trap: a green suite once shipped a toggle that did nothing).
  reading = false,
  // Fired from the textarea's own focus. The parent folds the header on it,
  // which is why it is the TEXTAREA and not the form: clicking Attach or a
  // recipient chip is not the operator settling in to write.
  onComposerFocus,
  // Fired whenever `collapsed` changes — INCLUDING the draft hydration's
  // auto-expand, which is a real expansion the parent must see. Reported from
  // an effect rather than from each setter so there is exactly one place that
  // can ever disagree with the state.
  onCollapsedChange,
}) {
  const [mode, setMode] = useState('reply')
  const [text, setText] = useState('')
  const [recipients, setRecipients] = useState(EMPTY_RECIPIENTS)
  const [files, setFiles] = useState([])

  // The pill. A CLICKED expansion focuses the textarea (via the effect
  // below) — a click that opens a composer and leaves focus on a vanished
  // button strands the next keystroke on the body, where the surface's
  // single-letter shortcuts live. A DRAFT's auto-expand deliberately does
  // NOT focus: it fires on every j/k step onto a conversation with a saved
  // draft, and stealing focus there would turn the very next j into a letter
  // typed into somebody's half-written reply — the exact class of bug
  // isTypingTarget exists to prevent, manufactured from the inside.
  const [collapsed, setCollapsed] = useState(startCollapsed)
  const textareaRef = useRef(null)
  // MAIL-READER.1 — the id the Send button's aria-describedby points at. From
  // useId rather than a module constant so two composers on one page (the
  // reader card and a compose dock) can never both claim the same id and hand
  // a screen reader the wrong audience.
  const audienceDescriptionId = useId()
  const focusOnExpandRef = useRef(false)
  function expand(nextMode) {
    if (nextMode) setMode(nextMode)
    focusOnExpandRef.current = true
    setCollapsed(false)
  }
  useEffect(() => {
    if (!collapsed && focusOnExpandRef.current) {
      focusOnExpandRef.current = false
      textareaRef.current?.focus()
    }
  }, [collapsed])

  const conversationId = conversation?.id

  // DRAFT PERSISTENCE (never initial useState — that would run during SSR,
  // where there is no window and no conversation-specific draft to read yet).
  //
  // `skipNextWriteRef` exists to stop the write-through effect below from
  // firing on the SAME render pass this hydration effect runs on: both
  // effects flush after mount with the pre-hydration `text`/`mode` (''/
  // 'reply') still in their closures, and without the guard that pass would
  // write-through the blank state and immediately clear the very draft this
  // effect just read back off disk. It is consumed exactly once per
  // conversation — read here, spent by the write-through effect's first run for
  // this conversation — and reset whenever the conversation id changes again.
  const skipNextWriteRef = useRef(true)

  // MAIL-DRAFTSCOPE.2 — drafts are keyed per USER and per EMAIL ACCOUNT as
  // well as per conversation (Richard's call), so hydration has to know who is
  // signed in. `undefined` = still resolving (persist nothing yet, hydrate
  // nothing yet); `null` = resolution failed, and the store fails CLOSED — no
  // key, no persistence — rather than writing a draft some other signed-in
  // user could hydrate. resolveViewerId is module-cached, so this is one
  // getSession per page load, not per mount.
  const [viewerId, setViewerId] = useState(undefined)
  useEffect(() => {
    let cancelled = false
    resolveViewerId().then((id) => { if (!cancelled) setViewerId(id) })
    return () => { cancelled = true }
  }, [])

  // The mailbox segment comes off the conversation itself (loadConversationForUser
  // selects *, so mailbox_id rides along); an orphan conversation's NULL becomes
  // the 'none' sentinel inside replyDraftKey.
  const draftScope = { userId: viewerId, mailboxId: conversation?.mailbox_id, conversationId }

  // What the composer holds RIGHT NOW, readable from the async hydration
  // effect below without widening its deps (deps of [text] would re-run
  // hydration per keystroke). Refreshed every render; cheap.
  const latestRef = useRef({ text: '', mode: 'reply' })
  // Updated in an effect, not during render (react-hooks/refs). Declared
  // BEFORE the hydration effect: effects run in declaration order within a
  // commit, so by the time hydration fires on viewer resolution this ref
  // already holds the same commit's text/mode.
  useEffect(() => {
    latestRef.current = { text, mode }
  })

  useEffect(() => {
    // Until the viewer resolves there is nothing safe to read: hydrating an
    // unscoped draft is exactly the cross-user bleed the scope exists to
    // prevent.
    if (viewerId === undefined) return
    const scope = { userId: viewerId, mailboxId: conversation?.mailbox_id, conversationId }

    // 🔴 LIVE TYPING OUTRANKS THE STORED DRAFT. Hydration is now async (it
    // waits on the session), and an operator can start typing before it
    // lands — the first cut called setText('') here and ERASED their words
    // mid-sentence. If anything has been typed, keep it, and persist it now
    // that the scope finally exists (writes before this point were no-ops:
    // no user id, no key — fail closed).
    const current = latestRef.current
    if (current.text.trim()) {
      skipNextWriteRef.current = false
      writeReplyDraft(scope, current)
      return
    }

    const draft = readReplyDraft(scope)
    // MAIL-DOCK.1 — a non-empty draft auto-expands the pill: words the
    // operator already wrote must never hide behind a bar that looks blank.
    // Without focus — see the pill comment above.
    if (draft) setCollapsed(false)
    // Arm the skip for the write-through pass this resolution triggers.
    // `!!draft` and a plain `true` are provably equivalent here — viewerId is
    // in the write effect's deps, so the viewer-resolution render always runs
    // that effect once and consumes whatever is armed, draft or no draft,
    // before any keystroke can be swallowed (mutation-tested: flipping this
    // to `true` changes nothing observable). `!!draft` is kept because it
    // states the INTENT — skip exactly the restore's own echo — and stays
    // correct if viewerId ever leaves those deps.
    skipNextWriteRef.current = !!draft
    if (draft) {
      setText(draft.text)
      setMode(draft.mode)
    }
    // Recipients/files are never restored — see mail-display.js's header
    // comment on why only { text, mode } are ever persisted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, viewerId])

  // Write-through: every change to the words or the mode is saved, so a row
  // switch, an `e`, a refresh or a crash can never destroy them again. Never
  // recipients, files, or anything else derived per conversation — same reason.
  // With no resolved viewer the store's own null-key guard makes this a no-op.
  useEffect(() => {
    if (skipNextWriteRef.current) {
      skipNextWriteRef.current = false
      return
    }
    writeReplyDraft(draftScope, { text, mode })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, viewerId, text, mode])

  // MAIL-READER.1 (05) — tell the parent which shape this box is in. Declared
  // LAST on purpose: the draft effects above are order-sensitive (latestRef
  // before hydration, hydration before write-through) and this one must never
  // be inserted among them. Deps are `collapsed` alone — the callback is an
  // inline arrow in the parent, so depending on its identity would re-fire
  // this on every parent render.
  useEffect(() => {
    onCollapsedChange?.(collapsed)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report state changes only
  }, [collapsed])

  const isNote = mode === 'note'
  // The reply route 400s without a requester address. Say so up front rather
  // than letting an operator type a reply into a dead end.
  const canReply = !!conversation?.requester_email
  const archived = isArchivedStatus(conversation?.status)

  // Everybody the server will include whether or not this box asks it to.
  //
  // THE REQUESTER FALLBACK MUST NOT APPLY TO AN EMPTY SET. "We could not derive
  // anybody" and "the operator took everybody off" are different answers, and
  // only the first one is a gap the requester fills. Falling back on the second
  // put the person they had just removed back on screen, and in the sentence
  // naming who the reply reaches, while the route would refuse the send — the
  // composer naming somebody who will not be mailed, which is the one thing
  // this programme exists to end.
  const audienceEmpty = !!replyRecipients?.empty
  const lockedTo = audienceEmpty
    ? []
    : replyRecipients?.to?.length
      ? replyRecipients.to
      : [conversation?.requester_email].filter(Boolean)
  const sendLabel = replyActionLabel(replyRecipients, recipients.to.length)

  // EMAIL-PARTICIPANTS.8 — THE PLACEHOLDER NAMES THE REAL AUDIENCE, not the
  // requester. It read `Reply to ${conversation.requester_email}` — the address the
  // FIRST message arrived from. On the 2026-08-12 conversation that meant the box an
  // operator types into said "Reply to ratesoffice@dublincity.ie" while the
  // reply was actually going to Eleanor: the same wrong-name-in-a-prominent-
  // place defect as the header, one component along.
  //
  // It reads `lockedTo`, so it inherits the empty-audience rule above rather
  // than re-deriving one, and can never name somebody the send would refuse.
  // With several people on it, naming one is precisely the mistake — the first
  // is the live counterparty and the rest are a count, which is the idiom the
  // send button already uses.
  //
  // "THE FIRST" IS THE SERVER'S ANSWER, NOT AN ASSUMPTION ABOUT MAIL HEADERS.
  // ticketParticipants() leads with the person the next reply answers, read
  // off the newest real message in whichever direction it went: its From when
  // they wrote to us, its first To when we wrote to them. It used to be the
  // From either way, which on our own reply is one of OUR addresses and gets
  // excluded — so this placeholder and the header's divergence check both
  // silently re-pointed at whoever happened to appear first (see
  // EMAIL-PARTICIPANTS.12 in src/lib/email-recipients.js).
  const replyPlaceholder = lockedTo.length === 0
    ? 'Reply…'
    : lockedTo.length === 1
      ? `Reply to ${lockedTo[0]}…`
      : `Reply to ${lockedTo[0]} and ${lockedTo.length - 1} ${lockedTo.length === 2 ? 'other' : 'others'}…`

  // A note can never carry files, so files present + note mode is a state the
  // operator has to resolve rather than one we resolve for them by dropping
  // their uploads.
  const filesBlockNote = isNote && files.length > 0
  const uploading = hasPendingUploads(files)
  // The two audiences the reply route refuses outright (EMAIL-PARTICIPANTS.5),
  // both free to catch here because nothing has been sent. A note reaches
  // nobody by design, so neither can ever apply to one.
  const overCap = !isNote && !!replyRecipients?.over_cap
  // Gated on canReply so a conversation with no requester address keeps its own,
  // more accurate sentence rather than being told to restore somebody nobody
  // ever removed.
  const noAudience = !isNote && canReply && audienceEmpty
  // The operator's own subtractions, straight off the conversation row. NOT derived
  // and never guessed: these are exactly the addresses the participants route
  // has stored, which is what makes the restore below able to lift them.
  const removedParticipants = conversation?.excluded_participants || []

  // MAIL-READER.1 — the audience sentence, verbatim, as a STRING. It used to
  // be a paragraph across the bottom of the card naming every recipient a
  // second time (the RecipientEditor chips two inches above are the first).
  // It now feeds the Send button's `title` and its sr-only description, and a
  // string is what both of those take: a title attribute cannot hold markup,
  // and an sr-only node built separately from the tooltip would be two
  // different answers to "who gets this". Bcc is still named AS private —
  // someone about to press send has to be able to see that they blind-copied
  // three people, and that the other recipients cannot.
  const audienceSummary = !isNote && canReply && !noAudience && lockedTo.length > 0
    ? [
        `Sends an email to ${lockedTo.join(', ')}`,
        recipients.cc.length > 0 ? `cc ${recipients.cc.join(', ')}` : null,
        recipients.bcc.length > 0
          ? `bcc ${recipients.bcc.join(', ')} (hidden from everyone else)`
          : null,
        conversation?.mailbox?.address
          ? `replies come back to ${conversation.mailbox.address}`
          : null,
      ].filter(Boolean).join(' · ')
    : null

  // The one line that may still occupy the surface, and only when it changes
  // what the button DOES. "Nobody is left on this reply" is deliberately not
  // here: noAudience already prints its own line beside the recipient box that
  // caused it, and saying it twice in one form is how a composer stops being
  // read at all.
  const noteOrBlockedLine = isNote ? (
    <>
      <Lock size={11} className="mr-1 inline align-[-1px]" aria-hidden="true" />
      Staff only — this is written to the conversation and <strong>not sent</strong> to{' '}
      {conversation?.requester_email || 'the member'}.
    </>
  ) : !canReply ? (
    'This conversation has no sender address, so it cannot be replied to. You can still add an internal note.'
  ) : null

  async function handleSubmit(e) {
    e.preventDefault()
    const body = text.trim()
    if (!body || sending) return
    if (!isNote && !canReply) return
    // Never send a partial set: a chip on screen that did not go with the email
    // is the same lie as a file the thread claims was sent.
    if (uploading || filesBlockNote) return
    // Stated here as well as on the disabled button, the way filesBlockNote is:
    // the button is the affordance, this is the rule, and a form submitted by
    // any other route (Enter in a field, a stale render) meets it too.
    if (overCap || noAudience) return
    // A note is sent to nobody, so it carries NEITHER recipients NOR files —
    // the route refuses one that does, and this is the client half of the same
    // rule for both. One `extras` object rather than two positional arguments,
    // so adding a third thing a send can carry does not renumber the callers.
    const result = await onSend(body, isNote, isNote
      ? { recipients: EMPTY_RECIPIENTS, attachments: [] }
      : { recipients, attachments: readyDrafts(files) })
    if (result?.ok) {
      setText('')
      setRecipients(EMPTY_RECIPIENTS)
      // The drafts were consumed by the send (their objects moved to the
      // message's own keys), so clearing is not just tidying — holding them
      // would offer the operator references that no longer resolve.
      setFiles([])
      // Cleared explicitly rather than left to the write-through effect's
      // own empty-text branch: a successful send is the one moment this
      // draft is DEFINITELY done, and saying so here does not depend on the
      // effect having run yet.
      clearReplyDraft(draftScope)
    }
    // Anything else keeps the draft — INCLUDING `result.sent`, the
    // delivered-but-unfiled case (EMAIL-REPLY-UNFILED.1): the mail went out
    // but the thread could not record it, so the words in this box are the
    // operator's only copy of what the member received, and the banner above
    // says not to send them again. Clearing here would make that failure look
    // like a clean success.
  }

  // MAIL-DOCK.1 — the slim pill (mockup D's bar): who the reply reaches, a
  // Note entry and a dark Reply ↵, nothing else. Every hook above has already
  // run — hydration, write-through and the viewer resolution are exactly the
  // same whether the form is showing or not, so a draft keeps persisting and
  // restoring across the collapsed state. The buttons carry type="button" by
  // convention even though no <form> wraps them here.
  if (collapsed) {
    return (
      <div className="flex items-center gap-2 border-t border-un1t-border bg-un1t-surface px-4 py-2">
        <button
          type="button"
          onClick={() => expand('reply')}
          className="min-w-0 flex-1 truncate text-left text-xs text-un1t-subtle transition-colors hover:text-un1t-text"
        >
          {replyPillLabel(conversation)}
        </button>
        <button
          type="button"
          onClick={() => expand('note')}
          className="shrink-0 rounded-md border border-un1t-border bg-un1t-bg px-2.5 py-1 text-xs font-medium text-un1t-text transition-colors hover:bg-un1t-surface"
        >
          Note
        </button>
        <button
          type="button"
          onClick={() => expand('reply')}
          className="shrink-0 rounded-md bg-un1t-text px-2.5 py-1 text-xs font-semibold text-un1t-bg transition-opacity hover:opacity-90"
        >
          Reply ↵
        </button>
      </div>
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      // MAIL-READER.1 — the composer may never own more than ~40% of the
      // reader card. `max-h-[40%]` resolves against the card's flex column
      // (MailDock gives it a definite height); where that height is
      // indeterminate the cap simply computes to `none` and the form behaves
      // exactly as it did before, which is the right way for a cap to fail.
      // `shrink-0` keeps the flex layout from squeezing it instead of the
      // thread — the thread carries `flex-1 min-h-0` and is the part that is
      // supposed to absorb the height.
      // MAIL-READER.1 (05) — 46% while the header is folded: reading mode
      // trades a header the operator has stopped reading for draft room.
      className={`shrink-0 ${reading ? 'max-h-[46%]' : 'max-h-[40%]'} overflow-y-auto border-t px-4 py-3 ${isNote ? 'border-amber-500/40 bg-amber-500/10' : 'border-un1t-border bg-un1t-bg'}`}
    >
      {/* Mode switch. type="button" on both — a bare <button> inside a <form>
          defaults to submit and would fire the send (CLAUDE.md). */}
      <div className="mb-2 flex flex-wrap items-center gap-1" role="group" aria-label="Compose mode">
        <ModePill
          active={!isNote}
          onClick={() => setMode('reply')}
          icon={Send}
          label="Reply to member"
        />
        <ModePill
          active={isNote}
          onClick={() => setMode('note')}
          icon={Lock}
          label="Internal note"
          tone="note"
        />
      </div>

      {/* Recipients. Never in note mode — a note has none, and a Cc box on a
          staff-only line is an invitation to believe one was sent. */}
      {!isNote && canReply && (
        <div className="mb-2">
          <RecipientEditor
            idPrefix="conversation-reply-recipients"
            value={recipients}
            onChange={setRecipients}
            lockedTo={lockedTo}
            lockedHint={
              lockedTo.length > 1
                ? 'Everybody on this thread is included. Removing someone drops them from this reply and from later ones.'
                : undefined
            }
            // EMAIL-PARTICIPANTS.7 — the ONE list of who this reaches, so the ×
            // sits on the chips that were already on screen rather than beside
            // a second copy of them. Absent (compose, forward) there is no ×.
            onRemoveLocked={onRemoveRecipient}
            lockedBusy={participantSaving}
            disabled={sending}
          />
        </div>
      )}

      {/* The people taken off this reply. Deliberately NOT inside the
          RecipientEditor: everything in that box is somebody the email goes
          to, and a chip sitting among them is read as a recipient however it
          is styled. Four signals say otherwise here — its own labelled group,
          no fill, a dashed edge, and the address struck through — because
          "these two are not getting this" has to survive being glanced at. */}
      {!isNote && canReply && removedParticipants.length > 0 && (
        <div className="mb-2">
          {/* The heading is TIED to the group, not merely above it. Sighted
              readers get "not a recipient" from the strike-through and the
              unfilled chip; a screen reader gets neither, so without the
              association the only cue left is the word "Restore" on a button —
              and an address announced with no cue at all reads as somebody on
              the reply. */}
          <p
            id="reply-removed-participants"
            className="mb-1 text-[11px] font-medium uppercase tracking-wider text-un1t-muted"
          >
            Not on this reply
          </p>
          <div
            role="group"
            aria-labelledby="reply-removed-participants"
            className="flex flex-wrap items-center gap-1.5"
          >
            {removedParticipants.map(address => (
              <span
                key={`removed-${address}`}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-un1t-border px-2 py-0.5 text-xs text-un1t-subtle"
              >
                <span className="line-through">{address}</span>
                {/* Restore is not a second way to add somebody: the route only
                    lifts an exclusion, so this can never reach an address the
                    thread did not already carry. */}
                {onRestoreRecipient && (
                  <button
                    type="button"
                    onClick={() => onRestoreRecipient(address)}
                    // Same reason the × is: the two writes are serialised
                    // against each other, so both have to say when one is out.
                    disabled={sending || participantSaving}
                    aria-label={`Restore ${address}`}
                    title="Put this person back on the reply"
                    className="text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
                  >
                    <RotateCcw size={11} aria-hidden="true" />
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Word for word what the reply route answers, so the composer and the
          400 cannot describe the same conversation differently. */}
      {noAudience && (
        <p className="mb-2 text-[11px] text-amber-700" role="alert">
          This conversation has no recipients left — restore one to reply.
        </p>
      )}
      {overCap && (
        <p className="mb-2 text-[11px] text-amber-700">
          This thread has {lockedTo.length} recipients and the limit is {MAX_RECIPIENTS}. Remove some before replying.
        </p>
      )}
      <label className="sr-only" htmlFor="conversation-composer">
        {isNote ? 'Internal note (staff only)' : 'Reply to the member'}
      </label>
      <textarea
        id="conversation-composer"
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        // MAIL-READER.1 (05) — the operator settling in to write is what
        // enters reading mode. Nothing here folds anything; the parent owns
        // that decision and may refuse it (a manual unfold sticks).
        onFocus={() => onComposerFocus?.()}
        // Four rows, not three: with the signature box and the recipient
        // sentence gone the words are what the composer is FOR, and the form's
        // own cap plus its scroll is what keeps that from eating the thread.
        rows={4}
        maxLength={MAX_LENGTH}
        disabled={!isNote && !canReply}
        placeholder={isNote ? 'Staff-only note. Nothing is sent.' : replyPlaceholder}
        className={`w-full resize-none rounded-lg border px-3 py-2 text-sm text-un1t-text focus:outline-none disabled:opacity-60 ${
          isNote
            ? 'border-amber-500/50 bg-un1t-bg focus:border-amber-600'
            : 'border-un1t-border bg-un1t-surface focus:border-un1t-accent'
        }`}
      />

      {filesBlockNote && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-700" role="alert">
          <AlertCircle size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
          {files.length === 1 ? 'A file is' : `${files.length} files are`} attached, and an internal
          note is not sent to anyone. Switch back to Reply to send {files.length === 1 ? 'it' : 'them'},
          or remove {files.length === 1 ? 'it' : 'them'} there first.
        </p>
      )}

      {/* MAIL-READER.1 — ONE toolbar row: what you can attach on the left,
          what happens when you click on the right. It replaces two stacked
          blocks (a full-width picker, then a paragraph-plus-button row) that
          between them owned as much of the card as the message body did.

          The picker keeps its own full form and simply wraps here — it has no
          compact variant, and inventing one would fork the size rules,
          the wording and the failure states away from the New email composer
          that mounts the very same component. */}
      <div
        data-composer-toolbar=""
        className="mt-2 flex flex-wrap items-end justify-between gap-x-3 gap-y-1"
      >
        <div className="min-w-0 flex-1">
          {/* Files ride on a reply only. In note mode the picker is gone but
              any already-attached files stay visible in the notice above —
              dropping them silently would be the thing this composer is most
              careful about everywhere else. */}
          {!isNote && canReply && (
            <AttachmentPicker
              scope={{ ticket_id: conversation?.id }}
              files={files}
              onChange={setFiles}
              disabled={sending}
            />
          )}

          {/* THE ONLY SENTENCES LEFT ON THE SURFACE, and they are here because
              each one changes what the button does rather than merely
              describing it. The note warning says the click sends nothing to
              the member; the no-sender line says why Send is dead. The
              emptied-audience and over-cap lines already sit above the
              textarea, next to the box that caused them, and are not repeated.
              Everything else about the audience is on the button itself. */}
          {noteOrBlockedLine && (
            <p className={`mt-2 text-[11px] ${isNote ? 'text-amber-700' : 'text-un1t-subtle'}`}>
              {noteOrBlockedLine}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="submit"
            size="sm"
            variant={isNote ? 'secondary' : 'primary'}
            loading={sending}
            // The audience sentence, verbatim, as a tooltip. It is not a
            // shortened paraphrase: someone about to click has to be able to
            // find out that they blind-copied three people, and where the
            // answers will land.
            title={audienceSummary || undefined}
            // …and the same words for a screen reader, tied to the button so
            // they are announced WITH it rather than orphaned somewhere in the
            // form. A tooltip alone would have deleted the information for
            // anyone not using a mouse.
            aria-describedby={audienceSummary ? audienceDescriptionId : undefined}
            // overCap/noAudience join filesBlockNote here as well as in
            // handleSubmit: a button that looks live and silently does nothing is
            // worse than a disabled one beside a sentence saying why.
            disabled={!text.trim() || (!isNote && !canReply) || uploading || filesBlockNote || overCap || noAudience}
            icon={isNote ? Lock : (sendLabel === 'Reply' ? Send : Users)}
          >
            {/* The label IS the guard rail — see the header. It states the
                number of people before the click, never after; a file still on
                its way up displaces it only because pressing send then would be
                the one click that cannot do what the label says. */}
            {isNote ? 'Add internal note' : uploading ? 'Waiting for files…' : sendLabel}
          </Button>
          {audienceSummary && (
            <span id={audienceDescriptionId} className="sr-only">{audienceSummary}</span>
          )}
        </div>
      </div>

      {!isNote && archived && (
        archivedHint !== undefined ? archivedHint : (
          <p className="mt-1.5 text-[11px] text-un1t-muted">
            This conversation is {statusMeta(conversation?.status).label.toLowerCase()} — sending a reply moves it back to pending.
          </p>
        )
      )}
    </form>
  )
}

function ModePill({ active, onClick, icon: Icon, label, tone }) {
  const activeClasses = tone === 'note'
    ? 'border-amber-600 bg-amber-500/10 font-semibold text-amber-700'
    : 'border-transparent bg-un1t-text font-medium text-un1t-bg'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active ? activeClasses : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      <Icon size={12} aria-hidden="true" />
      {label}
    </button>
  )
}
