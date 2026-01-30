// =============================================================================
// Linq API Types
// =============================================================================

export interface MessagePart {
  type: 'text' | 'attachment';
  value?: string;        // for text
  url?: string;          // for attachment
  mime_type?: string;    // for attachment
}

export interface MessagePayload {
  parts: MessagePart[];
}

export interface CreateChatRequest {
  to: string[];
  from: string;
  message?: MessagePayload;
  service?: string;
}

// API Response
export interface ChatResponse {
  chat: {
    id: string;
    display_name?: string;
    handles: Array<{
      handle: string;
      id: string;
      is_me: boolean;
      service: string;
      status: string;
    }>;
    service: string;
    is_group: boolean;
    message?: {
      id: string;
      delivery_status: string;
      parts: MessagePart[];
      sent_at: string;
    };
  };
}

// SendMessageResponse per OpenAPI spec
export interface MessageResponse {
  chat_id: string;
  message: {
    id: string;
    delivery_status: string;
    parts: MessagePart[];
    sent_at: string;
    is_read: boolean;
  };
}

// =============================================================================
// Webhook Event Types
// =============================================================================

export type WebhookEventType =
  | 'message.sent'
  | 'message.delivered'
  | 'message.failed'
  | 'message.received';

// Webhook payload - event type is in X-Webhook-Event header
export interface WebhookPayload {
  chat_id: string;
  message_id?: string;
  message?: {
    id: string;
    parts: MessagePart[];
    delivered_at?: string;
    is_delivered?: boolean;
  };
  delivered_at?: string;
  error?: string;
  from?: string;
  is_from_me?: boolean;
}

export interface WebhookEvent {
  type: WebhookEventType;
  timestamp: string;
  data: WebhookPayload;
}

// =============================================================================
// Queue Types
// =============================================================================

export type MessageStatus = 'pending' | 'sending' | 'sent' | 'delivered' | 'failed';

export interface QueuedMessage {
  id: string;
  groupId: string;
  order: number;
  chatId?: string;        // set after first message creates chat
  to: string[];
  from: string;
  parts: MessagePart[];
  status: MessageStatus;
  externalMessageId?: string;  // Linq message ID
  retries: number;
  maxRetries: number;
  createdAt: Date;
}

export interface MessageGroup {
  id: string;
  chatId?: string;
  service?: string;           // 'iMessage' | 'SMS' - set after chat creation
  to: string[];
  from: string;
  currentOrder: number;
  aborted: boolean;
  abortReason?: string;
  typingDelayMs: number;
  createdAt: Date;
}

export interface EnqueueOptions {
  to: string[];
  from: string;
  typingDelayMs?: number;
  maxRetries?: number;
}

export interface QueueEvents {
  'message:sent': (message: QueuedMessage) => void;
  'message:delivered': (message: QueuedMessage) => void;
  'message:failed': (message: QueuedMessage, error: string) => void;
  'group:completed': (group: MessageGroup) => void;
  'group:aborted': (group: MessageGroup, reason: string) => void;
}
