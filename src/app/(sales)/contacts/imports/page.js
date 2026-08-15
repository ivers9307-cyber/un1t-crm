// /contacts/imports — list of past CSV import batches.
//
// Manager+ to read, master to roll back (button hidden / locked
// for non-master). Newest first, capped at 100.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, FileText, AlertCircle, RotateCcw } from 'lucide-react'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'

export const dynamic = 'force-dynamic'

export default async function ImportsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/contacts')
  const locationId = user.activeLocation?.id

  const db = createServerClient()
  const { data: batches } = locationId ? await db
    .from('contact_imports')
    .select('*, actor:profiles!contact_imports_actor_user_id_fkey(full_name, email)')
    .eq('location_id', locationId)
    .order('created_at', { ascending: false })
    .limit(100) : { data: [] }

  return (
    <div className="p-6 max-w-5xl">
      <Link href="/contacts" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-4">
        <ArrowLeft size={14} /> Back to contacts
      </Link>
      <h2 className="text-2xl font-bold mb-1">Import history</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        Every CSV import at {user.activeLocation?.name || 'this location'}, newest first.
      </p>

      {(!batches || batches.length === 0) ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-10 text-center">
          <FileText size={28} className="mx-auto mb-2 text-un1t-subtle" />
          <h3 className="text-base font-semibold mb-1">No imports yet</h3>
          <p className="text-sm text-un1t-subtle">
            Use the <strong>Import contacts</strong> button on the Contacts page (master-only).
          </p>
        </div>
      ) : (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="text-[11px] uppercase tracking-wider text-un1t-subtle">
              <tr className="border-b border-un1t-border">
                <th className="text-left p-3">When</th>
                <th className="text-left p-3">By</th>
                <th className="text-left p-3">File</th>
                <th className="text-right p-3">Created</th>
                <th className="text-right p-3">Updated</th>
                <th className="text-right p-3">Skipped</th>
                <th className="text-right p-3">Errored</th>
                <th className="text-left p-3">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {batches.map(b => (
                <tr key={b.id} className="border-t border-un1t-border/40 hover:bg-un1t-border/10">
                  <td className="p-3 text-un1t-subtle text-xs">
                    {new Date(b.created_at).toLocaleString('en-IE', { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                  <td className="p-3 text-un1t-subtle text-xs">{b.actor?.full_name || b.actor?.email || '—'}</td>
                  <td className="p-3 text-un1t-text text-xs truncate max-w-[200px]">{b.source_filename || '(no filename)'}</td>
                  <td className="p-3 text-right tabular-nums">{b.created_count}</td>
                  <td className="p-3 text-right tabular-nums">{b.updated_count}</td>
                  <td className="p-3 text-right tabular-nums text-un1t-subtle">{b.skipped_count}</td>
                  <td className="p-3 text-right tabular-nums">
                    {b.errored_count > 0 ? <span className="text-red-700">{b.errored_count}</span> : <span className="text-un1t-muted">0</span>}
                  </td>
                  <td className="p-3">
                    {b.status === 'rolled_back' && (
                      <span className="inline-flex items-center gap-1 text-xs text-amber-700">
                        <RotateCcw size={11} /> Rolled back
                      </span>
                    )}
                    {b.status === 'completed' && <span className="text-xs text-emerald-700">Completed</span>}
                    {b.status === 'rolling_back' && <span className="text-xs text-un1t-subtle">Rolling back…</span>}
                    {b.status === 'failed' && (
                      <span className="inline-flex items-center gap-1 text-xs text-red-700">
                        <AlertCircle size={11} /> Failed
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    <Link href={`/contacts/imports/${b.id}`} className="text-xs text-blue-400 hover:text-blue-300">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
