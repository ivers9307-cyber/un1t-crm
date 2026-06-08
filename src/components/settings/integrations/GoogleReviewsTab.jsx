import GoogleReviewsCard from '@/components/settings/GoogleReviewsCard'

export default function GoogleReviewsTab({ location, connection }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-un1t-subtle">
        Connect this studio&apos;s Google Business listing to power the reviews
        carousel on its landing page. Reviews sync nightly; hide any you don&apos;t
        want featured below.
      </p>
      <GoogleReviewsCard location={location} connection={connection || null} />
    </div>
  )
}
