# Driver Feedback Service — Product Source of Truth

**Product:** Eastern Risen Driver Feedback Service  
**Organization:** Eastern Risen Expedition Pvt. Ltd.  
**Document status:** Authoritative product reference  
**Initial platform:** Responsive web application  
**Initial audience:** One travel agency  
**Language:** English  
**Last updated:** 2026-07-20

## 1. Purpose of this document

This document is the source of truth for the product. Backend behavior, API contracts, frontend requirements, analytics, exports, and acceptance criteria must be consistent with it.

The backend is developed in this repository. The frontend will live in a separate repository or folder and will consume requirements and contracts defined here. When product behavior changes, this document should be updated before or alongside the implementation.

Related engineering references:

- [DATA_MODEL.md](DATA_MODEL.md) — authoritative logical data model derived from this product specification

The following labels are used throughout:

- **Required:** Confirmed behavior for the initial product.
- **Recommended default:** A default that may be changed during implementation without altering the product's intent.
- **TBD:** A product or implementation decision that has not yet been finalized.

## 2. Product vision

The service helps a travel agency collect structured feedback about its drivers immediately after a trip. At the end of a trip, a driver uses a phone or tablet to open a passenger-safe feedback experience and hands the device to the passenger. The passenger submits feedback, optionally participates in a reward wheel, and returns the device.

Drivers can view only their aggregate performance. Administrators manage drivers, vendors, trips, questionnaires, rewards, feedback records, exports, and analytics.

The experience must remain usable when connectivity is unreliable. Feedback completed offline must be stored securely on the device and submitted automatically when connectivity returns. Rewards that require the server must not be available offline.

## 3. Product goals

1. Make post-trip feedback quick and comfortable on a shared phone or tablet.
2. Associate every response with exactly one trip and one driver.
3. Give administrators useful visibility into driver performance and negative feedback.
4. Give drivers a simple, privacy-safe view of their aggregate performance.
5. Support both agency drivers and outsourced drivers.
6. Allow the agency to change the questionnaire without invalidating historical data.
7. Continue collecting feedback during temporary internet outages.
8. Optionally reward passengers without tying reward eligibility to the rating they give.

## 4. Initial scope and scale

- One travel agency; this is not a multi-tenant SaaS product in the initial release.
- Approximately 14 agency drivers, plus outsourced drivers.
- Approximately 1,500–2,500 feedback submissions per month.
- Responsive web application designed for phones, tablets, and admin desktop use.
- English only.
- One administrator permission level. Multiple admin accounts may use that same role.
- Hosting, production domain, email provider, and final implementation stack will be selected during implementation.

## 5. Actors and permissions

### 5.1 Passenger

A passenger does not sign in.

The passenger can:

- Review the trip context displayed on the feedback screen.
- Enter the configured personal details.
- Answer the active questionnaire.
- Submit one feedback response for the trip.
- Use the reward wheel when it is enabled and the device is online.
- See either the awarded prize or the configured thank-you message.

The passenger must not be able to:

- Access driver or admin navigation.
- View earlier feedback or another passenger's information.
- View driver analytics or individual feedback records.
- Change the associated driver or trip from within the passenger feedback flow.

### 5.2 Driver

The driver signs in with a driver ID and password.

The driver can:

- View trips assigned to them.
- Select an assigned trip and start its feedback flow.
- Enter an unassigned trip manually and start its feedback flow.
- View their own aggregate overall score and aggregate category scores.
- Filter their aggregate results by month.
- Request a password-reset link by email.

The driver must not be able to:

- View individual feedback responses or written comments.
- View passenger personal information.
- View another driver's scores or trips.
- Configure questionnaires or rewards.
- Edit or delete submitted feedback.

### 5.3 Administrator

There is one administrator permission level.

The administrator can:

- Create and manage admin-accessible product data.
- Create, edit, deactivate, archive, and restore drivers where restoration is supported.
- Initiate a driver password reset.
- Create and manage outsourced driver vendors.
- Create trips and assign them to drivers.
- Inspect submitted feedback, including written comments.
- Flag or archive feedback while retaining its audit history.
- Configure, reorder, activate, archive, and version questionnaires and questions.
- Configure the optional reward wheel and its prize inventory.
- View dashboards and analytics.
- Export authorized report data to CSV, Excel, and PDF.

The administrator must not be able to edit the contents of a submitted feedback response.

