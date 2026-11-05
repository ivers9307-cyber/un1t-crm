'use client'

// MIASETTINGS.2c — the Mia settings page's section menu: a list on the left
// from 768px up, a select above the content below that. Both drive the same
// section. It only changes what you see, so it sits outside the page's
// disabled <fieldset> and a read-only viewer can still move around (Review
// Focus 1). The foot links leave the page: Activity, Requests and the
// channel connections in the Integrations hub.
//   sections  [{ key, label }] in menu order
//   active    the open section's key
//   onSelect  (key) => void
//   links     [{ href, label }]
//   dirtySections  Set of section keys with unsaved changes (a dot on each)
//   counts    { [sectionKey]: number } shown after the label (not part of its name)
//   dirty     any unsaved change: the foot links then ask before leaving

import GuardedLink from './GuardedLink'

export default function SectionMenu({ sections, active, onSelect, links = [], dirtySections = new Set(), dirty = false, counts = {} }) {
  return (
    <nav aria-label="Customer agent settings" className="mb-6 md:mb-0">
      <div className="md:hidden">
        <select aria-label="Section" value={active} onChange={(e) => onSelect(e.target.value)}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text">
          {sections.map((s) => <option key={s.key} value={s.key}>{s.label}{counts[s.key] != null ? ` (${counts[s.key]})` : ''}{dirtySections.has(s.key) ? ' (unsaved)' : ''}</option>)}
        </select>
      </div>
      <ul className="hidden md:block space-y-0.5">
        {sections.map((s) => {
          const on = s.key === active
          return (
            <li key={s.key} className="relative">
              <button type="button" onClick={() => onSelect(s.key)} aria-current={on ? 'page' : undefined}
                className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors ${on
                  ? 'bg-un1t-surface border border-un1t-border font-medium text-un1t-text'
                  : 'border border-transparent text-un1t-muted hover:text-un1t-text hover:bg-un1t-surface'}`}>
                {s.label}
              </button>
              {counts[s.key] != null && (
                <span aria-hidden="true"
                  className="pointer-events-none absolute right-7 top-1/2 -translate-y-1/2 text-xs text-un1t-muted">
                  {counts[s.key]}
                </span>
              )}
              {/* Beside the button, not in it, so the item's name stays its label. */}
              {dirtySections.has(s.key) && (
                <span role="img" aria-label="Unsaved changes"
                  className="pointer-events-none absolute right-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-amber-500" />
              )}
            </li>
          )
        })}
      </ul>
      {links.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-3 md:block md:mt-4 md:pt-4 md:border-t md:border-un1t-border md:space-y-1">
          {links.map((l) => (
            <li key={l.href}>
              <GuardedLink href={l.href} dirty={dirty} className="inline-block text-sm text-un1t-muted hover:text-un1t-text md:px-3 md:py-1">
                {l.label}
              </GuardedLink>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}
