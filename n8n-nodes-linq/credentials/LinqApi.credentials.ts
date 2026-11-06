import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	Icon,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';
export class LinqApi implements ICredentialType {
	icon: Icon = { light: 'file:../nodes/Linq/linq.png', dark: 'file:../nodes/Linq/linq.png' };
	name = 'linqApi';
	displayName = 'Linq API';
	documentationUrl = 'https://docs.linqapp.com';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
	];
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
	};
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.linqapp.com/api/partner/v3',
			url: '/phone_numbers',
			method: 'GET',
		},
	};
}
