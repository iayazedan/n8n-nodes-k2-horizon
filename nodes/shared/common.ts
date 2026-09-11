import type {
	ICredentialDataDecryptedObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeProperties,
	INodePropertyOptions,
	ISupplyDataFunctions,
} from 'n8n-workflow';

import type { RequestConfig } from './model';

export const CREDENTIAL_NAME = 'k2HorizonApi';

const DEFAULT_BASE_URL = 'https://api.ifm.ai/v1';
const DEFAULT_MODEL = 'IFM/K2-Horizon-375B-A23B';

/** Shown when GET /models cannot be reached, so the picker is never empty. */
const PUBLISHED_MODELS = [
	'IFM/K2-Horizon-375B-A23B',
	'IFM/K2-Horizon-MoVA-36B-A4B',
	'IFM/K2-Horizon-32B',
	'IFM/K2-Horizon-7B',
	'IFM/K2-Horizon-3.7B',
	'IFM/K2-Horizon-0.9B',
];

export function getBaseUrl(credentials: ICredentialDataDecryptedObject): string {
	return ((credentials.url as string) || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export const modelProperty: INodeProperties = {
	displayName: 'Model Name or ID',
	name: 'model',
	type: 'options',
	typeOptions: {
		loadOptionsMethod: 'getModels',
	},
	default: DEFAULT_MODEL,
	required: true,
	description:
		'Model to call. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
};

export const reasoningEffortProperty: INodeProperties = {
	displayName: 'Reasoning Effort',
	name: 'reasoningEffort',
	type: 'options',
	default: 'high',
	options: [
		{
			name: 'High (Recommended)',
			value: 'high',
			description: 'The level IFM tunes and evaluates K2 Horizon at',
		},
		{
			name: 'Low',
			value: 'low',
			description: 'Smallest thinking budget. Validate on your own evals first.',
		},
		{
			name: 'Medium',
			value: 'medium',
			description: 'Balanced thinking budget. Validate on your own evals first.',
		},
	],
	description:
		'Thinking budget. High also produces fewer malformed tool arguments, which matters most inside an agent loop.',
};

export async function getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	let ids: string[] = [];

	try {
		const credentials = await this.getCredentials(CREDENTIAL_NAME);

		const response = (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL_NAME, {
			method: 'GET',
			url: `${getBaseUrl(credentials)}/models`,
			json: true,
		})) as { data?: Array<{ id?: string }> };

		ids = (response.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id));
	} catch {
		// Listing models is a convenience, never a reason to break the
		// parameter panel -- fall through to the published catalogue.
	}

	// A key scoped to a single model can 403 on /models, and an unreachable
	// gateway returns nothing. Either way the picker stays usable rather than
	// empty.
	if (ids.length === 0) return PUBLISHED_MODELS.map((id) => ({ name: id, value: id }));

	return ids.sort().map((id) => ({ name: id, value: id }));
}

/**
 * Requests go through n8n's HTTP helper so the credential applies the bearer
 * token and the instance's proxy settings are respected -- and so the package
 * needs no HTTP client of its own.
 */
export function createRequests(
	ctx: IExecuteFunctions | ISupplyDataFunctions,
	headers: Record<string, string>,
	timeout?: number,
): RequestConfig {
	return {
		httpRequest: async (method, url, body) => ({
			body: await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_NAME, {
				method,
				url,
				body,
				headers,
				json: true,
				timeout,
			}),
		}),
		openStream: async (method, url, body) => ({
			body: await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_NAME, {
				method,
				url,
				body,
				headers,
				encoding: 'stream',
				timeout,
			}),
		}),
	};
}
