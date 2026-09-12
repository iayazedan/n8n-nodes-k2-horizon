'use strict';

// Opt-in checks against the real gateway. Skipped unless IFM_API_KEY is set:
//
//   IFM_API_KEY=IFM-... npm run test:live
//
// These spend tokens and are subject to the per-minute rate limit, so they are
// deliberately small and are never run in CI.

const test = require('node:test');
const assert = require('node:assert/strict');

const { K2Horizon, K2HorizonApi } = require('./helpers');

const KEY = process.env.IFM_API_KEY;
const BASE = process.env.IFM_BASE_URL ?? 'https://api.ifm.ai/v1';
const MODEL = process.env.IFM_MODEL ?? 'IFM/K2-Horizon-375B-A23B';
const skip = KEY ? false : 'set IFM_API_KEY to run the live checks';

/** n8n's helper, backed by a real request. */
async function httpRequestWithAuthentication(_credentialName, options) {
	const authed = await new K2HorizonApi().authenticate(
		{ apiKey: KEY, url: BASE },
		{ ...options, headers: { ...(options.headers ?? {}) } },
	);

	const response = await fetch(authed.url, {
		method: authed.method,
		headers: { 'Content-Type': 'application/json', ...authed.headers },
		body: authed.body ? JSON.stringify(authed.body) : undefined,
		signal: AbortSignal.timeout(authed.timeout ?? 120000),
	});

	const text = await response.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}

	return options.returnFullResponse
		? { statusCode: response.status, headers: Object.fromEntries(response.headers.entries()), body }
		: body;
}

function liveContext(params) {
	return {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({ apiKey: KEY, url: BASE }),
		getNodeParameter: (name, _i, fallback) => {
			if (name === 'messages.values') return params.messages;
			return name in params ? params[name] : fallback;
		},
		getNode: () => ({
			name: 'K2 Horizon',
			type: 'n8n-nodes-k2-horizon.k2Horizon',
			typeVersion: 1,
			parameters: {},
		}),
		continueOnFail: () => false,
		helpers: { httpRequestWithAuthentication },
	};
}

test('the credential test endpoint lists models', { skip }, async () => {
	const response = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
	assert.equal(response.status, 200);

	const body = await response.json();
	const ids = (body.data ?? []).map((m) => m.id);
	assert.ok(ids.includes(MODEL), `expected ${MODEL} in ${ids.join(', ')}`);
});

test('a plain reply comes back without its leading newline', { skip }, async () => {
	const [items] = await new K2Horizon().execute.call(
		liveContext({
			model: MODEL,
			reasoningEffort: 'low',
			outputFormat: 'text',
			simplifyOutput: true,
			options: { maxTokens: 200 },
			messages: [
				{ role: 'system', content: 'Answer with one word.' },
				{ role: 'user', content: 'Name a colour.' },
			],
		}),
	);

	const { content, reasoning } = items[0].json;
	assert.equal(typeof content, 'string');
	assert.ok(content.length > 0);
	assert.ok(!/^\s/.test(content), 'the gateway prefixes a newline; it should be stripped');
	assert.equal(typeof reasoning, 'string');
});

test('JSON Schema mode returns an object matching the schema', { skip }, async () => {
	const [items] = await new K2Horizon().execute.call(
		liveContext({
			model: MODEL,
			reasoningEffort: 'low',
			outputFormat: 'jsonSchema',
			schemaName: 'city',
			schema: JSON.stringify({
				type: 'object',
				properties: { city: { type: 'string' }, country: { type: 'string' } },
				required: ['city', 'country'],
			}),
			simplifyOutput: true,
			options: { maxTokens: 500 },
			messages: [{ role: 'user', content: 'Give the city and country for the Burj Khalifa.' }],
		}),
	);

	const { content } = items[0].json;
	assert.equal(typeof content, 'object');
	assert.equal(typeof content.city, 'string');
	assert.equal(typeof content.country, 'string');
});

test('an assistant turn can be replayed without a 400', { skip }, async () => {
	const [items] = await new K2Horizon().execute.call(
		liveContext({
			model: MODEL,
			reasoningEffort: 'low',
			outputFormat: 'text',
			simplifyOutput: true,
			options: { maxTokens: 200 },
			messages: [
				{ role: 'user', content: 'Pick the number 7.' },
				{ role: 'assistant', content: '7' },
				{ role: 'user', content: 'Double it. Reply with the number only.' },
			],
		}),
	);

	assert.match(items[0].json.content, /14/);
});
