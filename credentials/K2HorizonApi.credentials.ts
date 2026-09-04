import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
	Icon,
} from 'n8n-workflow';

export class K2HorizonApi implements ICredentialType {
	name = 'k2HorizonApi';

	displayName = 'K2 Horizon (IFM) API';

	documentationUrl = 'https://docs.ifm.ai';

	icon: Icon = { light: 'file:../icons/k2horizon.svg', dark: 'file:../icons/k2horizon.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'Created in the IFM Platform. Keys look like "IFM-xf…".',
		},
		{
			displayName: 'Base URL',
			name: 'url',
			type: 'string',
			default: 'https://api.ifm.ai/v1',
			description:
				'OpenAI-compatible base URL. Leave as-is for the hosted IFM gateway, or point it at your own SGLang or vLLM deployment — only the 375B model is hosted, but every K2 Horizon size is released as open weights.',
		},
	];

	// Powers the "Test" button. GET /models is the standard OpenAI-compatible
	// health check: it costs no tokens and fails loudly on a bad key or URL.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials?.url}}',
			url: '/models',
		},
	};

	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		requestOptions.headers ??= {};

		requestOptions.headers['Authorization'] = `Bearer ${credentials.apiKey}`;

		return requestOptions;
	}
}
