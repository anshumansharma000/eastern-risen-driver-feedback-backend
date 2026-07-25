import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { AuthGuards } from '../auth/auth.guard.js';
import { agencySettingsSchema, updateAgencySettingsBodySchema } from './settings.schemas.js';
import type { SettingsService } from './settings.service.js';

export interface SettingsRouteOptions {
  readonly guards: AuthGuards;
  readonly settingsService: SettingsService;
}

export const settingsRoutes: FastifyPluginAsyncTypebox<SettingsRouteOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', options.guards.admin);

  app.get(
    '/',
    {
      schema: {
        tags: ['agency settings'],
        summary: 'Get agency-wide settings',
        response: { 200: Type.Object({ data: agencySettingsSchema }) },
      },
    },
    async () => ({ data: serializeSettings(await options.settingsService.get()) }),
  );

  app.patch(
    '/',
    {
      schema: {
        tags: ['agency settings'],
        summary: 'Update agency-wide settings',
        body: updateAgencySettingsBodySchema,
        response: { 200: Type.Object({ data: agencySettingsSchema }) },
      },
    },
    async (request) => ({
      data: serializeSettings(
        await options.settingsService.update(request.body, request.auth!.accountId),
      ),
    }),
  );
};

function serializeSettings(settings: {
  id: string;
  agencyName: string;
  timezone: string;
  defaultThankYouMessage: string;
  negativeFeedbackThreshold: number | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...settings,
    createdAt: settings.createdAt.toISOString(),
    updatedAt: settings.updatedAt.toISOString(),
  };
}
