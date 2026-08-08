-- FLEET-CMD.3 — captures are PNG, not JPEG.
--
-- Found on hardware, not in CI. Debian's `grim` package is built WITHOUT
-- libjpeg, so `grim -t jpeg` exits with "jpeg support disabled" — the binary
-- accepts the flag and then refuses. Mig 477 had locked the bucket to
-- image/jpeg, which would have rejected every real capture.
--
-- PNG turns out to be the better choice anyway. Measured on stillorgan-tv2, a
-- full-resolution capture of the live board is ~111 KB: a leaderboard is large
-- flat areas of near-black, which is precisely what PNG compresses well and
-- what JPEG would have blurred. No downscaling needed, and full resolution is
-- what makes the text readable.

UPDATE storage.buckets
   SET allowed_mime_types = ARRAY['image/png']
 WHERE id = 'fleet-screenshots';
