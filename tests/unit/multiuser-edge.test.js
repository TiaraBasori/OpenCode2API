import request from 'supertest';
import { jest } from '@jest/globals';

const sdkMocks = {
    configProviders: jest.fn(),
    configUpdate: jest.fn(),
    sessionCreate: jest.fn(),
    sessionPrompt: jest.fn(),
    sessionMessages: jest.fn(),
    sessionDelete: jest.fn(),
    eventSubscribe: jest.fn()
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
        config: { providers: sdkMocks.configProviders, update: sdkMocks.configUpdate },
        session: { create: sdkMocks.sessionCreate, prompt: sdkMocks.sessionPrompt, messages: sdkMocks.sessionMessages, delete: sdkMocks.sessionDelete },
        event: { subscribe: sdkMocks.eventSubscribe }
    }))
}));

const { createApp } = await import('../../src/proxy.js');

const baseConfig = () => ({
    PORT: 10000,
    API_KEY: 'admin-master',
    API_KEYS: [
        { name: 'alice', key: 'sk-alice-secret' },
        { name: 'bob', key: 'sk-bob-secret' }
    ],
    OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
    REQUEST_TIMEOUT_MS: 5000,
    DISABLE_TOOLS: true,
    DEBUG: false
});

const okSession = () => {
    sdkMocks.configProviders.mockResolvedValue({ data: { providers: [{ id: 'opencode', models: { m: { name: 'm' } } }] } });
    sdkMocks.sessionCreate.mockResolvedValue({ data: { id: 'ses_x' } });
    sdkMocks.configUpdate.mockResolvedValue({ data: {} });
    sdkMocks.sessionMessages.mockResolvedValue({
        data: [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'hello' }] }]
    });
};

