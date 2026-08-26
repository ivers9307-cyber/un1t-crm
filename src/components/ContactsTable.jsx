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
import { ChevronRight, Mail, X, GitMerge, Trash2 } from 'lucide-react'
import dynamic from 'next/dynamic'

// PERF.3 — three modal components that only render when the operator
// actively picks the matching bulk action. Lazy-loaded so the
// /contacts initial JS bundle doesn't ship the merge / bulk-delete /
// sequence-picker code for users who only ever scroll the list.
// ssr:false because these are pure click-to-open modals.
const SequencePicker = dynamic(() => import('./SequencePicker'), { ssr: false })
const ContactMergeModal = dynamic(() => import('./ContactMergeModal'), { ssr: false })
const ContactBulkDeleteModal = dynamic(() => import('./ContactBulkDeleteModal'), { ssr: false })

// Badge palette keyed by pipeline_stage_slug (FUNNEL.1 taxonomy).
// Unmapped slugs fall back to the neutral grey badge.
const statusBadge = {
  new_lead:     'bg-blue-500/20 text-blue-700',
  first_class:  'bg-green-500/20 text-green-700',
  second_class: 'bg-teal-500/20 text-teal-700',
  trial_done:   'bg-amber-500/20 text-amber-700',
  converted:    'bg-emerald-500/20 text-emerald-700',
  member:       'bg-slate-500/20 text-slate-700',
  pack_member:  'bg-cyan-500/20 text-cyan-700',
  classpass:    'bg-purple-500/20 text-purple-700',
  gympass:      'bg-orange-500/20 text-orange-700',
  cold_lead:    'bg-zinc-500/20 text-zinc-700',
  dormant:      'bg-gray-500/20 text-gray-700',
}

function formatStage(slug) {
  return slug ? slug.replaceAll('_', ' ') : '—'
}

// Crossover marker — a home-studio pill + that contact's tags, shown when
// the contact is owned by a different studio than the one being viewed.
function CrossoverMarker({ ctx }) {
  if (!ctx) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle ml-2">
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-700"
        title={`Owned by ${ctx.homeStudio} — shown here because they have a deal at this studio`}
      >
        {ctx.homeStudio}
      </span>
      {(ctx.tags || []).slice(0, 6).map((t) => (
        <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-un1t-border text-un1t-subtle">{t}</span>
      ))}
    </span>
  )
}

// LISTFLAG.1 — "also on <studio>'s list". Distinct from CrossoverMarker above:
// that one means "owned elsewhere, has a DEAL here", this one means "holds a
// contact_location_preferences row at another studio", which is what actually
// identifies a pre-opening waitlist. Muted styling when that studio's email
// marketing is off, so "on the list" and "on the list but opted out" can never
// read the same to an operator about to hit send.
function ListFlagMarker({ flags }) {
  if (!Array.isArray(flags) || flags.length === 0) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle ml-2">
      {flags.map((f) => (
        <span
          key={f.id}
          className={`text-[10px] px-1.5 py-0.5 rounded-full ${
            f.emailMarketing
              ? 'bg-emerald-500/15 text-emerald-700'
              : 'bg-zinc-500/15 text-zinc-700'
          }`}
          title={
            f.emailMarketing
              ? `Also on the ${f.name} list`
              : `Also on the ${f.name} list, but email marketing is off for that studio`
          }
        >
          {f.name}
        </span>
      ))}
    </span>
  )
}

// CONTACT-DEDUP — the lookup list shows ONE row per linked person (the group
// primary). This chip flags that the row folds in other accounts so the
// operator knows the duplicates aren't lost — they're on the profile.
function LinkedMarker({ contact }) {
  if (!contact?.person_group_id) return null
  const n = contact.linked_count
  return (
    <span
      className="inline-flex items-center align-middle ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-700"
      title="This profile folds in linked accounts — open it to see all the emails, numbers and Glofox records"
    >
      {n > 0 ? `Linked +${n}` : 'Linked'}
    </span>
  )
}

