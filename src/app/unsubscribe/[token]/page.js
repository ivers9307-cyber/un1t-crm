import UnsubscribePage from '@/components/UnsubscribePage'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Unsubscribe — UN1T',
}

export default function Unsubscribe({ params }) {
  return <UnsubscribePage token={params.token} />
}
