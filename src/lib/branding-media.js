// BRANDINGBUCKET.1 — what the public 'branding' storage bucket accepts.
//
// The bucket's OWN limits (mig 252 set them; mig 675 re-asserts them and
// tests/branding-bucket-guard.test.js pins them). Every route that writes the
// bucket with the service role (logo/favicon, landing-page media, chooser
// tile, event heroes and logos, signature photos) validates a narrower list
// and a smaller cap of its own; the guard fails CI if one of them accepts a
// type outside BRANDING_BUCKET_MIME_TYPES or a size above
// BRANDING_BUCKET_MAX_BYTES, because Storage would then refuse at upload time
// what the route accepted. The one writer with no cap of its own is the
// signed upload (/api/landing-page-settings/media/signed-upload): the browser
// PUTs the bytes straight to Storage, so this is the real ceiling there, and
// src/lib/landing-media-upload.js holds tap-to-play video to it.
//
// Change a value here only together with a migration that sets the bucket to
// it, in the same PR. Plain data, no imports: the guard test imports this file.

/** Every type any branding writer accepts (mig 252's list, same order). */
export const BRANDING_BUCKET_MIME_TYPES = Object.freeze([
  'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
  'image/x-icon', 'image/vnd.microsoft.icon',
  'video/mp4', 'video/webm', 'video/quicktime',
])

/** 200 MiB: the tap-to-play testimonial video ceiling (mig 252). */
export const BRANDING_BUCKET_MAX_BYTES = 200 * 1024 * 1024
