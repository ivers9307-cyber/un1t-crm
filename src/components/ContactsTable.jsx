'use client'

// Client wrapper around the contacts table that adds a row-checkbox
// column + a sticky bulk-action bar with "Add to sequence". The table
// rows themselves still link to the contact detail page just like the
// previous server-rendered version.
//
// Why this is a client component: bulk select needs interactive state
// (selected ids, modal open), and the cleanest way to add it without
// touching the parent server page's data fetch was to peel the table
// into its own 'use client' island. The page server component still
// runs the Supabase query and passes the rows in.

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { ChevronRight, Mail, X, GitMerge } from 'lucide-react'
import SequencePicker from './SequencePicker'
import ContactMergeModal from './ContactMergeModal'

const statusBadge = {
  active_trial: 'bg-green-500/20 text-green-400',
  member:       'bg-emerald-500/20 text-emerald-400',
  cold:         'bg-gray-500/20 text-gray-400',
  lost_member:  'bg-red-500/20 text-red-400',
  returning:    'bg-indigo-500/20 text-indigo-400',
}

export default function ContactsTable({ contacts, locationId, canMerge = false }) {
  // Set<contactId>. Set so toggle is O(1) and resilient to the contact
  // list changing under us (filter / search updates).
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)

  const allIds = useMemo(() => contacts.map(c => c.id), [contacts])
  const allSelected = allIds.length > 0 && allIds.every(id => selectedIds.has(id))
  const someSelected = selectedIds.size > 0 && !allSelected

  function toggle(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelectedIds(prev => {
      if (allIds.every(id => prev.has(id))) return new Set()
      return new Set(allIds)
    })
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  const selectedCount = selectedIds.size
  const selectedIdsArray = useMemo(() => Array.from(selectedIds), [selectedIds])

  return (
    <>
      {/* Sticky action bar — only renders when ≥1 row is selected. */}
      {selectedCount > 0 && (
        <div className="sticky top-0 z-10 mb-3 -mx-6 px-6 py-2 bg-un1t-dark border-y border-un1t-gray flex items-center gap-3">
          <button onClick={clearSelection} className="text-un1t-light hover:text-un1t-white" title="Clear selection">
            <X size={14} />
          </button>
          <span className="text-sm text-un1t-white">
            {selectedCount} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setPickerOpen(true)}
            className="text-xs px-3 py-1.5 rounded-md bg-un1t-white text-un1t-black font-semibold hover:bg-un1t-accent flex items-center gap-1.5"
          >
            <Mail size={12} /> Add to sequence
          </button>
          {/* Merge — owner-only. Visible only when exactly 2 rows
              are selected (the merge API takes survivor + loser). */}
          {canMerge && selectedCount === 2 && (
            <button
              onClick={() => setMergeOpen(true)}
              className="text-xs px-3 py-1.5 rounded-md border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid flex items-center gap-1.5"
              title="Merge two contacts into one"
            >
              <GitMerge size={12} /> Merge
            </button>
          )}
        </div>
      )}

      {mergeOpen && (
        <ContactMergeModal
          contactIds={selectedIdsArray}
          contacts={contacts.filter(c => selectedIds.has(c.id))}
          onClose={() => setMergeOpen(false)}
        />
      )}

      <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-un1t-gray text-un1t-light text-xs uppercase tracking-wider">
              <th className="w-10 p-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={el => { if (el) el.indeterminate = someSelected }}
                  onChange={toggleAll}
                  className="cursor-pointer"
                  aria-label={allSelected ? 'Clear selection' : 'Select all'}
                />
              </th>
              <th className="text-left p-3">Name</th>
              <th className="text-left p-3">Email</th>
              <th className="text-left p-3">Phone</th>
              <th className="text-left p-3">Source</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Credits</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-un1t-gray">
            {contacts.map(c => {
              const isSelected = selectedIds.has(c.id)
              return (
                <tr
                  key={c.id}
                  className={`transition-colors ${isSelected ? 'bg-un1t-gray/30' : 'hover:bg-un1t-gray/20'}`}
                >
                  <td className="p-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(c.id)}
                      className="cursor-pointer"
                      aria-label={`Select ${c.name}`}
                    />
                  </td>
                  <td className="p-3">
                    <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                  </td>
                  <td className="p-3 text-un1t-light">{c.email}</td>
                  <td className="p-3 text-un1t-light">{c.phone}</td>
                  <td className="p-3">
                    <span className="text-xs px-1.5 py-0.5 bg-un1t-gray rounded">{c.lead_source || '—'}</span>
                  </td>
                  <td className="p-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge[c.lead_status] || 'bg-un1t-gray text-un1t-light'}`}>
                      {c.lead_status?.replace('_', ' ') || '—'}
                    </span>
                  </td>
                  <td className="p-3 text-un1t-light">{c.trial_credits_remaining ?? '—'}</td>
                  <td className="p-3">
                    <Link href={`/contacts/${c.id}`}>
                      <ChevronRight size={16} className="text-un1t-mid" />
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {contacts.length === 0 && (
          <p className="text-center text-un1t-light text-sm py-12">No contacts found.</p>
        )}
      </div>

      {/* Modal-style picker — fixed overlay so it floats above the table
          and the sticky action bar regardless of scroll position. */}
      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-24 px-4"
          onClick={() => setPickerOpen(false)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <SequencePicker
              contactIds={selectedIdsArray}
              locationId={locationId}
              variant="modal"
              onClose={() => setPickerOpen(false)}
              onSuccess={() => {
                // Leave the picker open so the operator sees the result
                // toast. They can dismiss to clear selection or pick another
                // sequence. We don't auto-clear because a follow-up enrol
                // (e.g. into a second sequence) is a real workflow.
              }}
            />
          </div>
        </div>
      )}
    </>
  )
}
