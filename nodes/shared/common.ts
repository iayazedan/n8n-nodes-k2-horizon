import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	INode,
	INodeProperties,
	INodePropertyOptions,
	ISupplyDataFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

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

/** Statuses the IFM error table marks "Backoff". Everything else is final. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Ceiling on a single wait, so a long Retry-After cannot hang a workflow. */
const MAX_RETRY_WAIT_MS = 60_000;

export const DEFAULT_MAX_RETRIES = 2;

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Retry-After is what the gateway sends on a 429 and is authoritative. Without
 * it, back off exponentially with jitter -- a batch of items that all hit the
 * per-minute guard at once must not retry in lockstep.
 */
function retryWaitMs(headers: IDataObject | undefined, attempt: number): number {
	const retryAfter = Number(headers?.['retry-after'] ?? headers?.['Retry-After']);
	if (Number.isFinite(retryAfter) && retryAfter > 0) {
		return Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS);
	}

	const window = Math.min(1000 * 2 ** attempt, 16_000);
	return window / 2 + Math.random() * (window / 2);
}

/**
 * A failed request carries a small JSON body even when a successful one would
 * have streamed, so reading it whole is safe -- and it releases the socket
 * before a retry.
 */
async function readErrorBody(body: unknown): Promise<unknown> {
	if (typeof body === 'object' && body !== null && Symbol.asyncIterator in body) {
		let text = '';
		for await (const chunk of body as AsyncIterable<Buffer | string>) text += chunk.toString();
		return parseJson(text) ?? text;
	}

	return typeof body === 'string' ? (parseJson(body) ?? body) : body;
}

function toApiError(
	node: INode,
	statusCode: number,
	body: unknown,
	retriesSpent: number,
): NodeApiError {
	const payload = (body ?? {}) as JsonObject;
	const apiError = payload.error as JsonObject | undefined;
	const message =
		(apiError?.message as string) ??
		(payload.detail as string) ??
		`Request failed with status code ${statusCode}`;

	// The gateway types a 429 as invalid_request_error, so the status is the
	// only reliable signal that waiting -- rather than editing -- is the fix.
	const description =
		statusCode === 429
			? `Rate or quota limit reached${retriesSpent > 0 ? ` after ${retriesSpent} retr${retriesSpent === 1 ? 'y' : 'ies'}` : ''}. Every key has a daily token cap and a per-minute guard: raise Max Retries, split the batch, or wait for the window to reset.`
			: ((apiError?.type as string) ?? undefined);

	return new NodeApiError(node, payload, { httpCode: String(statusCode), message, description });
}

/**
 * Requests go through n8n's HTTP helper so the credential applies the bearer
 * token and the instance's proxy settings are respected -- and so the package
 * needs no HTTP client of its own.
 *
 * Status errors are handled here rather than thrown by the helper, because a
 * 429 has to be read (for Retry-After) before it can be retried or reported.
 */
async function requestWithRetry(
	ctx: IExecuteFunctions | ISupplyDataFunctions,
	options: IHttpRequestOptions,
	maxRetries: number,
): Promise<unknown> {
	for (let attempt = 0; ; attempt++) {
		const response = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_NAME, {
			...options,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		})) as IN8nHttpFullResponse;

		if (response.statusCode < 300) return response.body;

		const body = await readErrorBody(response.body);

		if (attempt < maxRetries && RETRYABLE_STATUS.has(response.statusCode)) {
			await sleep(retryWaitMs(response.headers, attempt));
			continue;
		}

		throw toApiError(ctx.getNode(), response.statusCode, body, attempt);
	}
}

export function createRequests(
	ctx: IExecuteFunctions | ISupplyDataFunctions,
	headers: Record<string, string>,
	options: { timeout?: number; maxRetries?: number } = {},
): RequestConfig {
	const { timeout, maxRetries = DEFAULT_MAX_RETRIES } = options;

	return {
		httpRequest: async (method, url, body) => ({
			body: await requestWithRetry(
				ctx,
				{ method, url, body, headers, json: true, timeout },
				maxRetries,
			),
		}),
		openStream: async (method, url, body) => ({
			// A stream that breaks mid-generation cannot be resumed, so only the
			// opening handshake is retried here.
			body: (await requestWithRetry(
				ctx,
				{ method, url, body, headers, encoding: 'stream', timeout },
				maxRetries,
			)) as AsyncIterableIterator<Buffer | Uint8Array>,
		}),
	};
}