describe('multiuser edge review', () => {
    beforeEach(() => jest.clearAllMocks());

    test('hot-added key authenticates immediately; deleted key revoked immediately', async () => {
        const { app } = createApp(baseConfig());
        okSession();

        // hot add
        const add = await request(app).post('/admin/keys')
            .set('Authorization', 'Bearer admin-master')
            .send({ name: 'carol', key: 'sk-carol-secret' });
        expect(add.status).toBe(201);

        const useCarol = await request(app).post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-carol-secret')
            .send({ model: 'opencode/m', messages: [{ role: 'user', content: 'hi' }] });
        expect(useCarol.status).toBe(200);

        // delete -> revoked
        const del = await request(app).delete('/admin/keys/carol')
            .set('Authorization', 'Bearer admin-master');
        expect(del.status).toBe(204);
        const revoked = await request(app).post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-carol-secret')
            .send({ model: 'opencode/m', messages: [{ role: 'user', content: 'hi' }] });
        expect(revoked.status).toBe(401);
    });

    test('admin list never leaks full key values', async () => {
        const { app } = createApp(baseConfig());
        const res = await request(app).get('/admin/keys')
            .set('Authorization', 'Bearer admin-master');
        expect(res.status).toBe(200);
        const text = JSON.stringify(res.body);
        expect(text).not.toContain('sk-alice-secret');
        expect(text).not.toContain('sk-bob-secret');
        expect(text).not.toContain('admin-master');
        for (const row of res.body) {
            expect(typeof row.keyHint).toBe('string');
            expect(row.keyHint.endsWith ? row.keyHint.endsWith(row.keyHint.slice(-4)) : true).toBe(true);
            expect(row.key).toBeUndefined();
        }
    });

    test('user key cannot access admin surface', async () => {
        const { app } = createApp(baseConfig());
        const res = await request(app).get('/admin/keys')
            .set('Authorization', 'Bearer sk-alice-secret');
        expect(res.status).toBe(401);
    });

    test('master key requests meter under __api_key__ and appear in usage', async () => {
        const { app } = createApp(baseConfig());
        okSession();
        await request(app).post('/v1/chat/completions')
            .set('Authorization', 'Bearer admin-master')
            .send({ model: 'opencode/m', messages: [{ role: 'user', content: 'hi' }] });
        const res = await request(app).get('/health/details')
            .set('Authorization', 'Bearer admin-master');
        expect(res.status).toBe(200);
        expect(res.body.usage.total.requests).toBeGreaterThanOrEqual(1);
        expect(res.body.usage.total.totalTokens).toBeGreaterThan(0);
        const admin = await request(app).get('/admin/keys')
            .set('Authorization', 'Bearer admin-master');
        const masterRow = admin.body.find((row) => row.name === '__api_key__');
        expect(masterRow).toBeDefined();
        expect(masterRow.requests).toBeGreaterThanOrEqual(1);
    });

    test('failed business request counts requests but not tokens', async () => {
        const { app } = createApp(baseConfig());
        sdkMocks.sessionCreate.mockResolvedValue({ data: { id: 'ses_y' } });
        sdkMocks.configUpdate.mockResolvedValue({ data: {} });
        sdkMocks.sessionPrompt.mockRejectedValue(new Error('upstream down'));
        sdkMocks.sessionMessages.mockRejectedValue(new Error('upstream down'));
        await request(app).post('/v1/chat/completions')
            .set('Authorization', 'Bearer sk-alice-secret')
            .send({ model: 'opencode/m', messages: [{ role: 'user', content: 'hi' }] });
        const res = await request(app).get('/health/details')
            .set('Authorization', 'Bearer admin-master');
        const alice = res.body.usage.byKey.alice;
        expect(alice.requests).toBe(1);
        expect(alice.promptTokens).toBe(0);
        expect(alice.completionTokens).toBe(0);
    });

    test('rejects unsafe or reserved key names at config parse and hot-add', async () => {
        const { app } = createApp(baseConfig());
        for (const badName of ['__api_key__', 'team/alice', 'bad%name', 'a?b', 'a#b', 'x'.repeat(65)]) {
            const res = await request(app).post('/admin/keys')
                .set('Authorization', 'Bearer admin-master')
                .send({ name: badName, key: 'sk-valid-key-9999' });
            expect(res.status).toBe(400);
        }
    });

    test('diagnostics scope per-key usage by caller role (admin vs user vs public)', async () => {
        const cfg = { ...baseConfig(), METRICS_ENABLED: true, PUBLIC_DIAGNOSTICS: true };
        const aliceKey = cfg.API_KEYS[0].key;
        const { app } = createApp(cfg);
        okSession();
        await request(app).post('/v1/chat/completions')
            .set('Authorization', `Bearer ${aliceKey}`)
            .send({ model: 'opencode/m', messages: [{ role: 'user', content: 'hi' }] });

        // User key sees only its own entry in /health/details and /metrics
        const userDetails = await request(app).get('/health/details')
            .set('Authorization', `Bearer ${aliceKey}`);
        expect(userDetails.status).toBe(200);
        expect(Object.keys(userDetails.body.usage.byKey)).toEqual(['alice']);

        const userMetrics = await request(app).get('/metrics')
            .set('Authorization', `Bearer ${aliceKey}`);
        expect(userMetrics.status).toBe(200);
        expect(userMetrics.text).toContain('key="alice"');
        expect(userMetrics.text).not.toContain('key="bob"');

        // Unauthenticated PUBLIC_DIAGNOSTICS caller sees aggregate total but no key names
        const pubDetails = await request(app).get('/health/details');
        expect(pubDetails.status).toBe(200);
        expect(pubDetails.body.usage.byKey).toEqual({});
        expect(pubDetails.body.usage.total.requests).toBe(1);

        const pubMetrics = await request(app).get('/metrics');
        expect(pubMetrics.status).toBe(200);
        expect(pubMetrics.text).not.toContain('key="alice"');
        expect(pubMetrics.text).not.toContain('key="bob"');
    });

    test('multi-user mode with empty API_KEY still requires auth on diagnostics when PUBLIC_DIAGNOSTICS is false', async () => {
        const cfg = { ...baseConfig(), API_KEY: '', METRICS_ENABLED: true, PUBLIC_DIAGNOSTICS: false };
        const aliceKey = cfg.API_KEYS[0].key;
        const { app } = createApp(cfg);
        const unauthDetails = await request(app).get('/health/details');
        expect(unauthDetails.status).toBe(401);
        const userDetails = await request(app).get('/health/details')
            .set('Authorization', `Bearer ${aliceKey}`);
        expect(userDetails.status).toBe(200);
        expect(Object.keys(userDetails.body.usage.byKey)).toEqual(['alice']);
    });
});
