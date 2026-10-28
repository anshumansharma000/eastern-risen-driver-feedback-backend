# Frontend implementation prompt: driver milestones, booking links and admin timelines

Implement the driver milestones and booking timeline feature in the existing frontend application. Deliver working screens, API integration, offline queue handling, photo uploads, access controls and meaningful tests. Follow the application's existing framework, design system, routing, authentication, API client, state management and test conventions. Inspect the repository guidance and existing booking, trip, driver and passenger feedback screens before making changes. This is an implementation task, not a design-only proposal.

## 1. Product boundaries and existing behaviour

This feature belongs to the **feedback product**. Keep its navigation, API services, query keys, types and permissions separate from the core API, even when both products share a frontend repository, backend codebase or database.

- Use the timeline endpoints below, outside `/api/v1/core`.
- Feedback admins use the existing `ADMIN` session. Drivers use `DRIVER` login or a dedicated booking link.
- `CORE_ADMIN`, `CORE_REPORT_VIEWER`, `CORE_DATA_ENTRY` and customer roles do not gain timeline administration permissions.
- Never update core commercial bookings, invoices, receipts, payments or reports from timeline actions.
- Preserve existing passenger feedback, questionnaire sections, engagement grouping, feedback links, scoring and review behaviour.
- A driver booking link and passenger feedback link are different credentials with different capabilities. Keep their entry routes, storage and API clients separate.
- Existing trip `status` is the passenger feedback lifecycle. Never use it as actual trip progress. Read `operationalStatus` from timeline context/overview.
- Existing `engagementId` values may change after schedule edits. Associate timeline state with permanent `bookingId` and `tripId`, never an engagement ID.

The backend migration `0027_feedback_timeline.sql` has been applied to the configured database and verified. Existing trips have operational status `UNKNOWN`; newly created trips start at `SCHEDULED`. Updated backend code must also be deployed/running for the new endpoints to be available. Database migration alone does not deploy API code.

Backend reference: `FEEDBACK_TIMELINE_API.md`. If the frontend repository does not contain it, use the complete contract in this prompt and the deployed backend's OpenAPI documentation. Do not invent endpoints or silently alter backend semantics to accommodate a UI choice. Report a concrete contract gap when one prevents implementation.

## 2. Required user journeys

Implement these journeys:

1. A logged-in driver selects an assigned booking, sees their assigned trips, records milestones, notes, delays, photos and optional location, and sees submission state.
2. A driver opens a booking-specific link and performs the same timeline actions without logging in. The link only grants access to authorised trips in that booking.
3. A feedback admin sees operational trip progress and the latest received updates in the dashboard, opens the combined booking timeline across drivers, and inspects photos and optional location.
4. An admin issues, copies, refreshes, regenerates, extends or revokes a driver's booking link.
5. An admin corrects/reopens operational progress with a required reason. Drivers reload assignment context and receive refreshed access where needed.
6. Drivers can queue updates and photo files during a connection failure. Exact retries do not create duplicate updates. Updates that become unauthorised remain locally available for manual resolution.

Build one shared driver booking feature with two explicit access adapters, `LOGIN` and `LINK`, so components and event/upload rules do not diverge.

## 3. Route and navigation integration

Choose paths consistent with the existing application's router. Suggested pages:

- Driver booking list in the authenticated driver area.
- Driver booking detail with trip actions and own timeline.
- Public driver link landing page, such as `/driver-booking`.
- Feedback-admin operational overview.
- A Timeline tab/section on existing feedback booking detail.
- Link management actions grouped by booking and driver.

The actual public landing URL must exactly match backend `DRIVER_BOOKING_URL`, for example `https://<driver-frontend-host>/driver-booking`. This variable is not configured in the backend environment yet. Supply the final route and absolute deployment URL in the implementation handoff; do not guess a production hostname. Production requires HTTPS, with no embedded credentials, query string or fragment in the configured base URL. Existing configured frontend-origin and R2 upload CORS rules must include the frontend origin as appropriate.

Keep passenger feedback navigation available in its existing location. Labels such as “Trip updates” and “Timeline” should make progress reporting easy to find without replacing the feedback flow.

## 4. Authentication and driver link handling

Use existing session-cookie authentication for logged-in admins/drivers, including the API client's normal credentialed requests and session-expiry handling.

For booking links:

