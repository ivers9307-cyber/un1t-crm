-- TV-ROTATION.1 — per-display screen rotation.
--
-- One of the lobby TVs (UC Cast Pro, mig 160) is physically
-- mounted in portrait. The cast renders the /tv/cast/<token>
-- page into a portrait viewport, but the content pushed to it
-- is designed landscape (1920×1080 marketing images). With the
-- existing `objectFit: contain` render that landscape image
-- letterboxes into a thin strip in the middle of the tall
-- screen — most of the panel is black.
--
-- The fix is a per-display rotation: the operator records how
-- the panel is hung and the /tv page counter-rotates the whole
-- stage so a landscape design fills the screen edge-to-edge.
--
-- Stored as degrees rather than a 'portrait'/'landscape' enum
-- because the physical mount has four meaningful states — a TV
-- can be hung portrait either way round, and a ceiling-flipped
-- landscape panel needs 180. Degrees map straight onto the CSS
-- `rotate()` the client applies. 0 = normal landscape (default,
-- so every existing display is unaffected).

set check_function_bodies = off;

alter table public.tv_displays
  add column if not exists rotation smallint not null default 0
    check (rotation in (0, 90, 180, 270));

comment on column public.tv_displays.rotation is
  'TV-ROTATION.1 — clockwise screen rotation in degrees (0/90/180/270) the /tv/cast page applies so content fills a non-landscape-mounted panel. 0 = normal landscape. 90/270 = portrait mount; the client swaps stage width/height. Set per display via the Xero-style card in /admin/tv-displays.';
