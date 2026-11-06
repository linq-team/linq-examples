import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from standardwebhooks.webhooks import Webhook

from lfx_linq import LinqReplyInChat, LinqSendMessage

BASE = "https://api.linqapp.com/api/partner/v3"


@pytest.mark.asyncio
async def test_send_contract(respx_mock):
    route = respx_mock.post(BASE + "/messages").mock(
        return_value=httpx.Response(200, json={"chat_id": "chat-1", "message": {"id": "msg-1"}})
    )
    node = LinqSendMessage(
        api_key="test-key",
        recipients="+12025550123, person@example.com",
        text="hello",
        idempotency_key="event:reply",
    )
    result = await node.send_message()
    body = json.loads(route.calls.last.request.content)
    assert body == {
        "to": ["+12025550123", "person@example.com"],
        "message": {
            "parts": [{"type": "text", "value": "hello"}],
            "idempotency_key": "event:reply",
        },
    }
    assert route.calls.last.request.headers["Authorization"] == "Bearer test-key"
    assert result.data["chat_id"] == "chat-1"


@pytest.mark.asyncio
async def test_reply_contract(respx_mock):
    route = respx_mock.post(BASE + "/chats/chat-1/messages").mock(
        return_value=httpx.Response(200, json={"id": "msg-2"})
    )
    node = LinqReplyInChat(
        api_key="test-key", chat_id="chat-1", text="reply", idempotency_key="event:reply"
    )
    await node.send_message()
    assert (
        json.loads(route.calls.last.request.content)["message"]["idempotency_key"] == "event:reply"
    )


@pytest.mark.asyncio
async def test_invalid_recipient_no_request(respx_mock):
    node = LinqSendMessage(
        api_key="test", recipients="http://evil.test", text="hello", idempotency_key=""
    )
    with pytest.raises(ValueError, match="E.164"):
        await node.send_message()
    assert len(respx_mock.calls) == 0


@pytest.mark.asyncio
async def test_api_error_does_not_disclose_credentials_or_content(respx_mock):
    respx_mock.post(BASE + "/messages").mock(
        return_value=httpx.Response(403, json={"error": "test-key private-message"})
    )
    node = LinqSendMessage(
        api_key="test-key", recipients="+12025550123", text="private-message", idempotency_key=""
    )
    with pytest.raises(ValueError) as error:
        await node.send_message()
    assert "test-key" not in str(error.value) and "private-message" not in str(error.value)


