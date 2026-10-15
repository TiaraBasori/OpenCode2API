import request from 'supertest';
import { jest } from '@jest/globals';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [
                {
                    id: 'opencode',
                    models: {
                        'kimi-k2.5': { name: 'Kimi k2.5', release_date: '2024-01-15' },
                        'gpt-5-nano': { name: 'GPT-5 Nano', release_date: '2025-01-15' }
                    }
                }
            ]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    configGet: jest.fn(async () => ({ data: { plugin: [] } })),
    toolIds: jest.fn(async () => ({ data: ['web_fetch', 'filesystem', 'bash'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'test-session-id' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'Mock response' }] } })),
    sessionMessages: jest.fn(async () => ([
        {
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: 'Mock response' }]
        }
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => {
        const sessionId = 'test-session-id';
        const mockEvents = [
            { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: 'Mock' } },
            { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: ' response' } },
            { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
        ];
        return {
            stream: (async function* () {
                for (const event of mockEvents) yield event;
            })()
        };
    })
};

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const res = {
                statusCode: 200,
                headers: { 'content-type': 'image/png' },
                on: jest.fn((event, handler) => {
                    if (event === 'data') handler(Buffer.from('fake-image-data'));
                    if (event === 'end') handler();
                })
            };
            callback(res);
            return { on: jest.fn(), destroy: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const response = {
                statusCode: 200,
                headers: {},
                resume: jest.fn(),
                setEncoding: jest.fn(),
                on: jest.fn((event, handler) => {
                    if (event === 'data') handler('{"healthy":true}');
                    if (event === 'end') handler();
                })
            };
            callback(response);
            return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: {
            providers: sdkMocks.configProviders,
            update: sdkMocks.configUpdate,
            get: sdkMocks.configGet
        },
        tool: { ids: sdkMocks.toolIds },
        session: {
            create: sdkMocks.sessionCreate,
            prompt: sdkMocks.sessionPrompt,
            messages: sdkMocks.sessionMessages,
            delete: sdkMocks.sessionDelete
        },
        event: { subscribe: sdkMocks.eventSubscribe }
    }))
}));

const { createApp } = await import('../../src/proxy.js');

const WEATHER_TOOL = {
    name: 'weather_lookup',
    description: 'Look up weather by city',
    input_schema: {
        type: 'object',
        properties: {
            city: { type: 'string' },
            unit: { type: 'string' }
        },
        required: ['city']
    }
};

const parseSseEvents = (text) => text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()));

