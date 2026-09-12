'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { supplyContext, reply, K2HorizonChatModel } = require('./helpers');

/**
 * Binds tools to the supplied model and returns the `tools` array we put on
 * the wire.
 */
async function toolsSentFor(tool) {
	const ctx = supplyContext({
		respond: () => ({ statusCode: 200, headers: {}, body: reply('ok') }),
	});

	const { response } = await new K2HorizonChatModel().supplyData.call(ctx, 0);
	const withTools = response.chatModel.withTools([tool]);
	await withTools.generate([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);

	return ctx.calls[0].options.body.tools;
}

test('a plain JSON Schema tool is passed through untouched', async () => {
	const schema = {
		type: 'object',
		properties: { a: { type: 'number' }, b: { type: 'number' } },
		required: ['a', 'b'],
	};

	const [sent] = await toolsSentFor({
		type: 'function',
		name: 'multiply',
		description: 'Multiply two numbers',
		inputSchema: schema,
	});

	assert.equal(sent.type, 'function');
	assert.equal(sent.function.name, 'multiply');
	assert.deepEqual(sent.function.parameters, schema);
});

test('an unconvertible Zod schema falls back to a single string input', async () => {
	// n8n's built-in tools bundle their own copy of Zod, so the SDK's
	// `instanceof ZodSchema` check fails and hands the raw schema straight
	// back. The gateway rejects that with "Tool function parameters must
	// describe a JSON object", which used to kill the whole agent step.
	const foreignZod = {
		_def: { typeName: 'ZodEffects', effect: { type: 'transform' } },
		'~standard': { version: 1, vendor: 'zod' },
	};

	const [sent] = await toolsSentFor({
		type: 'function',
		name: 'calculator',
		description: 'Evaluate a maths expression',
		inputSchema: foreignZod,
	});

	assert.equal(sent.function.parameters.type, 'object', 'must be an object schema');
	assert.ok(!('_def' in sent.function.parameters), 'must not be a raw Zod object');
	assert.deepEqual(sent.function.parameters, {
		type: 'object',
		properties: { input: { type: 'string' } },
		required: ['input'],
	});
});

test('a Zod v4 schema is asked to convert itself', async () => {
	const converted = {
		type: 'object',
		properties: { city: { type: 'string' } },
		required: ['city'],
	};
	const zodV4Style = {
		_def: { typeName: 'ZodObject' },
		toJSONSchema: () => converted,
	};

	const [sent] = await toolsSentFor({
		type: 'function',
		name: 'weather',
		description: 'Look up the weather',
		inputSchema: zodV4Style,
	});

	assert.deepEqual(
		sent.function.parameters,
		converted,
		'its own conversion wins over the fallback',
	);
});

test('no tools means no tools field at all', async () => {
	const ctx = supplyContext({
		respond: () => ({ statusCode: 200, headers: {}, body: reply('ok') }),
	});
	const { response } = await new K2HorizonChatModel().supplyData.call(ctx, 0);
	await response.chatModel.generate([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);

	assert.equal(ctx.calls[0].options.body.tools, undefined);
});