## 6. Core user journeys

### 6.1 Driver sign-in

1. The driver enters their driver ID and password.
2. The service validates that the driver account is active.
3. The driver arrives at their driver home screen.
4. The driver can select an assigned trip or create an unassigned trip.
5. A forgotten password can be reset through an emailed reset link. An administrator can also initiate the reset.

### 6.2 Admin-assigned trip

1. The administrator creates a trip with the required trip details.
2. The administrator assigns an active driver to the trip.
3. The trip appears in that driver's assigned trip list.
4. At the end of the trip, the driver reviews/selects the trip and taps **Start feedback**.
5. The application switches to the passenger-safe feedback flow.

### 6.3 Driver-entered trip

1. The driver chooses to enter an unassigned trip.
2. The driver supplies all required trip fields.
3. The trip is automatically associated with the authenticated driver.
4. The driver confirms the details and taps **Start feedback**.
5. The application switches to the passenger-safe feedback flow.

### 6.4 Passenger feedback

1. The passenger sees a welcome screen and limited, non-sensitive trip context.
2. The passenger enters the required personal details and accepts the privacy/consent notice.
3. The passenger answers the active questionnaire in the configured order.
4. Required answers are validated before submission.
5. The passenger submits the feedback.
6. The system associates the immutable response with the trip, driver, passenger information, and a snapshot of the questionnaire.
7. If online, the response is stored on the server immediately.
8. If offline or submission fails because of connectivity, the response is queued securely and automatically retried when connectivity returns.

### 6.5 Completion without rewards

1. After a successful or safely queued submission, the passenger sees a configurable thank-you message.
2. The application prevents access to prior responses, driver-only screens, and admin screens.
3. The flow ends at a safe hand-back screen that requires driver authentication or an equivalent driver-only action to continue.

### 6.6 Completion with the reward wheel

1. The wheel is offered only when rewards are enabled and the device has a working server connection.
2. Every passenger with a completed eligible response receives the same opportunity to spin, regardless of their answers or rating.
3. The server selects the outcome using the configured probability and available inventory.
4. The outcome and inventory change are recorded atomically so a coupon cannot be awarded twice.
5. If a prize is won, its details and coupon code are emailed to the passenger.
6. The passenger sees a result screen, followed by the safe hand-back screen.
7. If the wheel is disabled or unavailable because the device is offline, the passenger sees the thank-you experience instead.

### 6.7 Driver score review

1. The authenticated driver opens their performance view.
2. The service shows regular arithmetic aggregates based on submitted, non-archived feedback.
3. The driver can view the overall aggregate and category aggregates.
4. The driver can filter the aggregates by month.
5. No individual response, comment, or passenger information is exposed.

### 6.8 Admin feedback review

1. The administrator opens the feedback list or dashboard.
2. The administrator can filter and inspect feedback.
3. Negative feedback is visibly surfaced on the dashboard.
4. The administrator may flag or archive a response.
5. Submitted answers remain immutable; all administrative state changes are audited.

## 7. Functional requirements

### 7.1 Authentication and account management

- **AUTH-001 — Required:** Drivers authenticate with a unique driver ID and password.
- **AUTH-002 — Required:** Administrators authenticate separately from drivers.
- **AUTH-003 — Required:** Deactivated or archived users cannot sign in.
- **AUTH-004 — Required:** Drivers can request a time-limited password-reset link by email.
- **AUTH-005 — Required:** Administrators can initiate a driver's password reset.
- **AUTH-006 — Required:** Passenger feedback mode must not expose authenticated driver or admin pages.
- **AUTH-007 — Required:** Authentication and password storage must follow current security best practices; plaintext passwords must never be stored.
- **AUTH-008 — Recommended default:** Require reauthentication or a driver-only unlock action after the passenger flow ends.

### 7.2 Driver and vendor management

- **DRV-001 — Required:** Administrators can create, view, edit, deactivate, and archive drivers.
- **DRV-002 — Required:** A driver is classified as either an agency driver or an outsourced driver.
- **DRV-003 — Required:** An outsourced driver can be linked to a vendor/company.
- **DRV-004 — Required:** Historical trips and feedback remain linked to archived drivers and vendors.
- **DRV-005 — Required:** Hard deletion must not remove records required for historical reporting or auditability.
- **DRV-006 — Required:** Driver IDs must be unique among accounts that may authenticate.

