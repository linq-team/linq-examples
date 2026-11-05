# Linq for n8n

Send and receive iMessage, RCS, and SMS using Linq. Includes **Send Message**, **Reply in Chat**, **Get Chat**, **List Phone Numbers**, and a signature-verifying **Linq Trigger**. Credentials stay in n8n's encrypted credential store; the node has no runtime package dependencies.

## Build and install locally

Requires Node.js 22 and npm. From this directory:

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm run typecheck
npm pack --ignore-scripts
```

Until npm publication, install the built package into a self-hosted n8n's custom-node directory. Run `npm run dev` for the official n8n development environment. After publication, self-hosted users can install `@linqapp/n8n-nodes-linq` under Settings → Community nodes. n8n Cloud availability requires n8n's separate verification approval.

## Sending

Create a **Linq API** credential using your token from https://dashboard.linqapp.com/api-tooling/. Select it on the Linq node. Use E.164 phone numbers or email recipients. Send Message leaves line selection to Linq. Reply in Chat retains the incoming chat's line. Neither operation overrides opt-outs.

Set **Idempotency Key** to a stable unique value per logical message. Reuse that key for a retry, and use a new one for new content. A timeout is an unknown delivery result, not proof the message was not sent. Do not turn on automatic retries without an idempotency key.

## Receiving

1. Configure n8n with a public HTTPS webhook base URL (use an HTTPS tunnel for local development).
2. Add **Linq Trigger** and select the same **Linq API** credential used for sending.
3. Activate the workflow. The trigger creates a Linq subscription for `message.received`, verifies it on reactivation, and deletes its own subscription when deactivated. Test and production webhook URLs are tracked separately.

Linq returns the signing secret only once. The trigger encrypts it with AES-256-GCM under a key derived from the API key, binds it to its subscription ID, and stores only ciphertext in node static data. Keep n8n's credential key and database secure. **Deactivate before rotating the Linq API key, then select the new credential and reactivate** to create a fresh subscription. If activation is interrupted after the remote subscription was created but before n8n persists state, delete the orphaned subscription in Linq before retrying.

The trigger verifies the original request bytes, HMAC signature, and a five-minute timestamp window. It rejects missing raw bodies instead of reserializing JSON. Only verified `message.received` inbound messages with a non-self sender are emitted; historical recovery events are ignored. Output: `eventId`, `messageId`, `chatId`, `from`, `text`, and the original event. Retries can re-run a workflow; use stable reply idempotency and a persistent deduplication store if downstream actions are not idempotent.

## AI reply example

Import `examples/inbound-ai-reply.json` after installing the node. Choose your Linq API credential on both Linq nodes and your OpenAI credential. Review the model selection and prompt, then activate it yourself. It is disabled by default. The workflow only responds to direct text messages, uses the verified trigger's chat ID, and derives the reply idempotency key from its event ID. The model only produces text; it does not choose the recipient. Review n8n execution-data retention because inbound and outbound content can be retained there.

## Public submission after review

Publish from GitHub Actions with npm provenance, then submit the exact package through https://creators.n8n.io/nodes. A maintainer must configure npm trusted publishing and confirm ownership of the `@linqapp` scope. See `.github/workflows/publish-n8n.yml` at repository root. Configure the `npm-n8n-release` environment with required reviewers before using the manual publishing workflow. This PR does not publish the package or submit a listing.

## AI Agent tool usage

The Linq action node can also be connected as an AI Agent tool. In that mode, configure recipients and chat IDs as fixed values or expressions from a verified trigger. Do not use model-generated values for routing unless the workflow intentionally authorizes the agent to choose recipients. The included reply workflow keeps routing outside the model.

## Implementation notes

The action node uses programmatic execution to normalize multi-recipient input, construct distinct send/reply payloads, bind per-item errors and outputs, and keep provider request details out of workflow errors. The trigger performs dependent subscription lifecycle calls and raw-byte cryptographic verification, which require programmatic handling.
