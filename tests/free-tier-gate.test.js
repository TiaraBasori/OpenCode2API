import {
    BACKEND_PROJECT_DIR,
    FREE_TIER_READ_GATE_PATH,
    buildBackendPermission,
} from '../src/backend/backend-permission.js';
import { isFreeTierSuspectModel, selectPromptToolOverrides } from '../src/proxy.js';

// Cross-module contract for the Zen free-tier `read` gate. Two independent
// mechanisms must agree:
//   1. selectPromptToolOverrides() drops every `false` entry for suspect
//      models and returns null when nothing stays true, so the prompt body
//      carries no `tools` map (any `false` entry -> 403 FreeTierError).
//   2. buildBackendPermission() leaves `read` visible via an ordered
//      { '*': deny, [NUL sentinel]: allow } gate whose selected (last) rule
//      is not `*`, while execution-time paths still hit the leading deny.
// If either half softens (`read: false` leaking into a free-tier prompt body,
// or the gate regressing to plain "deny"), Zen free tier breaks again.

const FREE_TIER_MODELS = [
    ['opencode', 'big-pickle'],
    ['opencode', 'union-alpha'],
    ['opencode', 'kimi-k2.5-free'],
];

const PAID_OR_OTHER_MODELS = [
    ['opencode', 'kimi-k2.5'],
    ['opencode', 'gpt-5'],
    ['anthropic', 'claude-sonnet-4-5'],
];

function expectDefaultReadGate(permission) {
    const gate = permission['read'];
    const entries = Object.entries(gate);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(['*', 'deny']);
    expect(entries[entries.length - 1]).toEqual([FREE_TIER_READ_GATE_PATH, 'allow']);
    expect(entries[entries.length - 1][0]).not.toBe('*');
}

describe('free-tier read gate cross-module contract', () => {
    test('all-false overrides vanish for free-tier models (no tools map)', () => {
        const allFalse = { bash: false, read: false };
        for (const [providerID, modelID] of FREE_TIER_MODELS) {
            expect(isFreeTierSuspectModel(providerID, modelID)).toBe(true);
            expect(selectPromptToolOverrides(allFalse, providerID, modelID)).toBeNull();
        }
    });

    test('mixed overrides keep only true entries for free-tier models', () => {
        const mixed = { bash: false, read: true };
        for (const [providerID, modelID] of FREE_TIER_MODELS) {
            const selected = selectPromptToolOverrides(mixed, providerID, modelID);
            expect(selected).toEqual({ read: true });
            expect(selected).not.toHaveProperty('read', false);
            expect(Object.values(selected).every((value) => value === true)).toBe(true);
        }
    });

    test('paid/other models preserve the override map verbatim, including read:false', () => {
        const allFalse = { bash: false, read: false };
        const mixed = { bash: false, read: true };
        for (const [providerID, modelID] of PAID_OR_OTHER_MODELS) {
            expect(isFreeTierSuspectModel(providerID, modelID)).toBe(false);
            expect(selectPromptToolOverrides(allFalse, providerID, modelID)).toBe(allFalse);
            expect(selectPromptToolOverrides(mixed, providerID, modelID)).toBe(mixed);
        }
    });

    test('default backend permission read gate keeps read visible without granting it', () => {
        const permission = buildBackendPermission();
        expectDefaultReadGate(permission);
        expect(permission['read']).not.toBe('deny');
        expect(permission['read']).not.toBe('allow');
        expect(permission['read']['*']).toBe('deny');
    });

    test('explicit read opt-in still yields a real allow (not the gate object)', () => {
        const permission = buildBackendPermission(['read']);
        expect(permission['read']).toBe('allow');
        expectDefaultReadGate(buildBackendPermission());
        expect(permission['external_directory']).toEqual({
            [`${BACKEND_PROJECT_DIR}/**`]: 'allow',
            '*': 'deny',
        });
    });

    test('NUL sentinel cannot be matched by representative real read paths', () => {
        expect(FREE_TIER_READ_GATE_PATH.endsWith('\u0000')).toBe(true);
        const candidates = [
            '/home/node/project/README.md',
            '/tmp/anything',
            '/__opencode_free_tier_gate_never__',
            '\\__opencode_free_tier_gate_never__',
        ];
        for (const candidate of candidates) {
            expect(candidate.endsWith('\u0000')).toBe(false);
            expect(candidate).not.toBe(FREE_TIER_READ_GATE_PATH);
            // OpenCode's Wildcard.match normalizes backslashes to slashes;
            // even then the sentinel's terminal NUL keeps it unmatched.
            expect(candidate.replaceAll('\\', '/')).not.toBe(FREE_TIER_READ_GATE_PATH);
        }
    });
});
