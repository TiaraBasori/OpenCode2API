import request from 'supertest';
import http from 'http';
import { jest } from '@jest/globals';
import { Opencode2apiToolLock } from '../../plugin/opencode2api-tool-lock.js';

const LOCK_SPEC = 'file:///home/node/project/plugin/opencode2api-tool-lock.js';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'big-pickle': { name: 'Big Pickle' } } }] }
    })),
    configUpdate: jest.fn(async () => ({})),
    configGet: jest.fn(async () => ({ data: { plugin: [LOCK_SPEC] } })),
    toolIds: jest.fn(async () => ({ data: ['bash', 'read', 'webfetch'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'ses_test' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'ok' }] } })),
    sessionMessages: jest.fn(async () => ([
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'ok' }] }
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({ stream: (async function* () { })() }))
};

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: { providers: sdkMocks.configProviders, update: sdkMocks.configUpdate, get: sdkMocks.configGet },
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

const { createApp, buildBackendConfigContent, checkHealth } = await import('../../src/proxy.js');

// Stands in for the OpenCode backend's health endpoint; the API itself is mocked.
const backend = http.createServer((req, res) => {
    res.writeHead(req.url === '/global/health' ? 200 : 404);
    res.end(req.url === '/global/health' ? '{"healthy":true}' : '');
});
await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
afterAll(() => backend.close());

const baseConfig = {
    PORT: 10000,
    API_KEY: 'k',
    OPENCODE_SERVER_URL: `http://127.0.0.1:${backend.address().port}`,
    REQUEST_TIMEOUT_MS: 5000,
    MANAGE_BACKEND: false,
    DEBUG: false
};

const chat = (app, body) => request(app)
    .post('/v1/chat/completions')
    .set('Authorization', 'Bearer k')
    .send({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'hi' }], ...body });

describe('tool policy with the tool-lock plugin loaded', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.configGet.mockResolvedValue({ data: { plugin: [LOCK_SPEC] } });
    });

    test('keeps the official tool list and carries the deny-all policy in the session title', async () => {
        const { app } = createApp({ ...baseConfig, DISABLE_TOOLS: true });
        const res = await chat(app);

        expect(res.statusCode).toEqual(200);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledWith({ body: { title: 'opencode2api [tools:none]' } });
        expect(sdkMocks.sessionPrompt.mock.calls.at(-1)[0].body.tools).toBeUndefined();
        expect(sdkMocks.toolIds).not.toHaveBeenCalled();
    });

    test('puts the internal allowlist into the policy instead of a tools map', async () => {
        const { app } = createApp({ ...baseConfig, DISABLE_TOOLS: true, INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'read'] });
        await chat(app);

        expect(sdkMocks.sessionCreate).toHaveBeenCalledWith({ body: { title: 'opencode2api [tools:webfetch,read]' } });
        expect(sdkMocks.sessionPrompt.mock.calls.at(-1)[0].body.tools).toBeUndefined();
    });

    test('external tool bridging still denies every internal tool', async () => {
        const { app } = createApp({ ...baseConfig, DISABLE_TOOLS: true, INTERNAL_ALLOWED_TOOLS: ['read'] });
        await chat(app, { tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] });

        expect(sdkMocks.sessionCreate).toHaveBeenCalledWith({ body: { title: 'opencode2api [tools:none]' } });
    });

    test('DISABLE_TOOLS=false allows every tool', async () => {
        const { app } = createApp({ ...baseConfig, DISABLE_TOOLS: false });
        await chat(app);

        expect(sdkMocks.sessionCreate).toHaveBeenCalledWith({ body: { title: 'opencode2api [tools:*]' } });
    });

    test('Responses API sessions get the same policy', async () => {
        const { app } = createApp({ ...baseConfig, DISABLE_TOOLS: true });
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer k')
            .send({ model: 'opencode/big-pickle', input: 'hi' });

        expect(res.statusCode).toEqual(200);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledWith({ body: { title: 'opencode2api [tools:none]' } });
        expect(sdkMocks.sessionPrompt.mock.calls.at(-1)[0].body.tools).toBeUndefined();
    });
});