describe('Proxy Anthropic Messages API', () => {
    let app;

    beforeAll(() => {
        process.env.OPENCODE_SERVER_URL = 'http://127.0.0.1:10001';
        process.env.OPENCODE_PROXY_DEBUG = 'false';
    });

    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.toolIds.mockResolvedValue({ data: ['web_fetch', 'filesystem', 'bash'] });
        sdkMocks.sessionPrompt.mockImplementation(async () => ({ data: { parts: [{ type: 'text', text: 'Mock response' }] } }));
        sdkMocks.sessionMessages.mockImplementation(async () => ([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Mock response' }]
            }
        ]));
        const config = {
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: false,
            DEBUG: false
        };
        app = createApp(config).app;
    });

    test('POST /v1/messages returns an Anthropic message for a text-only request', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Plain assistant reply' }]
            }
        ]);

        const res = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .set('anthropic-version', '2023-06-01')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 256,
                messages: [{ role: 'user', content: 'Hello' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.type).toEqual('message');
        expect(res.body.role).toEqual('assistant');
        expect(String(res.body.id).startsWith('msg_')).toBe(true);
        expect(res.body.model).toEqual('opencode/kimi-k2.5');
        expect(res.body.content).toEqual([{ type: 'text', text: 'Plain assistant reply' }]);
        expect(res.body.stop_reason).toEqual('end_turn');
        expect(res.body.stop_sequence).toBeNull();
        expect(res.body.usage.input_tokens).toBeGreaterThan(0);
        expect(res.body.usage.output_tokens).toBeGreaterThan(0);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.parts).toEqual([{ type: 'text', text: 'USER: Hello' }]);
        expect(promptCall.body.max_tokens).toEqual(256);
    });

    test('POST /v1/messages maps system prompt and multi-turn history into the prompt parts', async () => {
        const res = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 128,
                system: 'You are concise.',
                messages: [
                    { role: 'user', content: 'Hi' },
                    { role: 'assistant', content: 'Hello!' },
                    { role: 'user', content: [{ type: 'text', text: 'Bye' }] }
                ]
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You are concise.');
        expect(promptCall.body.parts).toEqual([
            { type: 'text', text: 'USER: Hi' },
            { type: 'text', text: 'ASSISTANT: Hello!' },
            { type: 'text', text: 'USER: Bye' }
        ]);
    });

    test('POST /v1/messages accepts system as content blocks and forwards temperature/stop_sequences', async () => {
        await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 128,
                system: [{ type: 'text', text: 'Rule one' }, { type: 'text', text: 'Rule two' }],
                temperature: 0.2,
                top_p: 0.9,
                stop_sequences: ['STOP'],
                messages: [{ role: 'user', content: 'Hi' }]
            });

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('Rule one');
        expect(promptCall.body.system).toContain('Rule two');
        expect(promptCall.body.temperature).toEqual(0.2);
        expect(promptCall.body.top_p).toEqual(0.9);
        expect(promptCall.body.stop).toEqual(['STOP']);
    });

    test('POST /v1/messages converts base64 image blocks into file parts', async () => {
        await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 128,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'What is in this picture?' },
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
                    ]
                }]
            });

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.parts[0]).toEqual({ type: 'text', text: 'USER: What is in this picture?' });
        expect(promptCall.body.parts[1]).toEqual({
            type: 'file',
            mime: 'image/png',
            url: 'data:image/png;base64,aGVsbG8=',
            filename: 'image'
        });
    });

    test('POST /v1/messages returns tool_use blocks without the external__ prefix', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{
                    type: 'text',
                    text: '<function_calls>[{"id":"call_weather_1","name":"weather_lookup","arguments":{"city":"Tokyo","unit":"celsius"}}]</function_calls>'
                }]
            }
        ]);

        const res = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 512,
                messages: [{ role: 'user', content: 'Weather in Tokyo?' }],
                tools: [WEATHER_TOOL]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.stop_reason).toEqual('tool_use');
        expect(res.body.content).toEqual([{
            type: 'tool_use',
            id: 'call_weather_1',
            name: 'weather_lookup',
            input: { city: 'Tokyo', unit: 'celsius' }
        }]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('External tools are virtualized by this proxy.');
        expect(promptCall.body.system).toContain('external__weather_lookup');
        // DISABLE_TOOLS is false in this fixture: no internal-tool overrides are attached.
        expect(promptCall.body.tools).toBeUndefined();
    });

    test('POST /v1/messages round-trips assistant tool_use and user tool_result history', async () => {
        // Turn 1: model calls the tool.
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{
                    type: 'text',
                    text: '<function_calls>[{"id":"call_weather_1","name":"weather_lookup","arguments":{"city":"Tokyo"}}]</function_calls>'
                }]
            }
        ]);
        const first = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 512,
                messages: [{ role: 'user', content: 'Weather in Tokyo?' }],
                tools: [WEATHER_TOOL]
            });
        expect(first.body.content[0].type).toEqual('tool_use');

        // Turn 2: client sends back the tool result.
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'It is sunny in Tokyo.' }]
            }
        ]);
        const second = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 512,
                messages: [
                    { role: 'user', content: 'Weather in Tokyo?' },
                    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_weather_1', name: 'weather_lookup', input: { city: 'Tokyo' } }] },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_weather_1', content: 'Sunny, 22C' }] }
                ],
                tools: [WEATHER_TOOL]
            });

        expect(second.statusCode).toEqual(200);
        expect(second.body.content).toEqual([{ type: 'text', text: 'It is sunny in Tokyo.' }]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        const partTexts = promptCall.body.parts.map((part) => part.text);
        const assistantPart = partTexts.find((text) => text.startsWith('ASSISTANT: <function_calls>'));
        const toolResultPart = partTexts.find((text) => text.startsWith('TOOL_RESULT:'));
        expect(assistantPart).toContain('"name":"external__weather_lookup"');
        expect(assistantPart).toContain('"id":"call_weather_1"');
        expect(toolResultPart).toBeTruthy();
        const parsedToolResult = JSON.parse(toolResultPart.slice('TOOL_RESULT:'.length));
        expect(parsedToolResult).toEqual({
            tool_call_id: 'call_weather_1',
            name: 'external__weather_lookup',
            content: 'Sunny, 22C'
        });
    });

    test('POST /v1/messages rejects missing or invalid max_tokens with 400 invalid_request_error', async () => {
        const missing = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }]
            });
        expect(missing.statusCode).toEqual(400);
        expect(missing.body).toEqual({
            type: 'error',
            error: { type: 'invalid_request_error', expect: undefined, message: expect.any(String) }
        });
        expect(missing.body.error.type).toEqual('invalid_request_error');

        const invalid = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: -3,
                messages: [{ role: 'user', content: 'Hello' }]
            });
        expect(invalid.statusCode).toEqual(400);
        expect(invalid.body.error.type).toEqual('invalid_request_error');

        const emptyMessages = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 64,
                messages: []
            });
        expect(emptyMessages.statusCode).toEqual(400);
        expect(emptyMessages.body.error.type).toEqual('invalid_request_error');
    });

    test('POST /v1/messages returns 400 model_not_found for an unknown model', async () => {
        const res = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/nope-model',
                max_tokens: 64,
                messages: [{ role: 'user', content: 'Hello' }]
            });
        expect(res.statusCode).toEqual(400);
        expect(res.body.type).toEqual('error');
        expect(res.body.error.type).toEqual('model_not_found');
        expect(res.body.error.message).toContain('Model not found');
    });

    test('POST /v1/messages streams a complete Anthropic SSE event sequence', async () => {
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            const sessionId = 'test-session-id';
            const mockEvents = [
                { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: 'Let me think' } },
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: 'Hel' } },
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: 'lo' } },
                { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
            ];
            return {
                stream: (async function* () {
                    for (const event of mockEvents) yield event;
                })()
            };
        });

        const res = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 128,
                stream: true,
                messages: [{ role: 'user', content: 'Say hello' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');

        const events = parseSseEvents(res.text);
        const types = events.map((event) => event.type);
        expect(types).toEqual([
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_stop',
            'content_block_start',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop'
        ]);

        expect(events[0].message.role).toEqual('assistant');
        expect(events[0].message.model).toEqual('opencode/kimi-k2.5');
        expect(events[0].message.usage.output_tokens).toEqual(0);
        expect(events[1].content_block).toEqual({ type: 'thinking', thinking: '' });
        expect(events[2].delta).toEqual({ type: 'thinking_delta', thinking: 'Let me think' });
        expect(events[4].content_block).toEqual({ type: 'text', text: '' });

        const textDeltas = events
            .filter((event) => event.type === 'content_block_delta' && event.delta.type === 'text_delta')
            .map((event) => event.delta.text)
            .join('');
        expect(textDeltas).toEqual('Hello');

        const messageDelta = events.find((event) => event.type === 'message_delta');
        expect(messageDelta.delta.stop_reason).toEqual('end_turn');
        expect(messageDelta.delta.stop_sequence).toBeNull();
        expect(messageDelta.usage.output_tokens).toBeGreaterThan(0);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.path.id).toEqual('test-session-id');
    });

    test('POST /v1/messages streams tool_use blocks via content_block_start/input_json_delta', async () => {
        const toolCallText = '<function_calls>[{"id":"call_weather_1","name":"weather_lookup","arguments":{"city":"Tokyo"}}]</function_calls>';
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            const sessionId = 'test-session-id';
            const mockEvents = [
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: toolCallText } },
                { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
            ];
            return {
                stream: (async function* () {
                    for (const event of mockEvents) yield event;
                })()
            };
        });

        const res = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 512,
                stream: true,
                messages: [{ role: 'user', content: 'Weather in Tokyo?' }],
                tools: [WEATHER_TOOL]
            });

        expect(res.statusCode).toEqual(200);
        const events = parseSseEvents(res.text);
        const types = events.map((event) => event.type);
        expect(types).toEqual([
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop'
        ]);

        const toolBlock = events[1].content_block;
        expect(toolBlock.type).toEqual('tool_use');
        expect(toolBlock.name).toEqual('weather_lookup');
        // The stream parser suffixes unique ids (same as chat-completions streaming).
        expect(String(toolBlock.id).startsWith('call_weather_1')).toBe(true);

        const jsonDelta = events[2].delta;
        expect(jsonDelta.type).toEqual('input_json_delta');
        expect(JSON.parse(jsonDelta.partial_json)).toEqual({ city: 'Tokyo' });

        const messageDelta = events.find((event) => event.type === 'message_delta');
        expect(messageDelta.delta.stop_reason).toEqual('tool_use');
    });

    test('POST /v1/messages accepts x-api-key auth and rejects missing credentials with Anthropic error shape', async () => {
        const missing = await request(app)
            .post('/v1/messages')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 64,
                messages: [{ role: 'user', content: 'Hello' }]
            });
        expect(missing.statusCode).toEqual(401);
        expect(missing.body).toEqual({
            type: 'error',
            error: { type: 'authentication_error', message: expect.any(String) }
        });

        const wrong = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'wrong-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 64,
                messages: [{ role: 'user', content: 'Hello' }]
            });
        expect(wrong.statusCode).toEqual(401);
        expect(wrong.body.error.type).toEqual('authentication_error');

        const ok = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 64,
                messages: [{ role: 'user', content: 'Hello' }]
            });
        expect(ok.statusCode).toEqual(200);
    });

    test('auth middleware still requires Bearer auth for /v1/chat/completions even with x-api-key', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }]
            });
        expect(res.statusCode).toEqual(401);
        expect(res.body.error.message).toEqual('Unauthorized');
    });

    test('anthropic edge: error shapes, stream error event, and auth isolation', async () => {
        // max_tokens validation
        const noMax = await request(app).post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(noMax.status).toEqual(400);
        expect(noMax.body.type).toEqual('error');
        expect(noMax.body.error.type).toEqual('invalid_request_error');

        const badMax = await request(app).post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({ model: 'opencode/kimi-k2.5', max_tokens: 0, messages: [{ role: 'user', content: 'hi' }] });
        expect(badMax.status).toEqual(400);

        // unknown model -> Anthropic-shaped model error
        const unknownModel = await request(app).post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({ model: 'opencode/nope', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
        expect(unknownModel.status).toEqual(400);
        expect(JSON.stringify(unknownModel.body)).toContain('model_not_found');

        // x-api-key must NOT unlock OpenAI-compatible endpoints
        const leaked = await request(app).post('/v1/chat/completions')
            .set('x-api-key', 'test-key')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(leaked.status).toEqual(401);

        // Bearer still works on /v1/messages
        const bearerOk = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
        expect(bearerOk.status).toEqual(200);
    });

    test('anthropic edge: terminal assistant error maps to 502 api_error, not the raw error name', async () => {
        sdkMocks.sessionMessages.mockResolvedValue([
            {
                info: { role: 'assistant', finish: 'error', error: { name: 'ProviderError', message: 'boom from upstream' } },
                parts: []
            }
        ]);
        const res = await request(app).post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({ model: 'opencode/kimi-k2.5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.status).toEqual(502);
        expect(res.body.type).toEqual('error');
        expect(res.body.error.type).toEqual('api_error');
        expect(res.body.error.message).toContain('boom from upstream');
    });

    test('anthropic edge: tool_result preserves block.name / empty / is_error content when tool registry is absent', async () => {
        const res = await request(app).post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 64,
                messages: [
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_x', name: 'custom_tool', content: '', is_error: true }] }
                ]
            });
        expect(res.status).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        const toolResultPart = promptCall.body.parts.map((p) => p.text).find((t) => t.startsWith('TOOL_RESULT:'));
        expect(toolResultPart).toBeDefined();
        const parsed = JSON.parse(toolResultPart.slice('TOOL_RESULT:'.length));
        expect(parsed).toEqual({
            tool_call_id: 'call_x',
            name: 'custom_tool',
            content: 'Tool execution error',
            is_error: true
        });
    });

});