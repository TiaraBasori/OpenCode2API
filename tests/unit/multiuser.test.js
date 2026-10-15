import request from 'supertest';
import { jest } from '@jest/globals';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [
                {
                    id: 'opencode',
                    models: {
                        'kimi-k2.5': { name: 'Kimi k2.5', release_date: '2024-01-15' }
                    }
                }
            ]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    configGet: jest.fn(async () => ({ data: { plugin: [] } })),
    toolIds: jest.fn(async () => ({ data: ['web_fetch', 'filesystem', 'bash'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'test-session-id' } })),
    sessionPrompt: jest.fn(async () => ({
        data: { parts: [{ type: 'text', text: 'Mock response' }] }
    })),
    sessionMessages: jest.fn(async () => ([
        {
            info: { role: 'assistant', finish: 'stop' },
            parts: [
                { type: 'text', text: 'Mock response' }
            ]
        }
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({ stream: (async function* () { })() }))
};

// checkHealth() probes OPENCODE_SERVER_URL over http; without this mock the
// request hits the real network and every business request hangs in
// ensureBackend() until the 25s lock timeout on any machine without a
// passwordless 1.x backend on 127.0.0.1:10001.
jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const response = {
                statusCode: 200,
                headers: {},
                resume: jest.fn(),
                setEncoding: jest.fn(),
                on: jest.fn((event, handler) => {
                    if (event === 'data') handler('{"healthy":true,"version":"1.19.0"}');
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
        tool: {
            ids: sdkMocks.toolIds
        },
        session: {
            create: sdkMocks.sessionCreate,
            prompt: sdkMocks.sessionPrompt,
            messages: sdkMocks.sessionMessages,
            delete: sdkMocks.sessionDelete
        },
        event: {
            subscribe: sdkMocks.eventSubscribe
        }
    }))
}));

const { createApp, parseApiKeysConfig, keyHintFor, createKeyUsageRegistry } = await import('../../src/proxy.js');

const createTestApp = (extraConfig = {}) => createApp({
    PORT: 10000,
    API_KEY: 'admin-key',
    API_KEYS: [
        { name: 'alice', key: 'sk-alice-secret-0001' },
        { name: 'bob', key: 'sk-bob-secret-0002' }
    ],
    OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
    REQUEST_TIMEOUT_MS: 5000,
    DISABLE_TOOLS: true,
    DEBUG: false,
    ...extraConfig
}).app;

const chatBody = {
    model: 'opencode/kimi-k2.5',
    messages: [{ role: 'user', content: 'Hello' }]
};

