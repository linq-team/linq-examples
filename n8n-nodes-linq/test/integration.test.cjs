const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { Linq } = require('../dist/nodes/Linq/Linq.node');
const { LinqTrigger } = require('../dist/nodes/Linq/LinqTrigger.node');
const { verifyWebhook, sealSecret, openSecret } = require('../dist/nodes/Linq/webhook');
const secret = 'whsec_' + Buffer.from('test-only-secret-not-a-real-key').toString('base64');
const event = {
	event_type: 'message.received',
	data: {
		id: 'msg-1',
		direction: 'inbound',
		chat: { id: 'chat-1', is_group: false },
		sender_handle: { handle: '+12025550123', is_me: false },
		parts: [{ type: 'text', value: 'hello' }],
	},
};
function signed(payload = event, ts = Math.floor(Date.now() / 1000)) {
	const raw = Buffer.from(JSON.stringify(payload));
	const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
		.update(`event-1.${ts}.`)
		.update(raw)
		.digest('base64');
	return {
		rawBody: raw,
		headers: {
			'webhook-id': 'event-1',
			'webhook-timestamp': String(ts),
			'webhook-signature': `v1,${signature}`,
		},
	};
}
async function run(params, items = [{ json: {} }], reject = false, continueOnFail = false) {
	const calls = [];
	const context = {
		getNode: () => ({ name: 'Linq' }),
		getInputData: () => items,
		getNodeParameter: (name, i, fallback) => params[name] ?? fallback,
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async function (credential, options) {
				calls.push({ credential, options });
				if (reject) throw { statusCode: 403, request: { Authorization: 'secret' } };
				return { id: 'result' };
			},
		},
	};
	return { output: await new Linq().execute.call(context), calls };
}
async function trigger(req) {
	let status = 200,
		body;
	const response = {
		status(s) {
			status = s;
			return this;
		},
		json(b) {
			body = b;
			return this;
		},
	};
	const context = {
		getNode: () => ({ name: 'trigger' }),
		getRequestObject: () => req,
		getResponseObject: () => response,
		getCredentials: async () => ({ apiKey: 'test-key' }),
		getNodeWebhookUrl: () => 'https://n8n.example.com/webhook/linq',
		getWorkflowStaticData: () => ({
			subscriptions: {
				'https://n8n.example.com/webhook/linq': {
					id: 'sub-1',
					sealed: sealSecret(secret, 'test-key', 'sub-1'),
				},
			},
		}),
		helpers: { returnJsonArray: (json) => [{ json }] },
	};
	const result = await new LinqTrigger().webhook.call(context);
	return { result, status, body };
}
test('sends exact API contract without a pinned sending line', async () => {
	const { calls, output } = await run({
		operation: 'send',
		recipients: '+12025550123, person@example.com',
		text: 'hello',
		idempotencyKey: 'event:reply',
	});
	assert.equal(calls[0].credential, 'linqApi');
	assert.equal(calls[0].options.url, 'https://api.linqapp.com/api/partner/v3/messages');
	assert.deepEqual(calls[0].options.body, {
		to: ['+12025550123', 'person@example.com'],
		message: { parts: [{ type: 'text', value: 'hello' }], idempotency_key: 'event:reply' },
	});
	assert.deepEqual(output[0][0].pairedItem, { item: 0 });
	assert.equal(calls[0].options.timeout, 30000);
});
test('replies only to supplied chat and encodes path segments', async () => {
	const { calls } = await run({ operation: 'reply', chatId: 'chat/a?x=1', text: 'reply' });
	assert.equal(
		calls[0].options.url,
		'https://api.linqapp.com/api/partner/v3/chats/chat%2Fa%3Fx%3D1/messages',
	);
	assert.equal(calls[0].options.body.override_optout, undefined);
});
test('per-item execution produces paired output', async () => {
	const { calls, output } = await run({ operation: 'getChat', chatId: 'chat-1' }, [
		{ json: {} },
		{ json: {} },
	]);
	assert.equal(calls.length, 2);
	assert.equal(output[0][1].pairedItem.item, 1);
});
test('invalid recipient stops before outbound request', async () => {
	await assert.rejects(run({ operation: 'send', recipients: 'https://evil.test', text: 'hello' }));
});
test('error output cannot expose request credentials', async () => {
	const { output } = await run({ operation: 'listPhoneNumbers' }, undefined, true, true);
	assert.equal(output[0][0].json.error, 'Linq request failed (HTTP 403)');
	assert.ok(!JSON.stringify(output).includes('secret'));
});
test('valid signed incoming message reaches the workflow', async () => {
	const { result, status } = await trigger(signed());
	assert.equal(status, 200);
	assert.equal(result.workflowData[0][0].json.chatId, 'chat-1');
	assert.equal(result.workflowData[0][0].json.text, 'hello');
});
test('tampered payload fails before workflow execution', async () => {
	const req = signed();
	req.rawBody = Buffer.from(JSON.stringify({ ...event, extra: 'tampered' }));
	const { result, status } = await trigger(req);
	assert.equal(status, 401);
	assert.equal(result.workflowData, undefined);
});
test('expired and future signatures are rejected', () => {
	for (const ts of [Date.now() / 1000 - 600, Date.now() / 1000 + 600]) {
		const req = signed(event, Math.floor(ts));
		assert.throws(() => verifyWebhook(req.rawBody, req.headers, secret));
	}
});
test('key rotation signatures accept a matching v1', () => {
	const req = signed();
	req.headers['webhook-signature'] = 'v1,invalid ' + req.headers['webhook-signature'];
	assert.doesNotThrow(() => verifyWebhook(req.rawBody, req.headers, secret));
});
test('parsed JSON without the original raw bytes fails closed', async () => {
	const req = signed();
	delete req.rawBody;
	req.body = event;
	assert.equal((await trigger(req)).status, 401);
});
test('outbound, status and self-authored events never trigger an agent', async () => {
	for (const value of [
		{ ...event, event_type: 'message.sent' },
		{ ...event, data: { ...event.data, direction: 'outbound' } },
		{ ...event, data: { ...event.data, sender_handle: { is_me: true } } },
	]) {
		const { result } = await trigger(signed(value));
		assert.deepEqual(result.workflowData, []);
	}
});
test('malformed inbound event is rejected', async () => {
	assert.equal(
		(await trigger(signed({ ...event, data: { ...event.data, chat: {} } }))).status,
		401,
	);
});

