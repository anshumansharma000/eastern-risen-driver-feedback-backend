# Driver Feedback Frontend Reference

**Product:** Eastern Risen Driver Feedback Service  
**Organization:** Eastern Risen Expedition Pvt. Ltd.  
**Status:** Living frontend reference  
**Last updated:** 2026-07-22  
**Frontend stack:** Next.js, TypeScript, Tailwind CSS  
**Initial locale:** English  
**Display timezone:** `Asia/Kolkata`

## 1. Purpose and authority

This file is the living reference for frontend architecture, information hierarchy, visual language, reusable interaction patterns, optional UI reference images, and frontend-specific decisions.

Authority order:

1. [PRODUCT.md](PRODUCT.md) defines product behavior, roles, permissions, privacy, analytics, and acceptance criteria.
2. The live backend OpenAPI contract defines available endpoints, validation, payloads, responses, and error codes.
3. [FRONTEND_API_REFERENCE.md](FRONTEND_API_REFERENCE.md) translates the implemented API contract for frontend use.
4. [DATA_MODEL.md](DATA_MODEL.md) explains lifecycle and data invariants.
5. This file defines how those requirements are presented and implemented in the frontend.
6. [FRONTEND_PROMPT.md](FRONTEND_PROMPT.md) is the reusable coding-agent brief derived from these sources.

If a visual reference conflicts with the product or API contract, the reference image does not override the contract. Record meaningful changes here as they are approved.

## 2. Product summary

The application collects structured passenger feedback immediately after a trip, usually on a phone or tablet owned by the driver. The same responsive web product serves three roles with strict privacy boundaries.

| Role | Primary job | UI character | Prohibited exposure |
| --- | --- | --- | --- |
| Passenger | Complete one feedback response and optionally receive a reward | Warm, guided, linear, touch-first | Other responses, driver/admin navigation, operational data |
| Driver | Find/create a trip, start handoff, see sync status and own aggregates | Fast, direct, mobile-first | Individual responses, comments, passenger PII, other drivers |
| Admin | Manage data and questionnaires, review feedback and analytics | Structured, responsive, desktop-first | Editing submitted answers; actions beyond backend authorization |

## 3. Experience principles

1. **Safe handoff:** switching from driver to passenger mode is deliberate; leaving it requires a driver-only action.
2. **One clear next action:** especially in the driver and passenger experiences.
3. **Privacy by presentation:** show only what each role needs, including in errors, queue states, URLs, and notifications.
4. **Trust under weak connectivity:** preserve passenger work, classify failures correctly, and retry safely without making promises the server has not confirmed.
5. **Honest system state:** distinguish saved, queued, synchronized, failed, inactive, archived, draft, and published states in words, not only colors.
6. **Aggregates need context:** pair every average with its response count and selected period.
7. **Accessible by default:** keyboard, touch, screen reader, contrast, focus, motion, and error handling are core behavior.
8. **Progressive density:** passenger pages are sparse; driver pages are compact; admin pages can be denser while preserving hierarchy.

## 4. Information architecture

Recommended route organization (adapt if an existing frontend establishes a compatible convention):

```text
app/
  (auth)/
    admin/login/
    driver/login/
    forgot-password/
    reset-password/
  (driver)/driver/
    page.tsx
    trips/
    performance/
    pending-sync/
  (passenger)/feedback/
    page.tsx
    details/
    questions/
    review/
    complete/
    reward/
    hand-back/
  (admin)/admin/
    page.tsx
    feedback/
    trips/
    drivers/
    vendors/
    vehicles/
    questionnaires/
    rewards/
    reports/
    settings/
```

### Navigation rules

- Passenger pages have no global application navigation.
- Driver navigation contains Home/Trips, Performance, Sync status, and Account/Sign out.
- Admin navigation contains Dashboard, Feedback, Trips, Drivers, Vendors, Vehicles, Questionnaires, Rewards, Reports, and Settings. Hide or mark modules not supported by the current API; never fake persistence.
- Preserve useful admin filters in URL search parameters.
- Do not put feedback tokens, reset tokens, passenger data, or coupon codes into URLs unless a backend-designed single-use reset route explicitly requires a token.

## 5. Core screen inventory

### Authentication

- Driver sign-in: driver code, password, forgot-password entry.
- Admin sign-in: email, password.
- Forgot/reset password: implementation depends on backend availability; do not imply an email was sent unless confirmed.
- Session expired, access denied, and service unavailable states.

### Driver

