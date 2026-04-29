import PreferenceCentre from '@/components/PreferenceCentre'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Communication Preferences — UN1T',
}

export default function PreferencePage({ params }) {
  return <PreferenceCentre token={params.token} />
}
