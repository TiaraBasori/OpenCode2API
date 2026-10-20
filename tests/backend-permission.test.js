import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    BACKEND_PROJECT_DIR,
    BACKEND_PERMISSION_TOOL_KEYS,
    FREE_TIER_READ_GATE_PATH,
    buildBackendPermission,
} from '../src/backend/backend-permission.js';

// Contract: the headless backend (opencode serve) must never `ask` (nobody
// can approve, so the prompt hangs until the proxy 180s timeout) and must
// not silently execute tools the proxy did not authorize (free-tier strip
// omits the tools map -> backend falls back to agent defaults = all on).
// Default posture is deny-all; only explicitly allowlisted internal tools
// are allowed. external_directory is always jailed to the backend project.
// `read` is special: when not explicitly allowed it emits an ordered gate
// object whose NUL-terminated sentinel allow keeps it visible upstream (Zen
// free tier needs read in tools[]) while every real path still hits the
// leading `*` deny.

const EXECUTION_KEYS = [
    'read',
    'edit',
    'glob',
    'grep',
    'list',
    'bash',
    'task',
    'todowrite',
    'question',
    'webfetch',
    'websearch',
    'lsp',
    'doom_loop',
    'skill',
];

const READ_GATE = { '*': 'deny', [FREE_TIER_READ_GATE_PATH]: 'allow' };

// Ordered rules matter: OpenCode's findLast-based filter must see the
// NUL-terminated non-wildcard sentinel allow last, or `read` is hidden from
// the upstream tools[] again. Every real path must still match only the `*`
// deny.
function expectReadGate(value) {
    expect(value).toEqual(READ_GATE);
    const entries = Object.entries(value);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(['*', 'deny']);
    expect(entries[entries.length - 1]).toEqual([FREE_TIER_READ_GATE_PATH, 'allow']);
    expect(entries[entries.length - 1][0]).not.toBe('*');
}

