// PAGES.1 — the three small input helpers of the landing page editor, shared
// by LandingPageSettingsForm and the studio offer rows. Presentational only.
// `ariaLabel` names a control whose Field label is not tied to it.

export function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-sm text-un1t-subtle mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-un1t-muted mt-1">{hint}</p>}
    </div>
  )
}

export function Input({ value, onChange, maxLength, placeholder, ariaLabel }) {
  return (
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
    />
  )
}

export function Textarea({ value, onChange, maxLength, rows, placeholder, ariaLabel }) {
  return (
    <textarea
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      maxLength={maxLength}
      rows={rows || 2}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text resize-y"
    />
  )
}
