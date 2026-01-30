// =============================================================================
// Webhook Server - Receives delivery confirmations from Linq
// =============================================================================

import express, { Request, Response } from 'express';
import { MessageQueueService } from './queue';
import { WebhookEvent, WebhookEventType, WebhookPayload } from './types';

export interface WebhookServerConfig {
  port: number;
  queue: MessageQueueService;
}

export function createWebhookServer(config: WebhookServerConfig): express.Application {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.post('/webhooks', async (req: Request, res: Response) => {
    try {
      const eventType = req.header('X-Webhook-Event') as WebhookEventType | undefined;
      const timestamp = req.header('X-Webhook-Timestamp') || new Date().toISOString();
      const body = req.body;
      const payload = body.data || body;

      const resolvedEventType = eventType || body.event_type;
      if (!resolvedEventType) {
        res.status(200).json({ received: true, ignored: true });
        return;
      }

      const event: WebhookEvent = {
        type: resolvedEventType as WebhookEventType,
        timestamp,
        data: payload,
      };

      await config.queue.handleWebhook(event);
      res.status(200).json({ received: true });
    } catch (error) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return app;
}

export function startWebhookServer(
  config: WebhookServerConfig
): Promise<ReturnType<express.Application['listen']>> {
  return new Promise((resolve) => {
    const app = createWebhookServer(config);
    const server = app.listen(config.port, () => resolve(server));
  });
}
