import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { openSecret, sealSecret, verifyWebhook } from './webhook';
type Subscription = { id: string; sealed: string; targetUrl: string; isTest: boolean };
function state(context: IHookFunctions | IWebhookFunctions): Record<string, Subscription> {
	const data = context.getWorkflowStaticData('node');
	if (!data.subscriptions) data.subscriptions = {};
	return data.subscriptions as unknown as Record<string, Subscription>;
}
function url(context: IHookFunctions | IWebhookFunctions): string {
	const value = context.getNodeWebhookUrl('default');
	if (!value || !value.startsWith('https://'))
		throw new NodeOperationError(context.getNode(), 'Configure a public HTTPS webhook URL in n8n');
	return value;
}
function statusCode(error: unknown): number | undefined {
	return (
		(error as { statusCode?: number; response?: { status?: number } })?.statusCode ??
		(error as { response?: { status?: number } })?.response?.status
	);
}
export class LinqTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Linq Trigger',
		name: 'linqTrigger',
		subtitle: 'Message Received',
		icon: { light: 'file:linq.png', dark: 'file:linq.png' },
		group: ['trigger'],
		version: 1,
		description: 'Receive signed inbound Linq messages',
		defaults: { name: 'Linq Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'linqApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'linq',
				rawBody: true,
			},
		],
		properties: [
			{
				displayName:
					'Activate to create a Linq webhook subscription automatically. Deactivation removes that subscription. Test and production URLs have separate signing secrets.',
				name: 'setupNotice',
				type: 'notice',
				default: '',
			},
		],
	};
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const target = url(this);
				const saved = state(this)[target];
				if (!saved) return false;
				const credential = await this.getCredentials('linqApi');
				try {
					openSecret(saved.sealed, credential.apiKey as string, saved.id);
				} catch {
					throw new NodeOperationError(
						this.getNode(),
						'Deactivate and reactivate this workflow after rotating the Linq API key',
					);
				}
				try {
					const subscription = await this.helpers.httpRequestWithAuthentication.call(
						this,
						'linqApi',
						{
							url: `https://api.linqapp.com/api/partner/v3/webhook-subscriptions/${encodeURIComponent(saved.id)}`,
							method: 'GET',
							json: true,
							timeout: 30000,
						},
					);
					return (
						subscription.target_url === target &&
						subscription.is_active === true &&
						subscription.subscribed_events?.includes('message.received')
					);
				} catch (error) {
					if (statusCode(error) === 404) {
						delete state(this)[target];
						return false;
					}
					throw new NodeOperationError(
						this.getNode(),
						'Could not check the Linq webhook subscription',
					);
				}
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const target = url(this);
				const saved = state(this)[target];
				if (saved) {
					try {
						await this.helpers.httpRequestWithAuthentication.call(this, 'linqApi', {
							url: `https://api.linqapp.com/api/partner/v3/webhook-subscriptions/${encodeURIComponent(saved.id)}`,
							method: 'DELETE',
							json: true,
							timeout: 30000,
						});
					} catch (error) {
						if (statusCode(error) !== 404)
							throw new NodeOperationError(
								this.getNode(),
								'Could not replace the previous Linq webhook subscription',
							);
					}
					delete state(this)[target];
				}
				const credentials = await this.getCredentials('linqApi');
				let subscription: { id: string; signing_secret: string };
				try {
					subscription = await this.helpers.httpRequestWithAuthentication.call(this, 'linqApi', {
						url: 'https://api.linqapp.com/api/partner/v3/webhook-subscriptions',
						method: 'POST',
						body: { target_url: target, subscribed_events: ['message.received'] },
						json: true,
						timeout: 30000,
					});
				} catch {
					throw new NodeOperationError(
						this.getNode(),
						'Could not create the Linq webhook subscription. Check Linq before retrying after a timeout.',
					);
				}
				if (typeof subscription.id !== 'string' || typeof subscription.signing_secret !== 'string')
					throw new NodeOperationError(
						this.getNode(),
						'Linq returned an invalid webhook subscription',
					);
				state(this)[target] = {
					id: subscription.id,
					targetUrl: target,
					isTest: this.getMode() === 'manual',
					sealed: sealSecret(
						subscription.signing_secret,
						credentials.apiKey as string,
						subscription.id,
					),
				};
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const target = url(this);
				const saved = state(this)[target];
				if (!saved) return true;
				try {
					await this.helpers.httpRequestWithAuthentication.call(this, 'linqApi', {
						url: `https://api.linqapp.com/api/partner/v3/webhook-subscriptions/${encodeURIComponent(saved.id)}`,
						method: 'DELETE',
						json: true,
						timeout: 30000,
					});
				} catch (error) {
					if (statusCode(error) !== 404)
						throw new NodeOperationError(
							this.getNode(),
							'Could not delete the Linq webhook subscription',
						);
				}
				delete state(this)[target];
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const res = this.getResponseObject();
		try {
			const credentials = await this.getCredentials('linqApi');
			const candidates = Object.values(state(this)).filter((value) => value.isTest);
			const saved =
				this.getMode() === 'manual'
					? candidates.length === 1
						? candidates[0]
						: undefined
					: state(this)[url(this)];
			if (!saved)
				throw new NodeOperationError(this.getNode(), 'No Linq subscription for this webhook URL');
			const secret = openSecret(saved.sealed, credentials.apiKey as string, saved.id);
			if (!Buffer.isBuffer(req.rawBody))
				throw new NodeOperationError(this.getNode(), 'Raw request body is unavailable');
			verifyWebhook(req.rawBody, req.headers, secret);
			const event = JSON.parse(req.rawBody.toString('utf8')) as IDataObject;
			const data = event.data as IDataObject | undefined;
			const sender = data?.sender_handle as IDataObject | undefined;
			const chat = data?.chat as IDataObject | undefined;
			if (
				event.event_type !== 'message.received' ||
				data?.direction !== 'inbound' ||
				sender?.is_me === true ||
				data?.reconciled_at != null
			) {
				return { webhookResponse: { ok: true }, workflowData: [] };
			}
			if (
				typeof data.id !== 'string' ||
				typeof chat?.id !== 'string' ||
				typeof sender?.handle !== 'string'
			)
				throw new NodeOperationError(this.getNode(), 'Invalid inbound message');
			return {
				webhookResponse: { ok: true },
				workflowData: [
					this.helpers.returnJsonArray({
						eventId: req.headers['webhook-id'] as string,
						chatId: chat.id,
						messageId: data.id,
						from: sender.handle,
						text: Array.isArray(data.parts)
							? (data.parts as IDataObject[])
									.filter((p) => p.type === 'text' && typeof p.value === 'string')
									.map((p) => p.value)
									.join('\n')
							: '',
						event,
					}),
				],
			};
		} catch {
			res.status(401).json({ error: 'Webhook signature or payload could not be verified' });
			return { noWebhookResponse: true };
		}
	}
}
