import type { Chat } from "chat";

export type WebhookContext = {
  bot: Chat<any>;
};

export type WebhookRoute = {
  path: string;
  handler: (req: Request) => Promise<Response>;
};

export type WebhookFactory = (ctx: WebhookContext) => WebhookRoute;
