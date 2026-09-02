'use client'

// MAIL-DOCK.2 — the card a new email is written in.
//
// THIN ON PURPOSE, exactly like MailDock: every branchable decision — which
// modes persist, what Esc does while dirty, who yields the bottom-right slot
// — lives in mail-display.js where it is unit-tested; MailSurface owns the
// state and TicketCompose owns the fields and the send. This file is the
// pixels: the same dark title bar, the same control set and geometry as the
// reader's card, wrapped around TicketCompose's form.
//
// THREE MODES, ONE CARD (MAIL-DOCK.1's vocabulary, verbatim):
//   dock — bottom-right of the Mail pane, the list still working underneath.
//   full — the SAME card at the near-fullscreen takeover (`fixed inset-4`),
//          body centred at the reading measure.
//   min  — only the title bar. The FORM STAYS MOUNTED (the typed draft is
//          the whole reason min exists) — hidden, never removed.
//
// WHERE IT DIVERGES FROM MailDock, AND WHY:
//   • ESC IS HANDLED HERE, SCOPED. Esc from inside the compose fields IS the
//     minimise gesture (Gmail's behaviour), so the card carries its own
//     keydown and stops propagation — the surface's window listener (whose
//     Esc ladder belongs to the READER) never sees it. The ladder itself is
//     the caller's (dirty lives in TicketCompose); this file only routes.
//   • THE TITLE BAR IS ALWAYS VISIBLE, not hidden below md. MailDock hides
//     its bar there because the thread has its own mobile header; this form
//     has no other chrome. A mobile OPEN never reaches this component at all
//     (below md MailSurface renders the Modal composer, byte-for-byte) — the
//     below-md classes here are only the safety net for a desktop window
//     resized mid-draft, where remounting into the Modal would cost the
//     words. That safety net is a full-screen card.
//   • ONE SLOT, TWO OCCUPANTS. `readerOccupancy` ('none'|'bar'|'card') says
//     what the reader currently shows as, so the compose BAR can stack to
//     the LEFT of it; the compose CARD always owns right-4 (the reader's bar
//     shifts instead — MailDock's `shifted`).

import { Minus, Maximize2, Minimize2, X } from 'lucide-react'
import { COMPOSE_MODE_MIN, composeCardTitle } from './mail-display'

// The card per mode. Base classes are the resize safety net (a full-screen
// card); everything dock-shaped is md:-prefixed, mirroring MailDock's map.
const CONTAINER = {
  dock: 'fixed inset-0 z-50 flex flex-col bg-un1t-bg md:absolute md:inset-auto md:bottom-0 md:right-4 md:z-30 md:h-[78vh] md:max-h-[calc(100%-0.5rem)] md:w-[min(560px,calc(100vw-2rem))] md:overflow-hidden md:rounded-t-xl md:border md:border-b-0 md:border-un1t-border md:shadow-2xl',
  full: 'fixed inset-0 z-50 flex flex-col bg-un1t-bg md:inset-4 md:overflow-hidden md:rounded-xl md:border md:border-un1t-border md:shadow-2xl',
}

// The minimised bar, positioned around whatever the READER currently shows
// as: right-4 when the corner is free (or the reader is the full-screen
// overlay, which holds no corner), left of the reader's 360px bar, left of
// its 560px docked card. Full literal strings so Tailwind's scanner sees
// every class; the widths are MailDock's own, quoted not derived.
// Audit F5 — below md the min shape is a BOTTOM BAR, never the full-sheet
// safety net (dock/full degrade to a full-screen FORM, which makes sense;
// a minimised card's body is hidden, so a full sheet was an opaque blank
// page with a title bar). The bar keeps the whole-bar restore target.
const MIN_BY_READER = {
  none: 'fixed bottom-0 inset-x-0 z-50 flex flex-col bg-un1t-bg border-t border-un1t-border md:absolute md:inset-auto md:bottom-0 md:right-4 md:z-30 md:h-auto md:w-[min(360px,calc(100vw-2rem))] md:overflow-hidden md:rounded-t-xl md:border md:border-b-0 md:border-un1t-border md:shadow-2xl',
  bar: 'fixed bottom-0 inset-x-0 z-50 flex flex-col bg-un1t-bg border-t border-un1t-border md:absolute md:inset-auto md:bottom-0 md:right-[calc(1.5rem+min(360px,calc(100vw-2rem)))] md:z-30 md:h-auto md:w-[min(360px,calc(100vw-2rem))] md:overflow-hidden md:rounded-t-xl md:border md:border-b-0 md:border-un1t-border md:shadow-2xl',
  card: 'fixed bottom-0 inset-x-0 z-50 flex flex-col bg-un1t-bg border-t border-un1t-border md:absolute md:inset-auto md:bottom-0 md:right-[calc(1.5rem+min(560px,calc(100vw-2rem)))] md:z-30 md:h-auto md:w-[min(360px,calc(100vw-2rem))] md:overflow-hidden md:rounded-t-xl md:border md:border-b-0 md:border-un1t-border md:shadow-2xl',
}

