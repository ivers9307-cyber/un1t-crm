// TVBUCKET.1 — what the public 'tv-content' storage bucket accepts.
//
// ONE list for the upload route (src/app/api/admin/tv-displays/upload/route.js
// validates every file against it before it uploads with the service role)
// and for the bucket itself: migration 671 sets the bucket's
// allowed_mime_types to TV_IMAGE_MIME_TYPES and its file_size_limit to
// TV_IMAGE_MAX_BYTES, and tests/tv-content-bucket-guard.test.js fails CI if
// the two drift. Change them together, in one PR with a migration, or Storage
// refuses the new type at upload time even though the route accepted it.
//
// Plain data, no imports: the guard test imports this file.

/** Image types a TV push image or a template base image may be. */
export const TV_IMAGE_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])

/**
 * 15 MiB: TV art is full-bleed 1920×1080 or larger. (A multipart POST to a
 * Vercel route is capped at ~4.5 MB before this check runs; the bucket
 * limit is the route's contract, not that platform cap.)
 */
export const TV_IMAGE_MAX_BYTES = 15 * 1024 * 1024
