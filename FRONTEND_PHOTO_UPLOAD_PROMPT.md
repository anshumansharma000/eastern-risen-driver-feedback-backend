# Frontend implementation prompt: optional feedback photo

Implement the optional passenger feedback photo experience and admin photo viewer against
the existing Eastern Risen Driver Feedback API. Follow the repository's current frontend
architecture, styling, API client, state-management, accessibility, and testing conventions.
Do not alter the questionnaire answer model or the existing feedback-token lifecycle.

## Passenger experience

Add a final optional step after the questionnaire/respondent/consent inputs are valid and
before the final feedback submission. The step should clearly say that the customer may
add one photo with the driver or skip it. Include concise privacy copy explaining that the
photo will be stored securely and visible only to authorised Eastern Risen administrators.

Provide two explicit actions:

1. **Take photo**: open a file input with
   `accept="image/jpeg,image/png,image/webp"` and `capture="environment"` so supported
   mobile browsers prefer the rear camera.
2. **Choose from library**: open a separate file input with the same `accept` value and no
   `capture` attribute.

Both actions ultimately produce one `File`. Show a local preview using `URL.createObjectURL`,
the filename when available, and formatted size. Provide **Replace**, **Remove**, and
**Continue without photo** actions. Revoke every object URL when it is replaced, removed,
or the component unmounts. Do not support multiple photos.

Accepted MIME types are `image/jpeg`, `image/png`, and `image/webp`. Reject any other
`File.type` before contacting the API. Perform a preliminary 10 MiB client-side size check,
but treat the server-returned `maxBytes` and server errors as authoritative. Do not claim
HEIC/HEIF support. If a device returns HEIC, explain that the customer can take a new photo
or continue without one.

The photo is optional. Any upload, connectivity, processing, or validation error must offer
**Try again** and **Continue without photo**. Never trap the customer on the photo screen.
If the application is offline, explain that photo upload needs a connection and allow the
existing offline feedback flow to continue without `photoId`.

## Passenger API sequence

Use the same `feedbackAccessToken` currently sent to the passenger context/start/submission
endpoints.

### 1. Create an upload intent

```http
POST /api/v1/passenger/feedback/photo-uploads
Authorization: Bearer <feedbackAccessToken>
Content-Type: application/json

{
  "contentType": "image/jpeg",
  "sizeBytes": 2451234
}
```

Allowed `contentType` values: `image/jpeg`, `image/png`, `image/webp`.

Successful response: HTTP `201`.

```ts
interface PhotoUploadIntentResponse {
  data: {
    id: string; // UUID; retain as the candidate photoId
    uploadUrl: string; // short-lived private R2 presigned URL
    method: 'PUT';
    headers: { 'Content-Type': string };
    expiresAt: string;
    maxBytes: number;
  };
}
```

### 2. Upload directly to R2

Send the original `File` directly to `data.uploadUrl`:

```ts
await fetch(intent.data.uploadUrl, {
  method: intent.data.method,
  headers: intent.data.headers,
  body: file,
});
```

Important requirements:

- Use exactly the method and headers returned by the API.
- `Content-Type` must exactly match the value used to create the intent.
- Do not use the application's normal API wrapper if it automatically adds JSON headers,
  credentials, cookies, an `Authorization` header, or a base URL.
- Do not send the feedback bearer token to R2.
- Do not log or persist the presigned URL.
- Treat any non-2xx R2 response as upload failure.
- If the intent expires, create a new intent rather than reusing it.

### 3. Complete and sanitize

After R2 returns success:

```http
POST /api/v1/passenger/feedback/photo-uploads/<intent.data.id>/complete
Authorization: Bearer <feedbackAccessToken>
```

There is no request body. Successful response: HTTP `200`.

```ts
interface CompletedPhotoResponse {
  data: {
    id: string;
    status: 'READY';
    contentType: 'image/jpeg';
    byteSize: number;
    completedAt: string;
  };
}
```

This call may take several seconds because the backend verifies the object, decodes it,
applies orientation, strips EXIF/GPS metadata, resizes it to fit within 2400×2400 without
enlarging, and stores a normalized JPEG under a private immutable key. Show a clear
processing state and prevent duplicate final-submission clicks while it is running.

### 4. Submit feedback

Only after completion returns `READY`, include the photo UUID in the existing final request:

```ts
interface SubmitFeedbackRequest {
  // all existing fields remain unchanged
  photoId?: string;
}
```