describe('API_KEYS configuration parsing', () => {
    test('returns an empty list for unset / empty values', () => {
        expect(parseApiKeysConfig(undefined)).toEqual([]);
        expect(parseApiKeysConfig(null)).toEqual([]);
        expect(parseApiKeysConfig('')).toEqual([]);
        expect(parseApiKeysConfig([])).toEqual([]);
    });

    test('parses an array of {name, key} objects', () => {
        expect(parseApiKeysConfig([
            { name: 'alice', key: 'sk-a' },
            { key: 'sk-b' }
        ])).toEqual([
            { name: 'alice', key: 'sk-a' },
            { name: 'key-2', key: 'sk-b' }
        ]);
    });

    test('parses a comma-separated "name:key" string (env style)', () => {
        expect(parseApiKeysConfig('alice:sk-a, bob:sk-b')).toEqual([
            { name: 'alice', key: 'sk-a' },
            { name: 'bob', key: 'sk-b' }
        ]);
    });

    test('splits "name:key" on the first separator and keeps "=" as an alternative', () => {
        expect(parseApiKeysConfig('alice:sk-a:extra')).toEqual([{ name: 'alice', key: 'sk-a:extra' }]);
        expect(parseApiKeysConfig('alice=sk-a')).toEqual([{ name: 'alice', key: 'sk-a' }]);
    });

    test('bare keys get default names key-1, key-2, ... in list order', () => {
        expect(parseApiKeysConfig('sk-first,sk-second')).toEqual([
            { name: 'key-1', key: 'sk-first' },
            { name: 'key-2', key: 'sk-second' }
        ]);
        expect(parseApiKeysConfig([{ key: 'sk-solo' }])).toEqual([{ name: 'key-1', key: 'sk-solo' }]);
    });

    test('mixed entries keep positional numbering across the whole list', () => {
        expect(parseApiKeysConfig('sk-bare,carol:sk-c')).toEqual([
            { name: 'key-1', key: 'sk-bare' },
            { name: 'carol', key: 'sk-c' }
        ]);
    });

    test('tolerates empty segments in env strings', () => {
        expect(parseApiKeysConfig('alice:sk-a,,bob:sk-b,')).toEqual([
            { name: 'alice', key: 'sk-a' },
            { name: 'bob', key: 'sk-b' }
        ]);
    });

    test('throws on duplicate key values', () => {
        expect(() => parseApiKeysConfig('alice:sk-dup,bob:sk-dup')).toThrow(/duplicate key/i);
        expect(() => createApp({
            PORT: 10000,
            API_KEY: 'admin-key',
            API_KEYS: [{ name: 'alice', key: 'sk-dup' }, { name: 'bob', key: 'sk-dup' }],
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001'
        })).toThrow(/duplicate/i);
    });

    test('throws on duplicate names', () => {
        expect(() => parseApiKeysConfig([{ name: 'alice', key: 'sk-a' }, { name: 'alice', key: 'sk-b' }])).toThrow(/duplicate name/i);
    });

    test('throws on malformed entries', () => {
        expect(() => parseApiKeysConfig(['alice:'])).toThrow(/no key/i);
        expect(() => parseApiKeysConfig([{ name: 'alice' }])).toThrow(/missing a key/i);
        expect(() => parseApiKeysConfig([42])).toThrow(/invalid/i);
        expect(() => parseApiKeysConfig(1234)).toThrow(/must be an array/i);
    });

    test('keyHintFor shows only the last 4 characters', () => {
        expect(keyHintFor('sk-alice-secret-0001')).toBe('…0001');
        expect(keyHintFor('abcde')).toBe('…bcde');
        expect(keyHintFor('abcd')).toBe('abcd');
    });
});

describe('Multi-user key auth', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.sessionPrompt.mockImplementation(async () => ({
            data: { parts: [{ type: 'text', text: 'Mock response' }] }
        }));
        sdkMocks.sessionMessages.mockImplementation(async () => ([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Mock response' }]
            }
        ]));
    });

    test('each listed key authenticates under its own name', async () => {
        const app = createTestApp();
        const aliceRes = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-alice-secret-0001')
            .send(chatBody);
        const bobRes = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-bob-secret-0002')
            .send(chatBody);
        expect(aliceRes.statusCode).toEqual(200);
        expect(bobRes.statusCode).toEqual(200);
    });

    test('a key not in API_KEYS falls back to the legacy API_KEY', async () => {
        const app = createTestApp();
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer admin-key')
            .send(chatBody);
        expect(res.statusCode).toEqual(200);
    });

    test('unlisted non-master keys are rejected with 401', async () => {
        const app = createTestApp();
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-mallory-9999')
            .send(chatBody);
        expect(res.statusCode).toEqual(401);
        expect(res.body.error.message).toEqual('Unauthorized');
    });

    test('missing Authorization header is rejected with 401', async () => {
        const app = createTestApp();
        const res = await request(app).post('/v1/chat/completions').send(chatBody);
        expect(res.statusCode).toEqual(401);
    });

    test('API_KEYS still authenticate when no API_KEY is configured', async () => {
        const app = createTestApp({ API_KEY: '' });
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-alice-secret-0001')
            .send(chatBody);
        expect(res.statusCode).toEqual(200);
    });

    test('single-key mode without API_KEYS behaves as before', async () => {
        const app = createTestApp({ API_KEYS: [] });
        const okRes = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer admin-key')
            .send(chatBody);
        const badRes = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer wrong-key')
            .send(chatBody);
        expect(okRes.statusCode).toEqual(200);
        expect(badRes.statusCode).toEqual(401);
    });
});

