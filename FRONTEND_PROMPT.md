# Frontend Implementation Prompt — Eastern Risen Driver Feedback

Use this prompt with a coding agent when creating or extending the frontend. Read [PRODUCT.md](PRODUCT.md), [README.md](README.md), [DATA_MODEL.md](DATA_MODEL.md), [FRONTEND_API_REFERENCE.md](FRONTEND_API_REFERENCE.md), and [FRONTEND_REFERENCE.md](FRONTEND_REFERENCE.md) before writing code. If these documents disagree, `PRODUCT.md` is the product authority, the live OpenAPI document is the API authority, `FRONTEND_API_REFERENCE.md` is the frontend-oriented API guide, and `FRONTEND_REFERENCE.md` is the presentation and frontend-engineering authority.

---

## Prompt

You are a senior frontend engineer and product-minded UI designer. Build a production-quality frontend for **Eastern Risen Expedition Pvt. Ltd.'s Driver Feedback Service**.

The product collects passenger feedback after a trip on a driver-held phone or tablet. It has three sharply separated experiences:

1. **Passenger:** no login; completes a short, passenger-safe feedback flow after a driver hands over the device.
2. **Driver:** signs in, manages their assigned or manually entered trips, starts the passenger handoff flow, sees pending synchronization state, and views only their own aggregate performance.
3. **Administrator:** manages operational data and questionnaires, reviews feedback, analytics, rewards, and exports.

### Technology

- Next.js with the App Router
- TypeScript in strict mode
- Tailwind CSS
- Prefer Server Components for read-heavy shells and Client Components only where interaction, browser APIs, or local state require them.
- Use a small, accessible component system built from reusable primitives. If the repository already uses a component library, extend it rather than adding a competing one.
- Use React Hook Form plus schema-based validation when a form library is needed; keep validation aligned with the backend contract.
- Use a well-supported query/cache layer only if the app's interaction complexity justifies it. Do not duplicate server and client caches without a clear need.
- Generate or derive API types from the backend OpenAPI contract when possible. Do not maintain hand-written response types that drift from the API.
- Use an IndexedDB-backed queue for offline feedback payloads; do not store sensitive passenger submissions in `localStorage`.

Do not invent endpoints, permissions, aggregate formulas, reward outcomes, or lifecycle transitions. If a required backend capability is not implemented, build a typed adapter boundary and a clearly labeled mock/placeholder state, then document the gap.

### Product and visual direction

Create a modern, calm, minimal, trustworthy travel-service interface. It should feel operational and refined, not like a generic admin template. Use restrained journey, route, horizon, and sunrise cues. Keep illustration and decoration subordinate to clarity.

Until official brand assets are supplied, use provisional semantic tokens rather than hard-coded brand values:

- warm off-white or very light neutral page background;
- deep ink/slate text and navigation surfaces;
- warm sunrise/amber primary accent;
- muted teal/blue secondary accent;
- green, amber, and red only for meaningful status and feedback states;
- generous spacing, rounded but not excessively pill-shaped controls, subtle borders, and restrained shadows;
- readable humanist sans-serif typography with tabular numerals for metrics where useful.

The passenger flow should feel warmer and simpler than the admin experience. The driver experience should be fast, touch-friendly, and direct. The admin experience should be information-dense without becoming visually noisy.

### Optional reference images

Reference UI images may be added during implementation. When images are present:

1. Inventory each image and state which page, component, or interaction it influences.
2. Extract reusable principles: layout, hierarchy, spacing, density, typography, color roles, component geometry, navigation, and interaction behavior.
3. Do not blindly clone pixels or import another product's brand identity.
4. Reconcile references with accessibility, responsive behavior, this product's workflows, and existing design tokens.
5. Record accepted decisions in `FRONTEND_REFERENCE.md` under **Reference image log** and **Decision log**.
6. When references conflict, prefer the newest explicitly approved reference; otherwise preserve the established system and flag the conflict.

### Required information architecture

Use route groups and layouts to enforce clear separation. Adapt exact paths to the existing frontend if it already has conventions.

```text
/(auth)
  /admin/login
  /driver/login
  /forgot-password
  /reset-password

/(driver)
  /driver
  /driver/trips
  /driver/trips/new
  /driver/trips/[tripId]
  /driver/performance
  /driver/pending-sync

/(passenger)
  /feedback
  /feedback/details
  /feedback/questions
  /feedback/review
  /feedback/complete
  /feedback/reward
  /feedback/hand-back

/(admin)
  /admin
  /admin/feedback
  /admin/feedback/[feedbackId]
  /admin/trips
  /admin/trips/[tripId]
  /admin/drivers
  /admin/drivers/[driverId]
  /admin/vendors
  /admin/vehicles
  /admin/questionnaires
  /admin/questionnaires/[questionnaireId]
  /admin/rewards
  /admin/reports
  /admin/settings
```