- Issued URLs contain a fragment: `#token=<opaque token>`.
- Read the token using `URLSearchParams(location.hash.slice(1))` on the public driver page before initialising page analytics.
- Remove the token from the visible address using `history.replaceState` without causing navigation.
- Retain it in memory and, only if needed for reloads/navigation, session-scoped storage namespaced to this feature and access identity. Do not use localStorage, persist it in the offline event store, put it in API query strings, or append it to unrelated navigation URLs.
- Send it as `Authorization: Bearer <token>` only to `/api/v1/driver-link/timeline/*`.
- Do not reuse passenger feedback token storage or overwrite the user's logged-in session.
- A link opened while another driver is logged in must still use the link's identity for this page. Do not silently switch to that logged-in driver's authority.
- Partition query caches, local drafts and queued events by access method and driver/booking identity. Never include raw tokens in query keys, telemetry or debug output. An in-memory access-instance ID may distinguish link sessions.
- Redact fragment tokens and Authorization headers from analytics, errors, logging and support exports. Exclude the link landing page from persistent browser/service-worker caches containing private API responses.
- Use an appropriate no-referrer policy for the credential-bearing landing page.
- Opening a page only loads context. Do not create a milestone in a mount effect, route loader or background refresh.
- On invalid, expired or revoked access, show a clear access-unavailable screen and retain unsynced local work. Do not display previously cached private context as though authorisation remains valid.
- Explicitly clearing an access session should warn if unsent work exists. Do not auto-delete the queue on a 401/403 response.

The backend responds with `Cache-Control: no-store` for timeline endpoints. Follow that intent in client caching; in-memory query state is acceptable but must be identity-scoped and cleared appropriately.

## 5. API conventions and exact endpoints

Use the existing API base URL. Paths below are relative to its origin.

Successful single-resource responses use `{ "data": ... }`. Collections use `{ "data": [...], "pagination": { "page", "pageSize", "total" } }`. Errors follow the existing `{ "error": { "code", "message", "details"?, "requestId" } }` contract. HTTP 204 has no JSON body. Pagination is one-based, defaults to 25 items and allows at most 100.

### Feedback admin

Base: `/api/v1/admin/timeline`.

| Method | Path                                          | Parameters/body                             | Result                                   |
| ------ | --------------------------------------------- | ------------------------------------------- | ---------------------------------------- |
| GET    | `/trips`                                      | `page`, `pageSize`, optional `bookingId`    | Operational overview rows                |
| GET    | `/bookings/:bookingId/events`                 | `page`, `pageSize`, optional `tripId`       | Combined booking timeline across drivers |
| POST   | `/bookings/:bookingId/drivers/:driverId/link` | `{}`, or optional `expiresAt`, `regenerate` | Issued/refreshed link and expiry         |
| DELETE | `/bookings/:bookingId/drivers/:driverId/link` | No body                                     | 204; revokes pair links                  |
| PATCH  | `/trips/:id/progress`                         | `{ "status", "reason" }`                    | `{ "tripId", "status" }`                 |
| GET    | `/photos/:id/url`                             | No body                                     | Private photo URL and expiry             |

### Logged-in driver

Base: `/api/v1/driver/timeline`.

| Method | Path                           | Parameters/body                       | Result                                     |
| ------ | ------------------------------ | ------------------------------------- | ------------------------------------------ |
| GET    | `/bookings`                    | `page`, `pageSize`                    | Assigned active/completed bookings         |
| GET    | `/bookings/:bookingId/context` | No body                               | Safe booking context/current trip versions |
| GET    | `/bookings/:bookingId/events`  | `page`, `pageSize`, optional `tripId` | Own updates for authorised trips           |
| POST   | `/events`                      | Event body below                      | 201 new / 200 replay receipt               |
| POST   | `/photo-uploads`               | Upload-intent body below              | Direct upload details                      |
| POST   | `/photo-uploads/:id/complete`  | No body                               | Verified upload status                     |
| GET    | `/photos/:id/url`              | No body                               | Own attached photo URL                     |

### Driver link

Base: `/api/v1/driver-link/timeline`.

- `GET /context` resolves the booking and driver from the bearer token.
- `GET /bookings/:bookingId/events` has the same pagination/trip filter as above, but only for that link's booking and current grants.
- `POST /events`, `POST /photo-uploads`, `POST /photo-uploads/:id/complete`, and `GET /photos/:id/url` use the same payloads as login access.
- There is no link-authorised booking-list endpoint.

