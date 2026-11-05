# Linq for Langflow

An installable Langflow extension using the official Linq Python SDK. It adds **Linq Send Message** and **Linq Reply in Chat** to the component palette, plus a signed inbound webhook example.

## Install

Requires Python 3.10–3.14 and Langflow/LFX 1.13.x. From this directory:

```sh
uv sync --extra example
uv run lfx extension validate src/lfx_linq
uv run lfx extension list --format json
```

For an existing Langflow environment, install this directory into **the same Python environment running Langflow** with `pip install /path/to/linq-examples/langflow`, then restart Langflow. The `langflow.extensions` entry point discovers the manifest. Once published, this becomes `pip install lfx-linq`.

The two components appear in the Linq bundle. Set the API key using the component's secret field or a Langflow global secret. Send Message takes comma-separated E.164 numbers or email addresses and lets Linq choose the sending line. Reply in Chat uses an existing chat ID. The message text can be supplied by an agent tool; the recipient/chat ID should be configured by the flow, not chosen from untrusted model output.

An optional idempotency key deduplicates retries of a logical send. Do not reuse it for different messages. Both components use a 30-second timeout, disable implicit SDK retries, and preserve API opt-out enforcement.

## Receive → generate → reply

`examples/gateway.py` provides a runnable example around a saved Langflow flow. It verifies Linq's Standard Webhooks signature over the original bytes, accepts only direct inbound text messages, and runs your text-generation flow using the chat ID as its session. The gateway then replies in the verified original chat with a stable idempotency key. SQLite records completed event IDs, including across restarts; replies within a chat are serialized and expired claims are protected by generation checks; an in-flight claim causes a retryable response rather than a second run.

1. In Langflow, save a text-only flow with **Chat Input → agent/model → Chat Output**. Use a single Chat Output. The gateway owns the outbound send, so do not add a Linq send component or other side-effecting tools to this example's flow. Retrieve its flow ID and a Langflow API key.
2. Configure the following environment variables in your process/secret manager:

| Variable | Value |
|---|---|
| `LINQ_API_KEY` | Your Linq bearer API key |
| `LINQ_WEBHOOK_SECRET` | The webhook subscription's one-time signing secret |
| `LANGFLOW_URL` | Your Langflow HTTPS origin; localhost HTTP is allowed for development |
| `LANGFLOW_FLOW_ID` | The saved text-only flow ID |
| `LANGFLOW_API_KEY` | Key for invoking that Langflow flow |
| `LINQ_EVENTS_DB` | Writable durable SQLite path, e.g. `/data/linq-events.db` |

3. Run one worker, behind an HTTPS proxy with a short request-size limit:

```sh
uv run uvicorn --app-dir examples gateway:app --host 127.0.0.1 --port 8787 --workers 1
```

4. Create a Linq subscription to the public `/webhooks/linq` URL with `subscribed_events: ["message.received"]`. Use the returned signing secret above. Send a message from your test recipient to your Linq number. A verified message reaches the Langflow flow and its generated response is sent to the same chat.

The example makes real API calls only when you start it and send a signed event. Run tests below with mock APIs first. Do not send customer traffic through the review instance.

## Limits of the example

A request has a 90-second total deadline, including the per-chat lock wait, flow execution, and send. Each HTTP operation also has a 30-second timeout. Configure the reverse proxy accordingly; webhook retries are deduplicated. A process crash releases an unfinished claim after 180 seconds. It may run the model again after a failed or uncertain send, but the Linq idempotency key remains unchanged. Keep the database on a durable local volume, run only one worker, and use a proper shared queue/worker design before scaling across replicas. This is a reference integration, not a hosted service. Plan database retention and Langflow session/execution retention for message content.

## Verify and package

```sh
uv run ruff check src tests examples
uv run pytest
uv run lfx extension validate src/lfx_linq --execute-imports
uv build
```

CI checks the bundle against the real installed LFX runtime, tests API request shapes, verifies signatures, and exercises a full signed webhook → mocked Langflow → mocked Linq reply round trip. No real messages are sent by tests.

## Submission after review

Publish `lfx-linq` to PyPI from a reviewed release after confirming package ownership, then propose the Linq bundle to Langflow using its [extension guide](https://docs.langflow.org/extensions-quickstart) and [contribution guide](https://docs.langflow.org/contributing-bundles). Include the package, manifest, passing validation, component docs, and gateway example. Publication and a public catalogue listing are separate: installation works independently of Langflow accepting the contribution. Nothing in this PR is published automatically.
