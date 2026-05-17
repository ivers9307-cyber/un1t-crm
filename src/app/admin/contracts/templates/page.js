// /admin/contracts/templates — list of contract templates the
// caller can administer. Master/owner only.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Plus, FileText, ChevronRight } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

const TYPE_LABEL = {
  fte: 'FTE',
  contractor: 'Contractor',
  both: 'FTE + Contractor',
}

export default async function TemplatesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isOwnerOrMaster(user)) redirect('/')

  const db = createServerClient()
  const { data: templates } = await db
    .from('contract_templates')
    .select('id, name, description, employment_type, version, active, updated_at')
    .order('updated_at', { ascending: false })

  const rows = templates || []

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <Link href="/admin/contracts" className="text-xs text-un1t-light hover:text-un1t-white">
            ← Contracts
          </Link>
          <h2 className="text-2xl font-bold mt-1">Templates</h2>
        </div>
        <Link
          href="/admin/contracts/templates/new"
          className="inline-flex items-center gap-1.5 text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
        >
          <Plus size={12} /> New template
        </Link>
      </div>
      <p className="text-sm text-un1t-light mb-6">
        Reusable contract bodies with <code className="text-xs">{'{{variable}}'}</code> placeholders. The
        issue wizard merges in profile + custom values at issue time and freezes the rendered text on
        the contract row.
      </p>

      {rows.length === 0 ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8 text-center">
          <FileText size={28} className="mx-auto text-un1t-light mb-3" />
          <p className="text-sm text-un1t-light mb-4">No templates yet.</p>
          <Link
            href="/admin/contracts/templates/new"
            className="inline-flex items-center gap-1.5 text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
          >
            <Plus size={12} /> Create your first template
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map(t => (
            <Link
              key={t.id}
              href={`/admin/contracts/templates/${t.id}`}
              className="block bg-un1t-dark border border-un1t-gray rounded-lg p-4 hover:border-un1t-mid/60"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-un1t-white">{t.name}</span>
                    {!t.active && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-gray-500/20 text-gray-600">
                        Archived
                      </span>
                    )}
                    <span className="text-[10px] uppercase tracking-wider text-un1t-mid">
                      v{t.version}
                    </span>
                  </div>
                  {t.description && (
                    <p className="text-xs text-un1t-light mt-1 truncate">{t.description}</p>
                  )}
                  <p className="text-[11px] text-un1t-mid mt-1">{TYPE_LABEL[t.employment_type]}</p>
                </div>
                <ChevronRight size={16} className="text-un1t-mid shrink-0 mt-1" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
