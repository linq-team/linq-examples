// =============================================================================
// Demo: Async Message Queue with Guaranteed Ordering
//
// Shows how to maintain guaranteed ordering with async APIs:
// - Sequential message delivery (1 → 2 → 3 → 4)
// - Typing indicators between messages
// - Abort capability on inbound user message
// =============================================================================

import { LinqClient } from './client';
import { MessageQueueService } from './queue';
import { startWebhookServer } from './webhook-server';
import { MessagePart } from './types';

const config = {
  apiUrl: process.env.LINQ_API_URL,
  apiToken: process.env.LINQ_API_TOKEN,
  webhookPort: parseInt(process.env.WEBHOOK_PORT || '3333', 10),
  fromPhone: process.env.LINQ_FROM_PHONE,
  toPhone: process.env.LINQ_TO_PHONE,
};

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runDemo() {
  console.log('\n' + '='.repeat(50));
  console.log('  Async Message Queue Demo');
  console.log('  Guaranteed Sequential Delivery');
  console.log('='.repeat(50));

  if (!config.apiUrl || !config.apiToken || !config.fromPhone || !config.toPhone) {
    console.log('\nMissing environment variables:\n');
    console.log('  LINQ_API_URL      API base URL');
    console.log('  LINQ_API_TOKEN    Your API token');
    console.log('  LINQ_FROM_PHONE   Sender phone (+1...)');
    console.log('  LINQ_TO_PHONE     Recipient phone (+1...)\n');
    process.exit(1);
  }

  console.log(`\n  From: ${config.fromPhone}`);
  console.log(`  To:   ${config.toPhone}\n`);

  // Initialize client and queue
  const client = new LinqClient({
    baseUrl: config.apiUrl,
    apiToken: config.apiToken,
  });

  const queue = new MessageQueueService(client);

  // Track progress
  queue.on('message:sent', (msg) => {
    console.log(`  → Message ${msg.order} sent, waiting for delivery...`);
  });

  queue.on('message:delivered', (msg) => {
    console.log(`  ✓ Message ${msg.order} delivered`);
  });

  let completed = false;
  queue.on('group:completed', () => {
    console.log(`  ✓ All messages delivered in order!`);
    completed = true;
  });

  queue.on('group:aborted', (_, reason) => {
    console.log(`  ✗ Aborted: ${reason}`);
    completed = true;
  });

  // Start webhook server
  const server = await startWebhookServer({ port: config.webhookPort, queue });

  // Graceful shutdown
  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Define messages to send
  const messages: MessagePart[][] = [
    [{ type: 'text', value: '1️⃣ First message' }],
    [{ type: 'text', value: '2️⃣ Second message' }],
    [{ type: 'text', value: '3️⃣ Third message' }],
    [{ type: 'text', value: '4️⃣ Fourth message' }],
  ];

  console.log('Sending 4 messages in sequence...\n');

  // Enqueue and process
  await queue.enqueue('demo', messages, {
    to: [config.toPhone],
    from: config.fromPhone,
    typingDelayMs: 1500,
  });

  // Wait for completion
  while (!completed) {
    await delay(100);
  }

  console.log('\n' + '='.repeat(50));
  console.log('  Demo Complete');
  console.log('='.repeat(50) + '\n');

  server.close();
  process.exit(0);
}

runDemo().catch((err) => {
  console.error(err);
  process.exit(1);
});