describe('backend permission contract', () => {
    test('project dir constant matches the container backend project', () => {
        expect(BACKEND_PROJECT_DIR).toBe('/home/node/project');
    });

    test('read gate sentinel is NUL-terminated, non-wildcard, and outside the project jail', () => {
        expect(FREE_TIER_READ_GATE_PATH.endsWith('\u0000')).toBe(true);
        expect(FREE_TIER_READ_GATE_PATH).not.toMatch(/[*?]/);
        expect(FREE_TIER_READ_GATE_PATH.startsWith(BACKEND_PROJECT_DIR)).toBe(false);
    });

    test('backslash normalization cannot reach the NUL-terminated sentinel', () => {
        const backslashCandidate = '\\__opencode_free_tier_gate_never__';
        expect(backslashCandidate.replaceAll('\\', '/')).not.toBe(FREE_TIER_READ_GATE_PATH);
    });

    test('tool keys are exactly the schema-valid opencode permission keys', () => {
        expect([...BACKEND_PERMISSION_TOOL_KEYS].sort()).toEqual(
            [...EXECUTION_KEYS, 'external_directory'].sort(),
        );
    });

    test('entrypoint.sh static fallback mirrors buildBackendPermission() with NUL sentinel order', () => {
        const entrypointPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'entrypoint.sh');
        const script = readFileSync(entrypointPath, 'utf8');
        const match = script.match(/^\s*BACKEND_PERM_JSON='([^']*)'\s*$/m);
        expect(match).not.toBeNull();
        const fallback = JSON.parse(match[1]);
        expect(fallback).toEqual(buildBackendPermission());
        expectReadGate(fallback['read']);
    });

    test('default denies every execution tool and jails the filesystem', () => {
        const perm = buildBackendPermission();
        for (const key of EXECUTION_KEYS) {
            if (key === 'read') continue;
            expect(perm[key]).toBe('deny');
        }
        expectReadGate(perm['read']);
        expect(perm['external_directory']).toEqual({
            [`${BACKEND_PROJECT_DIR}/**`]: 'allow',
            '*': 'deny',
        });
        expect(Object.values(perm)).not.toContain('ask');
    });

    test('default read value is an ordered free-tier gate, not deny or allow', () => {
        const gate = buildBackendPermission()['read'];
        expectReadGate(gate);
        expect(gate).not.toBe('deny');
        expect(gate).not.toBe('allow');
    });

    test('explicit allowlist allows only the listed tools', () => {
        const perm = buildBackendPermission(['websearch']);
        expect(perm['websearch']).toBe('allow');
        expect(perm['webfetch']).toBe('deny');
        expect(perm['bash']).toBe('deny');
        expectReadGate(perm['read']);
    });

    test('explicit opt-in to execution tools is preserved', () => {
        const perm = buildBackendPermission(['bash', 'read']);
        expect(perm['bash']).toBe('allow');
        expect(perm['read']).toBe('allow');
        expect(perm['edit']).toBe('deny');
    });

    test('explicit read allowlist keeps a real allow (no gate object)', () => {
        const perm = buildBackendPermission(['read']);
        expect(perm['read']).toBe('allow');
        expect(perm['read']).not.toEqual(READ_GATE);
    });

    test('case and whitespace normalization still yields an explicit read allow', () => {
        expect(buildBackendPermission([' READ '])['read']).toBe('allow');
    });

    test('alias and case variants match the schema key (web_fetch -> webfetch)', () => {
        expect(buildBackendPermission(['web_fetch'])['webfetch']).toBe('allow');
        expect(buildBackendPermission(['WebSearch'])['websearch']).toBe('allow');
        expect(buildBackendPermission(['WEB-FETCH'])['webfetch']).toBe('allow');
    });

    test('webFetchEnabled shortcut allows webfetch when no explicit list', () => {
        const perm = buildBackendPermission([], true);
        expect(perm['webfetch']).toBe('allow');
        expect(perm['websearch']).toBe('deny');
    });

    test('explicit list wins over the webfetch shortcut', () => {
        const perm = buildBackendPermission(['read'], true);
        expect(perm['read']).toBe('allow');
        expect(perm['webfetch']).toBe('deny');
    });

    test('unknown names are ignored and never emitted (schema-safe)', () => {
        const perm = buildBackendPermission(['nonexistent_xyz', '', '  ', 123, null]);
        expect(perm['nonexistent_xyz']).toBeUndefined();
        for (const key of EXECUTION_KEYS) {
            if (key === 'read') continue;
            expect(perm[key]).toBe('deny');
        }
        expectReadGate(perm['read']);
        expect(Object.keys(perm).sort()).toEqual([...BACKEND_PERMISSION_TOOL_KEYS].sort());
    });

    test('garbage inputs fall back to deny-all execution', () => {
        for (const bad of [null, undefined, 'bash', 42, { bash: true }]) {
            const perm = buildBackendPermission(bad);
            for (const key of EXECUTION_KEYS) {
                if (key === 'read') continue;
                expect(perm[key]).toBe('deny');
            }
            expectReadGate(perm['read']);
        }
    });

    test('empty and garbage allowlists still emit the read gate', () => {
        const inputs = [[], null, undefined, 'bash', 42, { bash: true }, ['nonexistent_xyz', '', '  ', 123, null]];
        for (const input of inputs) {
            expectReadGate(buildBackendPermission(input)['read']);
        }
    });

    test('external_directory stays jailed even when read is allowed', () => {
        const perm = buildBackendPermission(['read']);
        expect(perm['read']).toBe('allow');
        expect(perm['external_directory']).toEqual({
            [`${BACKEND_PROJECT_DIR}/**`]: 'allow',
            '*': 'deny',
        });
    });

    test('flat-action keys are strings, never objects', () => {
        const perm = buildBackendPermission(['websearch', 'question']);
        for (const key of ['todowrite', 'question', 'webfetch', 'websearch', 'doom_loop']) {
            expect(typeof perm[key]).toBe('string');
        }
        expect(perm['websearch']).toBe('allow');
        expect(perm['question']).toBe('allow');
    });

    test('custom projectDir scopes the jail (isolated-home workspaces)', () => {
        const perm = buildBackendPermission([], false, '/tmp/jail-xyz/empty-workspace');
        expect(perm['external_directory']).toEqual({
            '/tmp/jail-xyz/empty-workspace/**': 'allow',
            '*': 'deny',
        });
        expectReadGate(perm['read']);
        expect(perm['bash']).toBe('deny');
        expect(perm['websearch']).toBe('deny');
    });

    test('custom projectDir only rescopes external_directory, keeping the read gate', () => {
        const perm = buildBackendPermission([], false, '/tmp/jail-gate-check');
        expectReadGate(perm['read']);
        expect(perm['external_directory']).toEqual({
            '/tmp/jail-gate-check/**': 'allow',
            '*': 'deny',
        });
    });

    test('garbage projectDir falls back to the container default', () => {
        for (const bad of [null, undefined, '', '  ', 42]) {
            const perm = buildBackendPermission([], false, bad);
            expect(perm['external_directory']).toEqual({
                [`${BACKEND_PROJECT_DIR}/**`]: 'allow',
                '*': 'deny',
            });
            expectReadGate(perm['read']);
        }
    });

    test('permission values never contain ask', () => {
        const variants = [
            buildBackendPermission(),
            buildBackendPermission(['read', 'bash', 'websearch']),
            buildBackendPermission([], true, '/tmp/jail-ask-check'),
        ];
        for (const perm of variants) {
            expect(Object.values(perm)).not.toContain('ask');
            for (const value of Object.values(perm)) {
                if (value && typeof value === 'object') {
                    expect(Object.values(value)).not.toContain('ask');
                }
            }
        }
    });
});
