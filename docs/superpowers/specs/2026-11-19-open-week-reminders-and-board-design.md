# Open week: class reminders and its own board (OPENWEEK.7, OPENWEEK.8)

Approved by Richard, 19 Nov 2026.

## Reminders (OPENWEEK.7)
- The only message an open week signup gets: a WhatsApp reminder of each booked class.
- Morning class (starts before 12:00, studio clock): 18:00 the evening before. Lunch or afternoon (12:00 or later): 09:00 the same day.
- A signup after the send time still gets it up to 4 h late, never in the class's last hour.
- Who: granted or staff-handled claims on a live open week promo; their BOOKED `class_bookings` at that studio inside the window (so moved and hand-booked classes count, cancelled ones don't).
- Both studios. This lifts the "CRM never reminds un1t.online bookings" rule for open week classes only (one guarded reader).
- Template purpose `class_reminder` (UTILITY), picked per studio; body values: first name, tomorrow/today, time, class, studio.
- Once per booking: `customer_engagement_nudges` type `open_week_reminder`, key `cb:<booking id>`; retryable failures release the claim. Admin WhatsApp consent; STOP/block/undeliverable skip.

## Board (OPENWEEK.8)
- One board per studio: Leads, Active (attended at least one class), Completed (2+ open week classes attended, judged after Sunday 29 Nov), Converted (bought).
- Only open week page signups with classes in the window. 0-1 classes after Sunday stay where they are.
- No follow-up messages on the board.
