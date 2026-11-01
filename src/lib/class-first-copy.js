// CLASSFIRST.1 — the words and media keys the class-first cards (/trial,
// /corp) own on their offer block, with their defaults. No imports on
// purpose: landing-page-blocks.js seeds a new block from these, and the
// resolver (class-first-funnel.js) reads them, so this module sits under both.
//
// Tokens in done_class_body: {class} the class name, {day} its day label
// ("Mon, 5 Jan"), {time} its start ("11:00"), all from the public class
// shape (public-classes.js). No em-dashes in customer copy (CLAUDE.md).

export const CLASS_FIRST_STEP_KEYS = Object.freeze([
  'pick_title', 'pick_body', 'pick_cta_label', 'details_title', 'details_body',
  'no_classes_text', 'timetable_unavailable_text', 'skip_class_label', 'done_class_body',
])

export const CLASS_FIRST_HERO_KEYS = Object.freeze(['video_url', 'poster_url', 'video_focus', 'sound_default', 'sound_label'])

export const CLASS_FIRST_EXPECT_KEYS = Object.freeze(['expect_eyebrow', 'expect_heading', 'expect_cards'])

// The same literals as CAMPAIGN_FUNNEL_VIDEO_DEFAULTS (campaign-funnel.js).
export const CLASS_FIRST_HERO_DEFAULTS = Object.freeze({
  video_url: null,
  poster_url: null,
  video_focus: 'top',
  sound_default: 'on',
  sound_label: 'Tap for sound',
})

export const PAID_TRIAL_CLASS_FIRST_DEFAULTS = Object.freeze({
  pick_title: 'Pick your first class',
  pick_body: 'Choose a session for your first visit. You pay once, then we book you in.',
  // {day} is the weekday, {time} the class time (ctaLabelFor).
  pick_cta_label: 'Choose {day} {time}',
  details_title: 'Last step',
  details_body: 'We just need these to set you up.',
  no_classes_text: 'No classes are open to book in the next two weeks. Buy your trial and we will help you book your first one.',
  timetable_unavailable_text: 'We could not check the timetable just now. You can still start your trial and book your first class after.',
  skip_class_label: 'Continue without picking a class',
  done_class_body: 'Your first class: {class}, {day} at {time}. We will confirm it shortly.',
  expect_eyebrow: 'What to expect',
  expect_heading: 'Your first two weeks',
  expect_cards: Object.freeze([
    Object.freeze({ title: 'A coach beside you', body: 'Every session is coach-led. You are shown each movement and never left to guess.' }),
    Object.freeze({ title: 'Scaled to you', body: 'The same class works for a first-timer and a regular. The coach sets your level on the day.' }),
    Object.freeze({ title: 'Booked in minutes', body: 'Pick your first class here, pay once, and we book it for you. The rest you book in the app.' }),
  ]),
})

export const CORP_PROMO_CLASS_FIRST_DEFAULTS = Object.freeze({
  pick_title: 'Pick your first class',
  pick_body: 'Choose a session for your first visit. Your free classes go on your account and we book you in.',
  pick_cta_label: 'Choose {day} {time}',
  details_title: 'Last step',
  details_body: 'We just need these to set up your account.',
  no_classes_text: 'No classes are open to book in the next two weeks. Claim your classes and book your first one in the app.',
  timetable_unavailable_text: 'We could not check the timetable just now. You can still claim your classes and book in the app after.',
  skip_class_label: 'Continue without picking a class',
  done_class_body: 'Your first class: {class}, {day} at {time}. We will confirm it by email.',
  expect_eyebrow: 'What to expect',
  expect_heading: 'Three classes, on us',
  expect_cards: Object.freeze([
    Object.freeze({ title: 'A coach beside you', body: 'Every session is coach-led. You are shown each movement and never left to guess.' }),
    Object.freeze({ title: 'Any class, any level', body: 'Strength, conditioning or both. The coach scales the session to where you are.' }),
    Object.freeze({ title: 'Book in the app', body: 'Your first class is booked for you. The other two you book in the un1t.online app, whenever suits.' }),
  ]),
})

/** The defaults for a block type ('paid_trial' | 'corp_promo'); anything else reads as paid_trial. */
export function classFirstDefaultsFor(type) {
  return type === 'corp_promo' ? CORP_PROMO_CLASS_FIRST_DEFAULTS : PAID_TRIAL_CLASS_FIRST_DEFAULTS
}
