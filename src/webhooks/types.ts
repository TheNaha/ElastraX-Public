export type WebhookBody = Record<string, unknown>;
export type SendFn = (chatId: string, text: string, platform?: string) => Promise<void>;