When the customer skips/removes the photo, omit `photoId` entirely; do not send `null`, an
empty string, the R2 URL, or the `File`. Preserve the existing `clientSubmissionId` across
retries. A selected but unfinished photo must not be included. If feedback is queued through
the existing offline-sync mechanism, omit `photoId`.

If the final submission returns `PHOTO_NOT_READY`, retry the completion call once when safe,
then allow the customer to retry or submit without the photo. If final submission succeeds,
clear all local photo state and never attempt to reuse its upload URL.

## Suggested passenger state machine

Use explicit states instead of loosely related booleans:

```ts
type PhotoState =
  | { kind: 'empty' }
  | { kind: 'selected'; file: File; previewUrl: string }
  | { kind: 'creating-intent'; file: File; previewUrl: string }
  | { kind: 'uploading'; file: File; previewUrl: string; photoId: string }
  | { kind: 'processing'; file: File; previewUrl: string; photoId: string }
  | { kind: 'ready'; previewUrl: string; photoId: string }
  | { kind: 'error'; file?: File; previewUrl?: string; message: string };
```

The exact implementation may adapt to existing conventions, but transitions must be
deterministic and stale async responses must not overwrite a newer replacement selection.
Use an `AbortController` where appropriate and/or an operation generation ID.

## Passenger error handling

Read the standard API error envelope and map these codes to useful UI:

- `PHOTO_TOO_LARGE` (`413`): explain the configured size limit and let the customer choose
  another image or skip.
- `PHOTO_INVALID` (`422`): file was not a valid supported image; choose another or skip.
- `PHOTO_UPLOAD_MISSING` (`409`): R2 upload did not arrive; create a new intent and retry.
- `PHOTO_UPLOAD_REJECTED` (`409`): choose a new image or skip.
- `PHOTO_NOT_READY` (`409`): complete processing before final submission.
- `PHOTO_ATTACHMENT_CONFLICT` (`409`): do not silently create a new feedback submission;
  preserve `clientSubmissionId` and offer retry/skip according to existing submission rules.
- `PHOTO_STORAGE_UNAVAILABLE` (`503`) or transport failure: explain that photos are temporarily
  unavailable and prominently offer submission without a photo.
- `FEEDBACK_HANDOFF_INVALID` (`401`) and `FEEDBACK_HANDOFF_UNAVAILABLE` (`409`): use the existing
  terminal handoff experience.

## Admin experience

The existing authenticated admin detail response now includes:

```ts
interface AdminFeedbackPhotoSummary {
  id: string;
  contentType: string; // currently image/jpeg
  byteSize: number;
  attachedAt: string;
}

interface AdminFeedbackDetail {
  // existing fields unchanged
  photo: AdminFeedbackPhotoSummary | null;
}
```

If `photo` is `null`, render no photo section or a restrained “No photo provided” state. If it
is present, show a photo card with size and attachment time plus a **View photo** action.

Fetch the private URL only on demand using the existing credentialed admin API client:

```http
GET /api/v1/admin/feedback/<feedback-submission-id>/photo-url
```

Successful response:

```ts
interface AdminFeedbackPhotoAccessResponse {
  data: {
    id: string;
    url: string;
    expiresAt: string;
    contentType: string;
    byteSize: number;
  };
}
```

The URL expires after approximately five minutes. Do not store it in persistent state,
localStorage, analytics, or logs. Hold it in component memory only. If the image fails after
expiry, request a fresh URL. Display it with meaningful alt text such as
“Passenger-provided trip photo with the driver”; never include passenger contact details in
the alt text. Preserve the existing admin authorization and credential behavior.

## Tests and acceptance criteria

Add tests consistent with the frontend stack that verify:

1. Camera and library actions use the correct file-input attributes.
2. Unsupported and oversized files are rejected before creating an intent.
3. Preview replacement/removal revokes old object URLs.
4. The direct R2 request uses exactly the returned method/header and sends no app auth.
5. Completion occurs only after a successful R2 upload.
6. Final submission includes a READY `photoId` and omits it when skipped.
7. Upload failure never blocks feedback submission without a photo.
8. Stale async upload results cannot replace a newer selection.
9. Admin details render the nullable photo state correctly.
10. Admin signed URLs are fetched on demand and refreshed after expiry/failure.

Keep the experience mobile-first, keyboard accessible, screen-reader labelled, and clear
about progress. Do not add frontend Cloudflare credentials, an S3 SDK, public bucket URLs,
or any facility for listing bucket objects.