### 7.3 Trip management

- **TRIP-001 — Required:** Administrators can create a trip and assign it to an active driver.
- **TRIP-002 — Required:** Drivers can manually create their own unassigned trip.
- **TRIP-003 — Required:** A driver-created trip is automatically assigned to the authenticated driver.
- **TRIP-004 — Required:** A trip records:
  - Booking reference
  - Passenger name
  - Pickup location
  - Destination
  - Trip date and time
  - Vehicle
  - Driver
  - Driver source: agency or outsourced
  - Vendor/company when the driver is outsourced
  - Creation source: admin-assigned or driver-entered
- **TRIP-005 — Required:** A trip can have at most one submitted feedback response.
- **TRIP-006 — Required:** The system must reject accidental duplicate submissions at the server level.
- **TRIP-007 — Required:** Archived drivers, vendors, or trips must not disappear from historical feedback and reports.

### 7.4 Questionnaire management

- **QUE-001 — Required:** Administrators can configure the questionnaire used for all trips and passengers.
- **QUE-002 — Required:** Supported question types are:
  - 1–5 star rating
  - Emoji rating
  - Yes/no
  - Single or multiple choice
  - Written response
- **QUE-003 — Required:** Administrators can add, edit, reorder, activate, deactivate, and archive questions.
- **QUE-004 — Required:** Each question can be marked required or optional.
- **QUE-005 — Required:** The questionnaire supports, at minimum, overall experience, driving safety, punctuality, cleanliness, professionalism, and vehicle condition.
- **QUE-006 — Required:** Questionnaire changes apply to future feedback flows and do not rewrite historical responses.
- **QUE-007 — Required:** Each started/submitted response stores an immutable snapshot containing question wording, type, order, options, required status, category, and questionnaire version.
- **QUE-008 — Required:** Only one questionnaire version is active for new feedback at a time.

### 7.5 Passenger information and feedback

- **FDB-001 — Required:** The service collects passenger name, phone number, email address, and booking reference.
- **FDB-002 — Required:** The feedback flow displays an appropriate consent/privacy notice before submission.
- **FDB-003 — Required:** Required passenger fields and questionnaire answers are validated.
- **FDB-004 — Required:** A submitted feedback response and its answers cannot be edited.
- **FDB-005 — Required:** An administrator can flag or archive feedback without changing its submitted content.
- **FDB-006 — Required:** Flagging and archiving actions record the acting administrator and timestamp.
- **FDB-007 — Required:** Feedback is associated with exactly one passenger record/context, trip, driver, and questionnaire snapshot.
- **FDB-008 — Required:** The passenger cannot see prior responses after submission.
- **FDB-009 — Required:** A submission receives a stable client-generated identifier so an offline retry cannot create a duplicate.

### 7.6 Offline feedback submission

- **OFF-001 — Required:** The passenger feedback form remains usable during temporary connectivity loss after the relevant trip and questionnaire data have been loaded.
- **OFF-002 — Required:** A completed response that cannot reach the server is stored in a durable local queue.
- **OFF-003 — Required:** Queued responses retry automatically when connectivity returns.
- **OFF-004 — Required:** Retrying is idempotent and cannot create duplicate responses or duplicate rewards.
- **OFF-005 — Required:** Queued personal information and feedback must be protected from normal access through the application UI.
- **OFF-006 — Required:** Successfully synchronized local payloads are removed from the pending queue when safe to do so.
- **OFF-007 — Required:** The driver/admin side must provide a way to see whether the device has pending or failed submissions.
- **OFF-008 — Required:** Passengers do not need to be told that the response was queued because of connectivity.
- **OFF-009 — Required:** The reward wheel is not offered while offline.
- **OFF-010 — Required:** A queued response becomes reward-ineligible for that offline completion unless the product later defines a verified deferred-reward flow.

### 7.7 Rewards and prize wheel

- **RWD-001 — Required:** The administrator can enable or disable the reward wheel.
- **RWD-002 — Required:** When disabled, the passenger sees a configurable thank-you message.
- **RWD-003 — Required:** Reward eligibility and outcome must not depend on the passenger's rating or answers.
- **RWD-004 — Required:** A prize supports:
  - Prize name
  - Coupon-code inventory
  - Win probability or weight
  - Total and remaining inventory
  - Expiry date
  - Active/inactive status
