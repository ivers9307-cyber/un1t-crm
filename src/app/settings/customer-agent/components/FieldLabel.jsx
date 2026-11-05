'use client'

// MIAORG.1 Task 3 — a field label with its source tag ("Organisation
// default" / "Default", or the "Use organisation default" link) beside it.
// For the custom editors (quiet hours, template pickers, trial finisher);
// the plain fields use AgentField. Moved out of CustomerAgentClient
// (MIASETTINGS.2c) unchanged.
export default function FieldLabel({ tag, children }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-1">
      <label className="block text-sm font-medium text-un1t-text">{children}</label>
      {tag}
    </div>
  )
}
