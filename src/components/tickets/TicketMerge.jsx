'use client'

// 🔴 DORMANT SINCE RETIRE-TICKETS.1 — TicketInbox, the only surface that
// passed onMerge/onUnmerge, is deleted, and MailThread deliberately supplies
// its own `controls` slot, so nothing on the web renders this today. It is
// KEPT, not deleted: merge tombstone handling (scopeToUnmerged, the banner,
// the undo) is live data behaviour, the merge API routes still exist, and
// re-offering merge on Mail one day means passing two props — not rebuilding
// this. Comments below still say "TicketInbox" for how the wiring worked.

// EMAIL-MERGE.6 — folding one ticket into another, and undoing it.
//
// THE INCIDENT: two tickets that were one conversation with Dublin City
// Council. An operator answered on both and the council received the same
// reply twice. Merge joins them; mig 536 makes it reversible.
//
// ══ WHY THIS IS TWO STEPS AND NOT A DROPDOWN ════════════════════════
// Merging is the most consequential act on this surface that is not a send. It
// moves ANOTHER ticket's correspondence, closes a ticket, and — across
// mailboxes — changes who is able to read it. So picking a target and agreeing
// to the consequence are deliberately separate: the confirm names both
// subjects, says how many messages move, and labels which ticket disappears
// and which survives. "Merge into…" reads symmetrically, and a symmetric
// sentence about an asymmetric act is how you fold the wrong one away.
//
// ══ WHERE THE FETCHES LIVE, AND WHY THEY ARE SPLIT ══════════════════
// READS here, WRITES in TicketInbox.
//
// The two reads exist only while this component is showing something: the
// candidate queue only while the picker is open, the survivor's subject only
// while the banner is up. Holding them in TicketInbox would put a third list in
// its state and hand it to the 60s poll, refetching a list nobody is looking at
// on every tick. AttachmentPreview sets the precedent — it mints its own signed
// URL rather than having the inbox pre-fetch one per attachment.
//
// The WRITES are the inbox's, with handleAssign / handleStatus /
// patchParticipants, because neither finishes inside this component. A merge
// takes the source out of the queue and rewrites the survivor's row; an undo
// brings both back. Only TicketInbox can refetch the queue and re-read the
// thread, and a 409 — somebody merged it first — is answered by refreshing
// rather than leaving a stale view, which is the same thing. onMerge resolves
// to { ok, error, stale } so a failure that leaves the dialog useful can be
// shown IN the dialog, exactly as handleSend answers the composer.
//
// ══ THE BANNER STAYS PUT AFTER A MERGE, ON PURPOSE ══════════════════
// A merged ticket is hidden from every list and count (scopeToUnmerged), so the
// moment the operator navigates away the tombstone is unreachable — and the
// undo with it. Landing them on the survivor would be the friendlier-looking
// choice and would quietly make this feature one-way. Instead the merge leaves
// them where they are, on a ticket that now renders this banner: the survivor
// is one click away (Open) and so is the reversal (Undo). That is what
// EMAIL-MERGE.5 keeps the detail route answering 200 for.
//
// ══ THE CROSS-MAILBOX WARNING ═══════════════════════════════════════
// email_tickets.mailbox_id is the access unit — mig 502 keys message RLS on the
// TICKET'S mailbox — so folding studio@ into accounts@ makes the source's
// correspondence readable by everyone holding a grant on the TARGET mailbox.
// Mig 502 exists precisely because mailbox scoping was missing, so a merge
// across mailboxes re-widens a slice of what it closed.
//
// It is NOT blocked. Two tickets at one studio landing on two addresses is a
// real thing that happens (a member writes to studio@ and then to accounts@),
// and refusing would leave the duplicate this feature exists to remove. The
// answer is informed consent: when the two mailboxes differ, the confirm names
// BOTH and states the consequence in words. It appears only on that case —
// a warning shown on every merge is one the operator learns to click past, and
// then it is not there on the merge that actually widens access.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Merge, AlertTriangle, AlertCircle, ArrowRight, Undo2, ExternalLink, Search,
} from 'lucide-react'
import { Modal, Button, Field } from '@/components/ui'
import { buildTicketsUrl, mailboxLabel, requesterLabel } from '@/lib/ticket-display'

const INPUT_CLASSES =
  'w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-subtle/60 focus:outline-none focus:ring-1 focus:ring-un1t-text/30'

/**
 * "3 messages" / "1 message" — the count is the whole point of the confirm, so
 * it reads right.
 *
 * ZERO IS NOT A COUNT, IT IS AN ABSENCE OF ONE. Every real ticket has at least
 * one message, so a 0 here means the thread has not finished loading — and
 * "this moves 0 messages" is a confident, wrong sentence about the one number
 * the operator is being asked to weigh. It degrades to the vaguer phrasing
 * instead, which is true whatever the thread turns out to hold.
 */
