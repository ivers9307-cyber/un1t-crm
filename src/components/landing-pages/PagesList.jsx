'use client'
// PAGES.1 — Settings → Landing pages: every page the caller can view, one row
// each (Page · Path · Studios · Offer · Status · Updated · Edit), and the
// "+ New page" button that opens NewPageDialog. The rows are
// listPagesForUser's, handed down by the server page.
//
// A studio page (kind 'studio') still renders and is edited from the legacy
// studio editor until PR3, so its link opens /settings/landing-page?location_id=;
// a campaign page opens the page editor at /settings/landing-page/<id>. A row
// the caller cannot edit says "View" (the editor renders it read-only).
//
// Client bundle: pure modules only, never @/lib/landing-pages or @/lib/auth.

import { useState } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Button, Card, EmptyState, Table } from '@/components/ui'
import { formatInZone, PLATFORM_TZ } from '@shared/zoned-time'
import NewPageDialog from './NewPageDialog'

const STATUS_CHIPS = Object.freeze({
  live: { label: 'Live', className: 'bg-green-500/10 text-green-700' },
  draft: { label: 'Draft', className: 'bg-gray-500/10 text-gray-700' },
  coming_soon: { label: 'Coming soon', className: 'bg-amber-500/10 text-amber-700' },
  retired: { label: 'Retired', className: 'bg-gray-500/10 text-gray-700' },
})

const CHIP = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium'

/** Where a row's Edit (or View) link goes. */
function editorHref(page) {
  if (page.kind === 'studio') return `/settings/landing-page?location_id=${encodeURIComponent(page.primary_location_id || '')}`
  return `/settings/landing-page/${page.id}`
}

function StudiosCell({ page }) {
  const studios = page.studios || []
  if (page.scope === 'all') {
    const on = studios.filter((s) => s.enabled).length
    return (
      <span className={`${CHIP} bg-blue-500/10 text-blue-700`}>
        All studios · {on} of {studios.length} on
      </span>
    )
  }
  const one = studios.find((s) => s.location_id === page.primary_location_id) || studios[0]
  return <span>{one?.name || 'No studio'}</span>
}

function StatusChip({ state }) {
  const chip = STATUS_CHIPS[state] || STATUS_CHIPS.draft
  return <span className={`${CHIP} ${chip.className}`}>{chip.label}</span>
}

function updatedLabel(iso) {
  const ms = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(ms)) return ''
  return formatInZone(ms, PLATFORM_TZ, { day: 'numeric', month: 'short', year: 'numeric' })
}

const COLUMNS = [
  { key: 'title', header: 'Page', render: (p) => <span className="font-medium">{p.title}</span> },
  { key: 'slug', header: 'Path', render: (p) => <code className="text-xs text-un1t-muted">/{p.slug}</code> },
  { key: 'studios', header: 'Studios', render: (p) => <StudiosCell page={p} /> },
  { key: 'offer', header: 'Offer', render: (p) => <span className="text-un1t-muted">{p.offer_summary}</span> },
  { key: 'status', header: 'Status', render: (p) => <StatusChip state={p.publish_state} /> },
  { key: 'updated', header: 'Updated', render: (p) => <span className="text-un1t-subtle whitespace-nowrap">{updatedLabel(p.updated_at)}</span> },
  {
    key: 'edit',
    header: <span className="sr-only">Edit</span>,
    align: 'right',
    render: (p) => (
      <Link href={editorHref(p)} className="text-sm font-medium text-un1t-accent hover:underline">
        {p.can_edit ? 'Edit' : 'View'}
      </Link>
    ),
  },
]

/**
 * @param {object} props
 * @param {object[]} props.pages        listPagesForUser rows
 * @param {boolean} props.canCreate     show "+ New page"
 * @param {boolean} [props.canCreateAll] the caller may make an all-studios page
 * @param {{id:string,name:string}[]} props.studios  studios the caller may make a page for
 * @param {boolean} [props.showFrontPage] link the front-page (chooser) editor
 */
export default function PagesList({ pages = [], canCreate = false, canCreateAll = false, studios = [], showFrontPage = false }) {
  const [creating, setCreating] = useState(false)
  const newButton = canCreate ? (
    <Button icon={Plus} onClick={() => setCreating(true)}>New page</Button>
  ) : null

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-un1t-text">Landing pages</h2>
          <p className="text-sm text-un1t-subtle mt-1">
            Every public page: the studio pages and the campaign pages. Open one to edit it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {showFrontPage && (
            <Button as={Link} href="/settings/landing-page?page=chooser" variant="secondary">Front page</Button>
          )}
          {pages.length > 0 && newButton}
        </div>
      </div>

      {pages.length === 0 ? (
        <Card>
          <EmptyState title="No pages yet." action={newButton} />
        </Card>
      ) : (
        <Card padding="none" className="overflow-x-auto">
          <Table columns={COLUMNS} rows={pages} />
        </Card>
      )}

      {creating && (
        <NewPageDialog
          open
          onClose={() => setCreating(false)}
          pages={pages}
          studios={studios}
          canCreateAll={canCreateAll}
        />
      )}
    </div>
  )
}