test('historical recovery does not trigger a new reply', async () => {
	const { result } = await trigger(
		signed({ ...event, data: { ...event.data, reconciled_at: new Date().toISOString() } }),
	);
	assert.deepEqual(result.workflowData, []);
});
test('inbound sender with omitted optional is_me is accepted', async () => {
	const { result } = await trigger(
		signed({ ...event, data: { ...event.data, sender_handle: { handle: '+12025550123' } } }),
	);
	assert.equal(result.workflowData[0][0].json.chatId, 'chat-1');
});

test('subscription secret is encrypted and bound to its account and subscription', () => {
	const sealed = sealSecret(secret, 'account-key', 'sub-1');
	assert.ok(!sealed.includes(secret));
	assert.equal(openSecret(sealed, 'account-key', 'sub-1'), secret);
	assert.throws(() => openSecret(sealed, 'other-key', 'sub-1'));
	assert.throws(() => openSecret(sealed, 'account-key', 'sub-2'));
});
test('webhook lifecycle creates, checks and deletes only its own subscription', async () => {
	const data = {};
	const calls = [];
	const context = {
		getNode: () => ({ name: 'trigger' }),
		getNodeWebhookUrl: () => 'https://n8n.example.com/webhook/linq',
		getWorkflowStaticData: () => data,
		getCredentials: async () => ({ apiKey: 'test-key' }),
		helpers: {
			httpRequestWithAuthentication: async function (_credential, options) {
				calls.push(options);
				if (options.method === 'POST') return { id: 'sub-1', signing_secret: secret };
				if (options.method === 'GET')
					return {
						id: 'sub-1',
						target_url: 'https://n8n.example.com/webhook/linq',
						is_active: true,
						subscribed_events: ['message.received'],
					};
				return {};
			},
		},
	};
	const methods = new LinqTrigger().webhookMethods.default;
	assert.equal(await methods.checkExists.call(context), false);
	assert.equal(await methods.create.call(context), true);
	assert.ok(!JSON.stringify(data).includes(secret));
	assert.equal(await methods.checkExists.call(context), true);
	assert.equal(await methods.delete.call(context), true);
	assert.deepEqual(data.subscriptions, {});
	assert.deepEqual(
		calls.map((c) => c.method),
		['POST', 'GET', 'DELETE'],
	);
});

test('test and production webhook secrets do not overwrite each other', async () => {
	const data = {};
	let target = 'https://n8n.example.com/webhook/linq';
	let index = 0;
	const context = {
		getNode: () => ({ name: 'trigger' }),
		getNodeWebhookUrl: () => target,
		getWorkflowStaticData: () => data,
		getCredentials: async () => ({ apiKey: 'test-key' }),
		helpers: {
			httpRequestWithAuthentication: async () => ({ id: 'sub-' + ++index, signing_secret: secret }),
		},
	};
	const methods = new LinqTrigger().webhookMethods.default;
	await methods.create.call(context);
	target = 'https://n8n.example.com/webhook-test/linq';
	await methods.create.call(context);
	assert.equal(Object.keys(data.subscriptions).length, 2);
});
