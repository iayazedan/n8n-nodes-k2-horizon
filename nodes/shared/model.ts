import {
	BaseChatModel,
	getParametersJsonSchema,
	parseSSEStream,
	type ChatModelConfig,
	type FinishReason,
	type GenerateResult,
	type Message,
	type MessageContent,
	type StreamChunk,
	type TokenUsage,
	type Tool,
} from '@n8n/ai-node-sdk';
import type { IHttpRequestMethods } from 'n8n-workflow';

/**
 * K2 Horizon speaks OpenAI Chat Completions, so a generic OpenAI client gets
 * you most of the way -- but not all of it, and the gap is fatal inside an
 * agent.
 *
 * The gateway rejects any assistant turn replayed without a thinking field:
 *
 *   400 Assistant message is missing a thinking field.
 *       Provide one of: think, reasoning, reasoning_content, think_fast, think_faster.
 *
 * LangChain's ChatOpenAI -- which the SDK's built-in `type: 'openai'` provider
 * wraps -- discards the trace when it parses a reply, so it cannot send one
 * back. The first tool round trip inside an AI Agent therefore 400s: the model
 * asks for a tool, the tool runs, and replaying the turn fails. Verified
 * against the live gateway.
 *
 * Owning the wire format is the fix. It also keeps the package free of runtime
 * dependencies, since BaseChatModel comes from the peer SDK that n8n supplies.
 */

export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Constrains `content` only -- the reasoning trace stays free-form prose, so
 * the two have to be parsed separately.
 */
export type ResponseFormat =
	| { type: 'json_object' }
	| {
			type: 'json_schema';
			json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
	  };

interface WireToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

/** One entry of the `messages` array exactly as the gateway wants it. */
interface WireMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	reasoning_content?: string;
	tool_calls?: WireToolCall[];
	tool_call_id?: string;
}

interface WireRequest {
	model: string;
	messages: WireMessage[];
	stream: boolean;
	chat_template_kwargs?: { reasoning_effort: ReasoningEffort };
	response_format?: ResponseFormat;
	tools?: Array<{
		type: 'function';
		function: { name: string; description?: string; parameters: unknown };
	}>;
	tool_choice?: 'auto' | 'none' | 'required';
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	frequency_penalty?: number;
	presence_penalty?: number;
	seed?: number;
	stop?: string[];
}

interface WireResponse {
	id?: string;
	model?: string;
	choices?: Array<{
		message?: {
			content?: string | null;
			reasoning_content?: string;
			reasoning?: string;
			tool_calls?: WireToolCall[];
		};
		finish_reason?: string;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number } | null;
		completion_tokens_details?: { reasoning_tokens?: number } | null;
	};
}

interface WireStreamChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: WireResponse['usage'];
}

/**
 * Turns the SDK's content blocks into the gateway's message array.
 *
 * The load-bearing line is `reasoning_content` on assistant turns. It is always
 * set, falling back to an empty string, because the docs are explicit that ""
 * is a valid trace while a missing field is a 400. An assistant turn also has
 * to collapse into ONE wire message -- text, reasoning and every tool call
 * together -- since the gateway pairs tool results to the turn that requested
 * them.
 */
export function toWireMessages(messages: Message[]): WireMessage[] {
	const wire: WireMessage[] = [];

	for (const message of messages) {
		if (message.role === 'tool') {
			for (const block of message.content) {
				if (block.type !== 'tool-result') continue;
				wire.push({
					role: 'tool',
					tool_call_id: block.toolCallId,
					content:
						typeof block.result === 'string' ? block.result : JSON.stringify(block.result ?? ''),
				});
			}
			continue;
		}

		if (message.role === 'assistant') {
			let text = '';
			let reasoning = '';
			const toolCalls: WireToolCall[] = [];

			for (const block of message.content) {
				if (block.type === 'text') text += block.text;
				else if (block.type === 'reasoning') reasoning += block.text;
				else if (block.type === 'tool-call') {
					toolCalls.push({
						id: block.toolCallId ?? '',
						type: 'function',
						function: { name: block.toolName, arguments: block.input },
					});
				}
			}

			wire.push({
				role: 'assistant',
				content: text,
				// Never omit this. A missing thinking field is a 400; "" is fine.
				reasoning_content: reasoning,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
			continue;
		}

		const text = message.content
			.filter((block): block is Extract<MessageContent, { type: 'text' }> => block.type === 'text')
			.map((block) => block.text)
			.join('');

		wire.push({ role: message.role === 'system' ? 'system' : 'user', content: text });
	}

	return wire;
}

function toWireTools(tools: Tool[]): WireRequest['tools'] {
	const functions = tools.filter((tool) => tool.type === 'function');
	if (functions.length === 0) return undefined;

	return functions.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: getParametersJsonSchema(tool),
		},
	}));
}

function toFinishReason(reason?: string | null): FinishReason {
	switch (reason) {
		case 'stop':
			return 'stop';
		case 'length':
			return 'length';
		case 'tool_calls':
			return 'tool-calls';
		case 'content_filter':
			return 'content-filter';
		default:
			return 'other';
	}
}

function toUsage(usage: WireResponse['usage']): TokenUsage | undefined {
	if (!usage) return undefined;

	return {
		promptTokens: usage.prompt_tokens ?? 0,
		completionTokens: usage.completion_tokens ?? 0,
		totalTokens: usage.total_tokens ?? 0,
		...(usage.prompt_tokens_details?.cached_tokens
			? { inputTokenDetails: { cacheRead: usage.prompt_tokens_details.cached_tokens } }
			: {}),
		...(usage.completion_tokens_details?.reasoning_tokens
			? { outputTokenDetails: { reasoning: usage.completion_tokens_details.reasoning_tokens } }
			: {}),
	};
}

