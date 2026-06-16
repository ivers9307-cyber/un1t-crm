import { redirect } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default async function SequenceEditorRedirect(props) {
  const params = await props.params
  redirect(`/automations/${params.id}`)
}
