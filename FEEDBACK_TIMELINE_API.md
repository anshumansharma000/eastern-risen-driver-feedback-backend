# Driver milestones and booking timeline

This feature belongs to the **feedback product**. Routes are outside `/api/v1/core`;
new tables have the `feedback_` prefix in the existing feedback/public persistence
area. Core commercial bookings, billing, payments, reports, roles, audit and outbox
remain independent. A feedback booking's existing optional core reference is not
used to authorise driver updates or change core booking status.

## Rollout

1. Apply migration `0027_feedback_timeline.sql` with the normal migration workflow.
2. Set `DRIVER_BOOKING_URL` to the driver booking page, e.g.
   `https://your-driver-site.example/driver-booking`. Production requires HTTPS,
   with no existing credentials, query string or fragment. If unset, login-based
   reporting works but issuing driver links returns `DRIVER_LINK_URL_NOT_CONFIGURED`.
3. Implement the driver page and admin timeline screens using this contract.
   This repository implements the backend; the browser UI is maintained separately.
4. Run `npm run photos:cleanup` at least hourly, as for passenger photos.

Legacy trips receive operational status `UNKNOWN` (display “Progress not recorded”).
New trips created through the trip service start at `SCHEDULED`. Do not infer actual
completion from passenger feedback or existing booking status.

## Operational and feedback lifecycles

Existing trip `status` remains the passenger feedback lifecycle. Operational
progress is stored independently as `UNKNOWN`, `SCHEDULED`, `IN_PROGRESS`,
`COMPLETED`, or `CANCELLED`.

Milestones: `TRIP_STARTED`, `PASSENGER_PICKED_UP`, `ARRIVED`, `DROPPED_OFF`,
`TRIP_COMPLETED`. Other updates: `NOTE`, `DELAY`, `CORRECTION`.

Start or pickup moves progress to `IN_PROGRESS`. Arrival/drop-off retains current
progress. Only explicit completion moves progress to `COMPLETED`. Drivers can
complete a trip even if an earlier milestone was missed. Completion cannot
precede a recorded start. Notes/photos/corrections can be submitted after completion
within the reporting window. A late milestone at or before the completion time
can enter history without reversing status. A second completion or a milestone
later than completion requires an admin to reopen the trip. Operational cancellation
blocks new milestones but permits explanatory notes. Booking cancellation/archive
blocks all driver access.

Drivers do not close bookings. Admin booking closure remains an explicit action;
`readyToClose` is an advisory summary, true when at least one unarchived trip
exists and every such trip is operationally completed/cancelled. It does not change
commercial/core booking status or require passenger feedback to be submitted.

## Entry points and authentication

| Caller              | Base path                      | Authentication                  |
| ------------------- | ------------------------------ | ------------------------------- |
| Feedback admin      | `/api/v1/admin/timeline`       | Existing ADMIN session cookie   |
| Logged-in driver    | `/api/v1/driver/timeline`      | Existing DRIVER session cookie  |
| Driver booking link | `/api/v1/driver-link/timeline` | `Authorization: Bearer <token>` |

Core roles cannot use feedback admin endpoints. Driver links do not grant account
access, other bookings, passenger feedback responses, or core API access. Passenger
feedback links remain separate and cannot authorise milestone actions.

Link creation returns a URL with `#token=...`. The frontend reads the fragment,
removes it from the address bar using `history.replaceState`, and sends the token
in the Authorization header. Never put the token in API URLs, logs, analytics,
error reports or referrers. Preserve it only in the driver page's session-scoped
storage if navigation/reload support is needed. Treat it as a credential.
Opening a link only loads context; never submit an event from page load.
Timeline responses use `Cache-Control: no-store`. Browser mutations use the
existing configured origin allowlist.

## Admin endpoints

