// /admin/contracts/templates/[id] — edit an existing template.
// Same form as /new with an extra "Active" toggle (soft-delete), plus
// a read-only History section (CONTRACTS-TPLVER.1, mig 446) showing
// every body_markdown snapshot archived by a previous PATCH.
//
// CONTRACTS-SCOPE.1 — the template fetch is org-scoped in app code
// (service role bypasses RLS); previously this page had no org check
// at all, unlike its sibling list page and /admin/contracts/[id].

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import ContractTemplateForm from '@/components/ContractTemplateForm'

export const dynamic = 'force-dynamic'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default async function EditTemplatePage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isOwnerOrMaster(user)) redirect('/')

  // CONTRACTS-SCOPE.1 — service role bypasses RLS, so scope by org in app
  // code (mirrors /admin/contracts/[id] and the templates list page): a
  // non-master must not be able to open another tenant's template by
  // guessing its id. 404 (notFound) keeps ids non-enumerable.
  const orgId = user.activeOrganization?.id
  if (!user.isMaster && !orgId) notFound()
  const db = createServerClient()
  let templateQuery = db
    .from('contract_templates')
    .select('*')
    .eq('id', params.id)
  if (!user.isMaster) templateQuery = templateQuery.eq('organization_id', orgId)
  const { data: template } = await templateQuery.maybeSingle()
  if (!template) notFound()

  // CONTRACTS-TPLVER.1 — server-side fetch, same createServerClient
  // pattern as the template fetch above. This is a service-role page
  // (profiles embeds are safe here — see CLAUDE.md's "never embed
  // profiles from a mobile-direct select" invariant, which is about
  // the browser-anon client, not this server client). No separate org
  // check needed here: versions are keyed by template_id and this query
  // only runs after the org-scoped template read above already
  // succeeded, so a foreign template's versions are unreachable.
  const { data: versions } = await db
    .from('contract_template_versions')
    .select('id, version, body_markdown, variables_schema, created_at, changed_by_profile:profiles!changed_by (full_name)')
    .eq('template_id', params.id)
    .order('version', { ascending: false })

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <Link href="/contracts/templates" className="text-xs text-un1t-subtle hover:text-un1t-text">
        ← Templates
      </Link>
      <h2 className="text-2xl font-bold mt-1 mb-1">{template.name}</h2>
      <p className="text-xs text-un1t-subtle mb-6">Version {template.version}{template.active ? '' : ' · archived'}</p>
      <ContractTemplateForm initial={template} isEdit />

      <section className="mt-10">
        <h3 className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-3">History</h3>
        {(!versions || versions.length === 0) ? (
          <p className="text-sm text-un1t-muted">
            No previous versions. A snapshot is kept each time the body changes.
          </p>
        ) : (
          <div className="border border-un1t-border rounded-lg overflow-hidden">
            {versions.map((v, i) => (
              <details
                key={v.id}
                className={i < versions.length - 1 ? 'border-b border-un1t-border' : ''}
              >
                <summary className="px-4 py-3 text-sm cursor-pointer hover:bg-un1t-border/30 flex items-center gap-3">
                  <span className="text-xs uppercase tracking-wider text-un1t-muted w-10 shrink-0">v{v.version}</span>
                  <span className="text-un1t-text flex-1">{fmtDate(v.created_at)}</span>
                  <span className="text-xs text-un1t-subtle">{v.changed_by_profile?.full_name || 'Unknown'}</span>
                </summary>
                <div className="px-4 py-4 bg-un1t-bg/50">
                  <pre className="whitespace-pre-wrap font-mono text-xs text-un1t-text bg-white text-gray-900 rounded-md p-4 border border-un1t-border">
                    {v.body_markdown}
                  </pre>
                  {Array.isArray(v.variables_schema) && v.variables_schema.length > 0 && (
                    <div className="mt-3">
                      <p className="text-[10px] uppercase tracking-wider text-un1t-muted mb-1">Variables</p>
                      <ul className="text-xs text-un1t-subtle space-y-0.5">
                        {v.variables_schema.map((variable) => (
                          <li key={variable.key}>
                            <code className="text-[0.9em] font-mono">{'{{' + variable.key + '}}'}</code>
                            {variable.label ? ` — ${variable.label}` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