No timeline API supports server-side driver/status/date/search filters beyond those listed. Do not send invented parameters. Client-only filters must be labelled/scoped to loaded rows, or use the existing booking search to select a booking before requesting its overview. There are no WebSocket, push-notification, link-list, audit-history or rejected-update-inbox endpoints in this feature.

## 6. Frontend types

Use strict types matching these contracts. Reuse existing API-envelope types where available. Dates are ISO strings on the wire and should be parsed only where needed for display/validation.

```ts
type OperationalStatus = 'UNKNOWN' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

type TimelineEventType =
  | 'TRIP_STARTED'
  | 'PASSENGER_PICKED_UP'
  | 'ARRIVED'
  | 'DROPPED_OFF'
  | 'TRIP_COMPLETED'
  | 'NOTE'
  | 'DELAY'
  | 'CORRECTION';

type AccessMethod = 'LOGIN' | 'LINK';
type SubmissionMode = 'ONLINE' | 'OFFLINE_SYNC';

interface EventLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
}

interface DriverBookingContext {
  booking: {
    id: string;
    bookingReference: string;
    passengerName: string;
    startsAt: string;
    endsAt: string;
    status: 'ACTIVE' | 'COMPLETED';
  };
  driverId: string;
  accessMethod: AccessMethod;
  expiresAt: string | null;
  reportingClosesAt: string;
  trips: Array<{
    id: string;
    assignmentVersion: number;
    pickupLocation: string;
    destination: string;
    scheduledAt: string;
    scheduledEndAt: string;
    vehicle: { registrationNumber: string; displayName: string };
    operationalStatus: OperationalStatus;
    startedAt: string | null;
    completedAt: string | null;
  }>;
}

interface CreateTimelineEvent {
  clientEventId: string;
  tripId: string;
  assignmentVersion: number;
  type: TimelineEventType;
  occurredAt: string;
  recordedAt: string;
  submissionMode: SubmissionMode;
  note?: string;
  location?: EventLocation;
  photoIds?: string[];
  correctsEventId?: string;
  correctionReason?: string;
}

interface TimelineReceipt {
  id: string;
  receivedAt: string;
  replayed: boolean;
}

interface TimelineEvent {
  id: string;
  clientEventId: string;
  bookingId: string;
  tripId: string;
  driverId: string;
  driverNameSnapshot: string;
  assignmentVersion: number;
  actorAccountId: string | null;
  linkId: string | null;
  type: TimelineEventType;
  note: string | null;
  location: EventLocation | null;
  occurredAt: string;
  recordedAt: string;
  receivedAt: string;
  submissionMode: SubmissionMode;
  correctsEventId: string | null;
  correctionReason: string | null;
  accessMethod: AccessMethod;
  backdated: boolean;
  photos: Array<{ id: string }>;
}

interface TripOverviewRow {
  tripId: string;
  bookingId: string;
  bookingReference: string;
  bookingStatus: string;
  driverId: string;
  driverName: string;
  assignmentVersion: number;
  scheduledAt: string;
  scheduledEndAt: string;
  pickupLocation: string;
  destination: string;
  operationalStatus: OperationalStatus;
  startedAt: string | null;
  completedAt: string | null;
  latestUpdate: {
    id: string;
    type: TimelineEventType;
    occurredAt: string;
    receivedAt: string;
    driverName: string;
  } | null;
  readyToClose: boolean;
}

interface IssuedDriverLink {
  id: string;
  bookingId: string;
  driverId: string;
  expiresAt: string;
  link: string;
}

interface PhotoUploadIntent {
  tripId: string;
  assignmentVersion: number;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  sizeBytes: number;
}

interface PhotoUploadResponse {
  id: string;
  uploadUrl: string;
  method: 'PUT';
  headers: { 'Content-Type': string };
  expiresAt: string;
  maxBytes: number;
}

interface CompletedPhoto {
  id: string;
  status: 'READY' | 'ATTACHED';
  completedAt: string | null;
}

interface PrivatePhotoUrl {
  id: string;
  url: string;
  expiresAt: string;
}
```

Treat server payloads as authoritative. Runtime-validate responses if that is an existing application convention. Do not expose internal field names such as `assignmentVersion`, raw status codes or actor IDs in ordinary product copy.