- Home with ready/today's trips and **Enter trip manually**.
- Trip list with status and pagination.
- Trip details with route, vehicle, schedule, source, and explicit handoff confirmation.
- Manual trip form.
- Performance overview with month filter, overall average, category averages, and counts.
- Pending synchronization summary with counts and retry state only—never response contents or passenger PII.

### Passenger

- Welcome/trip context.
- Passenger details and consent.
- Questionnaire progress and accessible question controls.
- Review and submit.
- Connected thank-you or server-authoritative reward result.
- Safe hand-back state.
- Non-retryable problem state for expired/invalid handoff or contract errors.

### Admin

- Dashboard and analytics.
- Feedback list/detail and flag/archive controls.
- Trips list/create/detail/edit/archive.
- Drivers list/create/detail/edit/status/password reset.
- Vendors list/create/edit/status.
- Vehicles list/create/edit/status.
- Questionnaire list, version detail/editor, publish/archive actions, consent management.
- Rewards, reports/exports, and settings when APIs exist.

## 6. Visual system

Official brand assets have not yet been supplied. Everything in this section is provisional and should be expressed as semantic tokens so it can be replaced without component rewrites.

### Desired character

- modern, sleek, minimal, and trustworthy;
- warm travel/expedition identity rather than a generic SaaS dashboard;
- restrained route, horizon, landscape, or sunrise motifs;
- high readability and strong operational clarity;
- minimal decorative motion.

### Provisional token roles

The exact color values should be chosen and contrast-tested during frontend implementation.

| Token role | Intended use |
| --- | --- |
| `background` | Warm neutral app canvas |
| `surface` | Cards, forms, panels, dialogs |
| `surface-subtle` | Grouped rows, secondary regions, table headers |
| `foreground` | Primary ink/slate text |
| `muted-foreground` | Secondary labels and metadata with AA contrast |
| `primary` | Sunrise/amber action and brand accent |
| `primary-foreground` | Text/icons on primary |
| `secondary` | Muted teal/blue informational accent |
| `border` | Subtle structural separation |
| `success` | Confirmed success/active/synchronized |
| `warning` | Pending, attention, low inventory |
| `danger` | Destructive action, failure, negative alert |
| `focus` | Highly visible keyboard focus ring |

Use status tokens semantically. Do not use danger red as general decoration. Dark mode is not an MVP requirement unless later approved.

### Typography and geometry

- Use a highly readable sans-serif; prioritize performance and Indian-script readiness even though MVP is English-only.
- Keep body copy at a comfortable mobile reading size; never reduce critical labels to tiny metadata.
- Use tabular numerals for metrics, dates, inventory, and rating comparisons where beneficial.
- Prefer moderate corner radii, thin borders, and soft low-elevation shadows.
- Avoid excessive pills, glassmorphism, gradients behind body text, and ornamental dashboard charts.
- Passenger touch controls should be at least approximately 44×44 CSS pixels.

### Density by role

- Passenger: single-column, generous spacing, one primary action, persistent but unobtrusive progress.
- Driver: single-column or compact tablet split view, prominent trip cards and route information.
- Admin: responsive sidebar and content grid; tables on desktop with card/priority-column adaptations on small screens.

## 7. Reusable component map

### Foundations

- `Button`, `IconButton`, `LinkButton`
- `Input`, `Textarea`, `Select`, `Checkbox`, `RadioGroup`, `Switch`
- `Field`, `FieldError`, `FormSummary`
- `Card`, `Panel`, `Dialog`, `AlertDialog`, `Drawer`
- `Alert`, `Toast`, `InlineStatus`, `StatusBadge`
- `Skeleton`, `EmptyState`, `ErrorState`
- `DataTable`, `Pagination`, `FilterBar`
- `PageHeader`, `SectionHeader`, `MetricCard`

### Domain components

- `TripCard`, `TripRoute`, `TripStatusBadge`, `TripSourceBadge`
- `HandoffConfirmation`, `PassengerTripSummary`
- `QuestionRenderer`, with a component per question type
- `RatingInput`, `RatingDisplay`, `CategoryScore`
- `QuestionnaireVersionBadge`, `QuestionEditor`, `QuestionOrderList`
- `SyncStatusIndicator`, `PendingSyncSummary`
- `FeedbackReviewStatus`, `NegativeFeedbackCallout`
- `DriverSourceComparison`, `RatingTrendChart`
- `ExportScopeSummary`, `RewardInventoryStatus`

Centralize enum-to-label, enum-to-icon, and enum-to-tone mappings. Icons must have adjacent text or accessible names where meaning matters.

## 8. Data and API conventions

### Current base contract