- **RWD-005 — Required:** Expired, inactive, or out-of-stock prizes cannot be awarded.
- **RWD-006 — Required:** A coupon code can be assigned at most once.
- **RWD-007 — Required:** Prize selection and inventory reservation occur on the server in one atomic operation.
- **RWD-008 — Required:** The awarded prize and coupon code are emailed to the passenger.
- **RWD-009 — Required:** A feedback response can produce at most one reward-wheel attempt and one outcome.
- **RWD-010 — Required:** The administrator can review reward outcomes and remaining inventory.
- **RWD-011 — TBD:** Exact probability semantics when configured probabilities do not total 100%, including whether the remainder represents “no prize.”
- **RWD-012 — TBD:** Email sender, message templates, retry policy, and handling of undeliverable email.

### 7.8 Driver aggregates

- **SCORE-001 — Required:** Scores use standard arithmetic aggregates; no recency weighting or special formula is applied.
- **SCORE-002 — Required:** Drivers can see their overall aggregate score.
- **SCORE-003 — Required:** Drivers can see aggregate scores for rated categories.
- **SCORE-004 — Required:** Drivers can filter scores by month.
- **SCORE-005 — Required:** Drivers cannot drill down to individual responses.
- **SCORE-006 — Required:** Archived feedback is excluded from current aggregates but retained for audit/history.

### 7.9 Admin dashboard and analytics

- **ANL-001 — Required:** Show overall and per-driver ratings.
- **ANL-002 — Required:** Surface negative feedback prominently.
- **ANL-003 — Required:** Show monthly feedback metrics, including response count and rating trends.
- **ANL-004 — Required:** Support comparison of agency drivers and outsourced drivers.
- **ANL-005 — Required:** Support filters for date/month, driver, driver source, vendor, and rating/category where applicable.
- **ANL-006 — Required:** Administrators can inspect the individual feedback behind dashboard metrics.
- **ANL-007 — TBD:** Rating threshold or rule that classifies feedback as negative.

### 7.10 Reports and exports

- **EXP-001 — Required:** Administrators can export basic reports as CSV, Excel, and PDF.
- **EXP-002 — Required:** Exports respect active dashboard/report filters.
- **EXP-003 — Required:** Default exports may include passenger name and booking reference.
- **EXP-004 — Required:** Default exports exclude passenger phone number and email address.
- **EXP-005 — Required:** Exports can include driver, vendor, trip, rating, category, response, and timestamp information appropriate to the report.
- **EXP-006 — Required:** Archived records remain available to historical reports when an administrator explicitly includes them.
- **EXP-007 — Recommended default:** Record export generation in an audit log because exports may contain personal information.

## 8. Data model — conceptual entities

This is a product-level model, not a final database schema.

### 8.1 Administrator

- Identifier
- Name
- Email
- Authentication credentials/state
- Active/archive state
- Created and updated timestamps

### 8.2 Driver

- Identifier
- Unique driver ID used for sign-in
- Name
- Email
- Phone number, if collected operationally
- Authentication credentials/state
- Driver source: agency or outsourced
- Vendor reference when outsourced
- Active/deactivated/archived state
- Created and updated timestamps

### 8.3 Vendor

- Identifier
- Company name
- Optional operational contact details
- Active/archive state
- Created and updated timestamps

### 8.4 Vehicle

- Identifier
- Display name or model
- Registration/vehicle reference
- Active/archive state

Vehicle management details are implementation-level until expanded by a future product decision.

### 8.5 Trip

- Identifier
- Booking reference
- Passenger name
- Pickup location
- Destination
- Trip date and time
- Vehicle reference or snapshot
- Driver reference
- Driver-source snapshot
- Vendor reference/snapshot when applicable
- Creation source: administrator or driver
- Feedback state
- Created and updated timestamps
- Archive state

### 8.6 Questionnaire

- Identifier
- Name
- Version
- Active/archive state
- Ordered questions
- Created and updated timestamps

### 8.7 Question

- Identifier
- Prompt text
- Type
- Category
- Ordered choice options where applicable
- Required/optional state
- Display order
- Active/archive state

### 8.8 Passenger feedback

- Identifier
- Client-generated idempotency identifier
- Trip reference
- Driver reference/snapshot
- Passenger name
- Passenger phone number
- Passenger email address
- Booking reference
- Consent record and timestamp
- Questionnaire snapshot/version
- Ordered answer set
- Aggregate/derived rating fields used for reporting
- Submitted timestamp and synchronization metadata
- Flag/archive state
- Reward eligibility/outcome reference

