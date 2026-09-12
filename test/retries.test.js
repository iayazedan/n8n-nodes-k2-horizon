'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
	executeContext,
	runNode,
	reply,
	retryWaitMs,
	supplyContext,
	K2HorizonChatModel,
} = require('./helpers');

const rateLimited = (retryAfter) => ({
	status: 429,
	headers: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) },
	body: {
		error: {
			message: 'Token limit exceeded: Request rate limit reached',
			type: 'invalid_request_error',
		},
	},
});

test('waits out a 429, then succeeds', async () => {
	const ctx = executeContext({
		params: { outputFormat: 'text', options: { maxRetries: 3 } },
		replies: [
			rateLimited(0.4),
			{ status: 503, body: { error: { message: 'unavailable' } } },
			{ status: 200, body: reply('recovered') },
		],
	});

	const started = Date.now();
	const out = await runNode(ctx);

	assert.equal(ctx.calls.length, 3, 'two retries');
	assert.equal(out[0].json.content, 'recovered');

	const afterHeader = ctx.calls[1].at - ctx.calls[0].at;
	assert.ok(afterHeader >= 380, `Retry-After honoured, waited ${afterHeader}ms`);

	// No header on the 503, so exponential backoff with jitter applies instead.
	const backoff = ctx.calls[2].at - ctx.calls[1].at;
	assert.ok(backoff >= 400 && backoff < 3000, `backoff was ${backoff}ms`);
	assert.ok(Date.now() - started >= 780);
});

test('gives up after Max Retries and explains the limit', async () => {
	const ctx = executeContext({
		params: { outputFormat: 'text', options: { maxRetries: 1 } },
		replies: [rateLimited(0)],
	});

	await assert.rejects(runNode(ctx), (err) => {
		assert.equal(err.constructor.name, 'NodeApiError');
		assert.equal(err.httpCode, '429');
		assert.match(err.description, /after 1 retry/);
		assert.match(err.description, /Max Retries/);
		return true;
	});
	assert.equal(ctx.calls.length, 2, 'one retry, then stop');
});

test('Max Retries of 0 disables retrying', async () => {
	const ctx = executeContext({
		params: { outputFormat: 'text', options: { maxRetries: 0 } },
		replies: [rateLimited(0)],
	});

	await assert.rejects(runNode(ctx), (err) => err.httpCode === '429');
	assert.equal(ctx.calls.length, 1);
});

test('a non-retryable status is never retried', async () => {
	const ctx = executeContext({
		params: { outputFormat: 'text', options: { maxRetries: 5 } },
		replies: [
			{ status: 400, body: { error: { message: 'bad request', type: 'invalid_request_error' } } },
		],
	});

	await assert.rejects(runNode(ctx), (err) => err.httpCode === '400');
	assert.equal(ctx.calls.length, 1, '400 is a client mistake, not a transient failure');
});

// The wait itself is tested directly rather than by sleeping: a Retry-After of
// a day would otherwise leave a 60s timer pending and hang the test run.
test('Retry-After is honoured but capped at a minute', () => {
	assert.equal(retryWaitMs({ 'retry-after': '2' }, 0), 2000);
	assert.equal(retryWaitMs({ 'Retry-After': '3' }, 0), 3000, 'header casing does not matter');
	assert.equal(retryWaitMs({ 'retry-after': '86400' }, 0), 60_000, 'a day is capped to a minute');
});

test('without a header the wait backs off exponentially, with jitter', () => {
	for (const attempt of [0, 1, 2, 3]) {
		const window = Math.min(1000 * 2 ** attempt, 16_000);
		const wait = retryWaitMs({}, attempt);
		assert.ok(wait >= window / 2 && wait <= window, `attempt ${attempt} waited ${wait}ms`);
	}

	assert.ok(retryWaitMs(undefined, 99) <= 16_000, 'the backoff window itself is capped');
});

test('a nonsensical Retry-After falls back to backoff', () => {
	for (const header of [
		{ 'retry-after': 'soon' },
		{ 'retry-after': '-5' },
		{ 'retry-after': '0' },
	]) {
		const wait = retryWaitMs(header, 0);
		assert.ok(wait >= 500 && wait <= 1000, `${JSON.stringify(header)} -> ${wait}ms`);
	}
});

test('a streamed request retries its opening handshake only', async () => {
	const sse = () =>
		Readable.from([
			Buffer.from('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'),
			Buffer.from('data: [DONE]\n\n'),
		]);

	const ctx = supplyContext({
		params: { options: { maxRetries: 2 } },
		respond: (_options, attempt) =>
			attempt === 1
				? {
						statusCode: 429,
						headers: { 'retry-after': '0.3' },
						body: Readable.from([Buffer.from('{"error":{"message":"slow down"}}')]),
					}
				: { statusCode: 200, headers: {}, body: sse() },
	});

	const { response } = await new K2HorizonChatModel().supplyData.call(ctx, 0);
	const chunks = [];
	for await (const chunk of response.chatModel.stream([
		{ role: 'user', content: [{ type: 'text', text: 'hi' }] },
	])) {
		chunks.push(chunk);
	}

	assert.equal(ctx.calls.length, 2, 'handshake retried');
	assert.equal(ctx.calls[0].options.encoding, 'stream');
	assert.deepEqual(chunks[0], { type: 'text-delta', delta: 'hi' });
	assert.equal(chunks.at(-1).type, 'finish');
});
