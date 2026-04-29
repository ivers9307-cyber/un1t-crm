import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Plus, ArrowLeft, FileText, CheckCircle2, Clock, XCircle, Pause } from 'lucide-react'

export const dynamic = 'force-dynamic'

const statusConfig = {
  draft:    { label: 'Draft',    color: 'bg-gray-500/20 text-gray-400',    icon: FileText },
  PENDING:  { label: 'Pending',  color: 'bg-yellow-500/20 text-yellow-400', icon: Clock },
  APPROVED: { label: 'Approved', color: 'bg-green-500/20 text-green-400',  icon: CheckCircle2 },
  REJECTED: { label: 'Rejected', color: 'bg-red-500/20 text-red-400',      icon: XCircle },
  PAUSED:   { label: 'Paused',   color: 'bg-orange-500/20 text-orange-400', icon: Pause },
  DISABLED: { label: 'Disabled', color: 'bg-red-500/20 text-red-400',      icon: XCircle },
}

export default async function WhatsAppTemplatesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: templates } = await db.from('whatsapp_templates')
    .select('*')
    .eq('location_id', user.activeLocation?.id)
    .order('created_at', { ascending: false })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link href="/whatsapp" className="text-un1t-light hover:text-un1t-white transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h2 className="text-2xl font-bold">Message Templates</h2>
            <p className="text-sm text-un1t-light mt-1">Meta-approved templates for WhatsApp messaging</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/api/whatsapp/templates?location_id=${user.activeLocation?.id}&sync=true`}
            className="flex items-center gap-2 border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            Sync from Meta
          </Link>
          <Link
            href="/whatsapp/templates/new"
            className="flex items-center gap-2 bg-un1t-white text-un1t-black text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-un1t-accent transition-colors"
          >
            <Plus size={16} />
            New Template
          </Link>
        </div>
      </div>

      {(!templates || templates.length === 0) ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-12 text-center">
          <FileText size={40} className="mx-auto mb-4 text-un1t-light" />
          <h3 className="text-lg font-semibold mb-2">No templates yet</h3>
          <p className="text-sm text-un1t-light mb-4">
            Create message templates and submit them to Meta for approval before sending broadcasts
          </p>
          <Link
            href="/whatsapp/templates/new"
            className="inline-flex items-center gap-2 bg-un1t-white text-un1t-black text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-un1t-accent transition-colors"
          >
            <Plus size={16} />
            Create Template
          </Link>
        </div>
      ) : (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg divide-y divide-un1t-gray">
          {templates.map(template => {
            const config = statusConfig[template.status] || statusConfig.draft
            const StatusIcon = config.icon
            const bodyComp = template.components?.find(c => c.type === 'BODY')

            return (
              <Link
                key={template.id}
                href={`/whatsapp/templates/${template.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-un1t-gray/20 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-un1t-gray/30 flex items-center justify-center">
                    <FileText size={18} className="text-un1t-light" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{template.name}</p>
                    <p className="text-xs text-un1t-light mt-0.5 truncate max-w-md">
                      {bodyComp?.text || 'No body text'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-xs text-un1t-mid">{template.category}</span>
                  <span className="text-xs text-un1t-mid">{template.language}</span>
                  {template.total_sent > 0 && (
                    <span className="text-xs text-un1t-light">{template.total_sent} sent</span>
                  )}
                  <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${config.color}`}>
                    <StatusIcon size={10} />
                    {config.label}
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
