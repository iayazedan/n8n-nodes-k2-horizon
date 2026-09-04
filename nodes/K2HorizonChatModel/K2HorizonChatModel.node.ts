import { randomUUID } from 'node:crypto';

import { supplyModel } from '@n8n/ai-node-sdk';

import { K2HorizonChatModelClient } from './model';
import type {
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

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

type ModelOptions = {
	temperature?: number;
	maxTokens?: number;
	topP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	timeout?: number;
	maxRetries?: number;
	sessionId?: string;
};

export class K2HorizonChatModel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'K2 Horizon Chat Model',
		name: 'k2HorizonChatModel',
		icon: { light: 'file:../../icons/k2horizon.svg', dark: 'file:../../icons/k2horizon.dark.svg' },
		group: ['transform'],
		version: [1],
		description: 'Use K2 Horizon (IFM) as the reasoning engine for an AI Agent',
		subtitle: '={{ $parameter["model"] }}',
		defaults: {
			name: 'K2 Horizon Chat Model',
		},
		codex: {
			categories: ['assistant'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
			resources: {
				primaryDocumentation: [{ url: 'https://docs.ifm.ai' }],
			},
		},

		inputs: [],

		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [
			{
				name: 'k2HorizonApi',
				required: true,
			},
		],
		properties: [
			{
				displayName:
					'K2 Horizon speaks the standard OpenAI tool-calling schema, so it can drive the AI Agent node and its tools directly',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
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
			},
			{
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
			},
			{
				displayName: 'Options',
				name: 'options',
				placeholder: 'Add Option',
				description: 'Additional options to add',
				type: 'collection',
				default: {},
				options: [
					{
						displayName: 'Frequency Penalty',
						name: 'frequencyPenalty',
						type: 'number',
						typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 2 },
						default: 0,
						description: 'Penalises tokens by how often they have already appeared',
					},
					{
						displayName: 'Max Retries',
						name: 'maxRetries',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 10 },
						default: 2,
						description: 'Retry attempts for rate limits and transient server errors',
					},
					{
						displayName: 'Max Tokens',
						name: 'maxTokens',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 4096,
						description:
							'Upper bound on generated tokens per agent step. Reasoning tokens count towards it.',
					},
					{
						displayName: 'Presence Penalty',
						name: 'presencePenalty',
						type: 'number',
						typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 2 },
						default: 0,
						description: 'Penalises tokens that have appeared at all, regardless of count',
					},
					{
						displayName: 'Sampling Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 1 },
						default: 0.7,
						description:
							'Controls randomness. Lower is more deterministic and repetitive; 0 is close to fixed.',
					},
					{
						displayName: 'Session ID',
						name: 'sessionId',
						type: 'string',
						default: '',
						description:
							'Sent as X-Session-ID, which keeps every step of one agent run on the compute node holding its cache. Leave empty to mint a fresh opaque ID per run.',
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						typeOptions: { minValue: 1000 },
						default: 300000,
						description:
							'Per-request timeout. High reasoning effort on long prompts can run for minutes.',
					},
					{
						displayName: 'Top P',
						name: 'topP',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
						default: 1,
						description: 'Nucleus sampling cutoff. Prefer tuning this or temperature, not both.',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				let ids: string[] = [];

				try {
					const credentials = await this.getCredentials('k2HorizonApi');
					const baseUrl = ((credentials.url as string) || DEFAULT_BASE_URL).replace(/\/+$/, '');

					const response = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'k2HorizonApi',
						{ method: 'GET', url: `${baseUrl}/models`, json: true },
					)) as { data?: Array<{ id?: string }> };

					ids = (response.data ?? [])
						.map((model) => model.id)
						.filter((id): id is string => Boolean(id));
				} catch {
					// Listing models is a convenience, never a reason to break the
					// parameter panel -- fall through to the published catalogue.
				}

				// A key scoped to a single model can 403 on /models, and an
				// unreachable gateway returns nothing. Either way the picker stays
				// usable rather than empty.
				if (ids.length === 0) return PUBLISHED_MODELS.map((id) => ({ name: id, value: id }));

				return ids.sort().map((id) => ({ name: id, value: id }));
			},
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
		const credentials = await this.getCredentials('k2HorizonApi');
		const model = this.getNodeParameter('model', itemIndex) as string;
		const reasoningEffort = this.getNodeParameter(
			'reasoningEffort',
			itemIndex,
			'high',
		) as 'low' | 'medium' | 'high';
		const options = this.getNodeParameter('options', itemIndex, {}) as ModelOptions;

		// An agent loop resends a growing transcript, so a stable ID is where
		// prefix caching pays off. Minting one per run keeps it opaque and
		// unshared, which is what the routing guidance asks for.
		const sessionId = options.sessionId || randomUUID();
		const headers = { 'X-Session-ID': sessionId };

		// Requests go through n8n's HTTP helper so the credential applies the
		// bearer token and the instance's proxy settings are respected -- and so
		// the package needs no HTTP client of its own.
		const client = new K2HorizonChatModelClient(
			model,
			{
				httpRequest: async (method, url, body) => ({
					body: await this.helpers.httpRequestWithAuthentication.call(this, 'k2HorizonApi', {
						method,
						url,
						body,
						headers,
						json: true,
						timeout: options.timeout,
					}),
				}),
				openStream: async (method, url, body) => ({
					body: await this.helpers.httpRequestWithAuthentication.call(this, 'k2HorizonApi', {
						method,
						url,
						body,
						headers,
						encoding: 'stream',
						timeout: options.timeout,
					}),
				}),
			},
			{
				baseURL: (credentials.url as string) || DEFAULT_BASE_URL,
				apiKey: credentials.apiKey as string,
				reasoningEffort,
				temperature: options.temperature,
				maxTokens: options.maxTokens,
				topP: options.topP,
				frequencyPenalty: options.frequencyPenalty,
				presencePenalty: options.presencePenalty,
				maxRetries: options.maxRetries,
				timeout: options.timeout,
			},
		);

		return supplyModel(this, client);
	}
}