export default function ComposeDock({
  mode = 'dock',
  subject,
  readerOccupancy = 'none',
  onMinimise,   // ─ while open
  onRestore,    // the bar (or ─ again) while minimised
  onExpand,     // ⤢ dock → full
  onContract,   // ⤡ full → dock
  onClose,      // ✕ — requestClose (TicketCompose's own dirty-confirm)
  onEscape,     // the dirty-aware ladder — the caller decides, this routes
  footer,       // the submit row, moved inside the card bottom
  children,     // TicketCompose's form
}) {
  const min = mode === COMPOSE_MODE_MIN
  const full = mode === 'full'

  const container = min
    ? (MIN_BY_READER[readerOccupancy] || MIN_BY_READER.none)
    : (CONTAINER[mode] || CONTAINER.dock)

  // Same icon-button recipe as MailDock — the bar is the house ink, so the
  // hover is a light wash.
  const control = 'shrink-0 rounded p-1 text-un1t-bg/80 transition-colors hover:bg-un1t-bg/15 hover:text-un1t-bg'

  return (
    <section
      aria-label="New email"
      data-compose-mode={mode}
      className={container}
      // 🔴 Esc from inside the compose card is the MINIMISE gesture, not the
      // reader's dismissal — stopPropagation is what keeps the surface's
      // window listener (and its reader Esc ladder) from ever seeing it.
      // Scoped here rather than on window so an Esc pressed with focus
      // OUTSIDE the card changes nothing about a draft it was not aimed at.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        // Audit F4 — an Esc cancelling an IME composition (CJK input) is not
        // a dismissal; yanking the card to its bar mid-word is jarring.
        if (e.isComposing || e.keyCode === 229) return
        e.stopPropagation()
        onEscape?.()
      }}
    >
      {/* The dark title bar — MAIL-DOCK.1's exact vocabulary. While minimised
          the WHOLE bar is a restore target, with the controls stopping the
          bubble so ✕ stays a close; ─ doubles as the keyboard-reachable
          restore, same as the reader's bar. */}
      <div
        onClick={min ? onRestore : undefined}
        className={`flex shrink-0 items-center gap-2 bg-un1t-text px-3 py-2 text-un1t-bg ${min ? 'cursor-pointer' : ''}`}
      >
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {composeCardTitle(subject)}
        </span>
        <button
          type="button"
          aria-label={min ? 'Restore the email' : 'Minimise the email'}
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
          aria-label="Close the email"
          title="Close"
          onClick={(e) => { e.stopPropagation(); onClose?.() }}
          className={control}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      {/* The form. Minimised = hidden, NOT unmounted — the typed draft is the
          whole reason the bar exists. `hidden` (not md:hidden): a minimised
          compose has no below-md life to preserve, unlike the reader's
          mobile pane. Full mode centres the column at the reading measure. */}
      <div
        className={`${min ? 'hidden ' : ''}flex min-h-0 w-full flex-1 flex-col${full ? ' md:mx-auto md:w-full md:max-w-[680px]' : ''}`}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {children}
        </div>
        {/* The submit footer, inside the card bottom — the Modal's sibling
            footer has no Modal to live in here. */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-un1t-border px-4 py-3">
          {footer}
        </div>
      </div>
    </section>
  )
}
