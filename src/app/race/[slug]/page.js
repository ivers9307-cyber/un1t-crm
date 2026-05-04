import RaceSignupWidget from '@/components/RaceSignupWidget'

export const dynamic = 'force-static'
export const revalidate = 60

export default function PublicRaceSignupPage({ params }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <RaceSignupWidget slug={params.slug} />
    </div>
  )
}