## 7. Driver booking screen and milestone controls

Build for mobile use first, with readable trip cards, large touch targets and clear current-trip selection. Display booking reference, passenger name, trip route, scheduled time, vehicle and operational progress. The public link page must not expose booking notes, passenger contact information, other drivers' trips or passenger feedback answers.

Use these labels and rules:

| Server status | Display               | Suggested actions                                                                 |
| ------------- | --------------------- | --------------------------------------------------------------------------------- |
| UNKNOWN       | Progress not recorded | Start, pickup, arrival, drop-off, complete, note, delay                           |
| SCHEDULED     | Scheduled             | Start, pickup, arrival, drop-off, complete, note, delay                           |
| IN_PROGRESS   | In progress           | Arrival, drop-off, complete, note, delay; avoid accidental duplicate start/pickup |
| COMPLETED     | Completed             | Notes/photos and eligible corrections; no routine new milestones                  |
| CANCELLED     | Cancelled             | Notes/photos and eligible corrections; no new milestones                          |

Use labels such as “Start trip”, “Passenger picked up”, “Arrived”, “Passenger dropped off” and “Complete trip”. Drop-off is distinct from completion. Do not impose a mandatory ordered checklist: drivers may miss an earlier milestone and still legitimately complete the trip. Existing recorded updates can inform button copy but the server decides validity.

Each action opens a lightweight composer with optional note, photos and “Include my location” choice. Notes/delays must contain a nonblank note or at least one photo. Notes are limited to 4,000 characters. Up to 10 photos may be attached to an event.

Confirm trip completion with the selected route/trip visible to avoid completing the wrong leg. Completing one trip does not complete the booking or start passenger feedback.

Disable duplicate local submission while one action is being accepted. Show “Sending”, “Queued”, “Sent”, “Upload failed” and “Needs attention” states without claiming a queued milestone has become the server's official progress. If showing anticipated local progress, clearly label it as pending. Refresh authoritative context after acceptance.

Show actual start/completion separately from scheduled times. Preserve the selected trip when refreshing if it remains authorised. If it disappears or its version changes, invalidate the composer and explain that the assignment has changed.

## 8. Time capture and optional geolocation

At the user's action, capture the occurrence time, recording time and assignment version for the draft. For a normal immediate update, occurrence and recording can be the same captured instant. Do not keep a recording timestamp running while the user waits for a photo upload or location permission; the saved draft time belongs to the actual entry creation.

Manual backdating can be available in an advanced control labelled “This happened earlier”. Enforce occurrence no later than recording and no earlier than booking start minus 24 hours. The server tolerates five minutes of device-clock skew into the future. Explain errors in plain language; do not imply the server verifies when an event physically happened.

Location capture is optional and happens only after a user chooses it. Use a one-time browser geolocation request with bounded timeout; no background tracking. Save latitude, longitude, accuracy in metres and location capture time. Reject invalid coordinate values locally. If location capture happens after the draft's recording timestamp, either capture/update the draft's recording time before its first submission, or omit location if the time gap would exceed the server's five-minute allowance. Never mutate a payload after its first submission attempt.

Permission denial, timeout or unsupported browsers must leave normal reporting usable. Omit the entire `location` property when unavailable; do not send zeros or invented coordinates. Display whether the entry contains location and its reported accuracy. Do not infer geotags from photo EXIF; the backend strips photo metadata.

Display dates using the application's configured agency timezone, with a sensible configured fallback if that setting is unavailable to a public driver. Do not call protected admin settings APIs from the link page. Retain ISO timestamps in transport and local records. Show a timezone label where date interpretation matters.

## 9. Offline queue and immutable retry behaviour

Use the existing IndexedDB/local database pattern or add a small, bounded IndexedDB queue that stores event drafts and photo blobs. A token must not be stored in that queue. Include a record format version for future upgrades.

Maintain a separate mutable draft and frozen submission envelope:

