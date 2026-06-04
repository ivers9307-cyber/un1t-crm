'use client'
// Bottom-bar planner (MOBILE-LAYOUT.6). Edits permissions.mobile.layout for
// one assignment: which bar-eligible features fill the 3 slots (ordered) and
// which are "allowed" for the staff member to swap in later (Phase 2). No
// drag-drop dependency — 3 slot selects + allowed checkboxes.
import {
  MOBILE_NAV_FEATURES, DEFAULT_MOBILE_LAYOUT,
} from '@shared/mobile-nav'

const BAR_ELIGIBLE_FEATURES = MOBILE_NAV_FEATURES.filter(f => f.barEligible)

function templateFor(role, employmentType) {
  const r = DEFAULT_MOBILE_LAYOUT[role] || DEFAULT_MOBILE_LAYOUT.staff
  return r[employmentType] || r.fte
}

/**
 * @param {object} props
 * @param {string} props.role            selected assignment's role
 * @param {string} props.employmentType  'fte' | 'contractor'
 * @param {{bar?:string[], allowed?:string[]}|null} props.value  current override (or null)
 * @param {(layout: {bar:string[], allowed:string[]} | null) => void} props.onChange
 */
export default function MobileBarPlanner({ role, employmentType, value, onChange }) {
  // Candidate features for THIS person: bar-eligible, employment-appropriate.
  const candidates = BAR_ELIGIBLE_FEATURES.filter(
    f => !f.employmentType || f.employmentType === employmentType
  )

  const effective = value && Array.isArray(value.bar) ? value : templateFor(role, employmentType)
  const bar = [effective.bar[0] || '', effective.bar[1] || '', effective.bar[2] || '']
  const allowed = new Set(
    (effective.allowed || []).filter(k => candidates.some(c => c.key === k))
  )
  const isOverride = Boolean(value && Array.isArray(value.bar))

  function emit(nextBarArr, nextAllowedSet) {
    const cleanBar = nextBarArr.filter(Boolean).filter((k, i, a) => a.indexOf(k) === i)
    // Bar items are always allowed.
    const cleanAllowed = [...new Set([...nextAllowedSet, ...cleanBar])]
    onChange({ bar: cleanBar, allowed: cleanAllowed })
  }

  function setSlot(i, key) {
    const next = [...bar]
    next[i] = key
    // a key can only occupy one slot
    for (let j = 0; j < next.length; j++) if (j !== i && next[j] === key) next[j] = ''
    emit(next, allowed)
  }

  function toggleAllowed(key) {
    const next = new Set(allowed)
    if (next.has(key)) next.delete(key); else next.add(key)
    emit(bar, next)
  }

  return (
    <div className="mt-4 pt-4 border-t border-un1t-border">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Bottom-bar layout</h4>
        {isOverride && (
          <button type="button" onClick={() => onChange(null)} className="text-xs text-blue-400 hover:text-blue-300">
            Reset to role default
          </button>
        )}
      </div>
      <p className="text-xs text-un1t-subtle mb-3">
        Home and More are fixed. Pick up to 3 features for the bar (in order); only enabled features appear on the phone.
      </p>

      <div className="grid grid-cols-3 gap-2 mb-3">
        {[0, 1, 2].map(i => (
          <label key={i} className="text-xs text-un1t-subtle">
            Slot {i + 1}
            <select
              value={bar[i]}
              onChange={e => setSlot(i, e.target.value)}
              className="mt-1 w-full bg-un1t-surface border border-un1t-border rounded-md px-2 py-1.5 text-sm text-un1t-text"
            >
              <option value="">— empty —</option>
              {candidates.map(f => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <p className="text-xs text-un1t-subtle mb-1.5">Allowed for the bar (staff can swap these in — Phase 2):</p>
      <div className="flex flex-wrap gap-2">
        {candidates.map(f => (
          <label key={f.key} className="flex items-center gap-1.5 text-sm text-un1t-text bg-un1t-surface border border-un1t-border rounded-md px-2 py-1">
            <input type="checkbox" checked={allowed.has(f.key)} onChange={() => toggleAllowed(f.key)} />
            {f.label}
          </label>
        ))}
      </div>
    </div>
  )
}
