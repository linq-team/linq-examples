"""Signed Linq webhook -> Langflow text flow -> reply to the verified chat.

Run one Uvicorn worker. SQLite claims make retries safe across process restarts.
The flow must only generate text: this gateway owns the outbound message.
"""

import asyncio
import os
import sqlite3
import time
from urllib.parse import quote, urlparse
from weakref import WeakValueDictionary

import httpx
from fastapi import FastAPI, HTTPException, Request
from linq import APIError, AsyncClient
from standardwebhooks.webhooks import Webhook, WebhookVerificationError

app = FastAPI()
MAX_BODY = 1024 * 1024
_chat_locks = WeakValueDictionary()


def claim(path: str, event_id: str) -> tuple[str, int]:
    with sqlite3.connect(path, timeout=5) as db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, done INTEGER NOT NULL DEFAULT 0, lease REAL NOT NULL, generation INTEGER NOT NULL DEFAULT 0)"
        )
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT done,lease,generation FROM events WHERE id=?", (event_id,)
        ).fetchone()
        if row and row[0]:
            return "done", row[2]
        if row and row[1] > time.time():
            return "busy", row[2]
        generation = row[2] + 1 if row else 1
        db.execute(
            "INSERT INTO events(id,lease,generation) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET lease=excluded.lease,generation=excluded.generation",
            (event_id, time.time() + 180, generation),
        )
        return "claimed", generation


def finish(path: str, event_id: str, generation: int, done: bool) -> None:
    with sqlite3.connect(path, timeout=5) as db:
        db.execute(
            "UPDATE events SET done=?,lease=0 WHERE id=? AND generation=? AND done=0",
            (int(done), event_id, generation),
        )


def response_text(response: dict) -> str:
    # The public run API wraps terminal components under outputs[].outputs[].
    try:
        values = [
            output["results"]["message"]["text"]
            for group in response["outputs"]
            for output in group["outputs"]
        ]
    except (KeyError, TypeError):
        raise ValueError("Malformed Langflow output") from None
    if len(values) != 1 or not isinstance(values[0], str) or not values[0].strip():
        raise ValueError("The Langflow flow must return exactly one Chat Output message")
    return values[0]


async def process_event(text: str, chat_id: str, event_id: str) -> None:
    base = os.environ["LANGFLOW_URL"].rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}
    ):
        raise ValueError("Use HTTPS for remote Langflow")
    flow_id = quote(os.environ["LANGFLOW_FLOW_ID"], safe="")
    async with httpx.AsyncClient(timeout=30.0) as client:
        result = await client.post(
            f"{base}/api/v1/run/{flow_id}",
            headers={"x-api-key": os.environ["LANGFLOW_API_KEY"]},
            json={
                "input_value": text,
                "input_type": "chat",
                "output_type": "chat",
                "session_id": chat_id,
            },
        )
        result.raise_for_status()
        reply = response_text(result.json())
    async with AsyncClient(
        api_key=os.environ["LINQ_API_KEY"], timeout=30.0, max_retries=0
    ) as client:
        await client.chats.messages.send(
            chat_id,
            message={
                "parts": [{"type": "text", "value": reply}],
                "idempotency_key": f"langflow:{event_id}",
            },
        )


async def handle_event(text: str, chat_id: str, event_id: str) -> dict:
    # One process: serialize replies and session history updates within each chat.
    lock = _chat_locks.setdefault(chat_id, asyncio.Lock())
    async with lock:
        path = os.environ.get("LINQ_EVENTS_DB", "linq-events.db")
        status, generation = await asyncio.to_thread(claim, path, event_id)
        if status == "done":
            return {"duplicate": True}
        if status != "claimed":
            raise HTTPException(503, "Event is already processing")
        succeeded = False
        try:
            await process_event(text, chat_id, event_id)
            succeeded = True
            return {"ok": True}
        finally:
            await asyncio.to_thread(finish, path, event_id, generation, succeeded)


@app.post("/webhooks/linq")
async def webhook(request: Request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_BODY:
            raise HTTPException(413, "Webhook too large")
    raw = bytes(raw)
    try:
        event = Webhook(os.environ["LINQ_WEBHOOK_SECRET"]).verify(raw, dict(request.headers))
    except (WebhookVerificationError, ValueError, TypeError):
        raise HTTPException(401, "Invalid webhook signature") from None
    if not isinstance(event, dict):
        raise HTTPException(400, "Invalid event")
    data = event.get("data", {})
    if event.get("event_type") != "message.received":
        return {"ignored": True}
    if not isinstance(data, dict) or data.get("direction") != "inbound":
        return {"ignored": True}
    sender = data.get("sender_handle", {})
    chat = data.get("chat", {})
    if data.get("reconciled_at") is not None:
        return {"ignored": True}
    if not isinstance(sender, dict) or sender.get("is_me") is True:
        return {"ignored": True}
    if not isinstance(chat, dict) or not isinstance(chat.get("id"), str) or not chat["id"]:
        raise HTTPException(400, "Missing chat")
    # Avoid responding to groups without an explicit group-agent policy.
    if chat.get("is_group") is not False:
        return {"ignored": True}
    parts = data.get("parts", [])
    if not isinstance(parts, list):
        raise HTTPException(400, "Invalid message parts")
    text = "\n".join(
        p["value"]
        for p in parts
        if isinstance(p, dict) and p.get("type") == "text" and isinstance(p.get("value"), str)
    )
    if not text.strip():
        return {"ignored": True}
    event_id = request.headers["webhook-id"]
    try:
        # A wall-clock deadline covers lock wait, flow execution and sending.
        return await asyncio.wait_for(handle_event(text, chat["id"], event_id), timeout=90)
    except (APIError, httpx.HTTPError, ValueError, KeyError, TypeError, RuntimeError, TimeoutError):
        # No provider exception text, keys, prompts, or message contents in responses/logs.
        raise HTTPException(503, "Processing failed; delivery can be retried") from None
