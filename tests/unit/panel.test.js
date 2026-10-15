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
    toolIds: jest.fn(async () => ({
        data: ['web_fetch', 'filesystem', 'bash']
    })),
    sessionCreate: jest.fn(async () => ({
        data: { id: 'test-session-id' }
    })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'Mock response' }] } })),
    sessionMessages: jest.fn(async () => ([])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({ stream: (async function* () { })() }))
};

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

const { createApp } = await import('../../src/proxy.js');

const buildPanelApp = (overrides = {}) => createApp({
    PORT: 10000,
    API_KEY: 'test-key',
    OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
    OPENCODE_SERVER_PASSWORD: 'super-secret-backend-password',
    ZEN_API_KEY: 'super-secret-zen-key',
    REQUEST_TIMEOUT_MS: 5000,
    DISABLE_TOOLS: true,
    DEBUG: false,
    WEB_PANEL_ENABLED: true,
    ...overrides
}).app;

describe('Web Panel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.configProviders.mockResolvedValue({
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
        });
    });

    test('panel endpoints return 404 when the panel is disabled', async () => {
        const disabledApp = buildPanelApp({ WEB_PANEL_ENABLED: false });

        const htmlRes = await request(disabledApp).get('/panel');
        expect(htmlRes.statusCode).toEqual(404);

        const jsonRes = await request(disabledApp).get('/panel/keys.json');
        expect(jsonRes.statusCode).toEqual(404);
    });

    test('GET /panel serves the HTML shell with no-store and nosniff headers', async () => {
        const panelApp = buildPanelApp();

        const res = await request(panelApp).get('/panel');
        expect(res.statusCode).toEqual(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.headers['cache-control']).toEqual('no-store');
        expect(res.headers['x-content-type-options']).toEqual('nosniff');
        expect(res.text).toContain('<!DOCTYPE html>');
        // No secrets and no key material may reach the page source.
        expect(res.text).not.toContain('test-key');
        expect(res.text).not.toContain('super-secret-backend-password');
        expect(res.text).not.toContain('super-secret-zen-key');
    });

    test('GET /panel/keys.json returns 401 without auth when API_KEY is set', async () => {
        const panelApp = buildPanelApp();

        const res = await request(panelApp).get('/panel/keys.json');
        expect(res.statusCode).toEqual(401);
    });

    test('GET /panel/keys.json returns 401 on a wrong Bearer key', async () => {
        const panelApp = buildPanelApp();

        const res = await request(panelApp)
            .get('/panel/keys.json')
            .set('Authorization', 'Bearer wrong-key');
        expect(res.statusCode).toEqual(401);
    });

    test('GET /panel/keys.json returns models, health and uptime when authorized', async () => {
        const panelApp = buildPanelApp();

        const res = await request(panelApp)
            .get('/panel/keys.json')
            .set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        expect(res.headers['content-type']).toContain('application/json');
        expect(res.headers['cache-control']).toEqual('no-store');
        expect(res.headers['x-content-type-options']).toEqual('nosniff');
        expect(typeof res.body.uptime).toEqual('number');
        expect(res.body.uptime).toBeGreaterThan(0);
        expect(res.body.backend_url).toEqual('http://127.0.0.1:10001');
        expect(Array.isArray(res.body.models)).toEqual(true);
        expect(res.body.models.length).toBeGreaterThan(0);
        expect(res.body.models[0].id).toContain('/');
        expect(res.body.models[0]).toHaveProperty('owned_by');
        expect(res.body.health.status).toEqual('ok');
        expect(res.body.health.internal_tools.config.allowed_tools).toEqual([]);
    });

    test('GET /panel/keys.json never exposes secret values', async () => {
        const panelApp = buildPanelApp({
            INTERNAL_ALLOWED_TOOLS: ['web_fetch']
        });

        const res = await request(panelApp)
            .get('/panel/keys.json')
            .set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain('test-key');
        expect(serialized).not.toContain('super-secret-backend-password');
        expect(serialized).not.toContain('super-secret-zen-key');
    });


    test('panel edge: disabled + enabled matrix and no secrets with PUBLIC_DIAGNOSTICS', async () => {
        // Disabled: both 404 regardless of auth
        const offApp = buildPanelApp({ WEB_PANEL_ENABLED: false });
        expect((await request(offApp).get('/panel').set('Authorization', 'Bearer test-key')).status).toEqual(404);
        expect((await request(offApp).get('/panel/keys.json').set('Authorization', 'Bearer test-key')).status).toEqual(404);

        // Enabled + PUBLIC_DIAGNOSTICS: no-auth access to JSON, still no secrets
        const pubApp = buildPanelApp({ PUBLIC_DIAGNOSTICS: true });
        const pubRes = await request(pubApp).get('/panel/keys.json');
        expect(pubRes.status).toEqual(200);
        const pubSerialized = JSON.stringify(pubRes.body);
        expect(pubSerialized).not.toContain('test-key');
        expect(pubSerialized).not.toContain('super-secret-backend-password');
        expect(pubSerialized).not.toContain('super-secret-zen-key');

        // Enabled + wrong key: HTML shell 200 but JSON 401
        const app2 = buildPanelApp({});
        expect((await request(app2).get('/panel').set('Authorization', 'Bearer wrong')).status).toEqual(200);
        expect((await request(app2).get('/panel/keys.json').set('Authorization', 'Bearer wrong')).status).toEqual(401);

        // non-GET methods must not bypass the auth middleware
        expect((await request(app2).post('/panel/keys.json').set('Authorization', 'Bearer test-key')).status).toEqual(404);
        expect((await request(app2).post('/panel/keys.json')).status).toEqual(401);
    });

    test('GET /panel/keys.json works without auth when API_KEY is empty', async () => {
        const panelApp = buildPanelApp({ API_KEY: '' });

        const res = await request(panelApp).get('/panel/keys.json');
        expect(res.statusCode).toEqual(200);
        expect(Array.isArray(res.body.models)).toEqual(true);
    });

    test('GET /panel/keys.json works without auth when PUBLIC_DIAGNOSTICS is true', async () => {
        const panelApp = buildPanelApp({ PUBLIC_DIAGNOSTICS: true });

        const res = await request(panelApp).get('/panel/keys.json');
        expect(res.statusCode).toEqual(200);
        expect(res.body.public_diagnostics).toEqual(true);
        expect(Array.isArray(res.body.models)).toEqual(true);
        expect(res.body.models.length).toBeGreaterThan(0);
    });

    test('GET /panel/keys.json omits health details when diagnostics are disabled', async () => {
        const panelApp = buildPanelApp({ HEALTH_DETAILS_ENABLED: false });

        const res = await request(panelApp)
            .get('/panel/keys.json')
            .set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        expect(res.body.health).toEqual(null);
        expect(Array.isArray(res.body.models)).toEqual(true);
    });

    test('GET /panel/keys.json degrades gracefully when the backend is unreachable', async () => {
        sdkMocks.configProviders.mockRejectedValue(new Error('connect ECONNREFUSED'));
        const panelApp = buildPanelApp();

        const res = await request(panelApp)
            .get('/panel/keys.json')
            .set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        expect(res.body.models).toEqual([]);
        expect(res.body.health.status).toEqual('ok');
    });
});
