/** Provider-independent content; account-access rules never belong in a transport. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type MailTransport = (message: MailMessage, idempotencyKey: string) => Promise<void>;

export interface ResendMailConfig {
  provider: 'resend';
  apiKey: string;
  from: string;
  replyTo?: string;
}

export type CustomerMailConfig =
  ResendMailConfig | { provider: 'relay'; endpoint: string; token: string };