Not all listed admin modules have backend endpoints yet. Gate unfinished modules honestly; do not present fake successful actions.

### Experience requirements

#### Authentication

- Provide separate driver and admin sign-in pages with role-appropriate language.
- Driver login uses driver code and password; admin login uses email and password.
- Authentication uses the backend's opaque HttpOnly session cookie. Requests must include credentials; never try to read or persist the cookie in JavaScript.
- Resolve the current principal through `/api/v1/auth/me` and enforce role-aware route guards on both server and client boundaries where appropriate.
- On `401`, clear private client state and return to the correct login page. On `403`, show a safe access-denied state without revealing data.
- Include loading, invalid-credential, deactivated-account, expired-session, and service-unavailable states.

#### Driver

- Design mobile-first for use at the end of a trip, often one-handed or on a tablet.
- Home should prioritize today's/ready trips and a clear **Enter trip manually** action.
- Visually distinguish `ADMIN_ASSIGNED` from `DRIVER_ENTERED` trips and show status without color alone.
- Trip cards should emphasize booking reference, scheduled date/time in `Asia/Kolkata`, pickup-to-destination route, vehicle, and feedback state.
- Require a clear confirmation before **Start feedback**. Explain that the screen is about to switch into passenger-safe mode.
- Starting feedback returns a one-time `feedbackAccessToken`. Keep it only for the handoff flow and its protected offline envelope; never place it in URL query parameters, logs, analytics, or normal persistent app state.
- Pending and failed offline submissions must be visible by count/status only. Never reveal passenger names, answers, phone numbers, email addresses, or comments to the driver.
- Performance shows overall and category arithmetic averages with response counts and month filtering. Do not support drill-down to individual responses.

#### Passenger feedback

- Make this a focused, linear, mobile/tablet-first flow with large touch targets, minimal navigation, clear progress, and no driver/admin navigation.
- Load passenger context from `/api/v1/passenger/feedback/context` using `Authorization: Bearer <feedbackAccessToken>`.
- Persist the exact questionnaire snapshot supplied by the API with the offline submission envelope. Submit the same snapshot unchanged.
- Show limited trip context: booking reference, route, scheduled time, vehicle, and driver display name. Do not expose operational or account data.
- Collect passenger name, phone, email, booking reference, and explicit consent. Show the active consent content before acceptance.
- Render all supported question types accessibly:
  - `STAR_RATING`
  - `EMOJI_RATING`
  - `YES_NO`
  - `SINGLE_CHOICE`
  - `MULTIPLE_CHOICE`
  - `TEXT`
- Required fields and questions must be validated before submission. Errors must be announced and associated with the corresponding control.
- Generate `clientSubmissionId` once, before the first submission attempt, and reuse it for every retry.
- Use `submissionMode: ONLINE` for the initial connected attempt and `OFFLINE_SYNC` for a queued retry.
- If connectivity is unavailable or a retryable network failure occurs, securely enqueue the complete immutable envelope in IndexedDB and move the passenger to the normal thank-you/hand-back experience. Do not tell the passenger that submission is pending.
- Never queue validation, authorization, expired-token, duplicate-conflict, or other non-retryable failures as if they were connectivity errors.
- Remove a queued payload only after a confirmed accepted or idempotently replayed receipt.
- Do not offer the reward wheel to offline/queued submissions. Offline submissions are reward-ineligible.
- A completion screen must not allow navigation back to view answers or passenger data. End in a clean hand-back screen requiring driver reauthentication or a driver-only unlock action.
- Warn before accidental browser navigation while an unsaved response exists, without trapping the user indefinitely.

#### Admin

- Build a responsive desktop-first shell with a collapsible sidebar, clear page titles, breadcrumbs only where useful, global account controls, and mobile fallbacks.
- Dashboard should prioritize overall rating, response count, rating trend, source comparison, and visibly surfaced negative feedback. Always display sample counts alongside averages.
- Do not invent the negative-feedback rule while its threshold is TBD. Encapsulate the rule behind configuration and label placeholder behavior clearly.
- Lists need URL-backed filters, pagination, sorting where supported, empty states, loading skeletons, recoverable error states, and archive/deactivation visibility.
- Driver management supports agency and outsourced sources; outsourced drivers require a vendor.
- Trip creation requires booking reference, passenger name, route, scheduled time, active vehicle, and active driver.
- Questionnaire editing must support ordered questions, supported types, category, required/optional, scored/not scored, options, and active/inactive/archive status. Make draft versus active/retired versions unmistakable. Publishing needs a consequence-aware confirmation because published versions are immutable.
- Submitted feedback content is read-only. Flag/archive controls modify review state only and must never imply answer editing.
- Export controls must repeat the active filters and explicitly state that phone and email are excluded by default.
- Reward configuration and analytics should be implemented only when supported by real API contracts. Server-selected outcomes must never be simulated as authoritative.

### API contract and error handling