| Method | Path under admin base                                                   | Behaviour                                                                                        |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET    | `/trips?page=1&pageSize=25&bookingId=<optional UUID>`                   | Trip overview: assignment version, operational status, driver, latest received update, readiness |
| GET    | `/bookings/:bookingId/events?page=1&pageSize=25&tripId=<optional UUID>` | Combined timeline for all drivers, including recorded history for archived trips                 |
| POST   | `/bookings/:bookingId/drivers/:driverId/link`                           | Issue/refresh link and grants for currently assigned unarchived trips                            |
| DELETE | `/bookings/:bookingId/drivers/:driverId/link`                           | Revoke all links for the pair; 204                                                               |
| PATCH  | `/trips/:id/progress`                                                   | Admin operational override/reopen with mandatory reason                                          |
| GET    | `/photos/:id/url`                                                       | Short-lived private URL for an attached photo                                                    |

Issue-link body: `{}` or `{ "expiresAt": "ISO timestamp", "regenerate": true }`.
Response: `{ "data": { "id", "bookingId", "driverId", "expiresAt", "link" } }`.
Issuing normally reuses an active pair link, refreshes its trip grants and preserves expiry unless an explicit expiry is supplied;
regeneration creates a new token and invalidates all previous pair tokens.
Default expiry is booking end + 24 hours. Explicit expiry may extend up to 30 days
after the later of booking end or today. For an already-ended booking whose default
expiry is in the past, provide an explicit future expiry.

Progress body: `{ "status": "SCHEDULED", "reason": "Trip reopened after early completion" }`.
Allowed override values are SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED. Overrides
start a fresh operational cycle: reset actual times for the selected status,
increment `assignmentVersion`, preserve event history, and invalidate previous
link grants/queued events. Refresh/reissue driver access and reload context afterwards.
The override and reason are recorded in feedback audit history.

## Driver endpoints

| Method | Path under logged-in driver base | Behaviour                                                                   |
| ------ | -------------------------------- | --------------------------------------------------------------------------- |
| GET    | `/bookings?page=1&pageSize=25`   | Assigned active/completed bookings                                          |
| GET    | `/bookings/:bookingId/context`   | Safe booking summary and driver's current trips                             |
| GET    | `/bookings/:bookingId/events`    | Own updates for currently authorised trips; same pagination/filter as admin |
| POST   | `/events`                        | Record milestone/note/correction; idempotent retry                          |
| POST   | `/photo-uploads`                 | Create direct photo upload                                                  |
| POST   | `/photo-uploads/:id/complete`    | Verify uploaded photo                                                       |
| GET    | `/photos/:id/url`                | Download own attached photo for current assignment                          |

Link base supports the same events/photo endpoints. Its context endpoint is
`GET /context`; the booking is determined by the token. It has no booking-list
endpoint. Timeline reads use `/bookings/:bookingId/events` and reject another
booking ID. Drivers see only their own events for authorised trips; admins see
all drivers' history.

Context includes booking id/reference, passenger name, period and feedback booking
status, plus driver id, access method, reporting deadline, optional link expiry, and trips with id,
`assignmentVersion`, route, scheduled times, vehicle and operational progress.
It excludes passenger phone/email, booking notes and individual passenger feedback.

## Event submission and offline contract

```json
{
  "clientEventId": "3ab871bc-7d24-4fb0-97c1-a4d20bf2b2d8",
  "tripId": "8048ef5c-05ac-480c-a6a3-343420ee49ed",
  "assignmentVersion": 1,
  "type": "PASSENGER_PICKED_UP",
  "occurredAt": "2026-10-10T10:00:00+05:30",
  "recordedAt": "2026-10-10T10:00:00+05:30",
  "submissionMode": "ONLINE",
  "note": "Picked up at terminal 3",
  "location": {
    "latitude": 28.5562,
    "longitude": 77.1,
    "accuracyMeters": 18,
    "capturedAt": "2026-10-10T10:00:00+05:30"
  },
  "photoIds": []
}
```

Generate `clientEventId` before the first attempt. Retain the entire envelope,
including assignment version, times and submission mode, for every retry. New
acceptance returns 201; an exact replay returns 200 with `replayed: true`. Reusing
an ID for changed content returns `TIMELINE_RETRY_CONFLICT`. Concurrent retries
create only one event. Do not switch submission mode after a potentially accepted
online attempt. For an event first queued without a network submission, use
`OFFLINE_SYNC` from the outset. Store binary photos separately until uploads finish;
do not send unverified attachment IDs.

