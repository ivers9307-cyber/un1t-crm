import { createServerClient } from '@/lib/supabase'
import KanbanBoard from '@/components/KanbanBoard'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function PipelinePage() {
  const db = createServerClient()

  const [stagesRes, dealsRes] = await Promise.all([
    db.from('pipeline_stages').select('*').order('display_order'),
    db.from('deals')
      .select('*, contacts(*)')
      .eq('status', 'open')
      .order('created_at', { ascending: false }),
  ])

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-bold">Pipeline</h2>
        <span className="text-sm text-un1t-light">
          {dealsRes.data?.length || 0} open deals
        </span>
      </div>
      <KanbanBoard
        initialStages={stagesRes.data || []}
        initialDeals={dealsRes.data || []}
      />
    </div>
  )
}
