'use client'

// ResendSettings — "resend to people who don't open" for a marketing email
// (CAMPAIGN-RESEND), shared by the quick composer and the full campaign editor
// (EDITORRESEND.1). Controlled: `value` is { enabled, waitHours, subject } and
// every change comes back through onChange with the whole value.
import { Clock, AlertTriangle } from 'lucide-react'

const fieldCls =
  'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-subtle/60 focus:outline-none focus:ring-1 focus:ring-un1t-text/30'

/** The wait is valid when resend is off, or between 1 and 168 hours. */
export function resendWaitValid({ enabled, waitHours }) {
  return !enabled || (Number(waitHours) >= 1 && Number(waitHours) <= 168)
}

function WaitPill({ active, onClick, label }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
        active ? 'border-un1t-text/30 bg-un1t-text/[0.04] text-un1t-text font-medium' : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'}`}>
      <Clock size={15} />{label}
    </button>
  )
}

export default function ResendSettings({ value, onChange, originalSubject = '' }) {
  const { enabled, waitHours, subject } = value
  const set = (patch) => onChange({ ...value, ...patch })
  return (
    <div>
      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input type="checkbox" className="mt-0.5 accent-un1t-text"
          checked={enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span className="text-sm text-un1t-text">
          Resend to people who don&apos;t open
          <span className="block text-[11px] text-un1t-subtle mt-0.5">Unsubscribes, bounces and suppressions between the two sends are respected automatically.</span>
        </span>
      </label>
      {enabled && (
        <div className="mt-3 space-y-3">
          <div>
            <span className="block text-xs font-medium text-un1t-subtle mb-1">Wait before resending</span>
            <div className="flex items-center gap-2">
              {[24, 48, 72].map((h) => (
                <WaitPill key={h} active={Number(waitHours) === h} onClick={() => set({ waitHours: h })} label={`${h}h`} />
              ))}
              <input type="number" min={1} max={168} aria-label="Hours to wait before resending" className={`${fieldCls} w-24`}
                value={waitHours} onChange={(e) => set({ waitHours: e.target.value })} />
              <span className="text-xs text-un1t-subtle">hours</span>
            </div>
            {Number(waitHours) >= 1 && Number(waitHours) < 24 && (
              <p className="mt-1 text-xs text-amber-700 flex items-start gap-1.5">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                Opens are still arriving — resending this early reaches people who just haven&apos;t got to it yet.
              </p>
            )}
            {!resendWaitValid(value) && (
              <p className="mt-1 text-[11px] text-rose-700">Pick a wait between 1 and 168 hours.</p>
            )}
          </div>
          <label className="block">
            <span className="block text-xs font-medium text-un1t-subtle mb-1">New subject <span className="text-un1t-subtle/60">(optional)</span></span>
            <input className={fieldCls} value={subject} maxLength={500}
              onChange={(e) => set({ subject: e.target.value })} placeholder={originalSubject || 'Reuses the original subject if left blank'} />
            <span className="block text-[11px] text-un1t-subtle mt-1">The subject the resend goes out with. Leave blank to reuse the original.</span>
          </label>
          <p className="text-[11px] text-un1t-subtle">Open counts undercount slightly — some inboxes preload images, so a few real openers still look unopened and the odd non-opener looks opened.</p>
        </div>
      )}
    </div>
  )
}
