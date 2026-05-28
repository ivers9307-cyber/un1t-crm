'use client'

// ContactsHeaderActions — buttons that sit next to the page title
// on /contacts. Lives in a client component because the Import
// wizard is a stateful modal — would otherwise force the whole
// page to be a client component.
//
// `locations` (master sees all) is threaded into the wizard so the
// Step 1 dropdown can pick a target studio. `defaultLocationId` is
// the current active location.

import { useState } from 'react'
import Link from 'next/link'
import { Plus, Upload, History } from 'lucide-react'
import ContactImportWizard from './ContactImportWizard'

export default function ContactsHeaderActions({
  canCreate,
  canImport,
  locations = [],
  defaultLocationId = null,
}) {
  const [importOpen, setImportOpen] = useState(false)
  return (
    <div className="flex items-center gap-2">
      {canImport && (
        <>
          <Link
            href="/contacts/imports"
            className="inline-flex items-center gap-1.5 border border-un1t-border text-un1t-subtle text-sm font-medium px-3 py-2 rounded-lg hover:text-un1t-text hover:border-un1t-muted transition-colors"
            title="View past CSV import batches"
          >
            <History size={14} /> Imports
          </Link>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-2 border border-un1t-border text-un1t-subtle text-sm font-medium px-4 py-2 rounded-lg hover:text-un1t-text hover:border-un1t-muted transition-colors"
          >
            <Upload size={16} /> Import contacts
          </button>
        </>
      )}
      {canCreate && (
        <Link
          href="/contacts/new"
          className="inline-flex items-center gap-2 bg-un1t-text text-un1t-bg text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors"
        >
          <Plus size={16} /> New contact
        </Link>
      )}
      {importOpen && (
        <ContactImportWizard
          onClose={() => setImportOpen(false)}
          locations={locations}
          defaultLocationId={defaultLocationId}
        />
      )}
    </div>
  )
}