`occurredAt` is the driver-reported event time, `recordedAt` is when the driver
created the entry, and server `receivedAt` is authoritative receipt time. Device
clock values and geotags are reported data, not independently verified evidence.
Event time must not be after recorded time or earlier than booking start minus
24 hours; recorded time permits five minutes of clock skew into the future.
Timeline ordering is occurred time, receipt time, then ID. The admin overview's
latest update uses receipt time so a newly synced older event is visible.
`backdated` indicates an event occurred over one minute before recording.
Use agency timezone for display; API timestamps retain UTC offsets.

Login-based reporting ends 24 hours after scheduled booking end, or at a later
active admin-issued link extension for that booking/driver. Links require their
own unexpired credentials. Revocation invalidates link access immediately; it
does not remove the driver's normal logged-in access to still-assigned trips.

On `TRIP_ASSIGNMENT_CHANGED`, revoked/expired link or forbidden access, keep the
queued record locally, stop automatic retries, and provide an admin-resolution
message. The API does not silently accept a historical submission from a removed
assignment. This backend does not implement a server-side rejected-update inbox;
manual admin resolution is needed for such queued records.

## Assignment changes and durable history

Timeline records attach directly to permanent trip and booking IDs, not derived
feedback engagement IDs. Existing engagement rebuilding remains compatible.
Trips expose `assignmentVersion`, incremented by driver/booking reassignment or
admin operational override. Driver link grants record the version authorised at
issuance or new-trip creation. Permission is rechecked on every read, event and photo operation.

New trips automatically receive a grant through existing unexpired, unrevoked links
for the same booking and driver, preserving the URL/token and expiry. Creating a
trip does not issue missing links, revive invalid links, or refresh existing trip
grants. A returning driver does not regain the earlier assignment's grant. Admins
refresh or reissue access after reassignment or reopening. Removing a driver's last unarchived
trip revokes the old booking link. Booking cancellation/archive revokes links;
reactivation does not resurrect them. Account deactivation blocks all driver
access. A trip with timeline events or recorded operational activity cannot move to another booking. Completed trips
must be reopened before changing drivers. Reassigning a running trip preserves
its progress and earlier driver's history. Schedule changes audit prior schedule
values; original events retain their driver name and assignment version.

## Photos, geotags and corrections

Photo upload body: `{ "tripId", "assignmentVersion", "contentType": "image/jpeg", "sizeBytes": 12345 }`.
Supported types are JPEG, PNG and WebP. The response contains id, PUT URL, required
Content-Type header, expiry and maximum bytes. Upload directly, then call complete,
then submit the returned id in `photoIds` (maximum 10 per event).

Verification uses the existing private R2 processing, limits bytes/pixels, strips
metadata, and writes a normalised JPEG under a timeline-specific object namespace.
Uploads must belong to the current trip/driver/assignment, be verified and not
already attached. For photos added after a milestone, create a NOTE event with the
photo IDs; the original milestone remains intact. Photo URLs are short-lived and
issued only after permission checks.

Geotagging is explicitly optional. The frontend should ask for location with the
update action when the driver chooses to allow it. Omit `location` on denial,
unavailability or timeout; reporting must remain usable. Save geotags separately
from image metadata. No background location tracking is part of this feature.

Corrections append a new `CORRECTION` event with `correctsEventId`, a nonblank
`correctionReason`, and corrected note and/or location. The target must be that
driver's original event on the current assignment, not another correction. A
correction cannot rewrite event type/time, assignment or operational status. Show
original plus correction history; use the latest correction per target for current
note/location display. Status corrections use the admin progress override.

## Suggested frontend behaviour

Build one driver booking screen used by both entry points. Show assigned trips,
large milestone buttons, optional notes/photos, optional location and queued/sent
indicators. Keep drop-off separate from trip completion and confirm completion.
Reload context after assignment changes or admin reopening.

Add an admin overview with trip progress, latest received update and driver;
booking detail opens the combined timeline, with trip filtering and photo preview.
Expose link copy/regenerate/revoke, expiry extension and progress override with
reason. Periodic refresh is sufficient for this version.