- Local API: `http://localhost:3000`
- Development OpenAPI UI: `http://localhost:3000/docs`
- Auth: opaque HttpOnly database-backed cookie, `SameSite=Lax`, secure in production
- Browser session calls: `credentials: 'include'`
- Resource success: `{ data: ... }`
- Collection success: `{ data: [...], pagination: { page, pageSize, total } }`
- Empty success: HTTP `204` with no body
- Error: `{ error: { code, message, details?, requestId } }`
- Request correlation: `x-request-id`

Use a single typed client boundary that:

1. resolves base URL from validated configuration;
2. includes session credentials where needed;
3. supports passenger Bearer token calls without leaking the token;
4. parses `204` safely;
5. normalizes API/network errors;
6. preserves status, code, field details, and request ID;
7. exposes retryability explicitly rather than treating every failure as offline.

### Implemented endpoint groups as of 2026-07-22

- Authentication: admin login, driver login, logout, current user.
- Admin: vendors, drivers, vehicles, trips, questionnaires, versions/questions, consent versions.
- Driver: trip list/create/detail and start feedback.
- Passenger: feedback context and feedback submission.

See [FRONTEND_API_REFERENCE.md](FRONTEND_API_REFERENCE.md) for frontend integration details and [README.md](README.md) for the compact current endpoint list. Verify both against OpenAPI before wiring UI. Analytics, feedback review, rewards, exports, password reset, and driver aggregates may require backend work if not present in the live contract.

## 9. Passenger submission and offline queue

This is a security- and reliability-critical workflow.

### Online path

1. Driver starts feedback and receives a one-time `feedbackAccessToken` and expiry.
2. Passenger context is loaded with the Bearer token.
3. The exact questionnaire snapshot is retained unchanged.
4. A UUID `clientSubmissionId` is generated before the first attempt.
5. The client submits respondent data, consent timestamp, answers, questionnaire version/snapshot, client submission ID, submitted timestamp, and `submissionMode: ONLINE`.
6. HTTP `201` is a new accepted submission; HTTP `200` with `replayed: true` is an idempotent receipt.
7. Sensitive form/context state is cleared and the flow proceeds to reward or thank-you as allowed by the receipt.

### Offline/retryable failure path

1. Build the same immutable envelope before attempting submission.
2. If offline or a genuinely retryable transport failure occurs, place it in an IndexedDB-backed queue with the token and required retry metadata protected from normal UI access.
3. Proceed to thank-you/hand-back without exposing queued status to the passenger.
4. Retry when connectivity returns, on app start, and through a controlled manual retry mechanism.
5. Use the same `clientSubmissionId`, unchanged questionnaire snapshot, and `submissionMode: OFFLINE_SYNC`.
6. Remove local data only after confirmed acceptance/replay.
7. Offline/queued feedback is not reward eligible; never show the wheel.

### Do not queue

- client-side validation errors;
- backend validation errors;
- `401`/`403` authorization failures;
- expired/invalid feedback token;
- duplicate-trip conflict with a different client submission ID;
- other known non-retryable domain conflicts.

Queue UI visible to a driver may show only counts, age, sync state, and generic recovery actions. It must not expose the passenger name, contact information, answers, comments, or token.

## 10. Forms and validation

- Match backend length, format, required, and enum constraints.
- Keep the backend as the final validator.
- Preserve entered values after recoverable errors.
- Place field errors next to fields and provide an accessible form-level summary for long forms.
- Disable repeated submission while a request is active, but preserve idempotency if a retry still happens.
- Confirm destructive or consequential actions: archive, deactivate, questionnaire publish, feedback handoff, and export containing personal information.
- Do not use disabled buttons as the only explanation; provide visible guidance for unmet prerequisites.

Question value shapes must be validated against the immutable snapshot and question type. Do not coerce unknown server data silently.

## 11. State language

Use consistent user-facing labels:

| API state | Preferred label |
| --- | --- |
| `READY` | Ready for feedback |
| `FEEDBACK_STARTED` | Feedback started |
| `SUBMITTED` | Feedback received |
| `ARCHIVED` | Archived |
| `ADMIN_ASSIGNED` | Assigned by admin |
| `DRIVER_ENTERED` | Entered by driver |
| `ACTIVE` | Active |
| `DEACTIVATED` | Deactivated |
| `DRAFT` | Draft |
| `RETIRED` | Retired |
| pending local queue | Waiting to sync |
| actively retrying | Syncing |
| retryable failure | Sync needs attention |

Never describe a queued response as server-submitted. Never describe a client-selected reward as won; reward outcomes are server-authoritative.