export interface K2HorizonModelConfig extends ChatModelConfig {
	apiKey?: string;
	baseURL?: string;
	reasoningEffort?: ReasoningEffort;
	responseFormat?: ResponseFormat;
}

export interface RequestConfig {
	httpRequest: (
		method: IHttpRequestMethods,
		url: string,
		body?: object,
	) => Promise<{ body: unknown }>;
	openStream: (
		method: IHttpRequestMethods,
		url: string,
		body?: object,
	) => Promise<{ body: AsyncIterableIterator<Buffer | Uint8Array> }>;
}

export class K2HorizonChatModelClient extends BaseChatModel<K2HorizonModelConfig> {
	private baseURL: string;

	constructor(
		modelId: string,
		private requests: RequestConfig,
		config?: K2HorizonModelConfig,
	) {
		super('k2-horizon', modelId, config);
		this.baseURL = (config?.baseURL ?? 'https://api.ifm.ai/v1').replace(/\/+$/, '');
	}

	private buildBody(
		messages: Message[],
		config: K2HorizonModelConfig,
		stream: boolean,
	): WireRequest {
		const tools = toWireTools(this.tools);

		return {
			model: this.modelId,
			messages: toWireMessages(messages),
			stream,
			// reasoning_effort is not a top-level parameter on this gateway; it has
			// to reach the chat template.
			...(config.reasoningEffort
				? { chat_template_kwargs: { reasoning_effort: config.reasoningEffort } }
				: {}),
			...(config.responseFormat ? { response_format: config.responseFormat } : {}),
			...(tools ? { tools } : {}),
			temperature: config.temperature,
			top_p: config.topP,
			max_tokens: config.maxTokens,
			frequency_penalty: config.frequencyPenalty,
			presence_penalty: config.presencePenalty,
			seed: config.seed,
			...(config.stopSequences?.length ? { stop: config.stopSequences } : {}),
		};
	}

	async generate(messages: Message[], config?: K2HorizonModelConfig): Promise<GenerateResult> {
		const merged = this.mergeConfig(config) as K2HorizonModelConfig;
		const body = this.buildBody(messages, merged, false);

		const response = await this.requests.httpRequest(
			'POST',
			`${this.baseURL}/chat/completions`,
			body,
		);
		const payload = response.body as WireResponse;
		const choice = payload.choices?.[0];
		const reply = choice?.message ?? {};

		// The docs call reasoning_content canonical and `reasoning` a legacy
		// mirror; the hosted gateway sends only `reasoning`. Read both.
		const reasoning = reply.reasoning_content ?? reply.reasoning ?? '';
		// Plain replies come back prefixed with a newline. Left alone it reaches
		// every downstream node and any equality check on the answer.
		const text = (reply.content ?? '').replace(/^\s+/, '');

		const content: MessageContent[] = [];
		if (reasoning) content.push({ type: 'reasoning', text: reasoning });
		for (const call of reply.tool_calls ?? []) {
			content.push({
				type: 'tool-call',
				toolCallId: call.id,
				toolName: call.function?.name ?? '',
				input: call.function?.arguments ?? '{}',
			});
		}
		content.push({ type: 'text', text });

		return {
			id: payload.id,
			finishReason: toFinishReason(choice?.finish_reason),
			usage: toUsage(payload.usage),
			message: { role: 'assistant', content, id: payload.id },
			rawResponse: payload,
			providerMetadata: { model_provider: 'k2-horizon', model: payload.model, id: payload.id },
		};
	}

	async *stream(messages: Message[], config?: K2HorizonModelConfig): AsyncIterable<StreamChunk> {
		const merged = this.mergeConfig(config) as K2HorizonModelConfig;
		const body = this.buildBody(messages, merged, true);

		const response = await this.requests.openStream(
			'POST',
			`${this.baseURL}/chat/completions`,
			body,
		);

		// Tool call arguments arrive in fragments spread across many chunks, so
		// they are accumulated per index and only emitted once the call is whole.
		const buffers: Record<number, { id?: string; name: string; args: string }> = {};
		let finishReason: FinishReason | undefined;
		let usage: TokenUsage | undefined;

		for await (const event of parseSSEStream(response.body)) {
			if (!event.data || event.data === '[DONE]') continue;

			let chunk: WireStreamChunk;
			try {
				chunk = JSON.parse(event.data) as WireStreamChunk;
			} catch {
				continue;
			}

			if (chunk.usage) usage = toUsage(chunk.usage);

			const choice = chunk.choices?.[0];
			if (!choice) continue;

			const delta = choice.delta ?? {};
			const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
			if (reasoningDelta) yield { type: 'reasoning-delta', delta: reasoningDelta };
			if (delta.content) yield { type: 'text-delta', delta: delta.content };

			for (const call of delta.tool_calls ?? []) {
				const index = call.index ?? 0;
				const buffer = (buffers[index] ??= { name: '', args: '' });
				if (call.id) buffer.id = call.id;
				if (call.function?.name) buffer.name += call.function.name;
				if (call.function?.arguments) buffer.args += call.function.arguments;
			}

			if (choice.finish_reason) finishReason = toFinishReason(choice.finish_reason);
		}

		for (const buffer of Object.values(buffers)) {
			yield {
				type: 'tool-call-delta',
				id: buffer.id,
				name: buffer.name,
				argumentsDelta: buffer.args,
			};
		}

		yield { type: 'finish', finishReason: finishReason ?? 'stop', usage };
	}
}