1. Generate `clientEventId` using a UUID before any first attempt.
2. Save the draft, identity scope, assignment version and original times locally before network work starts.
3. For a draft first queued without a network submission, select `OFFLINE_SYNC`. For an online submission select `ONLINE`.
4. Complete all intended photo uploads and resolve verified photo IDs before freezing the final event body.
5. Persist the exact frozen body before sending `POST /events`.
6. Every retry of that ID must use the same body, times, mode, note, location and attachment IDs. An online request with an uncertain outcome must not become `OFFLINE_SYNC` on its retry.
7. A 201 receipt and a 200 receipt with `replayed: true` are both successful. Store the receipt, reconcile against fetched events by `clientEventId`, and stop retrying.
8. A timeout/network failure can mean the server accepted the request. Retry the same ID/body; do not generate another ID or rebuild the body.
9. Allow editing an unsent draft before freezing. Once any event submission has been attempted, resolve the existing attempt before changing its data. An intentional later correction is a new event with a new ID.

Partition the queue by driver, booking, trip and access identity. Queue ordering must respect each trip's original occurrence order when possible. Process a trip's queued milestones sequentially so a later completion is not sent ahead of its queued start. Use a single-flight processor/locking mechanism so reconnect handlers, polling and multiple tabs do not issue different envelopes for the same local item. Server idempotency remains the final safeguard.

Use bounded exponential backoff with jitter for transient failures and respect 429/Retry-After. Browser online/offline flags are hints, not evidence that the API is reachable. Resume on explicit retry, reconnect and authenticated page focus when appropriate. Do not promise closed-tab/background delivery or automatic cross-device synchronisation.

Before resuming work, reload context with current authority and compare assignment versions. Never silently replace a queued item's original version with the new version. On expired/revoked credentials, removed assignments, cancellation, a reporting-window closure or an assignment-version change, stop automatic submission and keep the item locally as “Needs attention”. Explain that an admin must resolve it. The backend has no rejected-update inbox and admins cannot inspect another device's unsent queue. Offer an explicit local review/copy/export of the driver-entered note/timestamps when useful, excluding credentials, and do not pretend it has been submitted to an admin.

For completion conflicts, show whether a late event is eligible to enter history: completed trips allow an earlier non-completion milestone at or before server completion time; a second completion or later milestone requires admin reopening. Preserve failed entries rather than discarding them.

On 401 during logged-in access, support reauthentication without deleting work. For link access, obtain a valid link through the normal admin process; do not automatically escalate into login mode or exchange credentials.

Show queue size and per-entry status. Provide an explicit discard action with confirmation for unsent work. Release stored photo blobs/object URLs when no longer needed, and document browser-storage limitations. Do not store previously viewed passenger information or unrelated account data in the queue.

## 10. Photo uploads and private previews

Reuse existing supported photo selection/preview components, but use timeline upload endpoints and state. Passenger feedback upload IDs cannot be attached to timeline events.

Workflow:

1. Select JPEG, PNG or WebP files. Unsupported HEIC or other formats need a clear message or an existing validated client conversion flow; never send an unsupported MIME type to this API.
2. Store selected blobs locally with the unsent draft. Enforce the 10-photo-per-event limit and sensible existing client size limits.
3. Request an upload intent with `tripId`, `assignmentVersion`, exact MIME type and byte size.
4. Upload the raw file body directly to the returned presigned URL using the returned PUT method and Content-Type header.
5. Do not attach the API bearer token or session credentials to the storage request. Use a storage-specific request path that does not inherit the authenticated API client's headers. Do not use multipart encoding.
6. Call `/photo-uploads/:id/complete`. Attach only IDs confirmed as verified/READY before the first event submission.
7. Persist upload/verification progress so reconnection does not create unnecessary new uploads.

If a PUT result is uncertain while the URL remains valid, retry the same file with the same upload intent or attempt verification. Once an intent expires, create a new intent if the event body has never been submitted. After the event body has been frozen and attempted, do not swap attachment IDs under the same `clientEventId`; resolve that event's outcome first.

For image verification rejection, explain that the selected image could not be accepted and preserve the rest of the draft. The driver can retry or remove that image before first event submission. If photo storage is unavailable, offer to continue without selected photos with an explicit user choice before freezing; never silently drop attachments.

To add a photo after a milestone is already recorded, submit a new NOTE event with the photo IDs. A photo-only NOTE is valid. Do not patch an existing milestone or attach a photo to multiple events.

Timeline reads return photo IDs, not permanent public URLs. Request private URLs lazily when a photo preview/viewer is opened. Retain them only in memory, honour expiry, and fetch a fresh URL when an expired URL fails. Do not expose object keys or persist signed URLs as durable image references. A historical photo may be visible to admins but no longer accessible to a driver after assignment changes; handle that restriction without breaking the timeline.