describe('tool policy without the plugin', () => {
    test('falls back to the per-request tools map', async () => {
        jest.clearAllMocks();
        sdkMocks.configGet.mockResolvedValue({ data: { plugin: [] } });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const { app } = createApp({ ...baseConfig, DISABLE_TOOLS: true });
        await chat(app);
        await chat(app);

        expect(sdkMocks.sessionCreate).toHaveBeenCalledWith(undefined);
        expect(sdkMocks.sessionPrompt.mock.calls.at(-1)[0].body.tools).toEqual({ bash: false, read: false, webfetch: false });
        expect(warn.mock.calls.filter(([msg]) => String(msg).includes('opencode2api-tool-lock.js'))).toHaveLength(1);
        warn.mockRestore();
    });
});

describe('tool-lock plugin', () => {
    const sessions = {
        ses_none: { title: 'opencode2api [tools:none]' },
        ses_all: { title: 'opencode2api [tools:*]' },
        ses_fetch: { title: 'opencode2api [tools:webfetch,read]' },
        ses_child: { title: 'Subtask (@general)', parentID: 'ses_fetch' },
        ses_plain: { title: 'New session' }
    };
    const client = {
        session: {
            get: jest.fn(async ({ path }) => {
                if (path.id === 'ses_broken') throw new Error('backend down');
                return { data: sessions[path.id] };
            })
        }
    };
    let hooks;
    const run = (sessionID, tool) => hooks['tool.execute.before']({ tool, sessionID, callID: 'c' }, { args: {} });

    beforeAll(async () => {
        hooks = await Opencode2apiToolLock({ client });
    });

    test('denies every tool for a deny-all session', async () => {
        await expect(run('ses_none', 'bash')).rejects.toThrow('Tool "bash" is disabled by opencode2api');
    });

    test('allows only listed tools', async () => {
        await expect(run('ses_fetch', 'webfetch')).resolves.toBeUndefined();
        await expect(run('ses_fetch', 'read')).resolves.toBeUndefined();
        await expect(run('ses_fetch', 'bash')).rejects.toThrow('disabled');
    });

    test('allows everything for a wildcard session', async () => {
        await expect(run('ses_all', 'bash')).resolves.toBeUndefined();
    });

    test('child sessions inherit the parent policy', async () => {
        await expect(run('ses_child', 'read')).resolves.toBeUndefined();
        await expect(run('ses_child', 'write')).rejects.toThrow('disabled');
    });

    test('points native calls to external tools back to the text contract', async () => {
        const hook = hooks['tool.execute.before'];
        await expect(hook(
            { tool: 'invalid', sessionID: 'ses_none', callID: 'c' },
            { args: { tool: 'external__get_weather', error: 'unavailable' } }
        )).rejects.toThrow('<function_calls>{"name":"external__get_weather"');
    });

    test('fails closed without a policy or when the lookup fails', async () => {
        await expect(run('ses_plain', 'read')).rejects.toThrow('disabled');
        await expect(run('ses_missing', 'read')).rejects.toThrow('disabled');
        await expect(run('ses_broken', 'read')).rejects.toThrow('disabled');
    });
});

describe('backend wiring', () => {
    test('adds the tool-lock plugin to existing OPENCODE_CONFIG_CONTENT', () => {
        const config = JSON.parse(buildBackendConfigContent('{"plugin":["/x.js"],"theme":"system"}'));
        expect(config.theme).toEqual('system');
        expect(config.plugin[0]).toEqual('/x.js');
        expect(config.plugin[1]).toMatch(/plugin[\\/]opencode2api-tool-lock\.js$/);
        expect(JSON.parse(buildBackendConfigContent('')).plugin).toHaveLength(1);
    });

    test('health check uses /global/health and requires healthy=true', async () => {
        const routes = {
            '/global/health': [200, '{"healthy":true,"version":"1"}'],
            '/health': [200, '<!doctype html>']
        };
        let healthy = true;
        const server = http.createServer((req, res) => {
            const [status, body] = routes[req.url] || [404, ''];
            res.writeHead(status);
            res.end(req.url === '/global/health' && !healthy ? '{"healthy":false}' : body);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}`;
        try {
            await expect(checkHealth(url)).resolves.toBe(true);
            healthy = false;
            await expect(checkHealth(url)).rejects.toThrow('unhealthy');
        } finally {
            server.close();
        }
    });
});
