import CancellationForm from '@/components/CancellationForm'

// Public, no auth, no server data fetch — a static shell that the client
// component hydrates from /api/public/cancellation-form/[token]. The token
// never reaches the server render, so nothing here can leak it into a cache.
export const dynamicParams = true
export const revalidate = 3600

export const metadata = {
  title: 'Your membership',
  robots: { index: false, follow: false },
}

export default async function CancelPage(props) {
  const params = await props.params
  return <CancellationForm token={params.token} />
}