The backend sanitises images, bounds dimensions and strips metadata. UI copy should describe private attachments, not claim photos independently prove event time/location.

## 11. Driver/admin timeline presentation and corrections

Admin booking detail shows the combined history across all drivers. Driver views show only their own events for currently authorised trips. Do not fabricate other drivers' updates to make the driver view resemble the admin view.

Render event label, driver snapshot, trip route where known, occurrence time, note, optional photo previews and optional location. Show access method as “Driver login” or “Driver link” in detail/audit copy. Link actions are attributed to the assigned driver link; do not call them independently verified identity.

Use `receivedAt` and `recordedAt` in details. Mark `OFFLINE_SYNC` entries as synced from offline reporting, and `backdated` entries as reported later. The overview's latest update is based on receipt time, so a newly received older event can appear there while staying earlier in chronological history.

The server timeline order is occurrence time, receipt time, then ID, ascending. Preserve that canonical order and support paginated “Load more”. If offering newest-first presentation, do not reverse one ascending page and imply it is the latest history; fetch the required pages or expose only the supported chronological view. Refetch/reconcile loaded pages after mutations and polling; do not append a single late receipt blindly at the bottom. Deduplicate by event ID/client ID.

Corrections are additive:

- A driver corrects their original event through a new `CORRECTION` event.
- Supply the original `correctsEventId`, a nonblank reason (maximum 1,000 characters), and corrected note and/or location.
- The original must belong to that driver on the current assignment, and must not itself be a correction.
- Do not offer changing event type, original occurrence/recording time, trip, driver, assignment or status through this action.
- Preserve original content and correction history. Display “Corrected” with expandable original/reason.
- Determine the latest correction by receipt time and ID. Correction events only overwrite fields supplied by the correction; an omitted note or location must not erase an earlier/original value. Do not allow silently clearing a field through an empty/null value unsupported by the request contract.
- Corrections can arrive on later pages. Update the correction index when more pages/refreshed data are loaded; do not claim a final corrected value from a partially loaded history.
- Photos attached to a correction are additional attachments; preserve originals.

Admins use the separate operational progress override for state changes. Its reason is stored in backend audit history; it is not emitted as a driver timeline event, and this feature has no audit-history read endpoint. Do not invent an admin-change timeline event or persist a local-only audit entry as server history.

## 12. Feedback admin overview and booking detail

Add an overview using `GET /api/v1/admin/timeline/trips`:

- Booking reference and route.
- Assigned driver.
- Scheduled time and operational status badge.
- Latest received update with occurrence and receipt time where helpful.
- Actual start/completion details.
- Action to open the booking timeline.
- “All active trips completed/cancelled—ready to close” when `readyToClose` is true.

The overview only includes unarchived trips. A booking's timeline can still include recorded events for archived trips. Unknown progress must read “Progress not recorded”, never “Scheduled” or “Completed” based on dates/feedback.

Booking closure remains the existing explicit admin booking action. Readiness is advisory and does not close bookings, start feedback or change core commercial state. Do not add an invented requirement that passenger feedback must be submitted for operational completion. Preserve whatever validation the existing booking closure API already enforces.

Use periodic refresh consistent with the app, e.g. a modest interval while visible. Pause/reduce polling on hidden pages, clean up on unmount and never reset an open draft, modal or scrolled timeline on refresh. Provide manual refresh and show last successful refresh/error state. Avoid unbounded fetching or silently dropping pages on a late update.

## 13. Driver link administration

Place actions on the feedback booking detail, grouped by currently assigned driver. One booking can have multiple drivers. The same driver returning later can use one booking–driver link for all currently granted trips; this does not depend on consecutive feedback engagement grouping.

Actions:

- **Issue/copy or refresh access:** POST with `{}`. An existing valid token is reused; current trip grants are refreshed and expiry preserved unless explicitly changed. For a new link the default is booking end + 24 hours. The frontend may copy the returned full URL or share it through an existing user-initiated share sheet.
- **Regenerate:** POST with `{ "regenerate": true }`, optionally with a future expiry. Explain that previous links become unusable and require the admin's deliberate confirmation.
- **Extend expiry:** POST with `{ "expiresAt": "<ISO timestamp>" }`. Validate a future value; the upper bound is 30 days after the later of booking end or current time. Normal extension reuses a valid token.
- **Revoke:** DELETE; explain that link access stops, while logged-in access to still-assigned trips is unaffected.