### 8.9 Prize

- Identifier
- Name
- Probability or weight
- Total and remaining inventory
- Expiry date
- Active/archive state
- Coupon-code inventory
- Created and updated timestamps

### 8.10 Reward outcome

- Identifier
- Feedback reference
- Prize reference/snapshot
- Assigned coupon code
- Outcome timestamp
- Email-delivery state
- Audit metadata

### 8.11 Audit event

- Identifier
- Actor and actor type
- Action
- Entity type and identifier
- Timestamp
- Non-sensitive change metadata

## 9. Lifecycle and immutability rules

1. Submitted feedback answers are immutable.
2. Questionnaire versions used by submitted feedback are immutable snapshots.
3. Drivers, vendors, trips, questionnaires, questions, prizes, and feedback should be archived instead of hard-deleted when historical references exist.
4. Deactivation controls future use; archiving removes an entity from normal operational views while preserving history.
5. A trip accepts at most one feedback submission.
6. One feedback submission permits at most one reward attempt.
7. One coupon code can be assigned at most once.
8. Administrative flag/archive/reset/export actions should be auditable.

## 10. Privacy and security requirements

- Passenger phone numbers and email addresses are sensitive personal information.
- Passenger data must be collected only after displaying the agency's consent/privacy notice.
- Passenger personal information must not be visible to drivers.
- Default report exports exclude phone numbers and email addresses.
- Backend authorization must enforce permissions independently of frontend visibility.
- Data must be encrypted in transit in production.
- Passwords must be hashed using a suitable adaptive password-hashing algorithm.
- Password-reset tokens must be single-use, time-limited, and stored safely.
- Logs, analytics telemetry, and error reports must not expose passwords, reset tokens, coupon codes, or unnecessary passenger information.
- Offline payloads contain personal information and must be minimized, isolated from normal UI access, and deleted locally after confirmed synchronization.
- Production retention periods and the wording of the consent/privacy notice are TBD and should be approved by the agency before launch.

## 11. Analytics definitions

Unless a later decision overrides these definitions:

- **Overall driver rating:** Arithmetic mean of eligible overall-rating answers for the selected period.
- **Category score:** Arithmetic mean of eligible numeric answers mapped to the category for the selected period.
- **Monthly feedback count:** Number of submitted, non-archived feedback responses whose submission timestamp falls within the month.
- **Rating trend:** Aggregate rating grouped by calendar month.
- **Agency vs. outsourced comparison:** Equivalent metrics grouped by the driver's source snapshot stored on the trip/feedback.
- **Negative feedback:** TBD pending confirmation of the rating threshold or classification rule.

The backend must return counts alongside averages so the frontend can show sample size and avoid misleading comparisons.

## 12. Frontend experience requirements

### 12.1 Passenger experience

- Mobile- and tablet-first.
- Large touch targets and readable typography.
- Minimal navigation and a short, linear flow.
- Clear progress through the questionnaire.
- No access to browser-visible historical feedback through application controls.
- A clean hand-back state after completion.
- Reward animation must not obscure the actual prize or misrepresent the server-selected outcome.

### 12.2 Driver experience

- Optimized for quick sign-in and end-of-trip handoff.
- Assigned trips and manual trip entry must be easy to distinguish.
- The transition into passenger mode must be explicit.
- Pending offline submissions must be visible to the driver without exposing their content.
- Aggregate scores should be simple and non-diagnostic; no individual feedback drill-down.

### 12.3 Admin experience

- Desktop-friendly responsive dashboard.
- Fast access to negative feedback and monthly metrics.
- Clear active, deactivated, and archived states.
- Questionnaire reordering and required/optional configuration.
- Prize inventory and coupon availability visibility.
- Export controls that clearly state which passenger fields will be included.

### 12.4 Visual direction

- Modern, sleek, minimal, and trustworthy.
- Inspired by Eastern Risen's travel and expedition identity.
- The design may use restrained landscape, journey, route, horizon, or sunrise motifs without becoming decorative or reducing usability.
- Exact colors, typography, logo usage, and imagery remain provisional until official brand assets are supplied.

## 13. Backend-to-frontend contract principles

The backend is the authority for authentication, authorization, questionnaire versions, submission state, reward outcomes, inventory, aggregates, and export permissions.

