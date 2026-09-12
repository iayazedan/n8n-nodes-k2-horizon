'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { executeContext, runNode, reply, K2HorizonChatModel, K2HorizonApi } = require('./helpers');

test('sends the request the gateway expects', async () => {
	const ctx = executeContext({
		params: {
			outputFormat: 'text',
			messages: [
				{ role: 'system', content: 'Be terse.' },
				{ role: 'user', content: 'Hi' },
				{ role: 'assistant', content: 'Hello.' },
				{ role: 'user', content: '   ' }, // blank rows are dropped
			],
		},
		replies: [{ status: 200, body: reply('\nHello there') }],
	});

	const out = await runNode(ctx);
	const { credentialName, options } = ctx.calls[0];

	assert.equal(credentialName, 'k2HorizonApi');
	assert.equal(options.url, 'https://api.ifm.ai/v1/chat/completions');
	assert.equal(options.json, true);
	assert.equal(options.body.stream, false);
	assert.deepEqual(options.body.chat_template_kwargs, { reasoning_effort: 'high' });
	assert.equal(options.body.response_format, undefined);

	// An assistant turn must always carry reasoning_content; the gateway 400s without it.
	assert.deepEqual(options.body.messages, [
		{ role: 'system', content: 'Be terse.' },
		{ role: 'user', content: 'Hi' },
		{ role: 'assistant', content: 'Hello.', reasoning_content: '' },
	]);

	// The gateway prefixes plain replies with a newline.
	assert.deepEqual(out[0].json, {
		content: 'Hello there',
		reasoning: 'thinking...',
		finishReason: 'stop',
	});
});

test('unset options are not sent at all', async () => {
	const ctx = executeContext({ params: { outputFormat: 'text' } });
	await runNode(ctx);
	const body = JSON.parse(JSON.stringify(ctx.calls[0].options.body));

	for (const key of ['temperature', 'top_p', 'max_tokens', 'seed']) {
		assert.ok(!(key in body), `${key} should be absent`);
	}
});

test('one session ID per execution, shared by its items', async () => {
	const ctx = executeContext({ params: { outputFormat: 'text' }, items: 3 });
	await runNode(ctx);

	const ids = ctx.calls.map((c) => c.options.headers['X-Session-ID']);
	assert.equal(ids.length, 3);
	assert.match(ids[0], /^[0-9a-f-]{36}$/);
	assert.ok(
		ids.every((id) => id === ids[0]),
		'all items share one ID',
	);

	const second = executeContext({ params: { outputFormat: 'text' } });
	await runNode(second);
	assert.notEqual(second.calls[0].options.headers['X-Session-ID'], ids[0], 'new ID per execution');
});

test('an explicit Session ID wins', async () => {
	const ctx = executeContext({
		params: { outputFormat: 'text', options: { sessionId: 'conv_1' } },
	});
	await runNode(ctx);
	assert.equal(ctx.calls[0].options.headers['X-Session-ID'], 'conv_1');
});

test('JSON mode parses the reply', async () => {
	const ctx = executeContext({
		params: { outputFormat: 'jsonObject' },
		replies: [{ status: 200, body: reply('{"city":"Dubai"}') }],
	});
	const out = await runNode(ctx);

	assert.deepEqual(ctx.calls[0].options.body.response_format, { type: 'json_object' });
	assert.deepEqual(out[0].json.content, { city: 'Dubai' });
});

test('JSON Schema mode sends a strict schema and returns a parsed object', async () => {
	const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
	const ctx = executeContext({
		params: {
			outputFormat: 'jsonSchema',
			schemaName: 'summary',
			schema: JSON.stringify(schema),
			options: { temperature: 0.2, maxTokens: 900, seed: 7, timeout: 5000 },
		},
		replies: [{ status: 200, body: reply('\n{"a":"b"}') }],
	});

	const out = await runNode(ctx);
	const { options } = ctx.calls[0];

	assert.deepEqual(options.body.response_format, {
		type: 'json_schema',
		json_schema: { name: 'summary', strict: true, schema },
	});
	assert.equal(options.body.temperature, 0.2);
	assert.equal(options.body.max_tokens, 900);
	assert.equal(options.body.seed, 7);
	assert.equal(options.timeout, 5000);
	assert.deepEqual(out[0].json.content, { a: 'b' });
});

test('a schema supplied as an object (from an expression) also works', async () => {
	const ctx = executeContext({
		params: { outputFormat: 'jsonSchema', schemaName: 'x', schema: { type: 'object' } },
		replies: [{ status: 200, body: reply('{}') }],
	});
	await runNode(ctx);
	assert.deepEqual(ctx.calls[0].options.body.response_format.json_schema.schema, {
		type: 'object',
	});
});

