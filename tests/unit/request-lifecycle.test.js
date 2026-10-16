import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../../src/proxy.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const model = 'opencode/test-model';
const tools = [{ type: 'function', function: { name: 'Bash', description: 'Local diagnostic only', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }];
const markup = (command = 'pwd', id) => '<function_calls>' + JSON.stringify({ ...(id ? { id } : {}), name: 'external__Bash', arguments: { command } }) + '</function_calls>';
const toolCallsOf = (route, stream, data) => {
  if (route === 'messages') {
    const blocks = stream ? data.filter(event => event.type === 'content_block_start').map(event => {
      if (event.content_block.type !== 'tool_use') return event.content_block;
      const json = data.filter(delta => delta.type === 'content_block_delta' && delta.index === event.index && delta.delta.type === 'input_json_delta').map(delta => delta.delta.partial_json).join('');
      return { ...event.content_block, input: json ? JSON.parse(json) : event.content_block.input };
    }) : data.content;
    return blocks.filter(block => block.type === 'tool_use').map(block => ({ function: { name: block.name, arguments: JSON.stringify(block.input) } }));
  }
  if (!stream) return route === 'responses' ? data.output.filter(item => item.type === 'function_call') : data.choices[0].message.tool_calls ?? [];
  return route === 'responses' ? data.filter(event => event.type === 'response.output_item.added' && event.item?.type === 'function_call').map(event => event.item) : data.flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? []);
};

