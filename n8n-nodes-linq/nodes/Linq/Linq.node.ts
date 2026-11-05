import type {
	IExecuteFunctions,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
export class Linq implements INodeType {
	description: INodeTypeDescription = {
		icon: { light: 'file:linq.png', dark: 'file:linq.png' },
		subtitle: '={{$parameter["operation"]}}',
		displayName: 'Linq',
		name: 'linq',
		group: ['transform'],
		version: 1,
		description: 'Send iMessage, RCS, and SMS with Linq',
		defaults: { name: 'Linq' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'linqApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'send',
				options: [
					{ name: 'Get Chat', value: 'getChat', action: 'Get a chat' },
					{ name: 'List Phone Numbers', value: 'listPhoneNumbers', action: 'List phone numbers' },
					{ name: 'Reply in Chat', value: 'reply', action: 'Reply in a chat' },
					{ name: 'Send Message', value: 'send', action: 'Send a message' },
				],
			},
			{
				displayName: 'Recipients',
				name: 'recipients',
				type: 'string',
				default: '',
				required: true,
				placeholder: '+12025550123',
				description:
					'Comma-separated E.164 phone numbers or email addresses. Linq selects the sending line.',
				displayOptions: { show: { operation: ['send'] } },
			},
			{
				displayName: 'Chat ID',
				name: 'chatId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['reply', 'getChat'] } },
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				displayOptions: { show: { operation: ['send', 'reply'] } },
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				description:
					'A stable unique key for this logical message, reused on retries. For replies, use the inbound event ID plus an action suffix.',
				displayOptions: { show: { operation: ['send', 'reply'] } },
			},
		],
	};
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const output: INodeExecutionData[] = [];
		for (let i = 0; i < this.getInputData().length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				let path: string;
				let method: IHttpRequestOptions['method'] = 'GET';
				let body: IDataObject | undefined;
				if (operation === 'send' || operation === 'reply') {
					const text = (this.getNodeParameter('text', i) as string).trim();
					if (!text) throw new NodeOperationError(this.getNode(), 'Text must not be empty');
					const key = (this.getNodeParameter('idempotencyKey', i, '') as string).trim();
					const message: IDataObject = {
						parts: [{ type: 'text', value: text }],
						...(key ? { idempotency_key: key } : {}),
					};
					method = 'POST';
					if (operation === 'send') {
						const to = (this.getNodeParameter('recipients', i) as string)
							.split(',')
							.map((s) => s.trim());
						if (to.some((s) => !/^\+[1-9]\d{1,14}$/.test(s) && !/^\S+@\S+\.\S+$/.test(s)))
							throw new NodeOperationError(
								this.getNode(),
								'Recipients must be E.164 phone numbers or email addresses',
							);
						body = { to, message };
						path = '/messages';
					} else {
						const id = (this.getNodeParameter('chatId', i) as string).trim();
						if (!id) throw new NodeOperationError(this.getNode(), 'Chat ID is required');
						path = `/chats/${encodeURIComponent(id)}/messages`;
						body = { message };
					}
				} else if (operation === 'getChat') {
					const id = (this.getNodeParameter('chatId', i) as string).trim();
					if (!id) throw new NodeOperationError(this.getNode(), 'Chat ID is required');
					path = `/chats/${encodeURIComponent(id)}`;
				} else if (operation === 'listPhoneNumbers') {
					path = '/phone_numbers';
				} else throw new NodeOperationError(this.getNode(), 'Unsupported operation');
				const response = await this.helpers.httpRequestWithAuthentication.call(this, 'linqApi', {
					url: `https://api.linqapp.com/api/partner/v3${path}`,
					method,
					body,
					json: true,
					timeout: 30000,
				});
				output.push({ json: response as IDataObject, pairedItem: { item: i } });
			} catch (error) {
				// Do not include HTTP request objects, which can carry the Authorization header.
				const status = (error as { statusCode?: number }).statusCode;
				const message = status
					? `Linq request failed (HTTP ${status})`
					: 'Linq operation failed. Check the operation inputs and credentials.';
				if (this.continueOnFail())
					output.push({ json: { error: message }, pairedItem: { item: i } });
				else throw new NodeOperationError(this.getNode(), message, { itemIndex: i });
			}
		}
		return [output];
	}
}
