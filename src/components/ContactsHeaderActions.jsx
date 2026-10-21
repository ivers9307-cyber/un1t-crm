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
import { Button } from '@/components/ui'
import ContactImportWizard from './ContactImportWizard'

export default function ContactsHeaderActions({
  canCreate,
  canImport,
  locations = [],
  defaultLocationId = null,
}) {
  const [importOpen, setImportOpen] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* VISREFRESH.1 — secondary actions quiet, one primary on the right. */}
      {canImport && (
        <>
          <Button as={Link} href="/contacts/imports" variant="ghost" icon={History} title="View past CSV import batches">
            Imports
          </Button>
          <Button type="button" variant="secondary" icon={Upload} onClick={() => setImportOpen(true)}>
            Import contacts
          </Button>
        </>
      )}
      {canCreate && (
        <Button as={Link} href="/contacts/new" icon={Plus}>
          New contact
        </Button>
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