test('truncated JSON blames Max Tokens rather than the model', async () => {
	const ctx = executeContext({
		params: { outputFormat: 'jsonObject' },
		replies: [{ status: 200, body: reply('{"a": "tru', 'length') }],
	});

	await assert.rejects(runNode(ctx), (err) => {
		assert.equal(err.constructor.name, 'NodeOperationError');
		assert.match(err.message, /complete JSON/);
		assert.match(err.description, /Max Tokens/);
		return true;
	});
});

test('configuration errors fail before any request is sent', async () => {
	const cases = [
		[
			'schema is not JSON',
			{ outputFormat: 'jsonSchema', schemaName: 'x', schema: '{nope' },
			/not valid JSON/,
		],
		[
			'schema is an array',
			{ outputFormat: 'jsonSchema', schemaName: 'x', schema: '[]' },
			/must be a JSON object/,
		],
		[
			'schema name has a space',
			{ outputFormat: 'jsonSchema', schemaName: 'has space', schema: '{}' },
			/Invalid schema name/,
		],
		[
			'no user message',
			{ outputFormat: 'text', messages: [{ role: 'system', content: 'x' }] },
			/at least one user message/,
		],
	];

	for (const [label, params, expected] of cases) {
		const ctx = executeContext({ params });
		await assert.rejects(runNode(ctx), (err) => {
			assert.equal(err.constructor.name, 'NodeOperationError', label);
			assert.match(err.message, expected, label);
			return true;
		});
		assert.equal(ctx.calls.length, 0, `${label}: no request should be made`);
	}
});

test('API errors surface the gateway message, and are not retried when final', async () => {
	const notFound = {
		status: 404,
		body: { error: { message: 'The model "x" does not exist', type: 'not_found_error' } },
	};

	const ctx = executeContext({ params: { outputFormat: 'text' }, replies: [notFound] });
	await assert.rejects(runNode(ctx), (err) => {
		assert.equal(err.constructor.name, 'NodeApiError');
		assert.equal(err.httpCode, '404');
		assert.match(err.message, /does not exist/);
		assert.equal(err.description, 'not_found_error');
		return true;
	});
	assert.equal(ctx.calls.length, 1, 'a 404 is final');
});

test('continueOnFail turns a failure into an item and keeps going', async () => {
	const ctx = executeContext({
		params: { outputFormat: 'text' },
		items: 2,
		replies: [{ status: 404, body: { error: { message: 'nope' } } }],
		continueOnFail: true,
	});

	const out = await runNode(ctx);
	assert.equal(out.length, 2);
	assert.match(out[0].json.error, /nope/);
	assert.deepEqual(out[1].pairedItem, { item: 1 });
});

test('Simplify Output off returns the raw response', async () => {
	const raw = reply('hi');
	const ctx = executeContext({
		params: { outputFormat: 'text', simplifyOutput: false },
		replies: [{ status: 200, body: raw }],
	});

	const out = await runNode(ctx);
	assert.equal(out[0].json, raw);
	assert.ok(out[0].json.usage, 'token usage survives');
});

test('the model picker falls back to the published catalogue', async () => {
	const { K2Horizon } = require('./helpers');
	const loadOptions = (response, fail) => ({
		getCredentials: async () => ({ apiKey: 'k', url: '' }),
		helpers: {
			httpRequestWithAuthentication: async (_c, options) => {
				if (fail) throw new Error('403');
				loadOptions.url = options.url;
				return response;
			},
		},
	});

	const node = new K2Horizon();
	const listed = await node.methods.loadOptions.getModels.call(
		loadOptions({ data: [{ id: 'b' }, { id: 'a' }, {}] }),
	);
	assert.deepEqual(listed, [
		{ name: 'a', value: 'a' },
		{ name: 'b', value: 'b' },
	]);
	assert.equal(loadOptions.url, 'https://api.ifm.ai/v1/models');

	const fallback = await node.methods.loadOptions.getModels.call(loadOptions(null, true));
	assert.equal(fallback[0].value, 'IFM/K2-Horizon-375B-A23B');
	assert.ok(fallback.length > 1);

	// Both nodes share one implementation.
	assert.equal(
		new K2HorizonChatModel().methods.loadOptions.getModels,
		node.methods.loadOptions.getModels,
	);
});

test('the credential applies the bearer token', async () => {
	const applied = await new K2HorizonApi().authenticate(
		{ apiKey: 'IFM-abc', url: 'https://api.ifm.ai/v1' },
		{ url: 'https://api.ifm.ai/v1/models' },
	);
	assert.equal(applied.headers.Authorization, 'Bearer IFM-abc');
});