describe('Admin key management endpoints', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('GET /admin/keys lists keys with hints and usage fields (admin key)', async () => {
        const app = createTestApp();
        const res = await request(app)
            .get('/admin/keys')
            .set('Authorization', 'Bearer admin-key');
        expect(res.statusCode).toEqual(200);
        expect(res.body).toEqual([
            {
                name: 'alice',
                keyHint: '…0001',
                requests: 0,
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                lastUsedAt: null,
                createdAt: expect.any(Number)
            },
            {
                name: 'bob',
                keyHint: '…0002',
                requests: 0,
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                lastUsedAt: null,
                createdAt: expect.any(Number)
            }
        ]);
    });

    test('POST /admin/keys adds a key that authenticates immediately (hot add)', async () => {
        const app = createTestApp();
        const addRes = await request(app)
            .post('/admin/keys')
            .set('Authorization', 'Bearer admin-key')
            .send({ name: 'carol', key: 'sk-carol-secret-0003' });
        expect(addRes.statusCode).toEqual(201);
        expect(addRes.body).toMatchObject({ name: 'carol', keyHint: '…0003' });

        const chatRes = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-carol-secret-0003')
            .send(chatBody);
        expect(chatRes.statusCode).toEqual(200);
    });

    test('POST /admin/keys rejects duplicate names and keys with 400', async () => {
        const app = createTestApp();
        const dupName = await request(app)
            .post('/admin/keys')
            .set('Authorization', 'Bearer admin-key')
            .send({ name: 'alice', key: 'sk-new-1111' });
        expect(dupName.statusCode).toEqual(400);

        const dupKey = await request(app)
            .post('/admin/keys')
            .set('Authorization', 'Bearer admin-key')
            .send({ name: 'newcomer', key: 'sk-alice-secret-0001' });
        expect(dupKey.statusCode).toEqual(400);

        const missing = await request(app)
            .post('/admin/keys')
            .set('Authorization', 'Bearer admin-key')
            .send({ name: 'nokey' });
        expect(missing.statusCode).toEqual(400);
    });

    test('DELETE /admin/keys/:name removes a key and revokes it', async () => {
        const app = createTestApp();
        const delRes = await request(app)
            .delete('/admin/keys/bob')
            .set('Authorization', 'Bearer admin-key');
        expect(delRes.statusCode).toEqual(204);

        const revokedRes = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-bob-secret-0002')
            .send(chatBody);
        expect(revokedRes.statusCode).toEqual(401);

        const listRes = await request(app)
            .get('/admin/keys')
            .set('Authorization', 'Bearer admin-key');
        expect(listRes.body.map((row) => row.name)).toEqual(['alice']);
    });

    test('DELETE /admin/keys/:name returns 404 for unknown names', async () => {
        const app = createTestApp();
        const res = await request(app)
            .delete('/admin/keys/ghost')
            .set('Authorization', 'Bearer admin-key');
        expect(res.statusCode).toEqual(404);
    });

    test('admin endpoints reject user keys with 401', async () => {
        const app = createTestApp();
        const getRes = await request(app)
            .get('/admin/keys')
            .set('Authorization', 'Bearer sk-alice-secret-0001');
        expect(getRes.statusCode).toEqual(401);

        const postRes = await request(app)
            .post('/admin/keys')
            .set('Authorization', 'Bearer sk-bob-secret-0002')
            .send({ name: 'x', key: 'sk-x-1111' });
        expect(postRes.statusCode).toEqual(401);

        const delRes = await request(app)
            .delete('/admin/keys/alice')
            .set('Authorization', 'Bearer sk-alice-secret-0001');
        expect(delRes.statusCode).toEqual(401);
    });

    test('admin endpoints are absent without API_KEYS (single-key mode)', async () => {
        const app = createTestApp({ API_KEYS: [] });
        const res = await request(app)
            .get('/admin/keys')
            .set('Authorization', 'Bearer admin-key');
        expect(res.statusCode).toEqual(404);
    });

    test('admin endpoints answer 501 when API_KEY (admin credential) is empty', async () => {
        const app = createTestApp({ API_KEY: '' });
        const getRes = await request(app).get('/admin/keys');
        const postRes = await request(app)
            .post('/admin/keys')
            .send({ name: 'x', key: 'sk-x-1111' });
        const delRes = await request(app).delete('/admin/keys/alice');
        expect(getRes.statusCode).toEqual(501);
        expect(postRes.statusCode).toEqual(501);
        expect(delRes.statusCode).toEqual(501);
    });

    test('PUBLIC_DIAGNOSTICS does not bypass admin auth', async () => {
        const app = createTestApp({ PUBLIC_DIAGNOSTICS: true });
        const res = await request(app).get('/admin/keys');
        expect(res.statusCode).toEqual(401);
    });
});

