import { and, asc, count, desc, eq, inArray, isNull, max, ne } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import {
  auditEvents,
  consentVersions,
  questionnaireVersions,
  questionnaires,
  questionOptions,
  versionQuestions,
} from '../../database/schema/index.js';
import { AppError } from '../../shared/errors/app-error.js';
import { type QuestionInput, validateQuestionnaireQuestions } from './questionnaire.validator.js';

export interface PaginationInput {
  readonly page: number;
  readonly pageSize: number;
}

export class QuestionnaireService {
  constructor(private readonly db: AppDatabase) {}

  async create(name: string, actorAccountId: string) {
    return this.db.transaction(async (tx) => {
      const [questionnaire] = await tx
        .insert(questionnaires)
        .values({
          name: name.trim(),
          createdByAccountId: actorAccountId,
        })
        .returning();
      const [version] = await tx
        .insert(questionnaireVersions)
        .values({
          questionnaireId: questionnaire!.id,
          versionNumber: 1,
          createdByAccountId: actorAccountId,
        })
        .returning();
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'QUESTIONNAIRE_CREATED',
        entityType: 'QUESTIONNAIRE',
        entityId: questionnaire!.id,
      });
      return { questionnaire: questionnaire!, version: version! };
    });
  }

  async list(input: PaginationInput) {
    const offset = (input.page - 1) * input.pageSize;
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(questionnaires)
        .orderBy(asc(questionnaires.name), asc(questionnaires.id))
        .limit(input.pageSize)
        .offset(offset),
      this.db.select({ value: count() }).from(questionnaires),
    ]);
    return { items, total: total?.value ?? 0 };
  }

  async updateName(id: string, name: string, actorAccountId: string) {
    return this.db.transaction(async (tx) => {
      const [questionnaire] = await tx
        .update(questionnaires)
        .set({ name: name.trim(), updatedAt: new Date() })
        .where(and(eq(questionnaires.id, id), ne(questionnaires.status, 'ARCHIVED')))
        .returning();
      if (!questionnaire)
        throw new AppError({
          code: 'QUESTIONNAIRE_NOT_FOUND',
          message: 'Questionnaire was not found',
          statusCode: 404,
        });
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'QUESTIONNAIRE_UPDATED',
        entityType: 'QUESTIONNAIRE',
        entityId: id,
        metadata: { changedFields: 'name' },
      });
      return questionnaire;
    });
  }

  async archive(id: string, actorAccountId: string) {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const [questionnaire] = await tx
        .update(questionnaires)
        .set({ status: 'ARCHIVED', archivedAt: now, updatedAt: now })
        .where(eq(questionnaires.id, id))
        .returning();
      if (!questionnaire)
        throw new AppError({
          code: 'QUESTIONNAIRE_NOT_FOUND',
          message: 'Questionnaire was not found',
          statusCode: 404,
        });
      await tx
        .update(questionnaireVersions)
        .set({ status: 'RETIRED', retiredAt: now, updatedAt: now })
        .where(
          and(
            eq(questionnaireVersions.questionnaireId, id),
            eq(questionnaireVersions.status, 'ACTIVE'),
          ),
        );
      await tx
        .update(questionnaireVersions)
        .set({ status: 'ARCHIVED', updatedAt: now })
        .where(
          and(
            eq(questionnaireVersions.questionnaireId, id),
            eq(questionnaireVersions.status, 'DRAFT'),
          ),
        );
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'QUESTIONNAIRE_ARCHIVED',
        entityType: 'QUESTIONNAIRE',
        entityId: id,
      });
      return questionnaire;
    });
  }

  async archiveDraft(questionnaireId: string, versionId: string, actorAccountId: string) {
    await this.assertDraft(questionnaireId, versionId);
    const [version] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(questionnaireVersions)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(
          and(eq(questionnaireVersions.id, versionId), eq(questionnaireVersions.status, 'DRAFT')),
        )
        .returning();
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'QUESTIONNAIRE_DRAFT_ARCHIVED',
        entityType: 'QUESTIONNAIRE_VERSION',
        entityId: versionId,
      });
      return rows;
    });
    return version!;
  }

  async listVersions(questionnaireId: string, input: PaginationInput) {
    await this.assertQuestionnaire(questionnaireId);
    const filter = eq(questionnaireVersions.questionnaireId, questionnaireId);
    const offset = (input.page - 1) * input.pageSize;
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(questionnaireVersions)
        .where(filter)
        .orderBy(desc(questionnaireVersions.versionNumber))
        .limit(input.pageSize)
        .offset(offset),
      this.db.select({ value: count() }).from(questionnaireVersions).where(filter),
    ]);
    return { items, total: total?.value ?? 0 };
  }

  async getVersion(questionnaireId: string, versionId: string) {
    const [version] = await this.db
      .select({
        id: questionnaireVersions.id,
        questionnaireId: questionnaireVersions.questionnaireId,
        questionnaireName: questionnaires.name,
        versionNumber: questionnaireVersions.versionNumber,
        status: questionnaireVersions.status,
        publishedAt: questionnaireVersions.publishedAt,
        retiredAt: questionnaireVersions.retiredAt,
        createdAt: questionnaireVersions.createdAt,
        updatedAt: questionnaireVersions.updatedAt,
      })
      .from(questionnaireVersions)
      .innerJoin(questionnaires, eq(questionnaires.id, questionnaireVersions.questionnaireId))
      .where(
        and(
          eq(questionnaireVersions.id, versionId),
          eq(questionnaireVersions.questionnaireId, questionnaireId),
        ),
      )
      .limit(1);
    if (!version) this.versionNotFound();
    const questions = await this.loadQuestions(versionId);
    return { ...version, questions };
  }

  async replaceQuestions(
    questionnaireId: string,
    versionId: string,
    inputs: readonly QuestionInput[],
    actorAccountId: string,
  ) {
    validateQuestionnaireQuestions(inputs, false);
    await this.assertDraft(questionnaireId, versionId);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(versionQuestions)
        .where(eq(versionQuestions.questionnaireVersionId, versionId));
      for (const [displayOrder, input] of inputs.entries()) {
        const [question] = await tx
          .insert(versionQuestions)
          .values({
            questionnaireVersionId: versionId,
            stableKey: input.stableKey,
            prompt: input.prompt.trim(),
            questionType: input.questionType,
            category: input.category,
            status: input.status ?? 'ACTIVE',
            isRequired: input.isRequired,
            displayOrder,
            contributesToScore: input.questionType === 'TEXT' ? false : input.contributesToScore,
            scoreMin: input.scoreMin ?? null,
            scoreMax: input.scoreMax ?? null,
          })
          .returning({ id: versionQuestions.id });
        if (input.options?.length) {
          await tx.insert(questionOptions).values(
            input.options.map((option, optionOrder) => ({
              versionQuestionId: question!.id,
              valueKey: option.valueKey,
              label: option.label.trim(),
              scoreValue: option.scoreValue ?? null,
              displayOrder: optionOrder,
            })),
          );
        }
      }
      await tx
        .update(questionnaireVersions)
        .set({ updatedAt: new Date() })
        .where(eq(questionnaireVersions.id, versionId));
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'QUESTIONNAIRE_DRAFT_UPDATED',
        entityType: 'QUESTIONNAIRE_VERSION',
        entityId: versionId,
        metadata: { questionCount: inputs.length },
      });
    });
    return this.getVersion(questionnaireId, versionId);
  }

  async publish(questionnaireId: string, versionId: string, actorAccountId: string) {
    await this.assertDraft(questionnaireId, versionId);
    const questions = await this.loadQuestions(versionId);
    validateQuestionnaireQuestions(
      questions.map((question) => ({ ...question, options: question.options })),
      true,
    );
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(questionnaireVersions)
        .set({ status: 'RETIRED', retiredAt: now, updatedAt: now })
        .where(eq(questionnaireVersions.status, 'ACTIVE'));
      const [published] = await tx
        .update(questionnaireVersions)
        .set({
          status: 'ACTIVE',
          publishedAt: now,
          retiredAt: null,
          updatedAt: now,
        })
        .where(
          and(eq(questionnaireVersions.id, versionId), eq(questionnaireVersions.status, 'DRAFT')),
        )
        .returning();
      if (!published)
        throw new AppError({
          code: 'QUESTIONNAIRE_VERSION_NOT_DRAFT',
          message: 'Only a draft version can be published',
          statusCode: 409,
        });
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'QUESTIONNAIRE_VERSION_PUBLISHED',
        entityType: 'QUESTIONNAIRE_VERSION',
        entityId: versionId,
        metadata: { versionNumber: published.versionNumber },
      });
    });
    return this.getVersion(questionnaireId, versionId);
  }

  async createDraft(questionnaireId: string, actorAccountId: string) {
    await this.assertQuestionnaire(questionnaireId);
    const [existingDraft] = await this.db
      .select({ id: questionnaireVersions.id })
      .from(questionnaireVersions)
      .where(
        and(
          eq(questionnaireVersions.questionnaireId, questionnaireId),
          eq(questionnaireVersions.status, 'DRAFT'),
        ),
      )
      .limit(1);
    if (existingDraft)
      throw new AppError({
        code: 'QUESTIONNAIRE_DRAFT_ALREADY_EXISTS',
        message: 'This questionnaire already has a draft',
        statusCode: 409,
      });
    const [latest] = await this.db
      .select()
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.questionnaireId, questionnaireId))
      .orderBy(desc(questionnaireVersions.versionNumber))
      .limit(1);
    const sourceQuestions = latest ? await this.loadQuestions(latest.id) : [];
    const versionId = await this.db.transaction(async (tx) => {
      const [version] = await tx
        .insert(questionnaireVersions)
        .values({
          questionnaireId,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          createdByAccountId: actorAccountId,
        })
        .returning({ id: questionnaireVersions.id });
      for (const question of sourceQuestions) {
        const [copy] = await tx
          .insert(versionQuestions)
          .values({
            questionnaireVersionId: version!.id,
            stableKey: question.stableKey,
            prompt: question.prompt,
            questionType: question.questionType,
            category: question.category,
            status: question.status,
            isRequired: question.isRequired,
            displayOrder: question.displayOrder,
            contributesToScore: question.contributesToScore,
            scoreMin: question.scoreMin,
            scoreMax: question.scoreMax,
          })
          .returning({ id: versionQuestions.id });
        if (question.options.length)
          await tx.insert(questionOptions).values(
            question.options.map((option) => ({
              versionQuestionId: copy!.id,
              valueKey: option.valueKey,
              label: option.label,
              scoreValue: option.scoreValue,
              displayOrder: option.displayOrder,
            })),
          );
      }
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'QUESTIONNAIRE_DRAFT_CREATED',
        entityType: 'QUESTIONNAIRE_VERSION',
        entityId: version!.id,
      });
      return version!.id;
    });
    return this.getVersion(questionnaireId, versionId);
  }

  async createConsent(content: string, actorAccountId: string) {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(consentVersions)
        .set({ retiredAt: now })
        .where(sqlIsNull(consentVersions.retiredAt));
      const [maxRow] = await tx
        .select({ value: max(consentVersions.version) })
        .from(consentVersions);
      const [consent] = await tx
        .insert(consentVersions)
        .values({
          version: (maxRow?.value ?? 0) + 1,
          content: content.trim(),
          effectiveAt: now,
          createdByAccountId: actorAccountId,
        })
        .returning();
      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'CONSENT_VERSION_ACTIVATED',
        entityType: 'CONSENT_VERSION',
        entityId: consent!.id,
        metadata: { version: consent!.version },
      });
      return consent!;
    });
  }

  async getActiveConsent() {
    const [consent] = await this.db
      .select()
      .from(consentVersions)
      .where(sqlIsNull(consentVersions.retiredAt))
      .limit(1);
    if (!consent)
      throw new AppError({
        code: 'ACTIVE_CONSENT_NOT_FOUND',
        message: 'No active consent notice is configured',
        statusCode: 409,
      });
    return consent;
  }

  async getActiveVersion() {
    const [version] = await this.db
      .select({
        id: questionnaireVersions.id,
        questionnaireId: questionnaireVersions.questionnaireId,
      })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.status, 'ACTIVE'))
      .limit(1);
    if (!version)
      throw new AppError({
        code: 'ACTIVE_QUESTIONNAIRE_NOT_FOUND',
        message: 'No active questionnaire is configured',
        statusCode: 409,
      });
    return this.getVersion(version.questionnaireId, version.id);
  }

  async getVersionById(versionId: string) {
    const [version] = await this.db
      .select({ questionnaireId: questionnaireVersions.questionnaireId })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.id, versionId))
      .limit(1);
    if (!version) this.versionNotFound();
    return this.getVersion(version.questionnaireId, versionId);
  }

  async getConsentById(id: string) {
    const [consent] = await this.db
      .select()
      .from(consentVersions)
      .where(eq(consentVersions.id, id))
      .limit(1);
    if (!consent)
      throw new AppError({
        code: 'CONSENT_VERSION_NOT_FOUND',
        message: 'Consent version was not found',
        statusCode: 404,
      });
    return consent;
  }

  private async loadQuestions(versionId: string) {
    const questions = await this.db
      .select()
      .from(versionQuestions)
      .where(eq(versionQuestions.questionnaireVersionId, versionId))
      .orderBy(asc(versionQuestions.displayOrder));
    const options = questions.length
      ? await this.db
          .select()
          .from(questionOptions)
          .where(inQuestionIds(questions.map((question) => question.id)))
          .orderBy(asc(questionOptions.displayOrder))
      : [];
    return questions.map((question) => ({
      ...question,
      options: options.filter((option) => option.versionQuestionId === question.id),
    }));
  }

  private async assertDraft(questionnaireId: string, versionId: string) {
    const [draft] = await this.db
      .select({ id: questionnaireVersions.id })
      .from(questionnaireVersions)
      .innerJoin(questionnaires, eq(questionnaires.id, questionnaireVersions.questionnaireId))
      .where(
        and(
          eq(questionnaireVersions.id, versionId),
          eq(questionnaireVersions.questionnaireId, questionnaireId),
          eq(questionnaireVersions.status, 'DRAFT'),
          ne(questionnaires.status, 'ARCHIVED'),
        ),
      )
      .limit(1);
    if (!draft)
      throw new AppError({
        code: 'QUESTIONNAIRE_VERSION_NOT_DRAFT',
        message: 'The questionnaire draft was not found or is immutable',
        statusCode: 409,
      });
  }

  private async assertQuestionnaire(id: string) {
    const [row] = await this.db
      .select({ id: questionnaires.id })
      .from(questionnaires)
      .where(eq(questionnaires.id, id))
      .limit(1);
    if (!row)
      throw new AppError({
        code: 'QUESTIONNAIRE_NOT_FOUND',
        message: 'Questionnaire was not found',
        statusCode: 404,
      });
  }

  private versionNotFound(): never {
    throw new AppError({
      code: 'QUESTIONNAIRE_VERSION_NOT_FOUND',
      message: 'Questionnaire version was not found',
      statusCode: 404,
    });
  }
}

const inQuestionIds = (ids: string[]) => inArray(questionOptions.versionQuestionId, ids);
const sqlIsNull = isNull;