- The development API defaults to `http://localhost:3000`; read the frontend API base URL from a validated environment variable.
- Include credentials for session-authenticated requests.
- Successful single-resource responses are `{ data: ... }`.
- Collections are `{ data: [...], pagination: { page, pageSize, total } }`.
- `204` responses have no body.
- Errors are `{ error: { code, message, details?, requestId } }`; every response also includes `x-request-id`.
- Translate known error codes into actionable UI copy. Keep the request ID in an expandable technical-details area or support message, never as the main error.
- Normalize errors in one typed API client layer. Avoid page-specific parsing of raw backend responses.
- Treat all timestamps as ISO timestamps from the server and display them in `Asia/Kolkata` unless later settings specify otherwise.
- Use the live OpenAPI document at `/docs` or its JSON endpoint as the final contract source. Verify exact operations before wiring a screen.

### State, security, and privacy

- Keep server state, local UI state, form state, and offline queue state conceptually separate.
- Never log passwords, reset tokens, feedback access tokens, coupon codes, passenger contact details, questionnaire answers, or offline envelopes.
- Never expose passenger PII in driver screens, notifications, queue status, telemetry, URLs, or error trackers.
- Do not place secrets or sensitive payloads in `localStorage`, query strings, server logs, or analytics events.
- Clear passenger form state and in-memory context after confirmed submission/queueing and when the safe hand-back state begins.
- Apply defense-in-depth in the UI, but rely on the backend for authorization and invariants.

### Accessibility and responsive behavior

- Target WCAG 2.1 AA.
- All flows must be operable by keyboard and touch.
- Minimum touch target approximately 44×44 CSS pixels.
- Use visible focus styles, semantic landmarks, logical heading order, descriptive labels, and screen-reader announcements for dynamic errors/status.
- Do not rely on color, icons, stars, or emoji alone to communicate meaning. Provide text or accessible names.
- Respect reduced-motion preferences; reward animation must be skippable/reduced and must reveal the exact server-selected result.
- Support narrow phones, tablets used in portrait/landscape, laptops, and wide admin screens. Do not simply shrink desktop tables onto phones; use responsive cards, priority columns, or safe horizontal scrolling as appropriate.

### Component and code quality expectations

- Establish semantic design tokens with CSS variables and map them into Tailwind.
- Create shared primitives for buttons, inputs, selects, dialogs, drawers, cards, status badges, tables, pagination, filters, alerts, empty states, skeletons, and toasts.
- Create domain components for trip route summaries, trip status, rating input/display, question renderer, questionnaire editor, score cards, pending-sync indicator, and feedback review state.
- Prefer composition over large conditional page components.
- Avoid `any`, unsafe casts, duplicated status-label maps, inline magic colors, and one-off spacing values.
- Co-locate tests with behavior or follow the repository's test convention.
- Add unit tests for validation, error normalization, status mapping, and offline retry classification.
- Add component tests for every question type and role-sensitive presentation.
- Add end-to-end tests for driver login → select/create trip → handoff; connected passenger submission; offline queue and later replay; safe hand-back; admin management; and role access boundaries.

### Required delivery sequence

1. Inspect the repository, installed dependencies, current conventions, OpenAPI contract, and supplied reference images.
2. Summarize the existing state and list contract gaps; do not overwrite established work without reason.
3. Propose the route map, component hierarchy, token system, and phased implementation plan.
4. Build the shared foundation and authentication boundary.
5. Build the driver and passenger MVP, including offline-safe submission.
6. Build admin modules supported by current APIs.
7. Add loading, empty, error, offline, forbidden, expired, and success states.
8. Test responsive layouts and keyboard/screen-reader behavior.
9. Run lint, type-check, unit/component tests, production build, and relevant end-to-end tests.
10. Update `FRONTEND_REFERENCE.md` with implemented routes, tokens, image-derived decisions, API gaps, and deviations.

### Definition of done

The work is complete only when:

- the three roles cannot cross into unauthorized experiences;
- the driver can select or create a valid trip and explicitly begin handoff;
- the passenger can complete every supported question type and consent flow;
- online submission is idempotent and offline submission persists and safely retries;
- rewards are unavailable offline and never chosen by the client;
- the passenger ends in a safe hand-back state with no prior answers exposed;
- driver performance exposes aggregates and counts only;
- supported admin CRUD/versioning flows reflect real lifecycle states;
- all meaningful screens include loading, empty, error, and responsive states;
- WCAG-oriented keyboard, focus, labeling, and reduced-motion behavior is present;
- no sensitive data leaks through logs, storage, routes, telemetry, or driver UI;
- lint, strict type-checking, tests, and production build pass;
- `FRONTEND_REFERENCE.md` accurately reflects the shipped implementation.

Before making material assumptions, check the source documents. If a decision remains genuinely open, choose the safest reversible default, label it provisional, and record it in the decision log.