Display the returned expiry and driver/booking clearly. There is no readonly endpoint listing link state. Do not issue links automatically from renders or polling just to display link status. Offer explicit issue/refresh, and display information returned by that action.

For already-ended bookings where default expiry would be in the past, ask for an explicit future expiry. `DRIVER_LINK_URL_NOT_CONFIGURED` means the backend landing URL needs configuration; show an admin setup message rather than a driver authentication error.

Do not automatically send links via WhatsApp, email or another service. The API does not deliver them. Existing manual sharing can be reused when explicitly triggered by the admin; do not assume the timeline endpoints return a driver phone number.

Assignment changes invalidate grants for changed trip versions. Removing the driver's last active assignment revokes the pair link. Cancellation/archive revokes links, and reactivation does not revive them. Refresh/reissue access after reassignment, new trip assignment or operational reopening, and show the new context to the driver.

## 14. Admin operational override/reopening

Use `PATCH /api/v1/admin/timeline/trips/:id/progress` with one of SCHEDULED, IN_PROGRESS, COMPLETED or CANCELLED, plus a nonblank reason up to 1,000 characters. UNKNOWN is not an override option.

Show the selected trip, current status, requested status and mandatory reason. Explain that this creates a new operational cycle, resets actual timing for that status and invalidates old queued assignment versions/link grants while preserving recorded history. Require deliberate confirmation for this consequence.

The feedback booking must be ACTIVE and trip unarchived. If the booking has already been completed, use the existing authorised booking reopening flow first; do not bypass backend permissions or mutate core state.

After success, refetch overview, booking/trip data and driver context; invalidate affected caches. Provide a reminder/action to refresh the driver's booking link. Do not assume the progress response contains the new assignment version; reload context/overview to obtain it.

Completed trips require reopening before changing drivers. Trips with timeline history or recorded operational activity cannot be moved to another booking. Keep existing schedule-editing validation and feedback locks visible; operational functionality does not remove those existing feedback restrictions.

## 15. Error and recovery behaviour

Use backend error codes to choose recovery actions, retaining request IDs for support without credentials.

| Error/code family                                                                                        | UI response                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| DRIVER_LINK_INVALID                                                                                      | Link invalid, expired or revoked; keep unsent work and request current access                                                               |
| DRIVER_ACCESS_REQUIRED                                                                                   | Active driver access unavailable; do not retry indefinitely                                                                                 |
| DRIVER_BOOKING_NOT_ASSIGNED / TRIP_ACCESS_DENIED                                                         | Assignment not authorised; reload safe context if possible and retain queued work                                                           |
| TRIP_ASSIGNMENT_CHANGED                                                                                  | Assignment version changed; stop sync and retain original work for admin resolution                                                         |
| BOOKING_NOT_AVAILABLE                                                                                    | Booking unavailable/cancelled/archived or cannot accept this operation                                                                      |
| DRIVER_REPORTING_WINDOW_CLOSED                                                                           | Reporting window closed; admin may extend access                                                                                            |
| TIMELINE_RETRY_CONFLICT                                                                                  | Existing event ID used with different data; stop, preserve both draft/envelope details and resolve without regenerating an ID automatically |
| TIMELINE_TIME_INVALID / TIMELINE_LOCATION_TIME_INVALID                                                   | Explain clock/time problem; permit draft correction only before first submission or after a definitive rejection                            |
| TRIP_OPERATION_COMPLETED / TRIP_COMPLETION_BEFORE_START / TRIP_OPERATION_CANCELLED                       | Explain progress conflict; retain the entry and show appropriate admin-reopening action/message                                             |
| TIMELINE_CORRECTION_INVALID / TIMELINE_EVENT_EMPTY                                                       | Inline validation; preserve entered content                                                                                                 |
| TIMELINE_PHOTO_INVALID / TIMELINE_PHOTO_EXPIRED / TIMELINE_PHOTO_NOT_FOUND / TIMELINE_PHOTO_SIZE_INVALID | Recover upload/draft state without dropping the rest of the event                                                                           |
| PHOTO_STORAGE_UNAVAILABLE                                                                                | Photos currently unavailable; explicit choice to continue without them before first event submission                                        |
| DRIVER_LINK_URL_NOT_CONFIGURED / DRIVER_LINK_EXPIRY_INVALID                                              | Admin setup/expiry correction                                                                                                               |
| TRIP_TIMELINE_BOOKING_LOCKED / BOOKING_CHANGED                                                           | Explain editing restriction/concurrent change and refetch                                                                                   |
| 429, transient 5xx, network timeout                                                                      | Bounded exact retry with clear pending state                                                                                                |

