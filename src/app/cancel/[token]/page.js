import CancellationForm from '@/components/CancellationForm'

// Public, no auth, no server data fetch — a shell that the client component
// hydrates from /api/public/cancellation-form/[token]. The token never
// reaches the server render, so nothing here can leak it into a cache.
//
// Rendered per request since W1.L4: the root layout reads the Host header
// to brand the <title> (a dynamic API), so the former `revalidate = 3600`
// static shell no longer applied. The render is a thin mount-point.
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Your membership',
  robots: { index: false, follow: false },
}

export default async function CancelPage(props) {
  const params = await props.params
  return <CancellationForm token={params.token} />
}