@pytest.fixture
def gateway(monkeypatch, tmp_path):
    spec = importlib.util.spec_from_file_location(
        "gateway", Path(__file__).parents[1] / "examples/gateway.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setenv("LINQ_WEBHOOK_SECRET", "whsec_dGVzdC1zZWNyZXQ=")
    monkeypatch.setenv("LINQ_API_KEY", "linq-test-key")
    monkeypatch.setenv("LANGFLOW_API_KEY", "langflow-test-key")
    monkeypatch.setenv("LANGFLOW_URL", "https://langflow.example.com")
    monkeypatch.setenv("LANGFLOW_FLOW_ID", "flow-1")
    monkeypatch.setenv("LINQ_EVENTS_DB", str(tmp_path / "events.db"))
    return mod


def signed(event_id="event-1", **overrides):
    event = {
        "event_type": "message.received",
        "data": {
            "id": "msg-1",
            "direction": "inbound",
            "chat": {"id": "chat-1", "is_group": False},
            "sender_handle": {"handle": "+12025550123", "is_me": False},
            "parts": [{"type": "text", "value": "hello"}],
        },
    }
    event.update(overrides)
    payload = json.dumps(event)
    now = datetime.now(timezone.utc)
    sig = Webhook("whsec_dGVzdC1zZWNyZXQ=").sign(event_id, now, payload)
    return payload, {
        "webhook-id": event_id,
        "webhook-timestamp": str(int(now.timestamp())),
        "webhook-signature": sig,
        "content-type": "application/json",
    }


def test_gateway_round_trip_and_duplicate(gateway, respx_mock):
    flow = respx_mock.post("https://langflow.example.com/api/v1/run/flow-1").mock(
        return_value=httpx.Response(
            200,
            json={
                "outputs": [{"outputs": [{"results": {"message": {"text": "generated reply"}}}]}]
            },
        )
    )
    reply = respx_mock.post(BASE + "/chats/chat-1/messages").mock(
        return_value=httpx.Response(200, json={"id": "reply-1"})
    )
    payload, headers = signed()
    with TestClient(gateway.app) as client:
        assert client.post("/webhooks/linq", content=payload, headers=headers).status_code == 200
        assert client.post("/webhooks/linq", content=payload, headers=headers).json() == {
            "duplicate": True
        }
    assert flow.call_count == reply.call_count == 1
    assert json.loads(flow.calls.last.request.content)["session_id"] == "chat-1"
    assert json.loads(reply.calls.last.request.content) == {
        "message": {
            "parts": [{"type": "text", "value": "generated reply"}],
            "idempotency_key": "langflow:event-1",
        }
    }


def test_gateway_rejects_tampering(gateway, respx_mock):
    payload, headers = signed()
    with TestClient(gateway.app) as client:
        assert (
            client.post("/webhooks/linq", content=payload + " ", headers=headers).status_code == 401
        )
    assert len(respx_mock.calls) == 0


def test_gateway_ignores_self_and_delivery_events(gateway, respx_mock):
    payload, headers = signed(event_type="message.sent")
    with TestClient(gateway.app) as client:
        assert client.post("/webhooks/linq", content=payload, headers=headers).json() == {
            "ignored": True
        }
    assert len(respx_mock.calls) == 0


def test_gateway_failure_can_retry(gateway, respx_mock):
    route = respx_mock.post("https://langflow.example.com/api/v1/run/flow-1").mock(
        side_effect=[
            httpx.Response(500),
            httpx.Response(
                200,
                json={
                    "outputs": [{"outputs": [{"results": {"message": {"text": "retry reply"}}}]}]
                },
            ),
        ]
    )
    respx_mock.post(BASE + "/chats/chat-1/messages").mock(
        return_value=httpx.Response(200, json={"id": "reply-1"})
    )
    payload, headers = signed()
    with TestClient(gateway.app) as client:
        assert client.post("/webhooks/linq", content=payload, headers=headers).status_code == 503
        assert client.post("/webhooks/linq", content=payload, headers=headers).status_code == 200
    assert route.call_count == 2


def test_claim_is_durable_and_old_worker_is_fenced(gateway, tmp_path, monkeypatch):
    path = str(tmp_path / "claims.db")
    status, first = gateway.claim(path, "event")
    assert status == "claimed"
    assert gateway.claim(path, "event")[0] == "busy"
    now = gateway.time.time()
    monkeypatch.setattr(gateway.time, "time", lambda: now + 181)
    status, second = gateway.claim(path, "event")
    assert status == "claimed" and second > first
    gateway.finish(path, "event", second, True)
    gateway.finish(path, "event", first, False)
    assert gateway.claim(path, "event")[0] == "done"


def test_ambiguous_flow_output_is_rejected(gateway):
    with pytest.raises(ValueError):
        gateway.response_text({"outputs": []})


def test_equivalent_json_retry_is_deduplicated(gateway, respx_mock):
    respx_mock.post("https://langflow.example.com/api/v1/run/flow-1").mock(
        return_value=httpx.Response(
            200, json={"outputs": [{"outputs": [{"results": {"message": {"text": "reply"}}}]}]}
        )
    )
    respx_mock.post(BASE + "/chats/chat-1/messages").mock(
        return_value=httpx.Response(200, json={"id": "reply"})
    )
    payload, headers = signed()
    with TestClient(gateway.app) as client:
        assert client.post("/webhooks/linq", content=payload, headers=headers).status_code == 200
        compact = json.dumps(json.loads(payload), separators=(",", ":"))
        now = datetime.now(timezone.utc)
        headers["webhook-timestamp"] = str(int(now.timestamp()))
        headers["webhook-signature"] = Webhook("whsec_dGVzdC1zZWNyZXQ=").sign(
            "event-1", now, compact
        )
        assert client.post("/webhooks/linq", content=compact, headers=headers).json() == {
            "duplicate": True
        }


def test_gateway_skips_recovered_history(gateway, respx_mock):
    payload, headers = signed()
    event = json.loads(payload)
    event["data"]["reconciled_at"] = "2026-11-01T00:00:00Z"
    payload, headers = signed(data=event["data"])
    with TestClient(gateway.app) as client:
        assert client.post("/webhooks/linq", content=payload, headers=headers).json() == {
            "ignored": True
        }
    assert len(respx_mock.calls) == 0


@pytest.mark.asyncio
async def test_same_chat_processing_is_serial(gateway, monkeypatch, tmp_path):
    import asyncio

    active = 0
    maximum = 0

    async def process(text, chat, event):
        nonlocal active, maximum
        active += 1
        maximum = max(active, maximum)
        await asyncio.sleep(0.01)
        active -= 1

    monkeypatch.setattr(gateway, "process_event", process)
    await asyncio.gather(
        gateway.handle_event("a", "same", "event-a"), gateway.handle_event("b", "same", "event-b")
    )
    assert maximum == 1


def test_python310_timeout_is_sanitized(gateway, monkeypatch):
    class LegacyTimeout(Exception):
        pass

    async def timeout(coro, timeout):
        coro.close()
        raise LegacyTimeout()

    monkeypatch.setattr(gateway.asyncio, "TimeoutError", LegacyTimeout)
    monkeypatch.setattr(gateway.asyncio, "wait_for", timeout)
    payload, headers = signed()
    with TestClient(gateway.app) as client:
        response = client.post("/webhooks/linq", content=payload, headers=headers)
    assert response.status_code == 503
    assert response.json() == {"detail": "Processing failed; delivery can be retried"}


def test_extension_and_distribution_versions_match():
    from importlib.metadata import version

    manifest = json.loads((Path(__file__).parents[1] / "src/lfx_linq/extension.json").read_text())
    assert manifest["version"] == version("lfx-linq")
