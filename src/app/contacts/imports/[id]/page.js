// /contacts/imports/[id] — drill-in for one batch.
//
// Shows the batch envelope (totals, status, who, when, source
// filename, batch tag, mapping) + every per-row outcome. Master
// can roll back via a button at the top.

import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import { ArrowLeft, Download } from 'lucide-react'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import ImportRollbackButton from '@/components/ImportRollbackButton'

export const dynamic = 'force-dynamic'

const ACTION_BADGE = {
  created:     'bg-emerald-500/20 text-emerald-700',
  updated:     'bg-blue-500/20 text-blue-700',
  skipped:     'bg-amber-500/20 text-amber-700',
  errored:     'bg-red-500/20 text-red-700',
  rolled_back: 'bg-un1t-gray/30 text-un1t-light',
}

export default async function ImportDetailPage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/contacts')

  const db = createServerClient()
  const { data: batch } = await db
    .from('contact_imports')
    .select('*, actor:profiles!contact_imports_actor_user_id_fkey(full_name, email)')
    .eq('id', params.id)
    .single()
  if (!batch) notFound()
  const guard = assertLocationAccess(user, batch.location_id)
  if (guard) redirect('/contacts/imports')

  const { data: rows } = await db
    .from('contact_import_rows')
    .select('id, row_number, action, contact_id, raw_row, error_message')
    .eq('import_id', params.id)
    .order('row_number', { ascending: true })
    .limit(5000)

  const canRollback = (user.isMaster || user.role === 'master') && batch.status === 'completed'
  const hasFailedRows = (batch.errored_count + batch.skipped_count) > 0

  return (
    <div className="p-6 max-w-5xl">
      <Link href="/contacts/imports" className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white mb-4">
        <ArrowLeft size={14} /> Import history
      </Link>

      <header className="flex items-start justify-between mb-6 gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold truncate">{batch.source_filename || 'Untitled import'}</h2>
          <p className="text-sm text-un1t-light mt-1">
            {new Date(batch.created_at).toLocaleString('en-IE')} · by {batch.actor?.full_name || batch.actor?.email || 'unknown'}
            {batch.batch_tag && (
              <> · tag <strong className="text-un1t-white">{batch.batch_tag}</strong></>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasFailedRows && (
            <a
              href={`/api/contacts/imports/${batch.id}/error-csv`}
              className="inline-flex items-center gap-1.5 border border-un1t-gray text-un1t-light text-xs font-medium px-3 py-1.5 rounded-md hover:text-un1t-white"
            >
              <Download size={12} /> Error rows
            </a>
          )}
          {canRollback && <ImportRollbackButton importId={batch.id} />}
        </div>
      </header>

      <div className="grid grid-cols-5 gap-2 mb-6">
        <Stat label="Total" value={batch.total_rows} tone="muted" />
        <Stat label="Created" value={batch.created_count} tone="emerald" />
        <Stat label="Updated" value={batch.updated_count} tone="blue" />
        <Stat label="Skipped" value={batch.skipped_count} tone="amber" />
        <Stat label="Errored" value={batch.errored_count} tone="red" />
      </div>

      {batch.status === 'rolled_back' && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 mb-6 text-sm text-amber-700">
          This batch was rolled back on {new Date(batch.rolled_back_at).toLocaleString('en-IE')}.
          Created contacts have been deleted; updated contacts have been restored to their pre-import values where possible.
        </div>
      )}

      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-2">Rows</h3>
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-x-auto">
        <table className="w-full text-xs min-w-[600px]">
          <thead className="text-[10px] uppercase tracking-wider text-un1t-light">
            <tr className="border-b border-un1t-gray">
              <th className="text-left p-2 w-12">#</th>
              <th className="text-left p-2 w-24">Action</th>
              <th className="text-left p-2">Email</th>
              <th className="text-left p-2">Detail</th>
            </tr>
          </thead>
          <tbody>
            {(rows || []).map(r => (
              <tr key={r.id} className="border-t border-un1t-gray/40">
                <td className="p-2 text-un1t-mid tabular-nums">{r.row_number}</td>
                <td className="p-2">
                  <span className={`inline-flex items-center text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full ${ACTION_BADGE[r.action] || ''}`}>
                    {r.action.replace('_', ' ')}
                  </span>
                </td>
                <td className="p-2 text-un1t-white">
                  {r.contact_id ? (
                    <Link href={`/contacts/${r.contact_id}`} className="hover:underline">
                      {r.raw_row?.email || r.raw_row?.Email || '—'}
                    </Link>
                  ) : (
                    r.raw_row?.email || r.raw_row?.Email || '—'
                  )}
                </td>
                <td className="p-2 text-un1t-light">{r.error_message || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Stat({ label, value, tone }) {
  const toneClasses = {
    emerald: 'border-emerald-500/40 text-emerald-700',
    blue:    'border-blue-500/40 text-blue-700',
    amber:   'border-amber-500/40 text-amber-700',
    red:     'border-red-500/40 text-red-700',
    muted:   'border-un1t-gray text-un1t-light',
  }
  return (
    <div className={`border rounded-md p-3 text-center ${toneClasses[tone] || toneClasses.muted}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-0.5">{value}</div>
    </div>
  )
}
