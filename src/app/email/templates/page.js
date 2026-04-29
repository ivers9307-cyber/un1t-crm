import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Plus, FileText, ArrowLeft, Trash2 } from 'lucide-react'
import DeleteTemplateButton from '@/components/DeleteTemplateButton'

export const dynamic = 'force-dynamic'

export default async function TemplatesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: templates } = await db.from('email_templates')
    .select('*')
    .eq('location_id', user.activeLocation?.id)
    .order('updated_at', { ascending: false })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link href="/email" className="text-un1t-light hover:text-white transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h2 className="text-2xl font-bold">Email Templates</h2>
            <p className="text-sm text-un1t-light mt-1">Reusable email designs for your campaigns</p>
          </div>
        </div>
        <Link
          href="/email/templates/new"
          className="flex items-center gap-2 bg-white text-black text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-200 transition-colors"
        >
          <Plus size={16} />
          New Template
        </Link>
      </div>

      {(!templates || templates.length === 0) ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-12 text-center">
          <FileText size={40} className="mx-auto mb-4 text-un1t-light" />
          <h3 className="text-lg font-semibold mb-2">No templates yet</h3>
          <p className="text-sm text-un1t-light mb-4">
            Create reusable email templates to speed up your campaign creation
          </p>
          <Link
            href="/email/templates/new"
            className="inline-flex items-center gap-2 bg-white text-black text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <Plus size={16} />
            Create Template
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map(template => (
            <div
              key={template.id}
              className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden group hover:border-white/30 transition-colors"
            >
              {/* Preview thumbnail */}
              <div className="h-40 bg-un1t-gray/20 flex items-center justify-center border-b border-un1t-gray">
                {template.html_content ? (
                  <iframe
                    srcDoc={template.html_content}
                    title={template.name}
                    className="w-full h-full border-0 pointer-events-none"
                    style={{ transform: 'scale(0.5)', transformOrigin: 'top left', width: '200%', height: '200%' }}
                    sandbox=""
                  />
                ) : (
                  <FileText size={32} className="text-un1t-mid" />
                )}
              </div>

              <div className="p-4">
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium text-sm truncate">{template.name}</h3>
                    {template.description && (
                      <p className="text-xs text-un1t-light mt-0.5 truncate">{template.description}</p>
                    )}
                    <p className="text-xs text-un1t-mid mt-1">
                      Updated {new Date(template.updated_at).toLocaleDateString('en-IE', { month: 'short', day: 'numeric' })}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 mt-3">
                  <Link
                    href={`/email/templates/${template.id}`}
                    className="flex-1 text-center text-xs border border-un1t-gray text-un1t-light hover:text-white hover:border-white/30 px-3 py-1.5 rounded-md transition-colors"
                  >
                    Edit
                  </Link>
                  <DeleteTemplateButton templateId={template.id} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