export default function ContactsTable({ contacts, locationId, crossoverContext = {}, listFlags = {}, canMerge = false, canDelete = false }) {
  // Set<contactId>. Set so toggle is O(1) and resilient to the contact
  // list changing under us (filter / search updates).
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

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
        <div className="sticky top-0 z-10 mb-3 -mx-6 px-6 py-2 bg-un1t-surface border-y border-un1t-border flex items-center gap-3">
          <button onClick={clearSelection} className="text-un1t-subtle hover:text-un1t-text" title="Clear selection">
            <X size={14} />
          </button>
          <span className="text-sm text-un1t-text">
            {selectedCount} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setPickerOpen(true)}
            className="text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent flex items-center gap-1.5"
          >
            <Mail size={12} /> Add to sequence
          </button>
          {/* Merge — owner-only. Visible only when exactly 2 rows
              are selected (the merge API takes survivor + loser). */}
          {canMerge && selectedCount === 2 && (
            <button
              onClick={() => setMergeOpen(true)}
              className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-muted flex items-center gap-1.5"
              title="Merge two contacts into one"
            >
              <GitMerge size={12} /> Merge
            </button>
          )}
          {/* Bulk delete — head_coach+ (= MANAGER_ROLES). Same
              cascade rules as the per-contact delete; whatsapp
              history blocks come back as per-row "blocked" entries
              in the response, NOT a hard fail of the whole batch. */}
          {canDelete && (
            <button
              onClick={() => setBulkDeleteOpen(true)}
              className="text-xs px-3 py-1.5 rounded-md border border-red-500/40 text-red-700 hover:bg-red-500/10 flex items-center gap-1.5"
              title="Delete selected contacts"
            >
              <Trash2 size={12} /> Delete
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

      {bulkDeleteOpen && (
        <ContactBulkDeleteModal
          contacts={contacts.filter(c => selectedIds.has(c.id))}
          onClose={() => setBulkDeleteOpen(false)}
          onDeleted={clearSelection}
        />
      )}

      {/* Desktop / tablet: original wide table. Hidden below md so
          phones don't horizontal-scroll a 7-column grid. */}
      <div className="hidden md:block bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-un1t-border text-un1t-subtle text-xs uppercase tracking-wider">
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
          <tbody className="divide-y divide-un1t-border">
            {contacts.map(c => {
              const isSelected = selectedIds.has(c.id)
              return (
                <tr
                  key={c.id}
                  className={`transition-colors ${isSelected ? 'bg-un1t-border/30' : 'hover:bg-un1t-border/20'}`}
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
                    <CrossoverMarker ctx={crossoverContext[c.id]} />
                    <ListFlagMarker flags={listFlags[c.id]} />
                    <LinkedMarker contact={c} />
                  </td>
                  <td className="p-3 text-un1t-subtle">{c.email}</td>
                  <td className="p-3 text-un1t-subtle">{c.phone}</td>
                  <td className="p-3">
                    <span className="text-xs px-1.5 py-0.5 bg-un1t-border rounded">{c.lead_source || '—'}</span>
                  </td>
                  <td className="p-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge[c.pipeline_stage_slug] || 'bg-un1t-border text-un1t-subtle'}`}>
                      {formatStage(c.pipeline_stage_slug)}
                    </span>
                  </td>
                  <td className="p-3 text-un1t-subtle">{c.trial_credits_remaining ?? '—'}</td>
                  <td className="p-3">
                    <Link href={`/contacts/${c.id}`}>
                      <ChevronRight size={16} className="text-un1t-muted" />
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {contacts.length === 0 && (
          <p className="text-center text-un1t-subtle text-sm py-12">No contacts found.</p>
        )}
      </div>

      {/* Mobile: card list. Same data, vertically stacked with the
          checkbox and chevron flanking each card. md:hidden so it
          disappears once the table fits horizontally. */}
      <div className="md:hidden space-y-2">
        {contacts.length === 0 ? (
          <div className="bg-un1t-surface border border-un1t-border rounded-lg p-8 text-center">
            <p className="text-sm text-un1t-subtle">No contacts found.</p>
          </div>
        ) : (
          contacts.map(c => {
            const isSelected = selectedIds.has(c.id)
            return (
              <div
                key={c.id}
                className={`bg-un1t-surface border rounded-lg overflow-hidden transition-colors ${
                  isSelected ? 'border-un1t-muted bg-un1t-border/30' : 'border-un1t-border'
                }`}
              >
                <div className="flex items-stretch">
                  {/* Checkbox column — generous tap target so bulk
                      selection on a phone doesn't fight you. */}
                  <label className="flex items-center px-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(c.id)}
                      className="cursor-pointer w-4 h-4"
                      aria-label={`Select ${c.name}`}
                    />
                  </label>
                  {/* Body — link wraps everything except the checkbox
                      so tapping the card navigates to detail. */}
                  <Link
                    href={`/contacts/${c.id}`}
                    className="flex-1 flex items-center gap-2 py-3 pr-3 min-w-0"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-un1t-text truncate">
                          {c.name}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full uppercase tracking-wider ${
                          statusBadge[c.pipeline_stage_slug] || 'bg-un1t-border text-un1t-subtle'
                        }`}>
                          {formatStage(c.pipeline_stage_slug)}
                        </span>
                        <CrossoverMarker ctx={crossoverContext[c.id]} />
                        <ListFlagMarker flags={listFlags[c.id]} />
                        <LinkedMarker contact={c} />
                      </div>
                      {(c.email || c.phone) && (
                        <div className="text-xs text-un1t-subtle truncate mt-0.5">
                          {c.email}
                          {c.email && c.phone ? ' · ' : ''}
                          {c.phone}
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-un1t-muted">
                        {c.lead_source && (
                          <span className="px-1.5 py-0.5 bg-un1t-border rounded">
                            {c.lead_source}
                          </span>
                        )}
                        {c.trial_credits_remaining != null && (
                          <span>{c.trial_credits_remaining} credits</span>
                        )}
                      </div>
                    </div>
                    <ChevronRight size={16} className="text-un1t-muted shrink-0" />
                  </Link>
                </div>
              </div>
            )
          })
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
