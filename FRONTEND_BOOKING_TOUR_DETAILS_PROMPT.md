# Frontend implementation prompt: booking tour name and file number

Implement frontend support for two new optional booking fields: `tourName` and
`fileNumber`. Inspect the existing frontend architecture, booking API types,
create/edit forms, validation, form components, query/cache layer, detail and
list views, styling, and test conventions first. Reuse existing patterns and
dependencies. This task is only about booking metadata; do not implement or
change the arrival, overall-tour, or coordination feedback flows yet.

## Backend contract

All authenticated requests must preserve the frontend's existing cookie/session
behavior.

### Create a booking

`POST /api/v1/admin/bookings` accepts these new optional properties:

```ts
interface CreateBookingRequest {
  bookingReference: string;
  tourName?: string | null;
  fileNumber?: string | null;
  passengerName: string;
  passengerPhone: string;
  startsAt: string;
  endsAt: string;
  notes?: string | null;
}
```

### Update a booking

`PATCH /api/v1/admin/bookings/:id` accepts these properties in addition to the
existing editable properties:

```ts
interface UpdateBookingRequest {
  tourName?: string | null;
  fileNumber?: string | null;
}
```

Patch semantics:

- omit a property to leave it unchanged;
- send a string to set or replace it;
- send `null` to clear it;
- the backend trims surrounding whitespace and stores a blank/whitespace-only
  string as `null`.

### Booking responses

Every booking resource returned by create, list, detail, update, and archive now
includes:

```ts
interface Booking {
  // Existing properties remain unchanged.
  tourName: string | null;
  fileNumber: string | null;
}
```

Existing bookings will return `null` for both fields until values are added.

Validation limits:

- `tourName`: at most 200 characters when non-null;
- `fileNumber`: at most 100 characters when non-null.

Neither field is unique, and neither field is required.

## UI requirements

1. Add a `Tour name` text field to the booking create form. It is optional and
   must enforce a maximum length of 200 characters.
2. Add a `File number` text field to the booking create form. It is optional and
   must enforce a maximum length of 100 characters.
3. Add both fields to the booking edit form, prefilled from the booking resource.
4. When an administrator clears either edit field, submit `null` for that field.
   Do not omit a cleared field, because omission means "leave unchanged".
5. Trim values before submission. Convert an empty or whitespace-only value to
   `null` (or omit it during creation). Do not make either field required.
6. Show both values on the booking detail view using the existing metadata
   layout. Use the application's standard missing-value treatment (for example,
   an em dash) when a value is `null`.
7. If the booking list/table has a suitable existing metadata area, show `Tour
name` as useful secondary information. Avoid adding enough columns to make the
   table unusable on smaller screens. `File number` must remain available in the
   detail view even if it is not shown in the list.
8. Update API/domain types, form schemas, default values, create and update
   payload builders, cached booking data handling, fixtures, mocks, and affected
   tests.
9. Use the frontend's existing inline validation and API error presentation.
10. Preserve current responsive layout, labels, keyboard navigation, focus
    behavior, and accessible error association.

An acceptable normalization helper is:

```ts
function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
```

For create, sending either `null` or omitting an empty optional value is valid.
For edit, explicitly send `null` when a previously populated value has been
cleared.

## Tests and acceptance criteria

Add tests appropriate to the repository proving that:

1. Booking creation works with both fields omitted.
2. Booking creation submits trimmed `tourName` and `fileNumber` values when
   provided.
3. The create form rejects a tour name over 200 characters and a file number over
   100 characters.
4. The edit form loads the existing values.
5. Editing can change either field without requiring the other.
6. Clearing a populated field sends `null`, not `undefined` and not an omitted
   property.
7. Booking detail renders both populated values and handles both `null` values.
8. Existing booking behavior and payload fields are unchanged.

Run the repository's formatter, linter, type checker, unit tests, and production
build. Report the files changed, tests run, and any assumption that could not be
confirmed from the existing frontend.
