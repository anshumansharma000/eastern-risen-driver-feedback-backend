import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { paginationSchema } from '../../shared/http/response.schemas.js';
import type { AuthGuards } from '../auth/auth.guard.js';
import {
  consentBodySchema,
  consentSchema,
  createQuestionnaireBodySchema,
  idParamsSchema,
  paginationQuerySchema,
  questionnaireSummarySchema,
  questionnaireVersionParamsSchema,
  questionnaireVersionSchema,
  replaceQuestionsBodySchema,
  updateQuestionnaireBodySchema,
} from './questionnaire.schemas.js';
import type { QuestionnaireService } from './questionnaire.service.js';

export interface QuestionnaireRouteOptions {
  readonly guards: AuthGuards;
  readonly questionnaireService: QuestionnaireService;
}

const versionSummarySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  questionnaireId: Type.String({ format: 'uuid' }),
  purpose: Type.Union([
    Type.Literal('ARRIVAL_EXPERIENCE'),
    Type.Literal('DRIVER_FEEDBACK'),
    Type.Literal('TOUR_EXPERIENCE'),
  ]),
  versionNumber: Type.Integer(),
  status: Type.Union([
    Type.Literal('DRAFT'),
    Type.Literal('ACTIVE'),
    Type.Literal('RETIRED'),
    Type.Literal('ARCHIVED'),
  ]),
  publishedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  retiredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const questionnaireRoutes: FastifyPluginAsyncTypebox<QuestionnaireRouteOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', options.guards.admin);

  app.post(
    '/',
    {
      schema: {
        tags: ['questionnaires'],
        summary: 'Create a questionnaire with its first draft',
        body: createQuestionnaireBodySchema,
        response: {
          201: Type.Object({
            data: Type.Object({
              questionnaire: questionnaireSummarySchema,
              draftVersionId: Type.String({ format: 'uuid' }),
            }),
          }),
        },
      },
    },
    async (request, reply) => {
      const result = await options.questionnaireService.create(
        request.body.name,
        request.body.purpose,
        request.auth!.accountId,
      );
      return reply.status(201).send({
        data: {
          questionnaire: serializeQuestionnaire(result.questionnaire),
          draftVersionId: result.version.id,
        },
      });
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['questionnaires'],
        summary: 'List questionnaires',
        querystring: paginationQuerySchema,
        response: {
          200: Type.Object({
            data: Type.Array(questionnaireSummarySchema),
            pagination: paginationSchema,
          }),
        },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? 25;
      const result = await options.questionnaireService.list({ page, pageSize });
      return {
        data: result.items.map(serializeQuestionnaire),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags: ['questionnaires'],
        summary: 'Rename a questionnaire',
        params: idParamsSchema,
        body: updateQuestionnaireBodySchema,
        response: { 200: Type.Object({ data: questionnaireSummarySchema }) },
      },
    },
    async (request) => ({
      data: serializeQuestionnaire(
        await options.questionnaireService.updateName(
          request.params.id,
          request.body.name,
          request.auth!.accountId,
        ),
      ),
    }),
  );

  app.post(
    '/:id/archive',
    {
      schema: {
        tags: ['questionnaires'],
        summary: 'Archive a questionnaire and retire its active version',
        params: idParamsSchema,
        response: { 200: Type.Object({ data: questionnaireSummarySchema }) },
      },
    },
    async (request) => ({
      data: serializeQuestionnaire(
        await options.questionnaireService.archive(request.params.id, request.auth!.accountId),
      ),
    }),
  );

  app.get(
    '/:id/versions',
    {
      schema: {
        tags: ['questionnaires'],
        summary: 'List questionnaire versions',
        params: idParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: Type.Object({
            data: Type.Array(versionSummarySchema),
            pagination: paginationSchema,
          }),
        },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? 25;
      const result = await options.questionnaireService.listVersions(request.params.id, {
        page,
        pageSize,
      });
      return {
        data: result.items.map(serializeVersionSummary),
        pagination: { page, pageSize, total: result.total },
      };
    },
  );

  app.post(
    '/:id/versions',
    {
      schema: {
        tags: ['questionnaires'],
        summary: 'Clone the latest version into a new draft',
        params: idParamsSchema,
        response: { 201: Type.Object({ data: questionnaireVersionSchema }) },
      },
    },
    async (request, reply) =>
      reply.status(201).send({
        data: serializeVersion(
          await options.questionnaireService.createDraft(
            request.params.id,
            request.auth!.accountId,
          ),
        ),
      }),
  );

  app.get(
    '/:id/versions/:versionId',
    {
      schema: {
        tags: ['questionnaires'],
        summary: 'Get a questionnaire version and its questions',
        params: questionnaireVersionParamsSchema,
        response: { 200: Type.Object({ data: questionnaireVersionSchema }) },
      },
    },
    async (request) => ({
      data: serializeVersion(
        await options.questionnaireService.getVersion(request.params.id, request.params.versionId),
      ),
    }),
  );

  app.put(
    '/:id/versions/:versionId/questions',
    {
      schema: {
        tags: ['questionnaires'],
        summary: 'Replace and reorder all questions in a draft',
        params: questionnaireVersionParamsSchema,
        body: replaceQuestionsBodySchema,
        response: { 200: Type.Object({ data: questionnaireVersionSchema }) },
      },
    },
    async (request) => ({
      data: serializeVersion(
        await options.questionnaireService.replaceQuestions(
          request.params.id,
          request.params.versionId,
          request.body.questions,
          request.auth!.accountId,
        ),
      ),
    }),
  );

  app.post(
    '/:id/versions/:versionId/publish',
    {
      schema: {
        tags: ['questionnaires'],
        summary: 'Publish an immutable questionnaire version',
        params: questionnaireVersionParamsSchema,
        response: { 200: Type.Object({ data: questionnaireVersionSchema }) },
      },
    },
    async (request) => ({
      data: serializeVersion(
        await options.questionnaireService.publish(
          request.params.id,
          request.params.versionId,
          request.auth!.accountId,
        ),
      ),
    }),
  );

  app.post(
    '/:id/versions/:versionId/archive',
    {
      schema: {
        tags: ['questionnaires'],
        summary: 'Archive a draft questionnaire version',
        params: questionnaireVersionParamsSchema,
        response: { 200: Type.Object({ data: versionSummarySchema }) },
      },
    },
    async (request) => ({
      data: serializeVersionSummary(
        await options.questionnaireService.archiveDraft(
          request.params.id,
          request.params.versionId,
          request.auth!.accountId,
        ),
      ),
    }),
  );
};

