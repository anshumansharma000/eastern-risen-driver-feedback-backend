import Fastify from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { describe, expect, it } from 'vitest';
import type { CoreServices } from '../index.js';
import { commercialRoutes } from './commercial.routes.js';

describe('Cashfree notification endpoint', () => {
  it('parses exact raw bytes and reconciles an authenticated order', async () => {
    const orders: string[] = [];
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    const services = {
      guards: { read: async () => {}, write: async () => {}, admin: async () => {} },
      commercial: {
        reconcile: async (id: string) => {
          orders.push(id);
          return { status: 'PAID' };
        },
      },
      paymentProvider: {
        name: 'cashfree',
        verifyWebhook: (body: Buffer, signature: string) =>
          body.toString() ===
            '{"data":{"order":{"order_id":"er_1234567890abcdef1234567890abcdef"}}}' &&
          signature === 'valid',
      },
    } as unknown as CoreServices;
    await app.register(commercialRoutes, { services });
    const response = await app.inject({
      method: 'POST',
      url: '/payments/webhooks/cashfree',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': 'valid',
        'x-webhook-timestamp': '1780000000',
      },
      payload: '{"data":{"order":{"order_id":"er_1234567890abcdef1234567890abcdef"}}}',
    });
    expect(response.statusCode).toBe(200);
    expect(orders).toEqual(['er_1234567890abcdef1234567890abcdef']);
    await app.close();
  });
});

describe('commercial invoice selection', () => {
  it('searches available invoices and links by number while accepting the existing UUID body', async () => {
    const bookingId = '11111111-1111-4111-8111-111111111111';
    const invoiceId = '22222222-2222-4222-8222-222222222222';
    const searches: Array<{
      id: string;
      query: string | undefined;
      page: number;
      pageSize: number;
    }> = [];
    const links: unknown[] = [];
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    const services = {
      guards: {
        read: async () => {},
        write: async (request: { auth?: { accountId: string } }) => {
          request.auth = { accountId: 'staff-account' };
        },
        admin: async () => {},
      },
      commercial: {
        availableInvoices: async (
          id: string,
          query: string | undefined,
          page: number,
          pageSize: number,
        ) => {
          searches.push({ id, query, page, pageSize });
          return {
            items: [
              {
                id: invoiceId,
                invoiceNumber: 'I/2627/000001',
                financialYear: '2627',
                invoiceDate: '2026-08-20',
                grandTotal: '1070.00',
                customerName: 'Test Payer',
                guestName: 'Traveller X 04',
                label: 'August itinerary',
                lineDescription: '4 PAX / itinerary',
                status: 'ISSUED',
                eligible: true,
                unavailableReasons: [],
              },
            ],
            total: 1,
          };
        },
        attachInvoice: async (_id: string, identifier: unknown) => {
          links.push(identifier);
          return { id: bookingId };
        },
      },
    } as unknown as CoreServices;
    await app.register(commercialRoutes, { services });
    const found = await app.inject({
      method: 'GET',
      url: `/commercial-bookings/${bookingId}/available-invoices?q=000001&page=2&pageSize=10`,
    });
    expect(found.statusCode).toBe(200);
    expect(searches).toEqual([{ id: bookingId, query: '000001', page: 2, pageSize: 10 }]);
    expect(found.json<{ pagination: { total: number } }>().pagination.total).toBe(1);
    expect(found.json<{ data: Array<{ invoiceNumber: string }> }>().data[0]?.invoiceNumber).toBe(
      'I/2627/000001',
    );
    expect(
      found.json<{
        data: Array<{ guestName: string; label: string; lineDescription: string }>;
      }>().data[0],
    ).toMatchObject({
      guestName: 'Traveller X 04',
      label: 'August itinerary',
      lineDescription: '4 PAX / itinerary',
    });
    for (const payload of [
      { invoiceNumber: 'I/2627/000001', financialYear: '2627' },
      { invoiceId },
    ]) {
      const linked = await app.inject({
        method: 'POST',
        url: `/commercial-bookings/${bookingId}/invoice`,
        payload,
      });
      expect(linked.statusCode, linked.body).toBe(200);
    }
    expect(links).toEqual([
      { invoiceNumber: 'I/2627/000001', financialYear: '2627' },
      { invoiceId },
    ]);
    await app.close();
  });
});