async function harness(mode, requestTimeout = 120) {
  let counter = 0;
  const sessions = new Map();
  const events = new Set();
  const state = { aborts: [], prompts: 0, polls: 0, permissions: new Set(), active: new Set(), promptBodies: [] };
  const send = event => { for (const response of events) response.write('data: ' + JSON.stringify(event) + '\n\n'); };
  const json = (response, data) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)); };
  const backend = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/global/health') return json(response, { healthy: true, version: '1.19.0' });
    if (pathname === '/config/providers') return json(response, { providers: [{ id: 'opencode', models: { 'test-model': { name: 'Synthetic model' } } }] });
    if (pathname === '/config') return json(response, { plugin: ['/home/node/project/plugin/opencode2api-tool-lock.js'] });
    if (pathname === '/session' && request.method === 'POST') {
      const id = 'ses_test_' + ++counter;
      sessions.set(id, { id, messages: [], response: null });
      return json(response, { id });
    }
    if (pathname === '/permission') return json(response, [...state.permissions].map(sessionID => ({ sessionID, id: 'per_' + sessionID, permission: 'doom_loop' })));
    if (pathname === '/event') {
      response.setHeader('Content-Type', 'text/event-stream');
      response.write(': connected\n\n');
      events.add(response);
      response.on('close', () => events.delete(response));
      return;
    }
    const match = pathname.match(/^\/session\/([^/]+)\/(message|abort)$/);
    if (match) {
      const id = match[1], session = sessions.get(id);
      if (match[2] === 'abort') {
        state.aborts.push(id);
        state.active.delete(id);
        state.permissions.delete(id);
        if (session?.response && !session.response.writableEnded) json(session.response, { info: { role: 'assistant', error: { name: 'MessageAbortedError' } }, parts: [] });
        return json(response, true);
      }
      if (request.method === 'GET') { state.polls++; return json(response, session?.messages ?? []); }
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); state.promptBodies.push(body); state.prompts++; state.active.add(id); session.response = response;
      const parts = [{ type: 'reasoning', text: 'synthetic unfinished reasoning' }];
      session.messages = [{ info: { id: 'msg_' + id, role: 'assistant', sessionID: id, time: { created: Date.now() } }, parts }];
      await sleep(20);
      const part = (type, text, suffix) => {
        send({ type: 'message.part.updated', properties: { part: { id: suffix + id, type, sessionID: id } } });
        send({ type: 'message.part.delta', properties: { sessionID: id, partID: suffix + id, field: 'text', delta: text } });
      };
      if (mode === 'permission') {
        part('reasoning', 'thinking', 'r');
        state.permissions.add(id);
        send({ type: 'message.part.updated', properties: { part: { id: 'tool_' + id, type: 'tool', sessionID: id, tool: 'invalid', state: { status: 'running', input: { tool: 'external__Bash' } } } } });
        send({ type: 'permission.asked', properties: { id: 'per_' + id, sessionID: id, permission: 'doom_loop', patterns: ['invalid'] } });
        return;
      }
      if (mode === 'timeout') { part('reasoning', 'thinking', 'r'); return; }
      if (mode === 'partial-error') {
        part('text', 'unfinished text', 't');
        session.messages[0].parts = [{ type: 'text', text: 'unfinished text' }];
        session.messages[0].info.error = { name: 'SyntheticProviderError', data: { message: 'synthetic upstream failure' } };
        send({ type: 'message.updated', properties: { info: session.messages[0].info } });
        state.active.delete(id);
        if (!response.writableEnded) json(response, { info: session.messages[0].info, parts: session.messages[0].parts });
        return;
      }
      if (mode === 'invalid-always' || (mode === 'invalid-then-valid' && state.prompts === 1)) {
        send({ type: 'message.part.updated', properties: { part: { id: 'invalid_' + id, type: 'tool', sessionID: id, tool: 'invalid', state: { status: 'error', input: { tool: 'external__Bash', error: 'unavailable' }, error: 'external__Bash is not a native tool. Call it by replying with only markup.' } } } });
        return;
      }
      if (mode === 'snapshot-tools') {
        session.messages[0].info.finish = 'stop';
        session.messages[0].info.time.completed = Date.now();
        session.messages[0].parts = [{ type: 'text', text: markup() }];
        state.active.delete(id);
        if (!response.writableEnded) json(response, { info: session.messages[0].info, parts: session.messages[0].parts });
        return;
      }
      if (mode === 'reason-only') {
        part('reasoning', markup(), 'r');
        session.messages[0].parts = [{ type: 'reasoning', text: markup() }];
      }
      if (mode === 'disagree') {
        part('reasoning', markup('pwd'), 'r'); part('text', markup('whoami'), 't');
        session.messages[0].parts = [{ type: 'reasoning', text: markup('pwd') }, { type: 'text', text: markup('whoami') }];
      }
      if (mode === 'native-unregistered') {
        send({ type: 'message.part.updated', properties: { part: { id: 'native_' + id, type: 'tool', sessionID: id, tool: 'write', state: { status: 'error', input: { filePath: '/tmp/unapproved', content: 'not executed' }, error: 'Tool "write" is disabled by opencode2api. Do not call it again.' } } } });
        return;
      }
      if (mode === 'native' || mode === 'native-batch') {
        const emitNative = (suffix, command) => send({ type: 'message.part.updated', properties: { part: { id: 'native_' + suffix + id, type: 'tool', sessionID: id, tool: 'bash', state: { status: 'error', input: { command }, error: 'Tool "bash" is disabled by opencode2api. Do not call it again.' } } } });
        emitNative('first', 'pwd');
        if (mode === 'native-batch') { await sleep(90); emitNative('second', 'whoami'); }
        send({ type: 'message.updated', properties: { info: { sessionID: id, role: 'assistant', finish: 'tool-calls' } } });
        return;
      }
      if (mode === 'mirror') {
        part('reasoning', markup(), 'r'); part('text', markup(), 't');
        session.messages[0].parts = [{ type: 'reasoning', text: markup() }, { type: 'text', text: markup() }];
      } else if (mode === 'distinct') {
        part('text', markup('pwd', 'intentional-1') + markup('pwd', 'intentional-2'), 't');
        session.messages[0].parts = [{ type: 'text', text: markup('pwd', 'intentional-1') + markup('pwd', 'intentional-2') }];
      } else if (!['reason-only', 'disagree'].includes(mode)) { part('text', 'TEXT_OK', 't'); session.messages[0].parts = [{ type: 'text', text: 'TEXT_OK' }]; }
      await sleep(30);
      session.messages[0].info.finish = 'stop'; session.messages[0].info.time.completed = Date.now();
      send({ type: 'message.updated', properties: { info: session.messages[0].info } });
      state.active.delete(id);
      if (!response.writableEnded) json(response, { info: session.messages[0].info, parts: session.messages[0].parts });
      return;
    }
    response.statusCode = 404; return json(response, { error: 'synthetic unknown path' });
  });
  await listen(backend);
  const { app } = createApp({ API_KEY: 'test-key', OPENCODE_SERVER_URL: `http://127.0.0.1:${backend.address().port}`, REQUEST_TIMEOUT_MS: requestTimeout, DISABLE_TOOLS: true, MANAGE_BACKEND: false, AUTO_CLEANUP_CONVERSATIONS: false, EVENT_FIRST_DELTA_TIMEOUT_MS: 60, EVENT_IDLE_TIMEOUT_MS: 50 });
  const proxy = http.createServer(app); await listen(proxy);
  const call = async (route, stream, extra = {}, signal) => {
    const body = route === 'responses' ? { model, input: 'Run the local diagnostic.', tools: tools.map(t => ({ type: 'function', ...t.function })), stream } : { model, max_tokens: 128, messages: [{ role: 'user', content: 'Run the local diagnostic.' }], tools: route === 'messages' ? tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) : tools, stream };
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/${route === 'responses' ? 'responses' : route === 'messages' ? 'messages' : 'chat/completions'}`,  { method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...extra }), signal: signal ?? AbortSignal.timeout(3000) });
    const raw = await response.text();
    return { status: response.status, raw, data: stream ? raw.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6))) : JSON.parse(raw) };
  };
  return { state, call, url: `http://127.0.0.1:${proxy.address().port}`, close: async () => { for (const r of events) r.end(); proxy.closeAllConnections(); backend.closeAllConnections(); await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => backend.close(resolve))]); } };
}