export const consentRoutes: FastifyPluginAsyncTypebox<QuestionnaireRouteOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', options.guards.admin);
  app.get(
    '/active',
    {
      schema: {
        tags: ['questionnaires'],
        summary: 'Get the active passenger consent notice',
        response: { 200: Type.Object({ data: consentSchema }) },
      },
    },
    async () => ({ data: serializeConsent(await options.questionnaireService.getActiveConsent()) }),
  );
  app.post(
    '/',
    {
      schema: {
        tags: ['questionnaires'],
        summary: 'Activate a new immutable passenger consent version',
        body: consentBodySchema,
        response: { 201: Type.Object({ data: consentSchema }) },
      },
    },
    async (request, reply) =>
      reply.status(201).send({
        data: serializeConsent(
          await options.questionnaireService.createConsent(
            request.body.content,
            request.auth!.accountId,
          ),
        ),
      }),
  );
};

function serializeQuestionnaire(row: {
  id: string;
  name: string;
  purpose: 'ARRIVAL_EXPERIENCE' | 'DRIVER_FEEDBACK' | 'TOUR_EXPERIENCE';
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

function serializeVersionSummary(row: {
  id: string;
  questionnaireId: string;
  purpose: 'ARRIVAL_EXPERIENCE' | 'DRIVER_FEEDBACK' | 'TOUR_EXPERIENCE';
  versionNumber: number;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED' | 'ARCHIVED';
  publishedAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...row,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeVersion(row: Awaited<ReturnType<QuestionnaireService['getVersion']>>) {
  return {
    ...serializeVersionSummary(row),
    questionnaireName: row.questionnaireName,
    purpose: row.purpose,
    questions: row.questions.map((question) => ({
      id: question.id,
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
      options: question.options.map((option) => ({
        id: option.id,
        valueKey: option.valueKey,
        label: option.label,
        scoreValue: option.scoreValue,
        displayOrder: option.displayOrder,
      })),
    })),
  };
}

function serializeConsent(row: {
  id: string;
  version: number;
  content: string;
  effectiveAt: Date;
  retiredAt: Date | null;
}) {
  return {
    id: row.id,
    version: row.version,
    content: row.content,
    effectiveAt: row.effectiveAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
  };
}
