"""Native Langflow components backed by the official Linq Python SDK."""

import re
from typing import ClassVar

from lfx.custom.custom_component.component import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema.data import Data
from linq import APIError, AsyncClient


def _secret(value):
    return value.get_secret_value() if hasattr(value, "get_secret_value") else str(value or "")


class LinqSendMessage(Component):
    display_name = "Linq Send Message"
    description = "Send iMessage, RCS, or SMS; Linq chooses the sending line."
    documentation = "https://docs.linqapp.com/channel/imessage/"
    icon = "MessageCircle"
    name = "LinqSendMessage"
    inputs: ClassVar[list] = [
        SecretStrInput(name="api_key", display_name="Linq API Key", required=True),
        MessageTextInput(
            name="recipients",
            display_name="Recipients",
            required=True,
            info="Comma-separated E.164 phone numbers or email addresses.",
        ),
        MessageTextInput(name="text", display_name="Message", required=True, tool_mode=True),
        MessageTextInput(
            name="idempotency_key",
            display_name="Idempotency Key",
            advanced=True,
            info="Stable per logical message. Reuse on retries, not for different messages.",
        ),
    ]
    outputs: ClassVar[list] = [Output(name="result", display_name="Result", method="send_message")]

    async def send_message(self) -> Data:
        recipients = [s.strip() for s in self.recipients.split(",")]
        if any(
            not (
                re.fullmatch(r"\+[1-9]\d{1,14}", s) or re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", s)
            )
            for s in recipients
        ):
            raise ValueError("Recipients must be E.164 phone numbers or email addresses")
        if not self.text.strip():
            raise ValueError("Message must not be empty")
        key = (self.idempotency_key or "").strip()
        message = {"parts": [{"type": "text", "value": self.text}]}
        if key:
            message["idempotency_key"] = key
        try:
            async with AsyncClient(
                api_key=_secret(self.api_key), timeout=30.0, max_retries=0
            ) as client:
                response = await client.messages.create(to=recipients, message=message)
        except APIError:
            raise ValueError(
                "Linq request failed; check credentials, recipients, and line status"
            ) from None
        result = Data(data=response.to_dict())
        self.status = result
        return result


class LinqReplyInChat(Component):
    display_name = "Linq Reply in Chat"
    description = "Reply in an existing Linq conversation."
    documentation = "https://docs.linqapp.com/channel/imessage/"
    icon = "MessageCircleReply"
    name = "LinqReplyInChat"
    inputs: ClassVar[list] = [
        SecretStrInput(name="api_key", display_name="Linq API Key", required=True),
        MessageTextInput(
            name="chat_id",
            display_name="Chat ID",
            required=True,
            info="Use the verified inbound chat ID; do not ask a model to choose it.",
        ),
        MessageTextInput(name="text", display_name="Message", required=True, tool_mode=True),
        MessageTextInput(
            name="idempotency_key",
            display_name="Idempotency Key",
            advanced=True,
            info="For an inbound reply, use the verified webhook ID plus an action suffix.",
        ),
    ]
    outputs: ClassVar[list] = [Output(name="result", display_name="Result", method="send_message")]

    async def send_message(self) -> Data:
        if not self.chat_id.strip() or not self.text.strip():
            raise ValueError("Chat ID and message must not be empty")
        message = {"parts": [{"type": "text", "value": self.text}]}
        key = (self.idempotency_key or "").strip()
        if key:
            message["idempotency_key"] = key
        try:
            async with AsyncClient(
                api_key=_secret(self.api_key), timeout=30.0, max_retries=0
            ) as client:
                response = await client.chats.messages.send(self.chat_id, message=message)
        except APIError:
            raise ValueError(
                "Linq reply failed; check credentials, chat, and line status"
            ) from None
        result = Data(data=response.to_dict())
        self.status = result
        return result
