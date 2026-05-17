import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import SequenceEditor from '@/components/SequenceEditor'

export const dynamic = 'force-dynamic'

export default async function EditSequencePage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: sequence } = await db.from('email_sequences')
    .select('*, sequence_steps(*)')
    .eq('id', params.id)
    .single()

  if (!sequence) notFound()

  // Sort steps
  if (sequence.sequence_steps) {
    sequence.sequence_steps.sort((a, b) => a.step_order - b.step_order)
  }

  return (
    <SequenceEditor
      sequence={sequence}
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
