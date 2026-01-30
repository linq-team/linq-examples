// =============================================================================
// Message Queue Service
//
// Handles sequential message delivery with:
// - Guaranteed ordering (1 -> 2 -> 3 -> 4)
// - Webhook-driven progression
// - Abort on inbound message
// - Retry on failure
// - Typing indicators between messages
// =============================================================================

import { EventEmitter } from 'events';
import { LinqClient } from './client';
import {
  QueuedMessage,
  MessageGroup,
  MessagePart,
  EnqueueOptions,
  WebhookEvent,
  QueueEvents,
} from './types';

export class MessageQueueService extends EventEmitter {
  private client: LinqClient;
  private groups: Map<string, MessageGroup> = new Map();
  private messages: Map<string, QueuedMessage> = new Map();
  private messagesByExternalId: Map<string, string> = new Map();

  constructor(client: LinqClient) {
    super();
    this.client = client;
  }

  on<E extends keyof QueueEvents>(event: E, listener: QueueEvents[E]): this {
    return super.on(event, listener);
  }

  emit<E extends keyof QueueEvents>(event: E, ...args: Parameters<QueueEvents[E]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Enqueue a sequence of messages to be sent in order
   */
  async enqueue(
    groupId: string,
    messageParts: MessagePart[][],
    options: EnqueueOptions
  ): Promise<void> {
    const group: MessageGroup = {
      id: groupId,
      to: options.to,
      from: options.from,
      currentOrder: 1,
      aborted: false,
      typingDelayMs: options.typingDelayMs ?? 2000,
      createdAt: new Date(),
    };
    this.groups.set(groupId, group);

    messageParts.forEach((parts, index) => {
      const message: QueuedMessage = {
        id: crypto.randomUUID(),
        groupId,
        order: index + 1,
        to: options.to,
        from: options.from,
        parts,
        status: 'pending',
        retries: 0,
        maxRetries: options.maxRetries ?? 3,
        createdAt: new Date(),
      };
      this.messages.set(message.id, message);
    });

    await this.processNext(groupId);
  }

  private async processNext(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group || group.aborted) return;

    const nextMessage = this.getMessageByOrder(groupId, group.currentOrder);
    if (!nextMessage) {
      this.emit('group:completed', group);
      return;
    }

    // Typing indicator + delay (except for first message)
    if (group.currentOrder > 1 && group.chatId) {
      try {
        await this.client.sendTypingIndicator(group.chatId);
      } catch {
        // Non-fatal
      }
      await this.delay(group.typingDelayMs);
      if (group.aborted) return;
    }

    await this.sendMessage(nextMessage, group);
  }

  private async sendMessage(message: QueuedMessage, group: MessageGroup): Promise<void> {
    message.status = 'sending';

    try {
      if (message.order === 1) {
        const response = await this.client.createChat(
          message.to,
          message.from,
          { parts: message.parts }
        );
        group.chatId = response.chat.id;
        group.service = response.chat.service;
        message.chatId = response.chat.id;
        message.externalMessageId = response.chat.message?.id;
      } else {
        if (!group.chatId) throw new Error('No chat ID');
        message.chatId = group.chatId;
        const response = await this.client.sendMessage(group.chatId, message.parts);
        message.externalMessageId = response.message.id;
      }

      message.status = 'sent';

      if (message.externalMessageId) {
        this.messagesByExternalId.set(message.externalMessageId, message.id);
      }

      this.emit('message:sent', message);
    } catch (error) {
      await this.handleSendError(message, group, error);
    }
  }

  private async handleSendError(
    message: QueuedMessage,
    group: MessageGroup,
    error: unknown
  ): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : String(error);
    message.retries++;

    if (message.retries < message.maxRetries) {
      await this.delay(1000 * message.retries);
      await this.sendMessage(message, group);
    } else {
      message.status = 'failed';
      this.emit('message:failed', message, errorMsg);
      this.abortGroup(group.id, `Message ${message.order} failed after ${message.maxRetries} retries`);
    }
  }

  async handleWebhook(event: WebhookEvent): Promise<void> {
    switch (event.type) {
      case 'message.sent':
      case 'message.delivered':
        await this.onMessageSuccess(event);
        break;
      case 'message.failed':
        await this.onMessageFailed(event);
        break;
      case 'message.received':
        await this.onInboundMessage(event);
        break;
    }
  }

  private async onMessageSuccess(event: WebhookEvent): Promise<void> {
    const messageId = event.data.message_id || event.data.message?.id;
    if (!messageId) return;

    const message = this.findMessageByExternalId(messageId);
    if (!message) return;

    message.status = event.type === 'message.delivered' ? 'delivered' : 'sent';

    const group = this.groups.get(message.groupId);
    if (!group || group.aborted) return;

    // Already processed this message (e.g., SMS got both sent and delivered webhooks)
    if (message.order < group.currentOrder) {
      if (event.type === 'message.delivered') {
        this.emit('message:delivered', message);
      }
      return;
    }

    // SMS doesn't reliably get delivery confirmations, so advance on message.sent
    // iMessage should wait for message.delivered
    const shouldAdvance =
      event.type === 'message.delivered' ||
      (group.service === 'SMS' && event.type === 'message.sent');

    if (shouldAdvance) {
      if (event.type === 'message.delivered') {
        this.emit('message:delivered', message);
      }
      group.currentOrder++;
      await this.processNext(message.groupId);
    }
  }

  private async onMessageFailed(event: WebhookEvent): Promise<void> {
    const messageId = event.data.message_id || event.data.message?.id;
    if (!messageId) return;

    const message = this.findMessageByExternalId(messageId);
    if (!message) return;

    const group = this.groups.get(message.groupId);
    if (!group) return;

    message.retries++;
    if (message.retries < message.maxRetries) {
      await this.delay(1000 * message.retries);
      await this.sendMessage(message, group);
    } else {
      message.status = 'failed';
      this.emit('message:failed', message, event.data.error || 'Unknown error');
      this.abortGroup(group.id, `Message ${message.order} failed`);
    }
  }

  private async onInboundMessage(event: WebhookEvent): Promise<void> {
    const chatId = event.data.chat_id;
    for (const [groupId, group] of this.groups) {
      if (group.chatId === chatId && !group.aborted) {
        this.abortGroup(groupId, 'inbound_message_received');
      }
    }
  }

  abortGroup(groupId: string, reason: string): void {
    const group = this.groups.get(groupId);
    if (!group || group.aborted) return;
    group.aborted = true;
    group.abortReason = reason;
    this.emit('group:aborted', group, reason);
  }

  abort(groupId: string): void {
    this.abortGroup(groupId, 'manually_aborted');
  }

  private getMessageByOrder(groupId: string, order: number): QueuedMessage | undefined {
    for (const message of this.messages.values()) {
      if (message.groupId === groupId && message.order === order) {
        return message;
      }
    }
    return undefined;
  }

  private findMessageByExternalId(externalId: string): QueuedMessage | undefined {
    const messageId = this.messagesByExternalId.get(externalId);
    return messageId ? this.messages.get(messageId) : undefined;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