describe('Per-key usage metering', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.sessionPrompt.mockImplementation(async () => ({
            data: { parts: [{ type: 'text', text: 'Mock response' }] }
        }));
        sdkMocks.sessionMessages.mockImplementation(async () => ([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Mock response' }]
            }
        ]));
    });

    test('successful requests accrue tokens to the key that made them', async () => {
        const app = createTestApp();
        await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-alice-secret-0001')
            .send(chatBody);

        const adminRes = await request(app)
            .get('/admin/keys')
            .set('Authorization', 'Bearer admin-key');
        const alice = adminRes.body.find((row) => row.name === 'alice');
        const bob = adminRes.body.find((row) => row.name === 'bob');
        expect(alice.requests).toEqual(1);
        expect(alice.promptTokens).toBeGreaterThan(0);
        expect(alice.completionTokens).toBeGreaterThan(0);
        expect(alice.totalTokens).toEqual(alice.promptTokens + alice.completionTokens);
        expect(alice.lastUsedAt).toEqual(expect.any(Number));
        expect(bob.requests).toEqual(0);
        expect(bob.totalTokens).toEqual(0);
    });

    test('two requests from different keys are metered separately', async () => {
        const app = createTestApp();
        await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-alice-secret-0001')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'Hello' }] });
        await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-bob-secret-0002')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'A very much longer prompt for bob so the token math differs' }] });

        const adminRes = await request(app)
            .get('/admin/keys')
            .set('Authorization', 'Bearer admin-key');
        const alice = adminRes.body.find((row) => row.name === 'alice');
        const bob = adminRes.body.find((row) => row.name === 'bob');
        expect(alice.requests).toEqual(1);
        expect(bob.requests).toEqual(1);
        expect(bob.promptTokens).toBeGreaterThan(alice.promptTokens);
    });

    test('Responses API requests are metered per key too', async () => {
        const app = createTestApp();
        await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer sk-bob-secret-0002')
            .send({ model: 'opencode/kimi-k2.5', input: 'Hello there' });

        const adminRes = await request(app)
            .get('/admin/keys')
            .set('Authorization', 'Bearer admin-key');
        const bob = adminRes.body.find((row) => row.name === 'bob');
        expect(bob.requests).toEqual(1);
        expect(bob.totalTokens).toBeGreaterThan(0);
    });

    test('failed requests count requests but never tokens', async () => {
        const app = createTestApp();
        await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-alice-secret-0001')
            .send({ model: 'opencode/kimi-k2.5' }); // no messages -> 400

        const adminRes = await request(app)
            .get('/admin/keys')
            .set('Authorization', 'Bearer admin-key');
        const alice = adminRes.body.find((row) => row.name === 'alice');
        expect(alice.requests).toEqual(1);
        expect(alice.promptTokens).toEqual(0);
        expect(alice.completionTokens).toEqual(0);
        expect(alice.totalTokens).toEqual(0);
    });

    test('usage appears in /health/details only when API_KEYS is configured', async () => {
        const withKeysApp = createTestApp();
        const withKeysRes = await request(withKeysApp)
            .get('/health/details')
            .set('Authorization', 'Bearer admin-key');
        expect(withKeysRes.statusCode).toEqual(200);
        expect(withKeysRes.body.usage).toBeDefined();
        expect(withKeysRes.body.usage.byKey.alice).toMatchObject({
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            lastUsedAt: null,
            createdAt: expect.any(Number)
        });
        expect(withKeysRes.body.usage.total).toEqual({
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0
        });

        const withoutKeysApp = createTestApp({ API_KEYS: [] });
        const withoutKeysRes = await request(withoutKeysApp)
            .get('/health/details')
            .set('Authorization', 'Bearer admin-key');
        expect(withoutKeysRes.statusCode).toEqual(200);
        expect(withoutKeysRes.body.usage).toBeUndefined();
    });

    test('/metrics exposes per-key request and token counters when API_KEYS is configured', async () => {
        const app = createTestApp({ METRICS_ENABLED: true });
        await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-alice-secret-0001')
            .send(chatBody);

        const res = await request(app)
            .get('/metrics')
            .set('Authorization', 'Bearer admin-key');
        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('opencode_proxy_key_requests_total{key="alice"} 1');
        expect(res.text).toContain('opencode_proxy_key_requests_total{key="bob"} 0');
        expect(res.text).toMatch(/opencode_proxy_key_tokens_total\{key="alice",type="prompt"\} [1-9]/);
        expect(res.text).toMatch(/opencode_proxy_key_tokens_total\{key="alice",type="completion"\} [1-9]/);
    });

    test('/metrics has no per-key counters in single-key mode', async () => {
        const app = createTestApp({ API_KEYS: [], METRICS_ENABLED: true });
        const res = await request(app)
            .get('/metrics')
            .set('Authorization', 'Bearer admin-key');
        expect(res.statusCode).toEqual(200);
        expect(res.text).not.toContain('opencode_proxy_key_requests_total');
        expect(res.text).not.toContain('opencode_proxy_key_tokens_total');
    });
});

