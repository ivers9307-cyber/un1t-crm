'use client'

// CONTRACTS-EDIT.1 — surfaces the "contract issued but email could
// not be sent" warning that ContractIssueWizard's handleIssue used
// to silently drop after a successful issue (json.warning was read
// off the response and then thrown away). The wizard now stashes it
// in sessionStorage keyed by the just-created contract id before
// navigating here; this component reads + clears that key on mount
// and shows a dismissible amber banner when present. The server page
// renders it unconditionally — it renders null whenever no warning
// was stashed (the common case: email sent fine, or the page was
// opened directly rather than just after an issue).

import { useEffect, useState } from 'react'
import { AlertCircle, X } from 'lucide-react'

export default function ContractIssueWarningBanner({ contractId }) {
  const [warning, setWarning] = useState(null)

  useEffect(() => {
    if (!contractId) return
    const key = `contract-issue-warning:${contractId}`
    try {
      const stored = window.sessionStorage.getItem(key)
      if (stored) {
        setWarning(stored)
        window.sessionStorage.removeItem(key)
      }
    } catch {
      // Private-browsing modes can block storage — the banner just
      // never appears in that case; no functional loss otherwise.
    }
  }, [contractId])

  if (!warning) return null

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 mb-4 flex items-start gap-2 print:hidden">
      <AlertCircle size={14} className="text-amber-700 mt-0.5 shrink-0" />
      <p className="text-xs text-amber-700 flex-1">{warning}</p>
      <button
        type="button"
        onClick={() => setWarning(null)}
        aria-label="Dismiss"
        className="text-amber-700 hover:text-amber-800 shrink-0"
      >
        <X size={14} />
      </button>
    </div>
  )
}