Frontend requirements derived from this document should be communicated through:

1. Versioned API documentation.
2. Stable identifiers and enumerated lifecycle states.
3. Machine-readable validation rules for questions and passenger fields.
4. Explicit error codes for duplicate feedback, expired trips, offline retry conflicts, unavailable prizes, and authentication failures.
5. Idempotency support for feedback submission and reward attempts.
6. Dates and timestamps in an unambiguous API format, with localization handled at the presentation boundary.
7. Contract tests or fixtures for key passenger, driver, admin, offline, and reward flows.

## 14. Non-functional requirements

### Reliability

- Feedback submission must be idempotent.
- Offline retries must tolerate app restarts and intermittent connectivity.
- Reward assignment and coupon inventory changes must be transactional.
- Failure to send a reward email must not award a second prize; email delivery should be retried independently.

### Performance

- The product should comfortably support 2,500 monthly responses with room for growth.
- Passenger screens should load quickly on typical mobile connections.
- Admin list and dashboard endpoints should be paginated or aggregated appropriately.

### Accessibility

- Core experiences should meet WCAG 2.1 AA expectations where practical.
- The questionnaire must be usable by keyboard as well as touch.
- Ratings and wheel outcomes must not rely on color alone.
- Form errors must be clearly associated with their fields.

### Compatibility

- Support current mainstream mobile and desktop browsers selected during implementation.
- The offline strategy must account for browser storage limitations and private/incognito behavior.

### Observability and auditability

- Monitor feedback synchronization failures, reward allocation failures, email failures, and export failures.
- Preserve audit events for security- and history-sensitive administrative actions.

## 15. MVP acceptance criteria

The initial product is acceptable when:

1. An administrator can create agency and outsourced drivers and assign vendors.
2. An administrator can create and assign a trip.
3. A driver can sign in and select that assigned trip.
4. A driver can instead create a valid unassigned trip.
5. A driver can launch a passenger-safe feedback flow.
6. A passenger can enter personal details, consent, complete the configured questionnaire, and submit exactly once.
7. A questionnaire can be reordered and its questions marked required or optional.
8. Changing the active questionnaire does not change historical feedback.
9. A response completed without connectivity is queued and later synchronized without duplication.
10. No reward wheel is offered offline.
11. When online and enabled, the wheel awards only an eligible, in-stock, unexpired coupon according to server-side configuration.
12. A reward email is sent or placed into a retryable delivery state.
13. The passenger ends on a safe thank-you/hand-back screen.
14. A driver can view only their own aggregate and monthly scores.
15. An administrator can inspect feedback, surface negative feedback, flag/archive feedback, and view monthly analytics.
16. Submitted feedback cannot be edited.
17. The administrator can export CSV, Excel, and PDF reports without phone numbers or email addresses by default.
18. Archived records remain historically reportable.

## 16. Explicitly out of scope for the initial release

- Multiple agency tenants.
- Languages other than English.
- Native iOS or Android applications.
- Passenger accounts.
- Driver access to individual feedback or written comments.
- Rating-weighted, recency-weighted, or otherwise specialized score formulas.
- Editing submitted feedback.
- Reward-wheel use while offline.
- Automatic questionnaire translation.
- Public review publishing or integration with third-party review platforms.
- Advanced disciplinary, case-management, or feedback follow-up workflows.

## 17. Open decisions

These items do not block initial domain and API design unless noted otherwise:

1. Final backend and frontend technology stacks.
2. Hosting provider, production domain, deployment process, and environments.
3. Transactional email provider and sender domain.
4. Exact password/session policies and supported browser versions.
5. Negative-feedback classification threshold.
6. Reward probability semantics, including a possible “no prize” outcome.
7. Reward email templates, retry limits, and undeliverable-email handling.
8. Exact data-retention period and final privacy/consent wording.
9. Official logo, brand colors, typography, and imagery.
10. Final vehicle-management depth beyond the trip's required vehicle field.
11. Whether archived feedback can be restored and who can perform restoration.

## 18. Change-management rule

Any change that affects actors, permissions, workflows, stored data, API behavior, analytics definitions, exports, privacy, offline behavior, or rewards must update this document. Material changes should include the date and a short note in the change log below.

## 19. Change log

| Date | Change |
| --- | --- |
| 2026-07-20 | Initial product source of truth created from product discovery discussions. |
