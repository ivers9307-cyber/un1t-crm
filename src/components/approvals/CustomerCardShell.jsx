'use client'

// APPROVALSQ.1 — the one card layout every customer item on /approvals uses
// (paid trial, corporate promo, offer sale, and the agent request card later).
// Layout, top to bottom: header row, summary, children (the why line, warnings,
// lists), contact, links, outcome, then one button row: actions on the left,
// quietAction pushed to the right end. No <form>: every button is type="button".

const STATE_TONES = {
  red: 'bg-red-500/10 text-red-700',
  amber: 'bg-amber-500/10 text-amber-700',
  neutral: 'bg-un1t-border/30 text-un1t-subtle border border-un1t-border',
}

const OUTCOME_TONES = {
  ok: 'bg-green-500/10 text-green-700',
  bad: 'bg-red-500/10 text-red-700',
  neutral: 'bg-un1t-border/30 text-un1t-subtle',
}

const CHIP = 'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded'

export default function CustomerCardShell({
  source, kind, state, name, meta, when, amount,
  summary, children, contact, links, outcome, actions, quietAction, error,
}) {
  return (
    <div className="border border-un1t-border rounded-lg p-4 bg-un1t-surface space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex items-center gap-2 flex-wrap">
          {source && <span className={`${CHIP} bg-un1t-border/30 text-un1t-text border border-un1t-border`}>{source}</span>}
          {kind && <span className={`${CHIP} bg-un1t-border/30 text-un1t-subtle border border-un1t-border`}>{kind}</span>}
          {state && <span className={`${CHIP} ${STATE_TONES[state.tone] || STATE_TONES.neutral}`}>{state.label}</span>}
          <span className="text-sm font-semibold text-un1t-text">{name}</span>
          {meta && <span className={`${CHIP} bg-un1t-border/30 text-un1t-subtle border border-un1t-border`}>{meta}</span>}
        </div>
        <div className="text-right">
          {amount && <div className="text-sm font-medium text-un1t-text tabular-nums">{amount}</div>}
          {when && <div className="text-xs text-un1t-subtle">{when}</div>}
        </div>
      </div>

      {summary && <div className="text-xs text-un1t-subtle">{summary}</div>}
      {children}
      {contact && <div className="text-xs text-un1t-subtle flex flex-wrap gap-x-4 gap-y-1">{contact}</div>}
      {links && <div className="text-xs flex flex-wrap gap-x-4 gap-y-1">{links}</div>}

      {outcome && (
        <div className={`text-sm rounded-md px-3 py-2 ${OUTCOME_TONES[outcome.tone] || OUTCOME_TONES.neutral}`}>
          {outcome.text}
        </div>
      )}
      {error && <div className="text-sm rounded-md px-3 py-2 bg-red-500/10 text-red-700">{error}</div>}

      {(actions || quietAction) && (
        <div className="flex gap-2 flex-wrap items-center">
          {actions}
          {quietAction && <div className="ml-auto">{quietAction}</div>}
        </div>
      )}
    </div>
  )
}
