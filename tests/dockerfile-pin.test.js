import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract: lock the runtime image's OpenCode backend pin and the proxy-side
// expectations around it. These tests cannot execute the installed backend, so
// a version bump still requires an upstream/real-backend check: the target
// version's Permission.disabled() must keep the findLast semantics (select the
// last rule by tool name, then check that rule's pattern is `*`), and `read`
// must stay in the upstream tools[] for a real Zen request.
//
// Bumping the pin requires updating PINNED_VERSION and re-running
// tests/free-tier-gate.test.js, tests/backend-permission.test.js, and this file.

const PINNED_VERSION = '1.18.35';

const dockerfilePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'Dockerfile');
const dockerfile = readFileSync(dockerfilePath, 'utf8');

describe('Dockerfile OpenCode backend pin', () => {
    test(`declares ARG OPENCODE_VERSION=${PINNED_VERSION}`, () => {
        const match = dockerfile.match(/^\s*ARG\s+OPENCODE_VERSION=(.+?)\s*$/m);
        expect(match).not.toBeNull();
        expect(match[1]).toBe(PINNED_VERSION);
    });

    test('declares a build-arg-pinned install', () => {
        const installLines = dockerfile
            .split(/\r?\n/)
            .filter(
                (line) =>
                    /\bnpm\s+(?:install|i)\s+(?:-g|--global)\b/.test(line) &&
                    line.includes('opencode-ai'),
            );
        expect(installLines).toHaveLength(1);
        const [installLine] = installLines;
        expect(installLine).toContain('opencode-ai@${OPENCODE_VERSION}');
        expect(installLine).toMatch(
            /\btest\s+-n\s+"\$\{OPENCODE_VERSION\}"\s+&&\s+npm\s+(?:install|i)\s+(?:-g|--global)\b/,
        );
        expect(dockerfile).not.toMatch(/opencode-ai@(?!\$\{OPENCODE_VERSION\})[\w.-]+/);

        const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
        const argIdx = runtime.search(/^\s*ARG\s+OPENCODE_VERSION=/m);
        const runIdx = runtime.search(
            /^\s*RUN\s+test\s+-n\s+"\$\{OPENCODE_VERSION\}"\s+&&\s+npm\s+install\b/m,
        );
        expect(argIdx).toBeGreaterThan(-1);
        expect(runIdx).toBeGreaterThan(argIdx);
        expect(dockerfile.match(/^\s*ARG\s+OPENCODE_VERSION=/gm)).toHaveLength(1);
    });

    test('does not persist the pin as a runtime ENV', () => {
        expect(dockerfile).not.toMatch(/^\s*ENV\s+OPENCODE_VERSION=/m);
    });
});
