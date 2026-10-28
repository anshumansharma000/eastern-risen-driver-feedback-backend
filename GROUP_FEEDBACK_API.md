# Group passenger feedback

Feedback links can accept responses from multiple travellers. A traveller is identified
by their submitted phone number, with one response per normalized phone number and
driver engagement. The same phone can submit for another engagement in the same
booking. Phone ownership is not verified; this prevents accidental duplicate feedback.

## Rollout

Apply `drizzle/0028_group_feedback.sql` before deploying the updated API. Existing
links and submissions remain in single-response mode. Historical phone numbers
remain encrypted; no historical responses are rewritten or deleted.

The schema adds a keyed, engagement-scoped phone fingerprint for new submissions.
It is never returned by the public APIs. The existing field-encryption key also
protects these fingerprints and must stay stable; a future key rotation must
recompute fingerprints alongside re-encrypting stored phone numbers.

## Link generation

Use either of these new endpoints with the usual authenticated session cookie:

- `POST /api/v1/admin/engagements/:id/feedback-link`
- `POST /api/v1/driver/engagements/:id/feedback-link` (assigned driver only)

Request:

```json
{ "allowMultipleSubmissions": true }
```

Send `false` for a single-response link. `{}` preserves an existing link's mode;
for a new link the default is `false`. The body is required for these POST routes.
Unknown fields are rejected.

Response:

```json
{
  "data": {
    "engagementId": "uuid",
    "feedbackLink": "https://passenger.example/feedback?token=opaque-token",
    "feedbackAccessTokenExpiresAt": "2026-10-20T12:00:00.000Z",
    "allowMultipleSubmissions": true
  }
}
```

The admin response also includes the existing `recipient` object for the booking
organiser. It does not list all travellers. Driver responses omit `recipient`.

Existing `GET .../feedback-link` routes and the driver's `POST .../start-feedback`
route remain supported, preserve an existing mode, and now include
`allowMultipleSubmissions` in their responses. New links requested through those
routes default to single-response mode.

Mode changes are allowed only while the engagement is `READY`. Changing the mode
of a valid link preserves its URL, token, expiry, and questionnaire snapshot.
Once a traveller calls the passenger `/start` endpoint, a different mode returns
409 `FEEDBACK_LINK_MODE_LOCKED`, even before the first submission.

An explicit generation request renews an expired, open link with a new token and
normal handoff expiry. Started collections retain their original questionnaire
and consent versions. Renewal preserves existing responses and duplicate checks.
The previous token becomes invalid. Completed single-response collections and
manually closed group collections cannot be reopened through link generation.

## Passenger flow

Authentication, question answers, consent, submission receipts and photo-upload
endpoints keep their existing contracts. `GET /api/v1/passenger/feedback/context`
adds `data.allowMultipleSubmissions`.

Group flow:

1. Open the shared link, load context, and call `/start` after the introduction.
2. Collect this traveller's name, phone, email, consent, and answers.
3. Create a distinct `clientSubmissionId` for this response, retaining it for all
   retries and offline synchronization of the same response.
4. Submit to `/submissions`. Each traveller can attach their own optional photo;
   an attached photo cannot be reused for another response.
5. Show the normal success receipt. Other travellers can still use the same link
   until it expires or an admin closes the collection.

Phone numbers must include an international country code. The backend normalizes
spaces, parentheses, periods and hyphens, and converts an international `00` prefix
to `+`. For example, `+91 98765-43210`, `0091 (98765) 43210` and `+919876543210`
identify the same traveller. Missing country codes and invalid lengths return
400 `RESPONDENT_PHONE_INVALID`. No country is inferred from the booking.

A different submission ID using an already-used phone returns 409
`RESPONDENT_FEEDBACK_ALREADY_SUBMITTED`. Display:

> Feedback has already been submitted using this phone number for this engagement.

The response does not reveal prior answers or contact details. Do not mark the
whole engagement or shared link as closed when receiving this error. Archiving
a response does not make that phone eligible to submit again.

Retrying the same submission ID and phone returns 200 with the existing receipt
and `replayed: true`. Reusing an ID for a different phone or engagement returns
409 `CLIENT_SUBMISSION_ID_CONFLICT`. The database prevents concurrent duplicate
responses. Single-response links still reject any second respondent with
`ENGAGEMENT_FEEDBACK_ALREADY_SUBMITTED` and consume the link after acceptance.

## Collection status and closure

Group engagements remain `FEEDBACK_STARTED` after responses arrive. They keep the
existing restrictions on changing trip assignments and feedback sections. Expiry
blocks new responses without resetting the engagement or deleting responses;
status alone does not indicate whether a link is still usable.

An admin may end group collection with:

```text
POST /api/v1/admin/engagements/:id/close-feedback
```

No body; returns 204. It consumes the shared link, marks the engagement `SUBMITTED`,
and records an audit event. New submissions, context loads and starts are denied.
Already-accepted submission retries can still retrieve their receipt. Responses
and their separate review histories remain intact. Drivers cannot close collection.

Admin feedback lists, individual review, company views, and driver analytics
continue to count each accepted response separately.

## Frontend changes

- Add an “Allow feedback from multiple travellers” toggle when generating a link.
  Use the new POST route with an explicit boolean. Disable mode changes once
  passenger feedback has started.
- Read the returned mode rather than assuming every link is single-response.
- Keep each traveller's draft, upload and submission ID separate. A shared URL
  does not represent one globally completed response. An optional “Give feedback
  as another traveller” action must create a fresh draft and submission ID.
- Preserve the existing single-response success screen. For group links, explain
  that each traveller should use their own phone number; people sharing a number
  count as one respondent.
- Handle the respondent duplicate error separately from collection closure. Do
  not show another traveller's saved answers or receipt.
- Add an admin “Close group feedback” action with confirmation. Keep expiry and
  invalid-link handling; do not automatically generate a replacement link.

Use the existing engagement and passenger endpoint contracts in
[FRONTEND_ENGAGEMENTS_PROMPT.md](FRONTEND_ENGAGEMENTS_PROMPT.md) for the remainder
of the form and offline flow.