describe('createKeyUsageRegistry', () => {
    test('tracks requests and usage per name with totals', () => {
        const registry = createKeyUsageRegistry([{ name: 'a' }, { name: 'b' }]);
        registry.trackRequest('a');
        registry.trackUsage('a', { promptTokens: 10, completionTokens: 5 });
        registry.trackRequest('a');
        registry.trackUsage('a', { promptTokens: 1, completionTokens: 2 });
        // Unknown names (e.g. the legacy master key in multi-user mode) are
        // registered on first sighting instead of being dropped.
        registry.trackRequest('ghost');
        registry.trackUsage('ghost', { promptTokens: 2, completionTokens: 1 });

        const { byKey, total } = registry.snapshot();
        expect(byKey.a).toMatchObject({ requests: 2, promptTokens: 11, completionTokens: 7, totalTokens: 18 });
        expect(byKey.b).toMatchObject({ requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
        expect(byKey.ghost).toMatchObject({ requests: 1, promptTokens: 2, completionTokens: 1, totalTokens: 3 });
        expect(total).toEqual({ requests: 3, promptTokens: 13, completionTokens: 8, totalTokens: 21 });
    });

    test('ignores falsy names and zeroes', () => {
        const registry = createKeyUsageRegistry();
        registry.trackRequest(undefined);
        registry.trackUsage(undefined, { promptTokens: 5 });
        expect(registry.snapshot().byKey).toEqual({});
        registry.register('new');
        expect(registry.has('new')).toBe(true);
        registry.trackUsage('new', { promptTokens: 4, completionTokens: 6 });
        expect(registry.entry('new').totalTokens).toEqual(10);
        registry.delete('new');
        expect(registry.has('new')).toBe(false);
        expect(registry.entry('missing')).toMatchObject({ requests: 0, totalTokens: 0 });
    });
});
