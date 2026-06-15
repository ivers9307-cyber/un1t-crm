'use client'
// ContactDetailTabs.jsx — PERSON-LINK.1
//
// Minimal presentational tab switcher for the contact detail page.
// Uses the App Router "server components as props to a client component"
// pattern: the page renders each tab's content as a SERVER node and
// passes it in `tabs[].content`. This component owns only the active-tab
// state + the tab strip chrome — no data fetching, no business logic.
//
// Props:
//   tabs — Array<{ id: string, label: React.ReactNode, content: React.ReactNode }>
//          Order is preserved; the first tab is active by default.
//
// Every tab button is type="button" (this can render inside a form via
// nested components; a bare <button> would otherwise default to submit —
// see CLAUDE.md "Lessons learned").

import { useState } from 'react'

export default function ContactDetailTabs({ tabs }) {
  const list = Array.isArray(tabs) ? tabs.filter(Boolean) : []
  const [activeId, setActiveId] = useState(list[0]?.id ?? null)

  if (list.length === 0) return null

  // Fall back to the first tab if the active id no longer resolves (e.g.
  // a tab was conditionally removed between renders).
  const active = list.find((t) => t.id === activeId) || list[0]

  return (
    <div>
      {/* Tab strip */}
      <div
        role="tablist"
        aria-label="Contact sections"
        className="flex items-center gap-1 border-b border-un1t-border mb-6 overflow-x-auto"
      >
        {list.map((tab) => {
          const isActive = tab.id === active.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveId(tab.id)}
              className={`relative px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors -mb-px border-b-2 ${
                isActive
                  ? 'border-un1t-accent text-un1t-text'
                  : 'border-transparent text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Active panel */}
      <div role="tabpanel">{active.content}</div>
    </div>
  )
}
