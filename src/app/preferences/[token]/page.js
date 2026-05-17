import PreferenceCentre from '@/components/PreferenceCentre'

// Public, no auth, no server data fetch — let Next.js render a static
// shell that PreferenceCentre then hydrates client-side.
export const dynamicParams = true
export const revalidate = 3600

export const metadata = {
  title: 'Communication Preferences — UN1T',
}

export default async function PreferencePage(props) {
  const params = await props.params;
  return <PreferenceCentre token={params.token} />
}
