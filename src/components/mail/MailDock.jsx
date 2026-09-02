'use client'

// MAIL-DOCK.1 — the card a selected conversation lives in.
//
// THIN ON PURPOSE. Every branchable decision — which modes persist, what Esc
// does, where min restores to, how the frames size — lives in mail-display.js
// where it is unit-tested; MailSurface owns the state and the keyboard. This
// file is the pixels: a container whose shape follows `mode`, and a dark
// title bar with three controls. It never fetches, never navigates and holds
// no state of its own.
//
// THREE MODES, ONE CARD (the approved mockup, D + A as a pair):
//   dock — bottom-right of the Mail pane, list still working underneath.
//   full — the SAME card at near-fullscreen (`fixed inset-4`); the body
//          column is centred at reading measure (~680px, mockup A).
//   min  — only the title bar. The children STAY MOUNTED (polls keep
//          running; an arriving message must not restore the card) — they are
//          hidden, not removed.
//
// MOBILE IS UNTOUCHED: below `md` this renders as the plain full-pane thread
// it always was (TicketThread's own back arrow is already md:hidden), the
// title bar does not exist, and none of the dock modes apply — `min` set on a
// desktop that was then narrowed degrades to the visible pane rather than to
// a vanished conversation.

import { Minus, Maximize2, Minimize2, X } from 'lucide-react'
import { READER_MODE_MIN } from './mail-display'

// The container per mode. Base classes are the MOBILE pane (a plain flex
// child of the surface's row); everything dock-shaped is md:-prefixed.
const CONTAINER = {
  // Width 1120px (Richard, 2 Sep: "twice the width") — wide enough to read
  // real HTML mail without the inner scroll dominating; still leaves the
  // list visible on a 27" screen, and the viewport clamp owns laptops.
  dock: 'flex w-full min-w-0 flex-1 flex-col bg-un1t-bg md:absolute md:bottom-0 md:right-4 md:z-30 md:h-[78vh] md:max-h-[calc(100%-0.5rem)] md:w-[min(1120px,calc(100vw-2rem))] md:flex-none md:overflow-hidden md:rounded-t-xl md:border md:border-b-0 md:border-un1t-border md:shadow-2xl',
  full: 'flex w-full min-w-0 flex-1 flex-col bg-un1t-bg md:fixed md:inset-4 md:z-50 md:h-auto md:w-auto md:flex-none md:overflow-hidden md:rounded-xl md:border md:border-un1t-border md:shadow-2xl',
  min: 'flex w-full min-w-0 flex-1 flex-col bg-un1t-bg md:absolute md:bottom-0 md:right-4 md:z-30 md:h-auto md:w-[min(360px,calc(100vw-2rem))] md:flex-none md:overflow-hidden md:rounded-t-xl md:border md:border-b-0 md:border-un1t-border md:shadow-2xl',
  // MAIL-DOCK.2 — the same bar, stepped LEFT of the compose CARD (which owns
  // right-4 while it is a card, at the reader card's own 1120px measure). Only
  // `min` ever shifts: the reader's dock/full cards cannot coexist with a
  // compose card (one bottom-right slot — MailSurface auto-minimises one
  // before the other opens).
  minShifted: 'flex w-full min-w-0 flex-1 flex-col bg-un1t-bg md:absolute md:bottom-0 md:right-[calc(1.5rem+min(1120px,calc(100vw-2rem)))] md:z-30 md:h-auto md:w-[min(360px,calc(100vw-2rem))] md:flex-none md:overflow-hidden md:rounded-t-xl md:border md:border-b-0 md:border-un1t-border md:shadow-2xl',
}

export default function MailDock({
  mode = 'dock',
  shifted = false, // MAIL-DOCK.2 — a compose CARD holds right-4; the min bar steps left
  subject,
  needsReply = false,
  onMinimise,   // ─ while open
  onRestore,    // the bar (or ─ again) while minimised
  onExpand,     // ⤢ dock → full
  onContract,   // ⤡ full → dock
  onClose,      // ✕ — clearSelection
  children,
}) {
  const min = mode === READER_MODE_MIN
  const full = mode === 'full'

  // Icon-only buttons share one recipe; the bar is the house ink
  // (bg-un1t-text text-un1t-bg per the contract), so the hover is a light wash.
  const control = 'shrink-0 rounded p-1 text-un1t-bg/80 transition-colors hover:bg-un1t-bg/15 hover:text-un1t-bg'

  return (
    <section
      aria-label="Conversation"
      data-reader-mode={mode}
      className={(min && shifted ? CONTAINER.minShifted : CONTAINER[mode]) || CONTAINER.dock}
    >
      {/* The dark title bar — md+ only; mobile keeps the thread's own header
          and back arrow. While minimised the WHOLE bar is a restore target
          (the mockup's gesture), with the controls stopping the bubble so ✕
          stays a close. A div-with-onClick is not keyboard-reachable, which
          is why ─ doubles as the accessible restore. */}
      <div
        onClick={min ? onRestore : undefined}
        className={`hidden shrink-0 items-center gap-2 bg-un1t-text px-3 py-2 text-un1t-bg md:flex ${min ? 'cursor-pointer' : ''}`}
      >
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {subject || '(no subject)'}
        </span>
        {/* The dark bar's chip: the mockup's translucent amber. text-amber-200
            rather than the mockup's -300 hex — the house chip lint (rightly)
            refuses a -300/-400 ramp beside a bg-*-500 tint because on a LIGHT
            card it is unreadable; on this ink bar the lighter -200 ramp is
            both compliant and higher-contrast. */}
        {needsReply && (
          <span className="shrink-0 rounded-full bg-amber-500/25 px-2 py-0.5 text-[10px] font-medium text-amber-200">
            Needs reply
          </span>
        )}
        <button
          type="button"
          aria-label={min ? 'Restore the conversation' : 'Minimise the conversation'}
          title={min ? 'Restore' : 'Minimise'}
          onClick={(e) => { e.stopPropagation(); (min ? onRestore : onMinimise)?.() }}
          className={control}
        >
          <Minus size={13} aria-hidden="true" />
        </button>
        {!min && (full ? (
          <button
            type="button"
            aria-label="Restore to docked size"
            title="Restore to docked size"
            onClick={onContract}
            className={control}
          >
            <Minimize2 size={13} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Expand to full screen"
            title="Expand to full screen"
            onClick={onExpand}
            className={control}
          >
            <Maximize2 size={13} aria-hidden="true" />
          </button>
        ))}
        <button
          type="button"
          aria-label="Close the conversation"
          title="Close"
          onClick={(e) => { e.stopPropagation(); onClose?.() }}
          className={control}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      {/* The thread. Minimised = hidden at md+, NOT unmounted — the polls and
          the composer's state survive; mobile never minimises so it stays
          visible there. Full mode centres the whole column at reading
          measure (mockup A's ~680px). */}
      <div
        className={`${min ? 'md:hidden ' : ''}flex min-h-0 w-full flex-1 flex-col${full ? ' md:mx-auto md:max-w-[680px]' : ''}`}
      >
        {children}
      </div>
    </section>
  )
}
