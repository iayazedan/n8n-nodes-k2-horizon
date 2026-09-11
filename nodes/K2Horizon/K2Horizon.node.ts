import { randomUUID } from 'node:crypto';

import type { Message, MessageRole } from '@n8n/ai-node-sdk';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	CREDENTIAL_NAME,
	createRequests,
	getBaseUrl,
	getModels,
	modelProperty,
	reasoningEffortProperty,
} from '../shared/common';
import {
	K2HorizonChatModelClient,
	type ReasoningEffort,
	type ResponseFormat,
} from '../shared/model';

type OutputFormat = 'text' | 'jsonObject' | 'jsonSchema';

type MessageOptions = {
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	seed?: number;
	sessionId?: string;
	timeout?: number;
};

const EXAMPLE_SCHEMA = `{
  "type": "object",
  "properties": {
    "summary": { "type": "string" },
    "keyPoints": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["summary", "keyPoints"]
}`;

export class K2Horizon implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'K2 Horizon',
		name: 'k2Horizon',
		icon: { light: 'file:../../icons/k2horizon.svg', dark: 'file:../../icons/k2horizon.dark.svg' },
		group: ['transform'],
		version: [1],
		description:
			'Send messages to K2 Horizon (IFM) and get back text, JSON or schema-shaped output',
		subtitle: '={{ $parameter["model"] }}',
		defaults: {
			name: 'K2 Horizon',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: CREDENTIAL_NAME,
				required: true,
			},
		],
		properties: [
			modelProperty,
			{
				displayName: 'Messages',
				name: 'messages',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				placeholder: 'Add Message',
				default: { values: [{ role: 'user', content: '' }] },
				options: [
					{
						displayName: 'Message',
						name: 'values',
						values: [
							{
								displayName: 'Role',
								name: 'role',
								type: 'options',
								options: [
									{
										name: 'Assistant',
										value: 'assistant',
										description:
											'An earlier model reply, for few-shot examples or a continued conversation',
									},
									{
										name: 'System',
										value: 'system',
										description: 'Instructions that shape every reply',
									},
									{
										name: 'User',
										value: 'user',
										description: 'The request to answer',
									},
								],
								default: 'user',
							},
							{
								displayName: 'Content',
								name: 'content',
								type: 'string',
								typeOptions: { rows: 4 },
								default: '',
							},
						],
					},
				],
			},
			reasoningEffortProperty,
			{
				displayName: 'Output Format',
				name: 'outputFormat',
				type: 'options',
				noDataExpression: true,
				default: 'text',
				options: [
					{
						name: 'JSON',
						value: 'jsonObject',
						description: 'Valid JSON of any shape. Describe the fields you want in a message.',
					},
					{
						name: 'JSON Schema',
						value: 'jsonSchema',
						description: 'JSON constrained to a schema you supply, so it validates by construction',
					},
					{
						name: 'Text',
						value: 'text',
						description: 'A plain-text reply',
					},
				],
			},
			{
				displayName:
					'JSON mode guarantees valid JSON, not its shape. Name the fields you want in a message, or use JSON Schema to pin them.',
				name: 'jsonObjectNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						outputFormat: ['jsonObject'],
					},
				},
			},
			{
				displayName: 'Schema Name',
				name: 'schemaName',
				type: 'string',
				required: true,
				default: 'response',
				description: 'Short identifier for the schema. Letters, digits, underscores and dashes.',
				displayOptions: {
					show: {
						outputFormat: ['jsonSchema'],
					},
				},
			},
			{
				displayName: 'Schema',
				name: 'schema',
				type: 'json',
				required: true,
				default: EXAMPLE_SCHEMA,
				description:
					'JSON Schema the reply must match. Keep it shallow and name fields as you would in a prompt -- deep or cryptic schemas cost tokens and degrade the answer.',
				displayOptions: {
					show: {
						outputFormat: ['jsonSchema'],
					},
				},
			},
			{
				displayName: 'Simplify Output',
				name: 'simplifyOutput',
				type: 'boolean',
				default: true,
				description:
					'Whether to return only the reply, its reasoning trace and finish reason instead of the raw API response',
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
						displayName: 'Max Tokens',
						name: 'maxTokens',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 4096,
						description:
							'Upper bound on generated tokens. Reasoning tokens count towards it, so set it generously.',
					},
					{
						displayName: 'Sampling Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 1 },
						default: 0.7,
						description:
							'Controls randomness. Lower is more deterministic; IFM suggests 0.3 or less for extraction-style work.',
					},
					{
						displayName: 'Seed',
						name: 'seed',
						type: 'number',
						default: 0,
						description:
							'Best-effort determinism: identical requests with the same seed tend to match',
					},
					{
						displayName: 'Session ID',
						name: 'sessionId',
						type: 'string',
						default: '',
						description:
							'Sent as X-Session-ID, which routes requests to the compute node already holding a shared prompt prefix. Leave empty to mint one opaque ID per execution, shared by all of its items.',
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

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials(CREDENTIAL_NAME);
		// Items in one execution usually share a system prompt, so one ID for all
		// of them is where prefix caching pays off -- while staying opaque and
		// never reused across executions.
		const executionSessionId = randomUUID();

		for (let i = 0; i < items.length; i++) {
			try {
				const model = this.getNodeParameter('model', i) as string;
				const reasoningEffort = this.getNodeParameter(
					'reasoningEffort',
					i,
					'high',
				) as ReasoningEffort;
				const outputFormat = this.getNodeParameter('outputFormat', i, 'text') as OutputFormat;
				const simplifyOutput = this.getNodeParameter('simplifyOutput', i, true) as boolean;
				const options = this.getNodeParameter('options', i, {}) as MessageOptions;

				const messages = toMessages(
					this.getNodeParameter('messages.values', i, []) as Array<{
						role: MessageRole;
						content: string;
					}>,
				);
				if (!messages.some((message) => message.role === 'user')) {
					throw new NodeOperationError(this.getNode(), 'Add at least one user message', {
						itemIndex: i,
					});
				}

				const client = new K2HorizonChatModelClient(
					model,
					createRequests(
						this,
						{ 'X-Session-ID': options.sessionId || executionSessionId },
						options.timeout,
					),
					{
						baseURL: getBaseUrl(credentials),
						reasoningEffort,
						responseFormat: getResponseFormat.call(this, outputFormat, i),
						temperature: options.temperature,
						maxTokens: options.maxTokens,
						topP: options.topP,
						seed: options.seed,
					},
				);

				const result = await client.generate(messages);

				if (!simplifyOutput) {
					returnData.push({ json: result.rawResponse as IDataObject, pairedItem: { item: i } });
					continue;
				}

				let text = '';
				let reasoning = '';
				for (const block of result.message.content) {
					if (block.type === 'text') text += block.text;
					else if (block.type === 'reasoning') reasoning += block.text;
				}

				returnData.push({
					json: {
						content:
							outputFormat === 'text'
								? text
								: parseJsonReply.call(this, text, result.finishReason, i),
						reasoning,
						finishReason: result.finishReason,
					},
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				// Validation failures are already NodeOperationErrors; anything else
				// came from the request, where NodeApiError keeps the HTTP context.
				throw error instanceof NodeOperationError
					? error
					: new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

function toMessages(values: Array<{ role: MessageRole; content: string }>): Message[] {
	return values
		.filter((value) => value.content.trim() !== '')
		.map((value) => ({ role: value.role, content: [{ type: 'text', text: value.content }] }));
}

function getResponseFormat(
	this: IExecuteFunctions,
	outputFormat: OutputFormat,
	itemIndex: number,
): ResponseFormat | undefined {
	if (outputFormat === 'jsonObject') return { type: 'json_object' };
	if (outputFormat !== 'jsonSchema') return undefined;

	const name = (this.getNodeParameter('schemaName', itemIndex) as string).trim();
	if (!/^[\w-]{1,64}$/.test(name)) {
		throw new NodeOperationError(this.getNode(), `Invalid schema name "${name}"`, {
			itemIndex,
			description: 'Use 1-64 letters, digits, underscores or dashes.',
		});
	}

	// A json parameter arrives as a string when typed and as an object when set
	// by expression, so both are accepted.
	const raw = this.getNodeParameter('schema', itemIndex) as string | object;
	let schema: unknown;
	try {
		schema = typeof raw === 'string' ? JSON.parse(raw) : raw;
	} catch (error) {
		throw new NodeOperationError(this.getNode(), 'Schema is not valid JSON', {
			itemIndex,
			description: (error as Error).message,
		});
	}
	if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
		throw new NodeOperationError(this.getNode(), 'Schema must be a JSON object', { itemIndex });
	}

	return {
		type: 'json_schema',
		json_schema: { name, strict: true, schema: schema as Record<string, unknown> },
	};
}

function parseJsonReply(
	this: IExecuteFunctions,
	text: string,
	finishReason: string | undefined,
	itemIndex: number,
): IDataObject {
	try {
		return JSON.parse(text) as IDataObject;
	} catch {
		// Decoding is constrained, so an unparseable reply almost always means
		// the token limit cut it off rather than the model going off-script.
		throw new NodeOperationError(this.getNode(), 'K2 Horizon did not return complete JSON', {
			itemIndex,
			description:
				finishReason === 'length'
					? 'The reply hit Max Tokens before the JSON was complete. Reasoning tokens count towards the limit: raise Max Tokens, then simplify the schema.'
					: `The reply ended with finish reason "${finishReason ?? 'unknown'}" and could not be parsed as JSON.`,
		});
	}
}
