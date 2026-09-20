// src/components/schedule/ShiftCard.jsx
'use client'

// ROSTERLOOK.1 — one shift on the week view, drawn from shiftCardModel.
//
// NEUTRAL SURFACE. The card used to be filled with its template's colour at
// 12% alpha. Nearly every template is blue and the evening ones are pink-red,
// so the roster read as a wall of pastel with some cards apparently in error,
// and the amber/red that really does mean "needs a coach" had nothing to stand
// out against. Colour on this card now means staffing status and nothing else:
//   amber border + "1 of 2"            below the minimum
//   red DASHED border + "Needs coach"  nobody on it
// Dashed as well as red, so the two states differ in greyscale and for a
// red/green deficiency (ROSTER-FIX.6b). Both are manager-only, and that is
// enforced in the MODEL: a coach's model has `status: null`.
//
// TONE. `model.tone` comes from cardTone(), 'neutral' for every block today.
// Wave 2 adds 'admin' by returning it there and adding ONE line to
// TONE_SURFACE. The markup below does not change.
//
// CONTENT ORDER: time (one line) → who (body size) → what (small, muted, full
// name, with a title for when the column truncates it). The old order led with
// a template name truncated to "Morning 8…" and printed the coaches smallest.
//
// TOOLTIP. The button below is stretched OVER the card's text, so a `title`
// on the template label or a coach's name is never under the pointer. The
// container carries model.hoverTitle instead (template, range, full names,
// status in words); being an ancestor of the button it shows on hover without
// becoming part of the button's accessible name or description.
//
// 🔴 POSITIONING. The card is `relative` (the button stretches over it), and so
// is every inner element holding an sr-only span: sr-only is position:absolute
// and an unanchored one escapes the roster's horizontal scroller and widens
// the page on a phone. Do not drop those `relative`s.
//
// STRUCTURE (ROSTER-FIX.6b-7, kept): the card is a plain container; the click
// target is a real <button> stretched over it with a short name of its own, so
// the card's text stays separately browsable by a screen reader.

const TONE_SURFACE = {
  neutral: 'bg-un1t-bg',
}
const STATUS_BORDER = {
  short: 'border-amber-500/60',
  empty: 'border-dashed border-red-500/60',
}

export default function ShiftCard({ model, dayLabel, isMine = false, showHint = false, selectMode = false, isSelected = false, onActivate }) {
  const surface = TONE_SURFACE[model.tone] || TONE_SURFACE.neutral
  const border = model.status ? STATUS_BORDER[model.status.kind] : 'border-un1t-border'
  const cardLabel = `${model.shortLabel}, ${dayLabel}`

  return (
    <div
      data-testid="shift-card"
      data-tone={model.tone}
      data-status={model.status ? model.status.kind : 'ok'}
      title={model.hoverTitle}
      className={`relative group rounded-md border p-2 text-xs ${surface} ${border} hover:ring-1 hover:ring-un1t-subtle/40 ${isMine ? 'ring-1 ring-blue-400/50' : ''} ${isSelected ? 'ring-2 ring-amber-400 ring-offset-1 ring-offset-un1t-bg' : ''}`}
    >
      <button
        type="button"
        aria-pressed={selectMode ? isSelected : undefined}
        onClick={onActivate}
        className="absolute inset-0 z-10 w-full rounded-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent"
      >
        <span className="sr-only">{selectMode ? `Select ${cardLabel}` : `Manage ${cardLabel}`}</span>
      </button>

      {/* Line 1 — the time, never wrapping. */}
      <div data-testid="shift-time" className="whitespace-nowrap font-semibold tabular-nums text-un1t-text">
        {model.timeLabel}
      </div>

      {/* Who — body size, one per line. */}
      {model.coaches.length > 0 && (
        <ul data-testid="shift-coaches" className="mt-1 space-y-0.5">
          {model.coaches.map((c) => (
            <li key={c.id} className="flex items-center gap-1 text-sm leading-snug">
              <span className={`truncate ${c.isMe ? 'text-blue-700 font-medium' : 'text-un1t-text'}`} title={c.name}>{c.name}</span>
              {c.adjusted && (
                <span
                  data-testid="adjusted-marker"
                  className="relative shrink-0 rounded bg-amber-500/10 px-1 text-[10px] font-medium text-amber-700"
                  title={c.adjusted.title}
                >
                  <span aria-hidden="true">Adjusted</span>
                  <span className="sr-only"> {c.adjusted.srLabel}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {model.emptyText && (
        <div className="mt-1 text-sm italic text-un1t-subtle">{model.emptyText}</div>
      )}

      {/* Staffing — only when something is wrong, only for a manager (the
          model decides both). */}
      {model.status?.kind === 'empty' && (
        <div
          data-testid="needs-coach-badge"
          className="mt-1 inline-flex items-center rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-700"
          title={model.status.title}
        >
          {model.status.label}
        </div>
      )}
      {model.status?.kind === 'short' && (
        <div
          data-testid="short-staffed-badge"
          className="relative mt-1 inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
          title={model.status.title}
        >
          <span className="sr-only">{model.status.srPrefix}</span>
          {model.status.label}
        </div>
      )}

      {/* What — small and muted, but the FULL name, with a title for when the
          column still truncates it. un1t-subtle, not un1t-muted: this is small
          text and #94A3B8 on white is 2.6:1. */}
      <div data-testid="shift-template" className="mt-1 truncate text-[11px] text-un1t-subtle" title={model.templateName}>
        {model.templateName}
      </div>

      {showHint && (
        <div aria-hidden="true" className="mt-1 text-[10px] text-un1t-muted italic text-right opacity-0 group-hover:opacity-100 transition-opacity">
          Click to manage
        </div>
      )}
    </div>
  )
}
