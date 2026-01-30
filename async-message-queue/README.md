# Async Message Queue Example

A reference implementation showing how to integrate with the Linq V3 async API while maintaining sequential message ordering.

## The Problem

When migrating from sync to async APIs, you lose the request-response pattern that lets you:
- Send messages in guaranteed order (1 → 2 → 3 → 4)
- Wait for delivery confirmation before sending next
- Abort remaining messages if user responds
- Retry failed messages while maintaining order

## The Solution

This queue service handles all of that by:
1. Accepting a batch of messages to send in sequence
2. Sending them one at a time via the API
3. Waiting for `message.delivered` webhooks before advancing
4. Showing typing indicators between messages
5. Aborting remaining queue on `message.received` (inbound)
6. Retrying failed messages before giving up

## Prerequisites

1. API access with a valid token
2. A webhook subscription pointing to your server
3. Node.js 18+

### Setting Up Webhooks

Create a webhook subscription via the API:

```bash
curl -X POST "https://api.example.com/v3/webhook-subscriptions" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target_url": "https://your-server.com/webhooks/linq",
    "subscribed_events": ["message.sent", "message.delivered", "message.failed", "message.received"]
  }'
```

For local development, use [ngrok](https://ngrok.com) to expose your webhook server.

## Quick Start

```bash
# Install dependencies
npm install

# Set environment variables
export LINQ_API_URL=https://api.example.com
export LINQ_API_TOKEN=your-token
export LINQ_FROM_PHONE=+1234567890
export LINQ_TO_PHONE=+0987654321

# Run the demo
npm run demo
```

## How It Works

```
Your app generates [msg1, msg2, msg3, msg4]
                    ↓
            Queue Service
                    ↓
           Send msg1 → API
                    ↓
           Wait for webhook (message.delivered)
                    ↓
           Send typing indicator
                    ↓
           Wait N seconds
                    ↓
           Send msg2 → API
                    ↓
              ... repeat ...

           ⚡ message.received webhook (user replied)
                    ↓
           ABORT remaining queue
```

## Usage

```typescript
import { LinqClient } from './client';
import { MessageQueueService } from './queue';
import { startWebhookServer } from './webhook-server';

// Initialize client
const client = new LinqClient({
  baseUrl: process.env.LINQ_API_URL,
  apiToken: process.env.LINQ_API_TOKEN,
});

// Initialize queue
const queue = new MessageQueueService(client);

// Start webhook server
await startWebhookServer({ port: 3333, queue });

// Listen for events
queue.on('message:delivered', (msg) => {
  console.log(`Message ${msg.order} delivered!`);
});

queue.on('group:completed', () => {
  console.log('All messages sent!');
});

queue.on('group:aborted', (group, reason) => {
  console.log(`Aborted: ${reason}`);
});

// Enqueue messages
await queue.enqueue('conversation-123', [
  [{ type: 'text', value: 'Hey!' }],
  [{ type: 'text', value: 'How are you?' }],
  [{ type: 'text', value: 'Let me know if you need anything.' }],
], {
  to: ['+1234567890'],
  from: '+0987654321',
  typingDelayMs: 2000,
});
```

## Configuration

```typescript
await queue.enqueue(groupId, messages, {
  to: ['+1...'],           // recipient(s)
  from: '+1...',           // sender
  typingDelayMs: 2000,     // delay between messages (default: 2000ms)
  maxRetries: 3,           // retries per message (default: 3)
});
```

## Webhook Events

| Event | Action |
|-------|--------|
| `message.delivered` | Advance to next message |
| `message.sent` | Wait for delivery |
| `message.failed` | Retry or abort group |
| `message.received` | Abort group (user responded) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LINQ_API_URL` | API base URL |
| `LINQ_API_TOKEN` | API authentication token |
| `LINQ_FROM_PHONE` | Sender phone number |
| `LINQ_TO_PHONE` | Recipient phone number |
| `WEBHOOK_PORT` | Webhook server port (default: 3333) |

## Project Structure

```
src/
├── types.ts          # TypeScript types
├── client.ts         # API client
├── queue.ts          # Message queue service
├── webhook-server.ts # Webhook handler
└── demo.ts           # Demo script
```
