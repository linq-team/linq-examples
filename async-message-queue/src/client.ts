// =============================================================================
// Linq V3 API Client
// =============================================================================

import {
  CreateChatRequest,
  ChatResponse,
  MessageResponse,
  MessagePart,
} from './types';

export interface LinqClientConfig {
  baseUrl: string;
  apiToken: string;
}

export class LinqClient {
  private baseUrl: string;
  private apiToken: string;

  constructor(config: LinqClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // remove trailing slash
    this.apiToken = config.apiToken;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json() as T & { error?: { message?: string } };

    if (!response.ok) {
      throw new Error(
        data.error?.message || `API error: ${response.status}`
      );
    }

    return data;
  }

  /**
   * Create a new chat and optionally send the first message
   */
  async createChat(
    to: string[],
    from: string,
    message?: { parts: MessagePart[] }
  ): Promise<ChatResponse> {
    const request: CreateChatRequest = {
      to,
      from,
      message,
    };
    return this.request<ChatResponse>('POST', '/v3/chats', request);
  }

  /**
   * Send a message to an existing chat
   */
  async sendMessage(
    chatId: string,
    parts: MessagePart[]
  ): Promise<MessageResponse> {
    // V3 API: POST /v3/chats/{chatId}/messages
    return this.request<MessageResponse>(
      'POST',
      `/v3/chats/${chatId}/messages`,
      { message: { parts } }
    );
  }

  /**
   * Send typing indicator for a chat
   * Note: Uses direct fetch since this endpoint may return 204 No Content
   */
  async sendTypingIndicator(chatId: string): Promise<void> {
    const url = `${this.baseUrl}/v3/chats/${chatId}/typing`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`Typing indicator failed: ${response.status}`);
    }
  }

  /**
   * Get chat details
   */
  async getChat(chatId: string): Promise<ChatResponse> {
    return this.request<ChatResponse>('GET', `/v3/chats/${chatId}`);
  }
}
