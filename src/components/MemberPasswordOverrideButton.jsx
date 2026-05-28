'use client'

// AUTH.1 — "Override password" entry point on the contact detail
// page. Only renders for contacts with a linked CRM auth account
// (contacts.user_id IS NOT NULL) AND for masters/owners.
//
// Server-side page passes `canShow` after evaluating both conditions
// — keeps the role check authoritative on the server. This component
// just toggles the modal.

import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import PasswordOverrideModal from './PasswordOverrideModal'

export default function MemberPasswordOverrideButton({ contactId, contactLabel }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-amber-300 hover:text-amber-200 border border-un1t-border hover:border-amber-300/40 px-3 py-1.5 rounded-md transition-colors"
        title="Set a new password for this member's CRM login"
      >
        <ShieldAlert size={12} />
        Override password
      </button>
      <PasswordOverrideModal
        open={open}
        onClose={() => setOpen(false)}
        targetType="member"
        targetId={contactId}
        targetLabel={contactLabel}
      />
    </>
  )
}
