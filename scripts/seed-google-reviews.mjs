// One-off QA seed: inserts sample google_reviews rows for a location so the
// carousel can be verified before the live Google sync exists.
//
//   node scripts/seed-google-reviews.mjs <location_id>
//
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the env
// (same as the app). Idempotent — upserts by (location_id, google_review_id).

import { createClient } from '@supabase/supabase-js'

const locationId = process.argv[2]
if (!locationId) {
  console.error('Usage: node scripts/seed-google-reviews.mjs <location_id>')
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const db = createClient(url, key)

const SAMPLES = [
  { author_name: 'Aoife M.', rating: 5, comment: "Best gym I've trained at. The coaches actually care and the S&C programming is next level." },
  { author_name: 'Daniel K.', rating: 5, comment: '3x a week completely changed my fitness. Coach-led classes keep me accountable.' },
  { author_name: 'Sarah B.', rating: 5, comment: 'Brilliant community and the strength programming is no joke. Down 8kg in 3 months.' },
  { author_name: 'Mark R.', rating: 4, comment: 'Top class facility, friendly staff, never a boring session.' },
  { author_name: 'Niamh O.', rating: 5, comment: 'Genuinely look forward to every session. Coaching is excellent.' },
  { author_name: 'Conor D.', rating: 5, comment: 'Hyrox-style training that actually prepares you for race day.' },
]

const rows = SAMPLES.map((s, i) => ({
  location_id: locationId,
  google_review_id: `seed-${i + 1}`,
  rating: s.rating,
  comment: s.comment,
  author_name: s.author_name,
  author_photo_url: null,
  review_time: new Date(Date.now() - i * 86400000).toISOString(),
  hidden: false,
}))

const { error } = await db
  .from('google_reviews')
  .upsert(rows, { onConflict: 'location_id,google_review_id' })

if (error) {
  console.error('Seed failed:', error.message)
  process.exit(1)
}
console.log(`Seeded ${rows.length} reviews for location ${locationId}.`)