for (const route of ['chat', 'responses', 'messages']) for (const stream of [true, false]) {
  test(`${route} ${stream ? 'stream' : 'JSON'} stops backend on total deadline, never succeeds with partial content`, async () => {
    const h = await harness('timeout');
    try {
      const r = await h.call(route, stream);
      if (stream) {
        assert.ok(r.data.some(x => x.error || x.type === 'response.failed'), r.raw);
        assert.equal(r.data.some(x => x.type === 'response.completed' || x.choices?.[0]?.finish_reason === 'stop' || x.delta?.stop_reason === 'end_turn'), false);
      } else assert.equal(r.status, 504, r.raw);
      assert.ok(h.state.aborts.length >= 1);
      assert.equal(h.state.active.size, 0);
    } finally { await h.close(); }
  });
}
for (const route of ['chat', 'responses', 'messages']) for (const stream of [true, false]) {
  test(`${route} ${stream ? 'stream' : 'JSON'} never succeeds after an upstream error with partial text`, async () => {
    const h = await harness('partial-error', 1000);
    try {
      const r = await h.call(route, stream);
      if (stream) {
        assert.ok(r.data.some(event => event.error || event.type === 'response.failed'), r.raw);
        assert.equal(r.data.some(event => event.type === 'response.completed' || event.choices?.[0]?.finish_reason === 'stop' || event.delta?.stop_reason === 'end_turn'), false, r.raw);
      } else assert.equal(r.status, 502, r.raw);
    } finally { await h.close(); }
  });
}
for (const route of ['chat', 'responses', 'messages']) {
  test(`${route} rejects unanswered doom_loop rather than waiting or returning success`, async () => {
    const h = await harness('permission', 300);
    try {
      const r = await h.call(route, true);
      assert.ok(r.data.some(x => x.error || x.type === 'response.failed'));
      assert.equal(r.data.some(x => x.type === 'response.completed' || x.choices?.[0]?.finish_reason === 'stop' || x.delta?.stop_reason === 'end_turn'), false);
      assert.ok(h.state.aborts.length);
      assert.equal(h.state.permissions.size, 0);
    } finally { await h.close(); }
  });
  test(`${route} mirrored tool markup is delivered once with unique public IDs`, async () => {
    const h = await harness('mirror', 1000);
    try {
      const r = await h.call(route, true);
      const calls = toolCallsOf(route, true, r.data);
      assert.equal(calls.length, 1, JSON.stringify(calls));
      assert.equal(route === 'responses' ? calls[0].name : calls[0].function.name, 'Bash');
    } finally { await h.close(); }
  });
  test(`${route} transfers a registered denied native tool to the client without server execution`, async () => {
    const h = await harness('native', 500);
    try {
      const r = await h.call(route, true);
      const calls = toolCallsOf(route, true, r.data);
      assert.equal(calls.length, 1, r.raw);
      const args = route === 'responses' ? calls[0].arguments : calls[0].function.arguments;
      assert.equal(JSON.parse(args).command, 'pwd');
      assert.ok(h.state.aborts.length);
      assert.equal(h.state.active.size, 0);
    } finally { await h.close(); }
  });
}