## 12. Accessibility baseline

- WCAG 2.1 AA target.
- Semantic landmarks and logical headings.
- Visible focus, logical focus movement, and focus restoration after dialogs.
- Keyboard-operable star, emoji, choice, reordering, table, and dialog interactions.
- Text alternatives/accessibility names for icon-only and rating controls.
- Error messages programmatically tied to fields and announced on submission.
- Status and chart meaning available without color and outside canvas/SVG-only presentation.
- Reduced-motion behavior for transitions and reward animation.
- Contrast-tested default, hover, focus, disabled, selected, error, and chart states.
- Responsive zoom/reflow without loss of functionality.

## 13. Loading, empty, error, and edge states

Every data-backed screen should deliberately cover:

- first load and background refresh;
- no records and no filtered matches;
- partial data or an unavailable secondary widget;
- offline state;
- unauthorized and forbidden;
- session or handoff expiry;
- validation errors;
- retryable server/network error;
- non-retryable conflict;
- success and idempotent replay;
- archived/deactivated/read-only records;
- pagination boundaries;
- long names, routes, questions, and translated-length-like content.

Use skeletons only when the final geometry is reasonably known. Prefer a clear status message over indefinite spinners.

## 14. Testing and quality gates

Minimum automated coverage:

- API error normalization and retry classification;
- status label/tone maps;
- form validation and all questionnaire input types;
- role-aware layouts and access boundaries;
- driver trip creation/selection and handoff confirmation;
- online submission with stable idempotency ID;
- offline queue persistence, restart recovery, replay, and cleanup;
- no rewards for `OFFLINE_SYNC`;
- no passenger PII in driver sync UI;
- questionnaire draft editing and publish confirmation;
- responsive passenger and admin critical paths.

Before delivery, run formatting, lint, strict type-check, unit/component tests, production build, and the relevant end-to-end suite. Perform manual checks at narrow phone, tablet portrait/landscape, laptop, and wide desktop sizes.

## 15. Reference image workflow

Place supplied images in a documented frontend design/reference directory rather than production public assets unless they are licensed and intentionally shipped.

For each image, record:

- filename and date received;
- source/ownership if known;
- target role/page/component;
- adopted principles;
- intentionally rejected details and why;
- affected design tokens/components;
- approval status.

Do not copy another product's logo, trademark, proprietary illustration, exact copy, or distinctive branded composition. Reference images guide design decisions; they are not automatically production assets.

### Reference image log

| Date | Image | Applies to | Adopted guidance | Status |
| --- | --- | --- | --- | --- |
| — | No images supplied yet | — | Use provisional visual direction in this file | Open |

## 16. Open frontend decisions

- Official logo and asset variants.
- Final brand colors and typography.
- Exact supported browser/version matrix.
- Negative-feedback classification threshold and presentation.
- Reward probability/no-prize semantics and final wheel visual design.
- Analytics/chart endpoint contracts.
- Feedback review and export endpoint contracts.
- Password-reset endpoint and delivery behavior.
- Driver aggregate endpoint contract.
- Offline payload protection details appropriate to browser capabilities and threat model.
- Whether dark mode is desired after MVP.

Open decisions must not be silently presented as confirmed behavior.

## 17. Decision log

| Date | Decision | Reason | Status |
| --- | --- | --- | --- |
| 2026-07-22 | Use Next.js App Router, TypeScript strict mode, and Tailwind CSS | Confirmed frontend stack | Confirmed |
| 2026-07-22 | Maintain separate passenger, driver, and admin route groups/layouts | Reinforces role, privacy, and navigation boundaries | Proposed until frontend scaffold exists |
| 2026-07-22 | Store offline feedback in IndexedDB, not `localStorage` | Payload size, structured queueing, and reduced accidental exposure | Proposed; security design review required |
| 2026-07-22 | Use semantic provisional design tokens | Official brand system is not yet supplied | Provisional |
| 2026-07-22 | Treat optional UI images as references and log derived decisions here | Preserves consistency and auditability across iterations | Confirmed process |

## 18. Maintenance checklist

Update this file when any of these change:

- routes or navigation;
- role capabilities or privacy boundaries;
- backend endpoint availability or response contracts;
- design tokens, fonts, logo, or brand assets;
- approved reference images;
- component patterns or state language;
- offline and synchronization behavior;
- accessibility target or supported browsers;
- testing strategy;
- a provisional decision becomes confirmed or is reversed.

For material product changes, update [PRODUCT.md](PRODUCT.md) as well. For contract changes, update backend schemas/OpenAPI and tests before or alongside frontend integration.
