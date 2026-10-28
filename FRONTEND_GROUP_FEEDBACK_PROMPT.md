# Frontend implementation prompt: group passenger feedback

Implement group passenger feedback in the existing frontend. Inspect repository instructions,
current engagement sharing screens, the passenger feedback form, API client, authentication,
query caches, photo uploads and offline queue before editing. Follow the existing framework,
design system and test conventions. Deliver working implementation and tests.

Database migration `0028_group_feedback` has been applied to the configured backend database
and verified. Ensure the updated backend API is running before rollout; applying a database
migration does not deploy API code. The backend contract is described in `GROUP_FEEDBACK_API.md`
in the backend repository.

## Product behaviour

An admin or assigned driver can generate one feedback link for a group and share it once.
Multiple travellers may submit through it, with one accepted response per normalized phone
number per driver engagement. The same phone may submit for another engagement in the same
booking. Phone ownership is not verified: do not add OTP or account registration.

Single-response links remain the default. Each traveller supplies their own respondent details,
answers, consent and optional photo. People sharing a phone number count as one respondent.

## Link generation and sharing

Add an “Allow feedback from multiple travellers” toggle to the existing admin and driver
engagement feedback-link generation/share UI.

Generate using the existing session-cookie API client:

- `POST /api/v1/admin/engagements/:id/feedback-link`
- `POST /api/v1/driver/engagements/:id/feedback-link`

Send `{ "allowMultipleSubmissions": true }` for a group or `false` for a single-response link.
The request body is required. `{}` preserves an existing mode and defaults a new link to false.
When selecting a mode, send the explicit boolean; never accidentally reset a known group link
because a checkbox was initialized to false.

Both responses contain `data.engagementId`, `data.feedbackLink`,
`data.feedbackAccessTokenExpiresAt` and `data.allowMultipleSubmissions`. Admin responses also
include the existing `recipient: { name, phone }` for the booking organiser. Drivers receive
no recipient object. Preserve current copy/share behaviour, and use group-appropriate share
text inviting each traveller to respond with their own phone number.

Existing GET feedback-link routes and the driver POST start-feedback route remain supported
and return the mode. Treat the returned value as authoritative. Mode changes are allowed only
while the engagement is READY; disable the toggle after passenger feedback starts. A change
after that returns 409 FEEDBACK_LINK_MODE_LOCKED: explain that the collection mode is fixed,
reload authoritative state, and preserve the current link. Selecting a different mode before
start preserves a valid URL, token and expiry.

## Passenger form and submission

`GET /api/v1/passenger/feedback/context` adds `data.allowMultipleSubmissions`. Read it and extend
frontend response types/runtime validation. Keep the existing questionnaire, consent and
submission payload contracts. Continue extracting the feedback URL's `?token=...` and sending
it as `Authorization: Bearer <token>` through the existing passenger API client.

Keep the normal introduction and explicit POST `/api/v1/passenger/feedback/start` flow.
For a group, show concise copy explaining that each traveller can give feedback once for this
part of the journey, using their own phone number. Require a country code. The backend accepts
international numbers with spaces, parentheses, periods or hyphens and an international `00`
prefix, then normalizes them. Do not infer a country from the booking.

Create a separate draft and clientSubmissionId for every traveller's response. Retain the
same ID for double taps, retries and offline synchronization of that response. Do not regenerate
an ID automatically after a timeout or duplicate error. Keep uploads and photoIds attached to
their own response; never reuse another traveller's photo or answers.

POST `/api/v1/passenger/feedback/submissions` still returns 201 for a new response and 200 with
`replayed: true` for a retry. Preserve the usual thank-you screen. Submitting group feedback
must not mark the entire link or engagement completed in client state. Do not persist a
link-wide “already submitted” flag that blocks other travellers. If offering “Give feedback as
another traveller”, start a clean draft with a new ID and respondent details, after resolving
any pending work. Keep single-response completion behaviour intact.

Handle these errors explicitly:

- 409 RESPONDENT_FEEDBACK_ALREADY_SUBMITTED: “Feedback has already been submitted with this
  phone number for this part of your journey.” Do not close the shared link or expose previous
  answers or receipts. Preserve unsent work until the traveller chooses to discard it.
- 400 RESPONDENT_PHONE_INVALID: show a phone-field error requiring a valid international number.
- 409 CLIENT_SUBMISSION_ID_CONFLICT: retain the draft for recovery; do not silently retry with
  a new ID or associate the returned response with a different traveller.
- 409 ENGAGEMENT_FEEDBACK_ALREADY_SUBMITTED: preserve the existing single-response handling.
- 401 FEEDBACK_HANDOFF_INVALID: retain unsynced work and show unavailable/expired access;
  do not automatically generate or renew a link.

## Admin closure and collection state

Add an admin-only “Close group feedback” action with confirmation. Call
`POST /api/v1/admin/engagements/:id/close-feedback` with no body. Success is 204;
do not parse it as JSON. Refresh relevant engagement, booking and feedback caches.
Drivers cannot close collection.

Group engagements remain FEEDBACK_STARTED after individual responses arrive. Admin closure
marks them SUBMITTED and invalidates the link. Expiry blocks new responses but does not
necessarily change engagement status. Do not infer response count or link validity solely
from status, and do not invent collection-count, traveller-list or link-status endpoints.
Use existing admin feedback lists to show individual responses and existing analytics.

Explicitly renewing an expired open link changes its token while retaining existing responses,
phone deduplication and pinned questions. Closed collections cannot be reopened by generation.

## Verification and handoff

Test the toggle payload and persisted returned mode; disabled mode changes after start;
two travellers submitting through one link; formatted variants of the same number being
rejected as duplicates; the same phone succeeding for another engagement in the same booking;
idempotent retries; isolated drafts and photos; single-response compatibility; admin-only
closure and 204 handling; expired/closed links; and preservation of offline work on errors.

Use the existing test framework and meaningful mocked API responses or integration tests.
Run relevant tests, lint and type checks. Report changed screens, validation results and any
backend deployment dependency. Preserve existing passenger feedback, driver access and
questionnaire flows.