for (const route of ['chat', 'responses', 'messages']) test(`${route} client disconnect aborts the matching backend session`, async () => {
  const h = await harness('timeout', 1000);
  try {
    const controller = new AbortController();
    const promise = h.call(route, true, {}, controller.signal).catch(() => null);
    while (!h.state.prompts) await sleep(5);
    controller.abort(); await promise;
    await sleep(120);
    assert.ok(h.state.aborts.length);
    assert.equal(h.state.active.size, 0);
  } finally { await h.close(); }
});

test('Distinct explicit tool IDs with equal arguments are retained', async () => {
  const h = await harness('distinct', 1000);
  try {
    const r = await h.call('responses', true);
    const calls = r.data.filter(x => x.type === 'response.output_item.added' && x.item?.type === 'function_call').map(x => x.item);
    assert.equal(calls.length, 2, r.raw);
    assert.equal(new Set(calls.map(x => x.call_id)).size, 2);
  } finally { await h.close(); }
});

for (const mode of ['reason-only', 'disagree', 'snapshot-tools']) for (const route of ['chat', 'responses', 'messages']) for (const stream of [true, false]) {
  test(`${route} ${stream ? 'stream' : 'JSON'} reconciles ${mode} tool calls without replay`, async () => {
    const h = await harness(mode, 1000);
    try {
      const r = await h.call(route, stream);
      const calls = toolCallsOf(route, stream, r.data);
      assert.equal(calls.length, 1, r.raw);
      const args = route === 'responses' ? calls[0].arguments : calls[0].function.arguments;
      assert.equal(JSON.parse(args).command, mode === 'disagree' ? 'whoami' : 'pwd');
    } finally { await h.close(); }
  });
}

test('Unregistered server tools are never exposed as client tools', async () => {
  const h = await harness('native-unregistered', 120);
  try {
    const r = await h.call('responses', true);
    assert.equal(r.data.some(x => x.type === 'response.output_item.added' && x.item?.type === 'function_call'), false);
    assert.ok(r.data.some(x => x.type === 'response.failed'));
  } finally { await h.close(); }
});

for (const route of ['chat', 'responses', 'messages']) {
  test(`${route} recovers one invalid external call internally without an unbounded loop`, async () => {
    const h = await harness('invalid-then-valid', 1000);
    try {
      const r = await h.call(route, true);
      assert.equal(r.data.some(x => x.error || x.type === 'response.failed'), false, r.raw);
      assert.equal(h.state.prompts, 2);
      assert.ok(r.raw.includes('TEXT_OK'));
      assert.equal(h.state.active.size, 0);
    } finally { await h.close(); }
  });
}

test('Repeated invalid calls are bounded to one internal correction', async () => {
  const h = await harness('invalid-always', 1000);
  try {
    const r = await h.call('responses', true);
    assert.equal(h.state.prompts, 2);
    assert.ok(r.data.some(x => x.type === 'response.failed'));
    assert.equal(h.state.active.size, 0);
  } finally { await h.close(); }
});

test('Native parallel batch preserves all distinct calls before handing off', async () => {
  const h = await harness('native-batch', 1000);
  try {
    const r = await h.call('responses', true);
    const calls = r.data.filter(x => x.type === 'response.output_item.added' && x.item?.type === 'function_call').map(x => x.item);
    assert.deepEqual(calls.map(c => JSON.parse(c.arguments).command), ['pwd', 'whoami']);
  } finally { await h.close(); }
});

test('Four concurrent requests keep isolated completion state', async () => {
  const h = await harness('text', 1000);
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => h.call('responses', true)));
    assert.equal(h.state.prompts, 4);
    for (const r of results) assert.equal(r.data.filter(x => x.type === 'response.completed').length, 1);
  } finally { await h.close(); }
});

test('Responses text has completed status and created_at', async () => {
  const h = await harness('text', 1000);
  try {
    const r = await h.call('responses', false);
    assert.equal(r.status, 200); assert.equal(r.data.status, 'completed'); assert.equal(typeof r.data.created_at, 'number');
    assert.equal(r.data.output[0].content[0].text, 'TEXT_OK');
  } finally { await h.close(); }
});
