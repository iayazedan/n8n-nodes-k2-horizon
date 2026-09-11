import { randomUUID } from 'node:crypto';

import { supplyModel } from '@n8n/ai-node-sdk';

import {
	CREDENTIAL_NAME,
	createRequests,
	getBaseUrl,
	getModels,
	modelProperty,
	reasoningEffortProperty,
} from '../shared/common';
import { K2HorizonChatModelClient, type ReasoningEffort } from '../shared/model';
import type { INodeType, INodeTypeDescription, ISupplyDataFunctions } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

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
				name: CREDENTIAL_NAME,
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
			modelProperty,
			reasoningEffortProperty,
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
		loadOptions: { getModels },
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
		const credentials = await this.getCredentials(CREDENTIAL_NAME);
		const model = this.getNodeParameter('model', itemIndex) as string;
		const reasoningEffort = this.getNodeParameter(
			'reasoningEffort',
			itemIndex,
			'high',
		) as ReasoningEffort;
		const options = this.getNodeParameter('options', itemIndex, {}) as ModelOptions;

		// An agent loop resends a growing transcript, so a stable ID is where
		// prefix caching pays off. Minting one per run keeps it opaque and
		// unshared, which is what the routing guidance asks for.
		const sessionId = options.sessionId || randomUUID();

		const client = new K2HorizonChatModelClient(
			model,
			createRequests(this, { 'X-Session-ID': sessionId }, options.timeout),
			{
				baseURL: getBaseUrl(credentials),
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
