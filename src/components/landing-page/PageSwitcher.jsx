'use client'

// PageSwitcher — top-of-editor dropdown that chooses WHICH public page
// /settings/landing-page is editing: the front-page split chooser, or
// any individual studio's marketing page. Navigates via a full load so
// the server re-resolves the selected page (and the right form mounts).

export default function PageSwitcher({ current, studios = [] }) {
  function onChange(e) {
    const v = e.target.value
    if (v === 'chooser') window.location.href = '/settings/landing-page?page=chooser'
    else window.location.href = `/settings/landing-page?location_id=${v}`
  }
  // Only worth showing when there's more than one destination.
  if (studios.length === 0) return null
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-un1t-subtle">
      <span className="uppercase tracking-wider">Editing</span>
      <select
        value={current}
        onChange={onChange}
        className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-xs text-un1t-text"
      >
        <option value="chooser">Front page (un1tdublin.com)</option>
        {studios.map((s) => (
          <option key={s.location_id} value={s.location_id}>{s.name}</option>
        ))}
      </select>
    </label>
  )
}
