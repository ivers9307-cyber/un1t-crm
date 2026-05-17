import UnsubscribePage from '@/components/UnsubscribePage'

// Public, no auth, no server data fetch — let Next.js render a static
// shell that UnsubscribePage then hydrates client-side.
export const dynamicParams = true
export const revalidate = 3600

export const metadata = {
  title: 'Unsubscribe — UN1T',
}

export default async function Unsubscribe(props) {
  const params = await props.params;
  return <UnsubscribePage token={params.token} />
}