Don't map every 401/403 to the application's generic sign-in redirect on the public link page. Do not infer a more specific reason than the API returns.

## 16. Accessibility, usability and responsive states

Provide keyboard navigation, meaningful button labels, visible focus, labelled form controls, screen-reader feedback for send/queue/upload state, and status text in addition to colours. Modals should handle focus correctly; do not move focus during polling.

Every screen needs loading, empty, error, retry, access-unavailable, offline and success states. Distinguish “No updates yet” from “Could not load updates”. Use responsive cards on mobile and the existing table/detail patterns on desktop. Photo viewers and timestamp/location details must remain usable on small screens.

Keep technical assignment/version/token details in development diagnostics, not routine driver copy. Drivers should understand which trip they are updating, whether the update reached the admin, and what to do if it did not.

## 17. Required verification

Add meaningful tests using the project's established tools. Prioritise observable behaviour over implementation-mirroring snapshots.

Verify:

1. Login and link entry share the driver UI but use correct endpoint/auth adapters.
2. A link opened by an already logged-in different driver still uses link identity.
3. Fragment tokens are removed from the address, excluded from logs/cache keys/exports, and not forwarded to storage uploads.
4. Core/customer roles cannot enter feedback-admin timeline UI; backend denial is handled.
5. UNKNOWN, SCHEDULED, IN_PROGRESS, COMPLETED and CANCELLED display/action rules remain separate from feedback status.
6. Drop-off does not auto-complete a trip; completion does not close the booking or start passenger feedback.
7. Opening/refreshing the page does not create events or issue links.
8. Double taps, a timed-out accepted POST, reconnects and multiple queue workers use the same ID/envelope and reconcile one receipt/event.
9. OFFLINE_SYNC is selected before first offline submission; uncertain ONLINE attempts preserve ONLINE on retry.
10. Queue ordering preserves start-before-completion, and blocked items survive reload/reauthentication.
11. Assignment changes, admin reopening, expired/revoked links, cancellation and reporting-window closure block automatic retries without deleting work or rewriting versions.
12. Location denial/timeout does not block reporting; invalid coordinates and device-clock errors display useful recovery.
13. Photo PUT requests use raw blobs and returned headers without API credentials; only verified own-assignment IDs enter frozen event bodies.
14. Upload expiry, verification rejection, optional removal before submission, private URL expiry and photo-only NOTE are handled.
15. Correction history preserves original data, applies only supplied fields and reconciles correction events arriving on later pages.
16. Timeline pagination/order and late received events reconcile without duplicates or false newest-first claims.
17. Link issue/extension/regeneration/revocation and expired default expiry behave correctly without mutation-on-render.
18. Admin progress requires a reason and refreshes affected caches/access; incomplete operational progress never masquerades as completed feedback/core state.
19. Existing passenger feedback collection, sharing, engagement management and core screens still work.
20. Loading/empty/error/offline states and mobile/keyboard accessibility are usable.

Run applicable type, lint, build and test checks. Exercise important flows against the updated backend or faithful request-level test fixtures, including new 201 and replay 200 receipts. Document any environment-dependent check that cannot be performed.

## 18. Completion and deployment handoff

Deliver the implementation, not just an outline. At completion, provide:

- The implemented driver/admin/public routes and affected components.
- The shared API adapters/types and offline queue behaviour.
- The exact public route chosen and the corresponding deployment URL needed for `DRIVER_BOOKING_URL`, without inventing a hostname.
- Frontend origin/R2 CORS and backend deployment requirements.
- Checks run, outcomes and material remaining limitations.
- Any specific backend contract gaps, with concrete examples and no invented endpoints.

Do not publish/deploy automatically unless separately authorised. Keep this feature in the feedback product throughout the implementation and retain the existing core and passenger feedback flows.
