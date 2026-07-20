// PersonHeader.jsx — PERSON-LINK.1
//
// Presentational header strip for the unified person profile.
// No interactivity — RSC-compatible, no 'use client' needed.
//
// Props:
//   name        — display name of the primary contact
//   stageSlug   — pipeline_stage_slug (optional; renders a pill when set)
//   linkedCount — number of linked accounts (shows chip only when > 1)
//   children    — actions slot (rendered right-aligned in the header)

import { initials } from '@/lib/person-view'

// Pipeline-stage pill styles — mirrors the -700 text ramp convention
// (CLAUDE.md: "text on light cards needs the -700 ramp").
// Keyed on pipeline_stage_slug (FUNNEL.1 taxonomy).
const STAGE_PILL = {
  new_lead:     'bg-blue-500/10 text-blue-700',
  first_class:  'bg-emerald-500/10 text-emerald-700',
  second_class: 'bg-teal-500/10 text-teal-700',
  trial_done:   'bg-amber-500/10 text-amber-700',
  converted:    'bg-emerald-500/10 text-emerald-700',
  member:       'bg-slate-500/10 text-slate-700',
  pack_member:  'bg-cyan-500/10 text-cyan-700',
  classpass:    'bg-purple-500/10 text-purple-700',
  gympass:      'bg-orange-500/10 text-orange-700',
  cold_lead:    'bg-zinc-500/10 text-zinc-700',
  dormant:      'bg-slate-500/10 text-slate-700',
}
const STAGE_PILL_DEFAULT = 'bg-slate-500/10 text-slate-700'

function formatStageSlug(slug) {
  return slug ? slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : ''
}

export default function PersonHeader({ name, stageSlug, linkedCount, children }) {
  const abbr = initials(name)
  const stageCls = stageSlug ? (STAGE_PILL[stageSlug] || STAGE_PILL_DEFAULT) : null

  return (
    <div className="flex items-center gap-4">
      {/* Avatar circle */}
      <div
        aria-hidden="true"
        className="flex-none h-12 w-12 rounded-full bg-un1t-text/[0.08] flex items-center justify-center text-base font-semibold text-un1t-text"
      >
        {abbr}
      </div>

      {/* Name + meta chips */}
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold text-un1t-text truncate">
          {name || '—'}
        </h2>
        <div className="flex flex-wrap items-center gap-2 mt-0.5">
          {stageCls && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${stageCls}`}>
              {formatStageSlug(stageSlug)}
            </span>
          )}
          {linkedCount > 1 && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-700">
              {linkedCount} linked accounts
            </span>
          )}
        </div>
      </div>

      {/* Actions slot — right-aligned */}
      {children && (
        <div className="flex-none flex items-center gap-2">
          {children}
        </div>
      )}
    </div>
  )
}