function messagesPhrase(n) {
  if (!(n > 0)) return 'this ticket’s messages'
  return n === 1 ? '1 message' : `${n} messages`
}

export default function TicketMerge({
  ticket,
  // How many messages move. The thread already has them, so it is passed rather
  // than counted again here — one number, one source. It is the RENDERED count,
  // capped at the detail route's MESSAGE_LIMIT (200); a thread that long would
  // understate, which is a fair trade against a second query whose only job is
  // to make a sentence more precise on a ticket nobody has.
  messageCount = 0,
  // (targetId) => Promise<{ ok, error?, stale? }> — owned by TicketInbox.
  onMerge,
  // () => Promise<void> — the undo. Its failures land in the thread's own error
  // banner, like every other inline mutation on this pane.
  onUnmerge,
  // (id) => void — select another ticket in the queue.
  onOpenTicket,
}) {
  const [picking, setPicking] = useState(false)
  const [candidates, setCandidates] = useState([])
  const [mailboxes, setMailboxes] = useState([])
  const [loadingList, setLoadingList] = useState(false)
  const [listError, setListError] = useState(null)
  const [filter, setFilter] = useState('')
  const [chosen, setChosen] = useState(null)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState(null)

  const [survivor, setSurvivor] = useState(null)
  const [undoing, setUndoing] = useState(false)

  // ── Focus follows the step ────────────────────────────────────────
  // The dialog swaps its ENTIRE contents between pick and confirm, so the
  // element the operator just activated unmounts — and the browser resolves
  // focus to <body>, OUTSIDE the dialog. Modal moves focus in on OPEN only, and
  // deliberately so (UI-MODAL-FOCUS.1: re-running it on every render is the
  // focus-steal bug), so nothing brings it back. Left alone, an operator who
  // picks a candidate with Enter is dropped at the top of the document with no
  // focus trap to walk them back in — they tab through the whole page behind
  // the dialog to reach Merge, on the one flow in this feature that moves a
  // conversation. Re-focusing the step container also gives a screen reader
  // something to announce, since the title changing is silent.
  const stepRef = useRef(null)
  const prevStep = useRef(null)

  const ticketId = ticket?.id
  const mergedIntoId = ticket?.merged_into_id || null
  const locationId = ticket?.location_id

  // ── The survivor's name, for the banner ───────────────────────────
  // Cosmetic, and treated as such: a failed lookup leaves the banner naming
  // "another ticket" rather than hiding it. Hiding it would strand the operator
  // on a tombstone with no route to the live thread and no way to reverse —
  // the one state this feature must never produce.
  useEffect(() => {
    setSurvivor(null)
    if (!mergedIntoId) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/email/tickets/${mergedIntoId}`, { cache: 'no-store' })
        const body = await res.json()
        if (cancelled || !body?.success) return
        setSurvivor(body.data?.ticket || null)
      } catch { /* the banner degrades to "another ticket" */ }
    })()
    return () => { cancelled = true }
  }, [mergedIntoId])

  // ── The candidates ────────────────────────────────────────────────
  // The live queue at this location, across every mailbox the caller can see —
  // deliberately NOT the list already in TicketInbox, which is narrowed by
  // whichever mailbox tab and view the operator happens to be on. A duplicate
  // that arrived at the other address is exactly the one they are looking for,
  // and a picker that could not show it would make the cross-mailbox case
  // unreachable while its own warning talks about it.
  const loadCandidates = useCallback(async () => {
    if (!locationId) return
    setLoadingList(true)
    setListError(null)
    try {
      const res = await fetch(buildTicketsUrl({ locationId }), { cache: 'no-store' })
      const body = await res.json()
      if (!body?.success) {
        setListError(body?.error || 'Could not load the other tickets')
        return
      }
      setCandidates(body.data?.tickets || [])
      setMailboxes(body.data?.mailboxes || [])
    } catch {
      setListError('Could not load the other tickets — check your connection and try again')
    } finally {
      setLoadingList(false)
    }
  }, [locationId])

  // ON A CHANGE BETWEEN STEPS ONLY, never on open: opening is Modal's own move
  // (its panelRef.focus() is what announces the dialog and its title), and this
  // effect runs after it — a parent's effect flushes after its children's — so
  // firing here on open would take that announcement away.
  useEffect(() => {
    const step = picking ? (chosen ? 'confirm' : 'pick') : null
    if (step && prevStep.current && step !== prevStep.current) stepRef.current?.focus()
    prevStep.current = step
  }, [picking, chosen])

  function openPicker() {
    setPicking(true)
    setChosen(null)
    setFilter('')
    setError(null)
    loadCandidates()
  }

  function closePicker() {
    setPicking(false)
    setChosen(null)
    setError(null)
  }

  async function confirmMerge() {
    if (!chosen || merging) return
    setMerging(true)
    setError(null)
    try {
      const result = await onMerge?.(chosen.id)
      // `stale` is the 409: somebody merged this ticket while the dialog was
      // open. The inbox has already refreshed, so the honest thing is to get
      // out of the way and let the re-read thread say what happened — the
      // dialog is arguing about a ticket that no longer exists in that state.
      if (result?.ok || result?.stale) {
        closePicker()
        return
      }
      setError(result?.error || 'Could not merge these tickets')
    } finally {
      setMerging(false)
    }
  }

  async function handleUndo() {
    if (undoing) return
    setUndoing(true)
    try {
      await onUnmerge?.()
    } finally {
      setUndoing(false)
    }
  }

  // ── Merged: the banner, instead of the action ─────────────────────
  // A tombstone can never be a merge source again — the route refuses chains so
  // the undo stays exact — so offering "Merge into…" here would be an action
  // whose only outcome is a 404.
  if (mergedIntoId) {
    return (
      <div
        data-testid="merge-banner"
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md bg-blue-500/10 px-3 py-2 text-xs text-blue-700"
        role="status"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Merge size={13} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            Merged into{' '}
            <span className="font-medium">
              {survivor?.subject || (survivor ? '(no subject)' : 'another ticket')}
            </span>
            . Its messages live there now.
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={ExternalLink}
            onClick={() => onOpenTicket?.(mergedIntoId)}
          >
            Open
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={Undo2}
            loading={undoing}
            onClick={handleUndo}
          >
            Undo
          </Button>
        </span>
      </div>
    )
  }

  // ── Not merged: the action, and the two-step dialog ───────────────
  const term = filter.trim().toLowerCase()
  const options = candidates
    .filter(t => t.id !== ticketId)
    .filter(t => !term
      || String(t.subject || '').toLowerCase().includes(term)
      || String(t.requester_email || '').toLowerCase().includes(term))

  const sourceMailbox = ticket?.mailbox || mailboxes.find(m => m.id === ticket?.mailbox_id) || null
  const targetMailbox = chosen ? mailboxes.find(m => m.id === chosen.mailbox_id) || null : null
  const crossMailbox = !!chosen && (chosen.mailbox_id ?? null) !== (ticket?.mailbox_id ?? null)

  return (
    <>
      <Button type="button" size="sm" variant="secondary" icon={Merge} onClick={openPicker}>
        Merge into…
      </Button>

      {picking && (
        <Modal
          open
          onClose={closePicker}
          title={chosen ? 'Merge these two tickets' : 'Pick the ticket this one belongs to'}
          size="lg"
          footer={
            chosen ? (
              <>
                <Button type="button" variant="secondary" onClick={() => setChosen(null)} disabled={merging}>
                  Back
                </Button>
                <Button type="button" variant="secondary" onClick={closePicker} disabled={merging}>
                  Cancel
                </Button>
                {/* Not `danger`: this is reversible by design, and dressing a
                    reversible act in the colour reserved for deletion is how
                    the colour stops meaning anything. */}
                <Button type="button" variant="primary" icon={Merge} loading={merging} onClick={confirmMerge}>
                  Merge
                </Button>
              </>
            ) : (
              <Button type="button" variant="secondary" onClick={closePicker}>
                Cancel
              </Button>
            )
          }
        >
          {/* tabIndex -1 so the step can RECEIVE focus without entering the tab
              order — see the stepRef effect above. */}
          <div ref={stepRef} tabIndex={-1} className="outline-none">
            {chosen ? (
              <ConfirmStep
                source={ticket}
                target={chosen}
                messageCount={messageCount}
                crossMailbox={crossMailbox}
                sourceMailbox={sourceMailbox}
                targetMailbox={targetMailbox}
                error={error}
              />
            ) : (
              <PickStep
                options={options}
                loading={loadingList}
                error={listError}
                filter={filter}
                onFilter={setFilter}
                onPick={setChosen}
                mailboxes={mailboxes}
                showMailbox={mailboxes.length > 1}
              />
            )}
          </div>
        </Modal>
      )}
    </>
  )
}

/** Step one: which conversation is this one really part of? */
function PickStep({ options, loading, error, filter, onFilter, onPick, mailboxes, showMailbox }) {
  const mailboxById = Object.fromEntries((mailboxes || []).map(m => [m.id, m]))

  return (
    <div className="space-y-3">
      <p className="text-xs text-un1t-subtle">
        Open and pending tickets at this studio. The one you pick SURVIVES — this ticket&rsquo;s
        messages move onto it.
      </p>

      <Field id="ticket-merge-filter" label="Find a ticket">
        {(p) => (
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-un1t-subtle"
              aria-hidden="true"
            />
            <input
              {...p}
              type="search"
              value={filter}
              onChange={(e) => onFilter(e.target.value)}
              placeholder="Subject or email address…"
              className={`${INPUT_CLASSES} pl-8`}
            />
          </div>
        )}
      </Field>

      {error && (
        <p className="flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-700" role="alert">
          <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {loading ? (
        <p className="py-6 text-center text-xs text-un1t-muted">Loading the other tickets…</p>
      ) : options.length === 0 ? (
        <p className="py-6 text-center text-xs text-un1t-muted">
          {error
            ? 'No tickets to show.'
            : filter
              ? 'No open ticket here matches that.'
              : 'There is no other open ticket at this studio to merge into.'}
        </p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {options.map(t => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onPick(t)}
                className="flex w-full items-center gap-2 rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-left transition-colors hover:border-un1t-text/30"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-un1t-text">
                    {t.subject || '(no subject)'}
                  </span>
                  <span className="block truncate text-[11px] text-un1t-muted">
                    {requesterLabel(t)}
                    {showMailbox && ` · ${mailboxLabel(mailboxById[t.mailbox_id])}`}
                  </span>
                </span>
                <ArrowRight size={13} className="shrink-0 text-un1t-subtle" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Step two: what is about to happen, in the fewest words that are still exact.
 *
 * The two tickets are LABELLED rather than described in a sentence whose word
 * order carries the meaning. "Merge A into B" is a sentence an operator can
 * read the wrong way round when both subjects look alike — which is the whole
 * situation that produces a duplicate in the first place.
 */
function ConfirmStep({ source, target, messageCount, crossMailbox, sourceMailbox, targetMailbox, error }) {
  const moving = messagesPhrase(messageCount)

  return (
    <div className="space-y-3">
      <p className="text-sm text-un1t-text">
        This moves <span className="font-medium">{moving}</span> onto another ticket.
      </p>

      <div className="space-y-2">
        <div
          data-testid="merge-disappears"
          className="rounded-md border border-un1t-border bg-un1t-surface px-3 py-2"
        >
          <p className="text-[11px] font-medium uppercase tracking-wider text-amber-700">
            Goes away
          </p>
          <p className="mt-0.5 truncate text-sm text-un1t-text">
            {source?.subject || '(no subject)'}
          </p>
          {/* The count is stated once, above, and deliberately not repeated
              here: "Its 1 message move off it" and "Its this ticket's messages
              move off it" are both what interpolating it produces. */}
          <p className="mt-0.5 text-[11px] text-un1t-muted">
            The one you are reading. Its messages move off it, it closes, and it leaves the queue.
          </p>
        </div>

        <div
          data-testid="merge-survives"
          className="rounded-md border border-un1t-border bg-un1t-surface px-3 py-2"
        >
          <p className="text-[11px] font-medium uppercase tracking-wider text-green-700">
            Survives
          </p>
          <p className="mt-0.5 truncate text-sm text-un1t-text">
            {target?.subject || '(no subject)'}
          </p>
          <p className="mt-0.5 text-[11px] text-un1t-muted">
            It keeps the whole conversation, and the next reply comes back to it.
          </p>
        </div>
      </div>

      {/* THE ACCESS CHANGE, said plainly and only when it is true. See the file
          header: mig 502 keys message RLS on the ticket's mailbox, so moving
          correspondence across mailboxes hands it to a different set of people.
          Not a refusal — the merge stays available underneath it. */}
      {crossMailbox && (
        <p
          data-testid="merge-mailbox-warning"
          className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700"
          role="alert"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          {targetMailbox ? (
            <span>
              These two tickets are on different email accounts. This correspondence arrived at{' '}
              <span className="font-medium">
                {mailboxLabel(sourceMailbox)}
                {sourceMailbox?.address ? ` (${sourceMailbox.address})` : ''}
              </span>
              , and merging files it under{' '}
              <span className="font-medium">
                {mailboxLabel(targetMailbox)}
                {targetMailbox.address ? ` (${targetMailbox.address})` : ''}
              </span>
              {' '}— so everyone with access to {mailboxLabel(targetMailbox)} will be able to read
              these messages.
            </span>
          ) : (
            // The target has no mailbox we can name (mailbox_id is ON DELETE
            // SET NULL, and such a ticket is visible to owners only). Access
            // there is narrower, not wider, so the copy says what changed
            // without claiming a widening that is not happening.
            <span>
              These two tickets are on different email accounts, so who can reach this
              correspondence changes once it moves.
            </span>
          )}
        </p>
      )}

      <p className="text-[11px] text-un1t-muted">
        You can undo this afterwards — the merged ticket keeps an Undo button.
      </p>

      {error && (
        <p className="flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-700" role="alert">
          <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  )
}
