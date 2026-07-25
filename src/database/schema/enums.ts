import { pgEnum } from 'drizzle-orm/pg-core';

export const accountRole = pgEnum('account_role', ['ADMIN', 'DRIVER']);
export const lifecycleStatus = pgEnum('lifecycle_status', ['ACTIVE', 'DEACTIVATED', 'ARCHIVED']);
export const driverSourceType = pgEnum('driver_source_type', ['AGENCY', 'OUTSOURCED']);
export const tripCreationSource = pgEnum('trip_creation_source', [
  'ADMIN_ASSIGNED',
  'DRIVER_ENTERED',
]);
export const tripStatus = pgEnum('trip_status', [
  'READY',
  'FEEDBACK_STARTED',
  'SUBMITTED',
  'ARCHIVED',
]);
export const questionnaireStatus = pgEnum('questionnaire_status', ['ACTIVE', 'ARCHIVED']);
export const questionnaireVersionStatus = pgEnum('questionnaire_version_status', [
  'DRAFT',
  'ACTIVE',
  'RETIRED',
  'ARCHIVED',
]);
export const questionStatus = pgEnum('question_status', ['ACTIVE', 'INACTIVE', 'ARCHIVED']);
export const questionType = pgEnum('question_type', [
  'STAR_RATING',
  'EMOJI_RATING',
  'YES_NO',
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
  'TEXT',
]);
export const questionCategory = pgEnum('question_category', [
  'OVERALL_EXPERIENCE',
  'DRIVING_SAFETY',
  'PUNCTUALITY',
  'CLEANLINESS',
  'PROFESSIONALISM',
  'VEHICLE_CONDITION',
  'CUSTOM',
]);
export const feedbackSubmissionMode = pgEnum('feedback_submission_mode', [
  'ONLINE',
  'OFFLINE_SYNC',
]);
export const feedbackReviewState = pgEnum('feedback_review_state', [
  'NORMAL',
  'FLAGGED',
  'ARCHIVED',
]);
export const feedbackReviewAction = pgEnum('feedback_review_action', ['FLAG', 'UNFLAG', 'ARCHIVE']);
export const outboxStatus = pgEnum('outbox_status', ['PENDING', 'PROCESSING', 'SENT', 'FAILED']);
