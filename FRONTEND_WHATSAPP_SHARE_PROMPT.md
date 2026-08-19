# Frontend implementation prompt: booking phone and WhatsApp feedback share

Implement the frontend changes for collecting a booking passenger's WhatsApp
number and opening a prefilled feedback invitation through `wa.me`. Inspect the
existing frontend architecture, routing, API client, form components, validation,
query/cache layer, notifications, styling, and test conventions first. Reuse
existing patterns and dependencies. Do not introduce a WhatsApp SDK, messaging
provider, backend send call, or new dependency unless the repository already has
an appropriate phone-input library.

## Backend contract

All authenticated requests must preserve the frontend's existing cookie/session
behavior.

### Booking writes

`POST /api/v1/admin/bookings` now requires:

```ts
interface CreateBookingRequest {
  bookingReference: string;
  passengerName: string;
  passengerPhone: string;
  startsAt: string;
  endsAt: string;
  notes?: string | null;
}
```

`PATCH /api/v1/admin/bookings/:id` accepts `passengerPhone?: string` in addition
to the existing editable fields.

The submitted phone must be canonical E.164 and match:

```text
^\+[1-9]\d{7,14}$
```

Examples:

```text
Valid:   +919876543210
Invalid: 9876543210
Invalid: +91 98765 43210
Invalid: +91-98765-43210
```

### Booking reads

Booking resources now include:

```ts
passengerPhone: string | null;
```

New bookings always have a value. Legacy bookings can return `null` until an
administrator edits them and supplies a number.

### Admin feedback share

Call this endpoint only after an administrator explicitly chooses to share:

```http
GET /api/v1/admin/trips/:tripId/feedback-link
```

Response:

```ts
interface AdminFeedbackShareResponse {
  data: {
    tripId: string;
    feedbackLink: string;
    feedbackAccessTokenExpiresAt: string;
    recipient: {
      name: string;
      phone: string | null;
    };
  };
}
```

This endpoint issues or reuses the trip's bearer feedback link. Do not call it
merely while rendering a list, prefetch it, log it, persist it in local storage,
or include it in analytics/error-reporting metadata.

## Booking UI requirements

1. Add a required `Passenger phone` or `WhatsApp number` field to booking
   creation.
2. Add the same field to booking editing so legacy records can be completed.
3. Prefer a country selector plus national-number input if an appropriate phone
   component already exists. Default the country selector to India (`IN`, `+91`)
   for convenience, but allow other countries.
4. Convert the UI value to canonical E.164 before submitting. Do not guess a
   country code from an unqualified number except through the explicit selected
   country.
5. If no phone library exists, use a plain input and require the administrator to
   enter `+` followed by country code and digits. Show helper text such as
   `Include country code, for example +919876543210`.
6. Validate before submission and map the backend validation error into the
   existing inline form-error presentation.
7. Display the stored number in booking detail. Follow the application's current
   privacy/display conventions; do not print it to console or telemetry.
8. When `passengerPhone` is `null`, clearly mark the legacy booking as missing a
   number and provide an `Add phone number` action that opens the booking edit
   flow.
9. Update API types, form defaults, mutations, cache invalidation, and affected
   tests/fixtures.

## WhatsApp share action

Add a `Share feedback on WhatsApp` action to the appropriate administrator trip
or booking-trip interface. Do not add it to passenger pages. Do not change the
driver flow unless that interface is explicitly intended to support this admin
action.

The action is available only when:

- the administrator is authenticated;
- the trip can still issue a feedback handoff (`READY` or `FEEDBACK_STARTED`);
- the booking has a passenger phone number; and
- a share request is not already in progress.

If the phone is missing, disable the action and show `Add a passenger phone
number to this booking before sharing on WhatsApp.` Provide a nearby route/action
to edit the booking.

On click:

1. Synchronously open a blank tab/window before awaiting the API request so
   browsers do not block it as an asynchronous popup.
2. Fetch `GET /api/v1/admin/trips/:tripId/feedback-link` using the existing API
   client and credentials.
3. Recheck `data.recipient.phone`; if it is `null`, close the blank window and
   present the missing-phone message.
4. Create this message, preserving the line breaks:

```text
Hi {recipient.name},

Thank you for travelling with Eastern Risen. We would appreciate your feedback about your recent trip.

Share your feedback here: {feedbackLink}
```

5. Convert the E.164 phone to the digits-only form required by `wa.me`:

```ts
const waNumber = recipient.phone.replace(/\D/g, '');
```

6. Build the URL by encoding the complete message, never by concatenating raw
   text:

```ts
const whatsappUrl = `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`;
```

7. Navigate the synchronously opened window to `whatsappUrl`. Set its opener to
   `null` where supported. If a window could not be opened, fall back to assigning
   the current page to `whatsappUrl` or render a normal anchor that requires one
   additional explicit click.
8. Keep the action in a loading/disabled state until the API call resolves.
9. On API failure, close the blank window, restore the action, and use the
   application's standard API error notification. Handle at least:
   `FEEDBACK_HANDOFF_UNAVAILABLE`, `ACTIVE_QUESTIONNAIRE_NOT_FOUND`,
   `ACTIVE_CONSENT_NOT_FOUND`, authentication expiry, and generic network errors.
10. Do not report success as `sent` or `delivered`. The frontend only opened a
    prefilled WhatsApp conversation; the administrator still has to press Send.

An acceptable helper shape is:

```ts
function buildWhatsAppShareUrl(phone: string, message: string): string {
  const waNumber = phone.replace(/\D/g, '');
  return `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`;
}
```

Keep the actual message construction separate from URL construction so both can
be unit tested.

## Security and behavior constraints

- Never place the feedback URL in logs, analytics events, toast diagnostics,
  persisted client caches, or browser storage.
- Never call an unofficial WhatsApp API.
- Never claim the message was sent; only say `WhatsApp opened` if feedback is
  needed at all.
- Do not attempt to detect whether the phone is registered with WhatsApp.
- Do not remove the leading `+` in stored or API-submitted E.164 values; remove
  non-digits only when building the `wa.me` path.
- Preserve accessibility: keyboard activation, visible focus, disabled/loading
  semantics, and an accessible name for the WhatsApp action.
- Ensure rapid repeated clicks cause only one API request/window.
- Keep the design consistent with the existing admin UI.

## Tests and acceptance criteria

Add tests appropriate to the repository for:

1. Booking create requires and submits a valid E.164 number.
2. Booking edit can add a phone to a legacy `null` record.
3. Invalid phone input is rejected inline.
4. Booking detail renders the stored number.
5. Missing phone disables share and exposes the edit path.
6. Share click calls the admin feedback-link endpoint exactly once.
7. The generated `wa.me` path contains digits only.
8. The message is encoded with the passenger name, exact feedback URL, and line
   breaks.
9. API failure closes the placeholder window and shows the standard error.
10. The UI never labels the action result as sent or delivered.

Run the repository's formatter, linter, type checker, unit tests, and production
build. Report the files changed, tests run, and any assumption that could not be
confirmed from the existing frontend.
