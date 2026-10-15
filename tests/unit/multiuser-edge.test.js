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
});
