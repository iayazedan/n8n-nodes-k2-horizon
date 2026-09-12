'use strict';

const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');

const { K2Horizon } = require(path.join(DIST, 'nodes/K2Horizon/K2Horizon.node.js'));
const { K2HorizonChatModel } = require(
	path.join(DIST, 'nodes/K2HorizonChatModel/K2HorizonChatModel.node.js'),
);
const { K2HorizonApi } = require(path.join(DIST, 'credentials/K2HorizonApi.credentials.js'));
const { retryWaitMs } = require(path.join(DIST, 'nodes/shared/common.js'));

/** A gateway reply with the fields the client actually reads. */
function reply(content, finishReason = 'stop', extra = {}) {
	return {
		id: 'chatcmpl-test',
		model: 'IFM/K2-Horizon-375B-A23B',
		choices: [{ message: { content, reasoning: 'thinking...' }, finish_reason: finishReason }],
		usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
		...extra,
	};
}

const baseParams = {
	model: 'IFM/K2-Horizon-375B-A23B',
	reasoningEffort: 'high',
	simplifyOutput: true,
	options: {},
	messages: [{ role: 'user', content: 'Hi' }],
};

/**
 * Stands in for n8n's execute context. `replies` is a queue of
 * { status, headers, body }; the last entry repeats once exhausted, which is
 * what lets the retry tests drive a 429 followed by a 200.
 */
function executeContext({ params = {}, items = 1, replies, continueOnFail = false } = {}) {
	const merged = { ...baseParams, ...params };
	const queue = replies ?? [{ status: 200, body: reply('ok') }];
	const calls = [];
	const node = {
		name: 'K2 Horizon',
		type: 'n8n-nodes-k2-horizon.k2Horizon',
		typeVersion: 1,
		parameters: {},
	};

	const ctx = {
		calls,
		getInputData: () => Array.from({ length: items }, () => ({ json: {} })),
		getCredentials: async () => ({ apiKey: 'IFM-test', url: 'https://api.ifm.ai/v1/' }),
		getNodeParameter: (name, _i, fallback) => {
			if (name === 'messages.values') return merged.messages ?? fallback;
			return name in merged ? merged[name] : fallback;
		},
		getNode: () => node,
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async function (credentialName, options) {
				calls.push({ credentialName, options, self: this, at: Date.now() });
				const next = queue[Math.min(calls.length - 1, queue.length - 1)];
				return {
					statusCode: next.status,
					headers: next.headers ?? {},
					body: typeof next.body === 'function' ? next.body(options) : next.body,
				};
			},
		},
	};

	return ctx;
}

/** Stands in for the context a sub-node gets when it supplies a model. */
function supplyContext({ params = {}, respond } = {}) {
	const merged = { model: 'IFM/K2-Horizon-7B', reasoningEffort: 'high', options: {}, ...params };
	const calls = [];

	return {
		calls,
		getCredentials: async () => ({ apiKey: 'IFM-test', url: 'https://gw.example/v1' }),
		getNodeParameter: (name, _i, fallback) => (name in merged ? merged[name] : fallback),
		getNode: () => ({ name: 'K2 Horizon Chat Model' }),
		helpers: {
			httpRequestWithAuthentication: async function (credentialName, options) {
				calls.push({ credentialName, options, self: this });
				return respond
					? respond(options, calls.length)
					: { statusCode: 200, headers: {}, body: reply('\nyo') };
			},
		},
	};
}

/** Runs the node and returns the first output branch. */
async function runNode(ctx) {
	const [items] = await new K2Horizon().execute.call(ctx);
	return items;
}

module.exports = {
	K2Horizon,
	K2HorizonChatModel,
	K2HorizonApi,
	retryWaitMs,
	reply,
	baseParams,
	executeContext,
	supplyContext,
	runNode,
};
