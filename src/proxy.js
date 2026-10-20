import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { createOpencodeClient } from '@opencode-ai/sdk';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { EXTERNAL_TOOL_PREFIX } from './tool-runtime/contracts.js';
import { buildExternalToolRegistry, findExternalToolByName } from './tool-runtime/registry.js';
import { buildToolExposure } from './tool-runtime/router.js';
import { validateToolCalls } from './tool-runtime/validator.js';
import { PANEL_CSP, PANEL_HTML } from './panel-page.js';
import { createUsageStore, defaultUsageFilePath } from './usage-persistence.js';
import {
    stripFunctionCallMarkup,
    parseExternalToolCallsFromText,
    createToolCallFilter,
    createExternalToolCallStreamParser
} from './tool-runtime/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Detect transient upstream provider failures that succeed on retry.
 *
 * The upstream (OpenCode Zen) occasionally mislabels throttling as billing
 * errors: a worker hits its request limit and returns
 * `401: {"message":"Insufficient balance...","type":"CreditsError"}` even
 * though the account is fine — the very next attempt succeeds. These errors
 * are surfaced to clients as bogus "insufficient balance" failures (issue #5).
 * Match them (plus generic rate-limit/5xx signatures) so the proxy can retry
 * with backoff before giving up.
 * @param {Error|object|null} error - Assistant message error or thrown error
 * @returns {boolean} true when the error looks transient
 */
function isTransientUpstreamError(error) {
    if (!error) return false;
    const message = [error.message, error.data?.message]
        .filter((part) => typeof part === 'string')
        .join(' ');
    if (!message) return false;

    const transientSignatures = [
        /insufficient balance/i,
        /credits?error/i,
        /rate.?limit/i,
        /too many requests/i,
        /worker request limit/i,
        /overloaded/i,
        /temporarily unavailable/i,
        /internal server error/i,
        /bad gateway/i,
        /service unavailable/i,
        /stream error/i
    ];
    if (transientSignatures.some((re) => re.test(message))) return true;

    // Upstream errors arrive as "<status>: {json}" strings; SDK errors may also
    // carry a numeric status on the object itself.
    const statusMatch = message.match(/\b(\d{3}):/);
    const status = statusMatch
        ? Number(statusMatch[1])
        : (error.statusCode || error.data?.status || null);
    if (typeof status === 'number') {
        if (status === 401 || status === 402 || status === 429) return true;
        if (status >= 500) return true;
    }
    return false;
}

/**
 * Transform upstream provider errors to OpenAI-compatible format
 * @param {Error} error - The error from the upstream provider
 * @returns {{statusCode: number, error: {message: string, type: string, code?: string}}} OpenAI-compatible error response
 */
function transformUpstreamError(error) {
    // Default fallback
    let statusCode = 500;
    let message = error.message || 'Internal server error';
    let type = 'internal_error';
    let code = error.code || error.constructor.name;

    // Handle timeout errors
    if (error.message && error.message.includes('Request timeout')) {
        statusCode = 504;
        type = 'timeout';
        code = 'timeout';
        message = 'Request timeout';
    }
    // Handle file access errors (Windows compatibility)
    else if (error.message && error.message.includes('ENOENT')) {
        statusCode = 500;
        type = 'internal_error';
        code = 'file_access_error';
        message = 'OpenCode backend file access error. This may be a Windows compatibility issue. Please try restarting the service.';
    }
    // Handle upstream provider errors (from OpenCode SDK)
    else if (error.statusCode) {
        statusCode = error.statusCode;
        
        // Map upstream error types to OpenAI-compatible types
        const upstreamType = error.code || error.type || '';
        const upstreamMessage = error.message || '';
        
        // Billing/credit errors - map to 402 Payment Required
        if (upstreamType === 'CreditsError' || 
            upstreamType === 'InsufficientBalanceError' ||
            upstreamMessage.toLowerCase().includes('insufficient balance') ||
            upstreamMessage.toLowerCase().includes('insufficient credits') ||
            upstreamMessage.toLowerCase().includes('billing') ||
            upstreamMessage.toLowerCase().includes('quota exceeded') ||
            upstreamMessage.toLowerCase().includes('credit limit')) {
            statusCode = 402;
            type = 'insufficient_quota';
            code = 'insufficient_quota';
            message = upstreamMessage || 'Insufficient balance or quota exceeded';
        }
        // Rate limit errors - map to 429
        else if (upstreamType === 'RateLimitError' ||
                 upstreamType === 'TooManyRequestsError' ||
                 statusCode === 429 ||
                 upstreamMessage.toLowerCase().includes('rate limit') ||
                 upstreamMessage.toLowerCase().includes('too many requests')) {
            statusCode = 429;
            type = 'rate_limit_exceeded';
            code = 'rate_limit_exceeded';
            message = upstreamMessage || 'Rate limit exceeded';
        }
        // Authentication errors - keep as 401
        else if (upstreamType === 'AuthenticationError' ||
                 upstreamType === 'InvalidAPIKeyError' ||
                 statusCode === 401 ||
                 upstreamMessage.toLowerCase().includes('invalid api key') ||
                 upstreamMessage.toLowerCase().includes('unauthorized') ||
                 upstreamMessage.toLowerCase().includes('authentication')) {
            statusCode = 401;
            type = 'invalid_api_key';
            code = 'invalid_api_key';
            message = upstreamMessage || 'Invalid API key';
        }
        // Permission errors - map to 403
        else if (upstreamType === 'PermissionError' ||
                 statusCode === 403 ||
                 upstreamMessage.toLowerCase().includes('permission denied') ||
                 upstreamMessage.toLowerCase().includes('access denied')) {
            statusCode = 403;
            type = 'permission_denied';
            code = 'permission_denied';
            message = upstreamMessage || 'Permission denied';
        }
        // Model not found - map to 404
        else if (upstreamType === 'NotFoundError' ||
                 statusCode === 404 ||
                 upstreamMessage.toLowerCase().includes('model not found') ||
                 upstreamMessage.toLowerCase().includes('does not exist')) {
            statusCode = 404;
            type = 'model_not_found';
            code = 'model_not_found';
            message = upstreamMessage || 'Model not found';
        }
        // Bad request - map to 400
        else if (statusCode === 400 || upstreamType === 'BadRequestError') {
            statusCode = 400;
            type = 'invalid_request_error';
            code = 'invalid_request_error';
            message = upstreamMessage || 'Invalid request';
        }
        // Server errors from upstream - map to 502/503
        else if (statusCode >= 500) {
            statusCode = 502;
            type = 'server_error';
            code = 'server_error';
            message = upstreamMessage || 'Upstream provider error';
        }
        // Default: pass through with mapped type
        else {
            type = upstreamType.toLowerCase().replace(/error$/, '_error') || 'upstream_error';
            code = upstreamType;
            message = upstreamMessage;
        }
    }

    return {
        statusCode,
        error: {
            message,
            type,
            ...(code && { code }),
            ...(error.availableModels && { available_models: error.availableModels })
        }
    };
}

// --- Multi-user API keys -----------------------------------------------------
//
// API_KEYS is an optional, additional way to authenticate: every entry is a
// named user key, while the legacy single API_KEY keeps working (it doubles as
// the admin key for /admin/keys). A request matching any API_KEYS entry is
// tagged with that key's name and metered per name; unlisted requests fall
// back to the API_KEY path so existing single-key deployments are unchanged.

// req.apiKeyName for requests authenticated with the legacy API_KEY (as opposed
// to a named API_KEYS entry). Deliberately not a valid usage-entry name.
const MASTER_KEY_NAME = '__api_key__';

// Prefix for API_KEYS entries configured without an explicit name ("key-N",
// where N is the entry's 1-based position in the list).
const DEFAULT_KEY_NAME_PREFIX = 'key';

/**
 * Normalize a configured key name: trim and drop control characters. Returns
 * the provided fallback when nothing usable remains.
 * @param {*} name - Raw name value (usually string)
 * @param {string} fallback - Default name (e.g. `key-2`)
 * @returns {string}
 */
function normalizeApiKeyName(name, fallback) {
    const cleaned = String(name ?? '')
        .trim()
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, '');
    return cleaned || fallback;
}

// Names must survive the admin REST surface: DELETE /admin/keys/:name routes on
// the raw name, so path separators can never be addressed, and `%` breaks
// param decoding for clients that forget to encode. Length is capped to keep
// admin tables and metrics sane; `__api_key__` is reserved for the legacy
// master-key pseudo-entry. Throws with a clear message on violation.
const API_KEY_NAME_MAX_LENGTH = 64;

function validateApiKeyName(name) {
    if (name === MASTER_KEY_NAME) {
        throw new Error(`[Config] API_KEYS name "${MASTER_KEY_NAME}" is reserved`);
    }
    if (name.length > API_KEY_NAME_MAX_LENGTH) {
        throw new Error(`[Config] API_KEYS name "${name.slice(0, 24)}…" exceeds ${API_KEY_NAME_MAX_LENGTH} characters`);
    }
    if (/[/%?#\\]/.test(name)) {
        throw new Error(`[Config] API_KEYS name "${name}" must not contain "/", "\\", "%" or URL-significant characters`);
    }
}

/**
 * Parse the optional multi-user API_KEYS configuration.
 *
 * Accepted shapes:
 *  - `[{ name: 'alice', key: 'sk-...' }, ...]` (config.json array; `name` optional)
 *  - `['alice:sk-...', 'sk-bare', ...]`        (string array; `name:key` or bare key)
 *  - `'alice:sk-...,bob:sk-...,sk-bare'`       (env-friendly comma-separated string,
 *                                              used by `OPENCODE_API_KEYS`)
 *
 * `name:key` entries split on the FIRST `:` or `=`. Entries without a separator
 * are bare keys and get the default name `key-N` (N = 1-based position in the
 * final list). Throws on malformed entries, duplicate keys, and duplicate
 * names, so a bad configuration fails at startup instead of per request.
 *
 * @param {Array|string|undefined|null} value - API_KEYS config value
 * @returns {Array<{name: string, key: string}>} normalized entries in config order
 */
export function parseApiKeysConfig(value) {
    if (value === undefined || value === null || value === '') return [];

    let rawEntries;
    if (Array.isArray(value)) {
        rawEntries = value;
    } else if (typeof value === 'string') {
        rawEntries = value.split(',');
    } else {
        throw new Error('[Config] API_KEYS must be an array of {name, key} or a comma-separated "name:key" string');
    }

    const parsed = [];
    const seenKeys = new Set();
    const seenNames = new Set();
    rawEntries.forEach((raw, index) => {
        let name = '';
        let key = '';
        if (typeof raw === 'string') {
            const trimmed = raw.trim();
            if (!trimmed) return; // tolerate empty segments / trailing commas
            const separator = trimmed.match(/^([^:=]+)([:=])(.*)$/);
            if (separator) {
                name = separator[1].trim();
                key = separator[3].trim();
                if (!key) {
                    throw new Error(`[Config] API_KEYS entry #${index + 1} ("${trimmed}") has a name but no key after the separator`);
                }
            } else {
                key = trimmed;
            }
        } else if (raw && typeof raw === 'object') {
            name = typeof raw.name === 'string' ? raw.name.trim() : '';
            key = typeof raw.key === 'string' ? raw.key.trim() : '';
        } else {
            throw new Error(`[Config] API_KEYS entry #${index + 1} is invalid: expected "name:key" or {name, key}`);
        }
        if (!key) {
            throw new Error(`[Config] API_KEYS entry #${index + 1} is missing a key`);
        }
        name = normalizeApiKeyName(name, `${DEFAULT_KEY_NAME_PREFIX}-${index + 1}`);
        validateApiKeyName(name);
        if (seenKeys.has(key)) {
            throw new Error(`[Config] API_KEYS contains a duplicate key for "${name}"; every key value must be unique`);
        }
        if (seenNames.has(name)) {
            throw new Error(`[Config] API_KEYS contains a duplicate name "${name}"; every key name must be unique`);
        }
        seenKeys.add(key);
        seenNames.add(name);
        parsed.push({ name, key });
    });
    return parsed;
}

/**
 * Constant-time string comparison so key checks do not leak timing detail.
 * Lengths are compared via a hashed fallback to keep timing flat, then the
 * mismatch fails the check.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeTokenEquals(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
        const hashA = crypto.createHash('sha256').update(bufA).digest();
        const hashB = crypto.createHash('sha256').update(bufB).digest();
        crypto.timingSafeEqual(hashA, hashB);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Last-4 hint for admin listings. Keys of 4 characters or fewer (test stubs)
 * are shown in full; real keys only ever reveal the suffix.
 * @param {string} key
 * @returns {string}
 */
export function keyHintFor(key) {
    const value = String(key || '');
    if (value.length <= 4) return value;
    return `…${value.slice(-4)}`;
}

/**
 * Escape a Prometheus label value (backslashes and double quotes).
 * @param {*} value
 * @returns {string}
 */
function escapePrometheusLabel(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Create a per-key usage registry. Entries exist eagerly for configured keys
 * (visible with zeroed counters before first use) and lazily for keys added at
 * runtime.
 *
 * Counters live in memory; an optional `store` (see usage-persistence.js)
 * lifts them across restarts by restoring them here and writing snapshots on
 * demand. Without a store the registry is process-lifetime only.
 *
 * @param {Array<{name: string}>} [entries] - initially configured key names
 * @param {object} [options]
 * @param {{read: Function, register: Function}} [options.store] - snapshot store
 * @returns {object} registry with trackRequest/trackUsage/entry/snapshot/...
 */
export function createKeyUsageRegistry(entries = [], { store = null } = {}) {
    const zeroUsage = (createdAt) => ({
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        lastUsedAt: null,
        createdAt
    });
    const map = new Map();
    const ensureEntry = (name) => {
        let entry = map.get(name);
        if (!entry) {
            entry = zeroUsage(Date.now());
            map.set(name, entry);
        }
        return entry;
    };

    // Restore before configured keys are seeded so a restart continues the
    // counters instead of zeroing them. A row whose key is no longer
    // configured is kept rather than dropped: an operator may be mid-rename,
    // and an admin can still see and delete it.
    if (store && typeof store.read === 'function') {
        const restored = store.read() || {};
        for (const [name, row] of Object.entries(restored)) {
            if (row && typeof row === 'object') {
                map.set(name, { ...zeroUsage(row.createdAt || Date.now()), ...row });
            }
        }
    }
    (Array.isArray(entries) ? entries : []).forEach(({ name }) => ensureEntry(name));

    const copyEntry = (entry) => ({
        requests: entry.requests,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        totalTokens: entry.totalTokens,
        lastUsedAt: entry.lastUsedAt,
        createdAt: entry.createdAt
    });

    const registry = {
        /** True when the name has a usage entry. */
        has: (name) => map.has(name),
        /** Ensure an entry exists (keys added at runtime via the admin API). */
        register: (name) => { ensureEntry(name); },
        /**
         * Count one request against a key. Falsy/unknown names (no auth
         * configured, legacy API_KEY, deleted key) are ignored.
         * @param {string|undefined} name
         */
        trackRequest(name) {
            if (!name) return;
            if (!map.has(name)) ensureEntry(name);
            const entry = map.get(name);
            entry.requests += 1;
            entry.lastUsedAt = Date.now();
        },
        /**
         * Add token usage for one successful business request. The completion
         * figure mirrors what the API response reports (reasoning included).
         * @param {string|undefined} name
         * @param {{promptTokens?: number, completionTokens?: number}} usage
         */
        trackUsage(name, { promptTokens = 0, completionTokens = 0 } = {}) {
            if (!name) return;
            if (!map.has(name)) ensureEntry(name);
            const entry = map.get(name);
            const prompt = Number(promptTokens) || 0;
            const completion = Number(completionTokens) || 0;
            entry.promptTokens += prompt;
            entry.completionTokens += completion;
            entry.totalTokens += prompt + completion;
        },
        /** Remove a key's accounting (admin delete). */
        delete(name) { map.delete(name); },
        /**
         * Usage snapshot for one key; zeroed counters for unknown names.
         * @param {string} name
         */
        entry(name) {
            return copyEntry(map.get(name) || zeroUsage(0));
        },
        /**
         * Aggregate snapshot: `{ byKey: { "<name>": {...} }, total: {...} }`.
         * Keys appear in configuration/insertion order.
         */
        snapshot() {
            const byKey = {};
            const total = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            for (const [name, entry] of map) {
                byKey[name] = copyEntry(entry);
                total.requests += entry.requests;
                total.promptTokens += entry.promptTokens;
                total.completionTokens += entry.completionTokens;
                total.totalTokens += entry.totalTokens;
            }
            return { byKey, total };
        }
    };

    if (store && typeof store.register === 'function') store.register(registry);
    return registry;
}

/**
 * Map the backend's own token counts (`info.tokens`) onto the proxy's usage
 * shape, or null when the backend did not report any. Cached prompt tokens are
 * included in the prompt count: providers bill them, and the OpenAI response
 * shape reports prompt tokens the same way. Reasoning is reported separately
 * and is also part of the billed completion figure.
 */
function usageFromInfo(info) {
    if (!info || !info.tokens) return null;
    const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    return {
        promptTokens: count(info.tokens.input) + count(info.tokens.cache?.read) + count(info.tokens.cache?.write),
        completionTokens: count(info.tokens.output),
        reasoningTokens: count(info.tokens.reasoning)
    };
}

// --- Mutex Logic with Timeout ---
async function getImageDataUri(url) {
    if (url.startsWith('data:')) {
        return url;
    }
    
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(`Invalid URL scheme: ${url}`);
    }
    
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        
        const req = protocol.get(url, { timeout: 10000 }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to fetch image: HTTP ${res.statusCode}`));
            }
            
            const contentType = res.headers['content-type'] || 'image/jpeg';
            const chunks = [];
            
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    const base64 = buffer.toString('base64');
                    resolve(`data:${contentType};base64,${base64}`);
                } catch (e) {
                    reject(new Error(`Failed to encode image: ${e.message}`));
                }
            });
        });
        
        req.on('error', (e) => reject(e));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Image fetch timeout'));
        });
    });
}

// --- Mutex Logic with Timeout ---
const queue = [];
let isProcessing = false;

const STARTUP_WAIT_ITERATIONS = 60;
const STARTUP_WAIT_INTERVAL_MS = 2000;
const STARTING_WAIT_ITERATIONS = 120;
const STARTING_WAIT_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
const DEFAULT_POLL_INTERVAL_MS = 500;
// Backoff base for transient upstream error retries (issue #5): 800ms, 1600ms.
const RETRY_BACKOFF_BASE_MS = 800;
const RETRY_MAX_ATTEMPTS = 3;
// Reasoning models can take well over 10s before emitting their first token.
// A short window here makes the event stream give up and fall back to polling on
// every request, which loses true streaming. Configurable for slow backends.
const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS = Number(process.env.OPENCODE2API_EVENT_FIRST_DELTA_TIMEOUT_MS) || 30000;
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = Number(process.env.OPENCODE2API_EVENT_IDLE_TIMEOUT_MS) || 8000;
// How often the per-key usage snapshot is rewritten while the proxy runs.
const DEFAULT_USAGE_SAVE_INTERVAL_MS = 5 * 60 * 1000;

const OPENCODE_BASENAME = 'opencode';

// Backend plugin that enforces the proxy's tool policy (see plugin/ for details).
const TOOL_LOCK_PLUGIN_FILE = 'opencode2api-tool-lock.js';
const TOOL_LOCK_PLUGIN_PATH = path.join(__dirname, '..', 'plugin', TOOL_LOCK_PLUGIN_FILE);

// Lowercase and drop separators so `web_fetch`, `WebFetch` and `webfetch` match.
function normalizeToolName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9./]/g, '');
}

function splitPathEnv() {
    const raw = process.env.PATH || '';
    return raw.split(path.delimiter).filter(Boolean);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushDir(list, dir) {
    if (!dir) return;
    if (!list.includes(dir)) list.push(dir);
}

function pushExistingDir(list, dir) {
    if (!dir) return;
    if (!fs.existsSync(dir)) return;
    if (!list.includes(dir)) list.push(dir);
}

function addVersionedDirs(list, baseDir, subpath) {
    if (!baseDir || !fs.existsSync(baseDir)) return;
    let entries = [];
    try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (e) {
        return;
    }
    entries.forEach((entry) => {
        if (!entry.isDirectory()) return;
        const full = path.join(baseDir, entry.name, subpath || '');
        pushExistingDir(list, full);
    });
}

function prefixToBin(prefix) {
    if (!prefix) return null;
    return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

function getOpencodeCandidateNames() {
    if (process.platform === 'win32') {
        return [`${OPENCODE_BASENAME}.cmd`, `${OPENCODE_BASENAME}.exe`, `${OPENCODE_BASENAME}.bat`, OPENCODE_BASENAME];
    }
    return [OPENCODE_BASENAME];
}

function findExecutableInDirs(dirs, names) {
    for (const dir of dirs) {
        for (const name of names) {
            const full = path.join(dir, name);
            if (fs.existsSync(full)) {
                return full;
            }
        }
    }
    return null;
}

function resolveOpencodePath(requestedPath) {
    const input = (requestedPath || '').trim();
    const names = getOpencodeCandidateNames();

    if (input) {
        const looksLikePath = path.isAbsolute(input) || input.includes('/') || input.includes('\\');
        if (looksLikePath) {
            if (fs.existsSync(input)) return { path: input, source: 'config' };
            const resolved = path.resolve(process.cwd(), input);
            if (fs.existsSync(resolved)) return { path: resolved, source: 'config' };
        }
    }

    const pathDirs = splitPathEnv();
    const fromPath = findExecutableInDirs(pathDirs, names);
    if (fromPath) return { path: fromPath, source: 'PATH' };

    const extraDirs = [];
    if (process.env.OPENCODE_HOME) {
        pushDir(extraDirs, path.join(process.env.OPENCODE_HOME, 'bin'));
    }
    if (process.env.OPENCODE_DIR) {
        pushDir(extraDirs, path.join(process.env.OPENCODE_DIR, 'bin'));
    }
    pushDir(extraDirs, prefixToBin(process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX));
    pushDir(extraDirs, process.env.PNPM_HOME);
    if (process.env.YARN_GLOBAL_FOLDER) {
        pushDir(extraDirs, path.join(process.env.YARN_GLOBAL_FOLDER, 'bin'));
    }
    if (process.env.VOLTA_HOME) {
        pushDir(extraDirs, path.join(process.env.VOLTA_HOME, 'bin'));
    }
    pushDir(extraDirs, process.env.NVM_BIN);
    pushDir(extraDirs, path.dirname(process.execPath));

    const home = os.homedir();
    if (home) {
        pushDir(extraDirs, path.join(home, '.opencode', 'bin'));
        pushDir(extraDirs, path.join(home, '.local', 'bin'));
        pushDir(extraDirs, path.join(home, '.npm-global', 'bin'));
        pushDir(extraDirs, path.join(home, '.npm', 'bin'));
        pushDir(extraDirs, path.join(home, '.pnpm-global', 'bin'));
        pushDir(extraDirs, path.join(home, '.local', 'share', 'pnpm'));
        pushDir(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1', 'installations'));
        pushDir(extraDirs, path.join(home, '.asdf', 'shims'));
    }

    if (process.platform === 'win32') {
        pushDir(extraDirs, process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null);
        pushDir(extraDirs, process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm') : null);
        pushDir(extraDirs, process.env.NVM_HOME);
        pushDir(extraDirs, process.env.NVM_SYMLINK);
        pushDir(extraDirs, process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs') : null);
        pushDir(extraDirs, process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs') : null);
    } else {
        pushDir(extraDirs, '/usr/local/bin');
        pushDir(extraDirs, '/usr/bin');
        pushDir(extraDirs, '/bin');
        pushDir(extraDirs, '/opt/homebrew/bin');
        pushDir(extraDirs, '/snap/bin');
    }

    // nvm (unix) versions
    const nvmDir = process.env.NVM_DIR || (home ? path.join(home, '.nvm') : null);
    if (nvmDir) {
        addVersionedDirs(extraDirs, path.join(nvmDir, 'versions', 'node'), 'bin');
    }

    // asdf nodejs installs
    const asdfDir = process.env.ASDF_DATA_DIR || (home ? path.join(home, '.asdf') : null);
    if (asdfDir) {
        addVersionedDirs(extraDirs, path.join(asdfDir, 'installs', 'nodejs'), 'bin');
    }

    // fnm installs
    if (home) {
        addVersionedDirs(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1'), 'installation' + path.sep + 'bin');
    }

    const fromExtras = findExecutableInDirs(extraDirs, names);
    if (fromExtras) return { path: fromExtras, source: 'known-locations' };

    return { path: null, source: 'not-found' };
}

function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;
    const { task, timeout, resolve, reject } = queue.shift();
    let settled = false;
    const timeoutMs = timeout || 120000;
    const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve()
        .then(() => task())
        .then((result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve(result);
        })
        .catch((err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            reject(err);
        })
        .finally(() => {
            isProcessing = false;
            if (queue.length > 0) {
                queueMicrotask(processQueue);
            }
        });
}

function lock(task, timeout = 120000) {
    return new Promise((resolve, reject) => {
        queue.push({ task, timeout, resolve, reject });
        processQueue();
    });
}

/**
 * Robust Health Check Helper
 */
function buildBackendAuthHeaders(password = '') {
    if (!password) return undefined;
    const token = Buffer.from(`opencode:${password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
}

// `/global/health` is OpenCode's real health endpoint. `/health` is not an API
// route: it falls through to the web UI handler, which may proxy to
// app.opencode.ai and answers 200 even when the API is not usable.
export function checkHealth(serverUrl, password = '') {
    return new Promise((resolve, reject) => {
        const headers = buildBackendAuthHeaders(password);
        const options = headers ? { headers } : undefined;
        const req = http.get(`${serverUrl}/global/health`, options, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Status ${res.statusCode}`));
                return;
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    const payload = JSON.parse(body);
                    if (payload?.healthy !== true) {
                        reject(new Error('Backend reported unhealthy'));
                        return;
                    }
                    // OpenCode 2.x moved the server API under /api/* and dropped
                    // the 1.x routes (@opencode-ai/sdk 1.x calls /config/providers,
                    // /session, ...). A 2.x backend boots fine, so every proxy
                    // request would instead fail with empty model lists and 404s.
                    // Refuse it up front with an actionable message.
                    const major = Number(String(payload?.version || '').split('.')[0]);
                    if (major >= 2) {
                        reject(new Error(
                            `OpenCode backend ${payload.version} is not compatible: opencode2api uses the 1.x server API. ` +
                            'Install a 1.x backend, e.g. `npm install -g opencode-ai@1.19.0` (newest compatible), ' +
                            'or point OPENCODE_PATH at a 1.x binary.'
                        ));
                        return;
                    }
                    resolve(true);
                } catch (e) {
                    reject(new Error('Unexpected health response'));
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

/**
 * Cleanup temporary directories
 */
function cleanupTempDirs() {
    // Only cleanup jail directories on non-Windows platforms
    // On Windows, we don't use isolated jail to avoid path issues
    if (process.platform === 'win32') return;

    const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail');
    try {
        if (fs.existsSync(jailRoot)) {
            fs.rmSync(jailRoot, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('[Cleanup] Failed to remove temp dirs:', e.message);
    }
}

// Register cleanup on exit
process.on('exit', cleanupTempDirs);

// Temp-dir cleanup is registered as an `exit` handler only. Do NOT add SIGINT /
// SIGTERM handlers here: this module is imported by the entry point, which owns
// the shutdown sequence (flush the usage snapshot, close the server, kill the
// backend). A handler here would race that one and exit(0) first — the entry
// point's async flush would never get to run.
// Note: Windows signal handling is limited, cleanup is handled via process.on('exit')

/**
 * Create Express app with proper configuration
 */
export function createApp(config) {
    const {
        API_KEY,
        API_KEYS,
        OPENCODE_SERVER_URL,
        OPENCODE_SERVER_PASSWORD,
        REQUEST_TIMEOUT_MS,
        DEBUG,
        DISABLE_TOOLS,
        CHAT_SESSION_AFFINITY,
        INTERNAL_ALLOWED_TOOLS = [],
        HEALTH_DETAILS_ENABLED = true,
        METRICS_ENABLED = false,
        PUBLIC_DIAGNOSTICS = false,
        OMIT_SYSTEM_PROMPT,
        AUTO_CLEANUP_CONVERSATIONS,
        CLEANUP_INTERVAL_MS,
        CLEANUP_MAX_AGE_MS,
        OPENCODE_HOME_BASE,
        EVENT_IDLE_TIMEOUT_MS = DEFAULT_EVENT_IDLE_TIMEOUT_MS,
        EVENT_FIRST_DELTA_TIMEOUT_MS = DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
        WEB_PANEL_ENABLED = false,
        USAGE_PERSISTENCE = false,
        USAGE_FILE = null,
        USAGE_SAVE_INTERVAL_MS = DEFAULT_USAGE_SAVE_INTERVAL_MS
    } = config;

    // Multi-user keys: parse once at app creation. Duplicate keys/names throw
    // here so a bad config fails at startup instead of per request. The legacy
    // single API_KEY keeps working for every path (it is also the admin key).
    const apiKeyEntries = parseApiKeysConfig(API_KEYS);
    const adminAuthEnabled = Boolean(API_KEY && API_KEY.trim() !== '');
    if (adminAuthEnabled) {
        const masterKey = API_KEY.trim();
        for (const entry of apiKeyEntries) {
            if (safeTokenEquals(entry.key, masterKey)) {
                throw new Error(`[Config] API_KEYS entry "${entry.name}" must not use the same key value as API_KEY (the admin key)`);
            }
        }
    }
    const apiKeyByName = new Map(apiKeyEntries.map((entry) => [entry.name, entry.key]));
    const multiUserEnabled = apiKeyEntries.length > 0;
    // Counters survive a restart only when the caller asked for it: a snapshot
    // next to the config, written every few minutes and on shutdown. The store
    // is created first so the registry can restore from it while it is built,
    // and the registry calls the store's `register` to start periodic saving.
    // With the flag off there is no store and the registry stays in process
    // memory, exactly as before.
    const usageStore = USAGE_PERSISTENCE && USAGE_FILE
        ? createUsageStore({
            file: USAGE_FILE,
            intervalMs: USAGE_SAVE_INTERVAL_MS,
            log: (message) => console.warn(message)
        })
        : null;
    const keyUsage = createKeyUsageRegistry(apiKeyEntries, { store: usageStore });
    // Exposed so the shutdown path can write one last snapshot.
    const persistUsageNow = () => (usageStore ? usageStore.close() : Promise.resolve(false));

    const findMatchingUserKeyName = (token) => {
        if (!token || !multiUserEnabled) return null;
        let matchedName = null;
        for (const entry of apiKeyEntries) {
            if (safeTokenEquals(token, entry.key)) {
                matchedName = entry.name;
            }
        }
        return matchedName;
    };

    const app = express();
    app.use(cors({
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'anthropic-version']
    }));
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

    const clientHeaders = buildBackendAuthHeaders(OPENCODE_SERVER_PASSWORD);
    const client = createOpencodeClient({ baseUrl: OPENCODE_SERVER_URL, headers: clientHeaders });

    // Extract and validate the Bearer token from a request, if any.
    const extractBearerToken = (req) => {
        const authHeader = req.headers.authorization;
        if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return null;
        return authHeader.slice('Bearer '.length).trim() || null;
    };

    // Auth middleware
    app.use((req, res, next) => {
        if (req.method === 'OPTIONS' || req.path === '/health' || req.path === '/' || req.path === '/health/details' || req.path === '/metrics') return next();
        if (multiUserEnabled && (req.path === '/admin/keys' || req.path.startsWith('/admin/keys/'))) return next();
        if (req.path === '/panel' || req.path === '/panel/data.json') {
            // Disabled panel: the routes do not exist (404) regardless of auth.
            if (!WEB_PANEL_ENABLED) {
                return res.status(404).json({
                    error: { message: `Route not found: ${req.method} ${req.path}`, type: 'not_found_error' }
                });
            }
            // Enabled: both GET endpoints gate themselves — /panel is a static
            // shell without data, /panel/data.json enforces the diagnostics
            // auth (PUBLIC_DIAGNOSTICS / Bearer) inside its handler.
            if (req.method === 'GET') return next();
        }
        const token = extractBearerToken(req);
        // Anthropic Messages clients authenticate via x-api-key; scope it to
        // /v1/messages so the OpenAI-compatible endpoints stay Bearer-only.
        const xApiKey = req.path === '/v1/messages' && typeof req.headers['x-api-key'] === 'string'
            ? req.headers['x-api-key'].trim()
            : '';
        const candidateToken = token || xApiKey || null;
        const rejectUnauthorized = () => {
            if (req.path === '/v1/messages') {
                return res.status(401).json({
                    type: 'error',
                    error: { type: 'authentication_error', message: 'invalid x-api-key' }
                });
            }
            return res.status(401).json({ error: { message: 'Unauthorized' } });
        };
        if (multiUserEnabled) {
            // API_KEYS hit wins and tags the request for per-key metering.
            const matchedUserKeyName = findMatchingUserKeyName(candidateToken);
            if (matchedUserKeyName) {
                req.apiKeyName = matchedUserKeyName;
                return next();
            }
        }
        if (API_KEY && API_KEY.trim() !== '') {
            // Fall back to the legacy single key (old deployments are unaffected;
            // /admin/keys uses this same master key as its admin credential).
            if (candidateToken && safeTokenEquals(candidateToken, API_KEY.trim())) {
                req.apiKeyName = MASTER_KEY_NAME;
                return next();
            }
            return rejectUnauthorized();
        }
        if (multiUserEnabled) {
            return rejectUnauthorized();
        }
        next();
    });

    const getProvidersList = async () => {
        const providersRes = await client.config.providers();
        const providersRaw = providersRes.data?.providers || [];
        return Array.isArray(providersRaw)
            ? providersRaw
            : Object.entries(providersRaw).map(([id, info]) => ({ ...info, id }));
    };

    const buildModelsList = (providersList) => {
        const models = [];
        providersList.forEach((p) => {
            if (p.models) {
                Object.entries(p.models).forEach(([mId, mData]) => {
                    models.push({
                        id: `${p.id}/${mId}`,
                        name: typeof mData === 'object' ? (mData.name || mData.label || mId) : mId,
                        object: 'model',
                        created: (mData && mData.release_date)
                            ? Math.floor(new Date(mData.release_date).getTime() / 1000)
                            : 1704067200,
                        owned_by: p.id
                    });
                });
            }
        });
        return models;
    };

    const normalizeModelID = (modelID) => {
        if (!modelID || typeof modelID !== 'string') return modelID;
        return modelID
            .replace(/^gpt(\d)/i, 'gpt-$1')
            .replace(/^o(\d)/i, 'o$1');
    };

    const resolveRequestedModel = async (requestedModel) => {
        const providersList = await getProvidersList();
        const models = buildModelsList(providersList);
        const fallbackModel = models[0]?.id || 'opencode/kimi-k2.5-free';
        let [providerID, modelID] = (requestedModel || fallbackModel).split('/');
        if (!modelID) {
            modelID = providerID;
            providerID = 'opencode';
        }
        const originalModelID = modelID;
        const normalizedModelID = normalizeModelID(modelID);
        const candidateModelIDs = [...new Set([modelID, normalizedModelID].filter(Boolean))];
        const exact = models.find((m) => candidateModelIDs.some((candidate) => m.id === `${providerID}/${candidate}`));
        if (exact) {
            const [, resolvedModelID] = exact.id.split('/');
            return {
                providerID,
                modelID: resolvedModelID,
                models,
                resolved: exact.id,
                ...(resolvedModelID !== originalModelID && { aliasFrom: `${providerID}/${originalModelID}` })
            };
        }
        const sameProvider = models.filter((m) => m.owned_by === providerID);
        const suffixMatch = sameProvider.find((m) => candidateModelIDs.some((candidate) => m.id.endsWith(`/${candidate}-free`) || m.id.endsWith(`/${candidate}`)));
        if (suffixMatch) {
            const [, resolvedModelID] = suffixMatch.id.split('/');
            return { providerID, modelID: resolvedModelID, models, resolved: suffixMatch.id, aliasFrom: `${providerID}/${originalModelID}` };
        }
        const error = new Error(`Model not found: ${providerID}/${modelID}`);
        error.statusCode = 400;
        error.code = 'model_not_found';
        error.availableModels = models.map((m) => m.id);
        throw error;
    };

    // Models endpoint
    app.get('/v1/models', async (_req, res) => {
        try {
            const models = buildModelsList(await getProvidersList());
            res.json({ object: 'list', data: models });
        } catch (error) {
            console.error('[Proxy] Model Fetch Error:', error.message);
            res.json({ object: 'list', data: [{ id: 'opencode/kimi-k2.5-free', object: 'model' }] });
        }
    });

    const logDebug = (...args) => {
        if (DEBUG) {
            console.log('[Proxy][Debug]', ...args);
        }
    };

    // Responses API state store (previous_response_id): maps a returned response id
    // to the OpenCode session that produced it, so stateful clients can continue a
    // conversation without resending full history. Entries expire after
    // RESPONSE_STATE_TTL_MS; the sweep then best-effort deletes the upstream session
    // once no live entry still references it, so statefulness never leaks sessions.
    const responseState = new Map();
    const RESPONSE_STATE_TTL_MS = 30 * 60 * 1000;
    const RESPONSE_STATE_SWEEP_INTERVAL_MS = 60 * 1000;
    const getResponseState = (responseId) => {
        const state = responseState.get(responseId);
        if (!state) return null;
        if (state.expiresAt <= Date.now()) {
            responseState.delete(responseId);
            return null;
        }
        return state;
    };
    const storeResponseState = (responseId, sessionId, model) => {
        if (!responseId || !sessionId) return;
        responseState.set(responseId, {
            sessionId,
            model,
            expiresAt: Date.now() + RESPONSE_STATE_TTL_MS
        });
    };
    const sweepResponseState = async () => {
        const now = Date.now();
        const expired = [];
        for (const [id, state] of responseState.entries()) {
            if (state.expiresAt <= now) {
                expired.push(state);
                responseState.delete(id);
            }
        }
        if (!expired.length) return;
        const liveSessionIds = new Set([...responseState.values()].map((s) => s.sessionId));
        for (const state of expired) {
            if (liveSessionIds.has(state.sessionId)) continue;
            try {
                await client.session.delete({ path: { id: state.sessionId } });
            } catch (e) {
                logDebug('Failed to delete expired response session', { sessionId: state.sessionId, error: e.message });
            }
        }
    };
    const responseStateSweepTimer = setInterval(() => {
        sweepResponseState().catch(() => {});
    }, RESPONSE_STATE_SWEEP_INTERVAL_MS);
    if (typeof responseStateSweepTimer.unref === 'function') responseStateSweepTimer.unref();

    const TOOL_MODE = Object.freeze({
        DISABLED: 'disabled',
        EXTERNAL_BRIDGE: 'external-bridge',
        INTERNAL_ALLOWLIST: 'internal-allowlist'
    });

    const TOOL_GUARD_MESSAGE = 'Tools are disabled. Do not call tools or function calls. Answer directly from the conversation and general knowledge. If external or real-time data is required, say so and ask the user to enable tools.';
    const EXTERNAL_TOOL_GUARD_MESSAGE = 'OpenCode internal tools remain disabled. If an external tool contract is present, use only that contract and never call or mention OpenCode internal tools.';

    const normalizeConfiguredToolNames = (entries = []) => [...new Set(
        entries
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
    )];

    const getEffectiveInternalAllowedTools = () => normalizeConfiguredToolNames(INTERNAL_ALLOWED_TOOLS);

    const SERVER_INTERNAL_ALLOWED_TOOL_NAMES = getEffectiveInternalAllowedTools();

    const buildInternalAllowlistPrompt = (allowedToolNames = []) => {
        if (allowedToolNames.length > 0) {
            return `OpenCode internal tool access is limited for this turn. You may use only these built-in tools when truly required: ${allowedToolNames.join(', ')}. Do not mention or attempt any other internal tools. If the required internal tools are unavailable, answer directly and say live tool access is unavailable.`;
        }
        return 'OpenCode internal tools are unavailable for this turn. Answer directly without attempting tool usage.';
    };

    const buildSystemPrompt = (systemMsg, reasoningEffort = null, toolMode = TOOL_MODE.DISABLED, internalAllowedTools = []) => {
        const parts = [];
        if (!OMIT_SYSTEM_PROMPT && systemMsg && systemMsg.trim()) {
            parts.push(systemMsg.trim());
        }
        if (reasoningEffort && reasoningEffort !== 'none') {
            parts.push(`[Reasoning Effort: ${reasoningEffort}]`);
        }
        if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
            parts.push(buildInternalAllowlistPrompt(internalAllowedTools));
        } else if (DISABLE_TOOLS) {
            parts.push(toolMode === TOOL_MODE.EXTERNAL_BRIDGE ? EXTERNAL_TOOL_GUARD_MESSAGE : TOOL_GUARD_MESSAGE);
        }
        const finalPrompt = parts.join('\n\n').trim();
        return finalPrompt || undefined;
    };

    const normalizeReasoningEffort = (value, fallback = null) => {
        if (!value || typeof value !== 'string') return fallback;
        const effortMap = {
            'none': 'none',
            'minimal': 'none',
            'low': 'low',
            'medium': 'medium',
            'high': 'high',
            'xhigh': 'high'
        };
        return effortMap[value.toLowerCase()] || fallback;
    };

    const stripFunctionCalls = (text, trim = true) => {
        if (!DISABLE_TOOLS || !text) return text;
        return stripFunctionCallMarkup(text, trim);
    };

    const normalizeTextContent = (content) => {

        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part.text === 'string') return part.text;
                if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') return part?.text || '';
                return '';
            }).join('');
        }
        if (content && typeof content.text === 'string') return content.text;
        if (content === null || content === undefined) return '';
        if (typeof content === 'number' || typeof content === 'boolean') return String(content);
        return '';
    };

    const normalizeToolArguments = (args) => {
        if (typeof args === 'string') return args;
        if (args === undefined) return '{}';
        try {
            return JSON.stringify(args);
        } catch (e) {
            return '{}';
        }
    };

    const normalizeToolResultContent = (content) => {
        const text = normalizeTextContent(content);
        if (text) return text;
        if (content === null || content === undefined) return '';
        if (typeof content === 'object') {
            try {
                return JSON.stringify(content);
            } catch (e) {
                return '';
            }
        }
        return String(content);
    };


    const createExternalToolContext = (tools, toolChoice) => {
        const registry = buildExternalToolRegistry(tools);
        const exposure = buildToolExposure(registry, toolChoice);
        return {
            registry,
            exposure,
            toolChoice: exposure.toolChoice,
            prompt: exposure.prompt
        };
    };

    const resolveToolMode = (tools = [], effectiveInternalAllowlist = []) => {
        if (Array.isArray(tools) && tools.length > 0) {
            return TOOL_MODE.EXTERNAL_BRIDGE;
        }
        if (effectiveInternalAllowlist.length > 0) {
            return TOOL_MODE.INTERNAL_ALLOWLIST;
        }
        return TOOL_MODE.DISABLED;
    };

    const createRequestToolContext = (tools, toolChoice, requestOpencodeConfig = undefined) => {
        let effectiveInternalAllowlist = SERVER_INTERNAL_ALLOWED_TOOL_NAMES;
        let requestInternalAllowlist = null;

        if (requestOpencodeConfig && typeof requestOpencodeConfig === 'object') {
            if (Array.isArray(requestOpencodeConfig.internal_allowed_tools)) {
                requestInternalAllowlist = requestOpencodeConfig.internal_allowed_tools
                    .map(name => String(name || '').trim())
                    .filter(Boolean);
            }
        }

        if (requestInternalAllowlist !== null) {
            effectiveInternalAllowlist = SERVER_INTERNAL_ALLOWED_TOOL_NAMES.filter(name => 
                requestInternalAllowlist.includes(name)
            );
        }

        const deniedRequestedTools = requestInternalAllowlist
            ? requestInternalAllowlist.filter(name => !SERVER_INTERNAL_ALLOWED_TOOL_NAMES.includes(name))
            : [];

        const mode = resolveToolMode(tools, effectiveInternalAllowlist);
        const external = mode === TOOL_MODE.EXTERNAL_BRIDGE
            ? createExternalToolContext(tools, toolChoice)
            : {
                registry: [],
                exposure: { tools: [], toolChoice: { mode: 'auto', requiredTool: null }, prompt: '' },
                toolChoice: { mode: 'auto', requiredTool: null },
                prompt: ''
            };

        return {
            mode,
            external,
            internal: {
                allowedToolNames: effectiveInternalAllowlist,
                requestedAllowlist: requestInternalAllowlist,
                deniedRequestedTools,
                resolutionPath: requestInternalAllowlist ? 'request-intersection' : 'server-default',
                resultingMode: mode
            }
        };


        return {
            mode,
            external,
            internal: {
                allowedToolNames: effectiveInternalAllowlist,
                requestedAllowlist: requestInternalAllowlist,
                deniedRequestedTools,
                resolutionPath: requestInternalAllowlist ? 'request-intersection' : 'server-default',
                resultingMode: mode
            }
        };
    };

    const finalizeValidatedToolCalls = (parsedToolCalls, registry) => {
        const { validCalls, invalidCalls } = validateToolCalls(parsedToolCalls, registry);
        invalidCalls.forEach(({ call, validation }) => {
            logDebug('Rejected external tool call', {
                tool: call?.function?.name,
                errors: validation?.errors?.map((error) => error.message)
            });
        });
        return { validCalls, invalidCalls };
    };

    const toPublicToolCalls = (toolCalls) => {
        if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
        return toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments
            }
        }));
    };

    const createForcedToolCallRequester = ({
        mode,
        sessionId,
        systemWithGuard,
        requiredTool,
        providerID,
        modelID,
        toolOverrides,
        requestTimeoutMs,
        forbidThinkBlock = false
    }) => async () => {
        if (mode !== 'required') return null;
        if (!requiredTool) return null;
        const forcedPromptParams = {
            path: { id: sessionId },
            body: {
                model: { providerID, modelID },
                ...(systemWithGuard ? { system: systemWithGuard } : {}),
                parts: [{
                    type: 'text',
                    text: `SYSTEM: Your previous reply did not emit the required external tool call. Reply now with ONLY <function_calls>{\"name\":\"${requiredTool}\",\"arguments\":{}}</function_calls> or an array inside <function_calls>...</function_calls>. Do not output any prose, reasoning, markdown${forbidThinkBlock ? ', or <think> block' : ''}. Infer the correct arguments from the conversation so far.`
                }]
            }
        };
        if (toolOverrides && Object.keys(toolOverrides).length > 0) {
            forcedPromptParams.body.tools = toolOverrides;
        }
        await promptWithTimeout(forcedPromptParams, requestTimeoutMs);
        return pollForAssistantResponse(sessionId, requestTimeoutMs);
    };

    const TOOL_IDS_CACHE_MS = 5 * 60 * 1000;
    let cachedToolIds = null;
    let cachedToolIdsAt = 0;
    let cachedDisabledToolOverrides = null;
    let cachedDisabledToolOverridesAt = 0;
    const internalToolMetrics = {
        externalBridgeRequests: 0,
        internalAllowlistRequests: 0,
        disabledRequests: 0,
        discoveryFailures: 0,
        fallbackToDisabled: 0
    };

    const logInternalToolEvent = (event, details = {}) => {
        if (!DEBUG) return;
        const payload = {
            event,
            ...details
        };
        payload.metrics = { ...internalToolMetrics };
        logDebug('Internal tool event', payload);
    };

    const trackToolMode = (toolMode, details = {}) => {
        if (toolMode === TOOL_MODE.EXTERNAL_BRIDGE) {
            internalToolMetrics.externalBridgeRequests += 1;
        } else if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
            internalToolMetrics.internalAllowlistRequests += 1;
        } else {
            internalToolMetrics.disabledRequests += 1;
        }
        logInternalToolEvent('tool-mode-selected', {
            toolMode,
            ...details
        });
    };

    const getBackendToolIds = async () => {
        if (cachedToolIds && Date.now() - cachedToolIdsAt < TOOL_IDS_CACHE_MS) {
            return cachedToolIds;
        }
        try {
            const idsRes = await client.tool.ids();
            const ids = Array.isArray(idsRes?.data)
                ? idsRes.data
                : Array.isArray(idsRes)
                    ? idsRes
                    : [];
            cachedToolIds = ids;
            cachedToolIdsAt = Date.now();
            logInternalToolEvent('backend-tool-ids-loaded', { count: ids.length });
            return ids;
        } catch (e) {
            internalToolMetrics.discoveryFailures += 1;
            logInternalToolEvent('backend-tool-ids-failed', { error: e.message });
            return null;
        }
    };

    const buildDisabledToolOverrides = (ids = []) => {
        const overrides = {};
        ids.forEach((id) => {
            overrides[id] = false;
        });
        return overrides;
    };

    const normalizeBackendToolIds = (ids = []) => ids.filter((id) => typeof id === 'string' && id.trim());

    // Built-in OpenCode tool IDs have no separators (`webfetch`), while configs
    // commonly spell them `web_fetch`; compare both sides in the same form.
    const matchesAllowedToolName = (toolId, allowedToolName) => {
        const id = normalizeToolName(toolId);
        const name = normalizeToolName(allowedToolName);
        if (!id || !name) return false;
        return id === name || id.endsWith(`.${name}`) || id.endsWith(`/${name}`);
    };

    const resolveInternalAllowedToolIds = (ids = [], allowedToolNames = []) => {
        const normalizedIds = normalizeBackendToolIds(ids);
        const normalizedAllowedNames = normalizeConfiguredToolNames(allowedToolNames);
        const matchedToolIds = new Set();
        const unmatchedAllowedNames = [];

        normalizedAllowedNames.forEach((allowedToolName) => {
            const matches = normalizedIds.filter((toolId) => matchesAllowedToolName(toolId, allowedToolName));
            if (matches.length === 0) {
                unmatchedAllowedNames.push(allowedToolName);
                return;
            }
            matches.forEach((match) => matchedToolIds.add(match));
        });

        return {
            normalizedIds,
            normalizedAllowedNames,
            matchedToolIds: [...matchedToolIds],
            unmatchedAllowedNames
        };
    };

    const getDisabledToolOverrides = async () => {
        if (!DISABLE_TOOLS) return null;
        if (cachedDisabledToolOverrides && Date.now() - cachedDisabledToolOverridesAt < TOOL_IDS_CACHE_MS) {
            return cachedDisabledToolOverrides;
        }
        const ids = await getBackendToolIds();
        if (!Array.isArray(ids)) return null;
        const overrides = buildDisabledToolOverrides(ids);
        cachedDisabledToolOverrides = overrides;
        cachedDisabledToolOverridesAt = Date.now();
        logInternalToolEvent('disabled-tool-overrides-loaded', { count: ids.length });
        return overrides;
    };

    // Tool enforcement. OpenCode Zen's free tier rejects any request whose tool
    // list differs from the official client's ("free tier can only be used from
    // within OpenCode"), and a per-request `tools` map strips tools from that
    // list. When the backend runs the opencode2api tool-lock plugin, the tool
    // list is left intact and the policy travels in the session title instead;
    // the plugin then refuses every tool the policy does not allow. Backends
    // without the plugin fall back to the `tools` map, which keeps tools off but
    // only works with models that skip the free-tier check.
    const TOOL_LOCK_CHECK_MS = 60 * 1000;
    let toolLockState = { loaded: false, checkedAt: 0, warned: false };

    const isToolLockLoaded = async () => {
        if (toolLockState.checkedAt && Date.now() - toolLockState.checkedAt < TOOL_LOCK_CHECK_MS) {
            return toolLockState.loaded;
        }
        let plugins;
        try {
            const res = await client.config.get();
            plugins = Array.isArray(res?.data?.plugin) ? res.data.plugin : [];
        } catch (e) {
            // Backend unreachable: do not cache, the request will surface the error.
            return toolLockState.loaded;
        }
        const loaded = plugins.some((spec) => typeof spec === 'string' && spec.replace(/\\/g, '/').endsWith(`/${TOOL_LOCK_PLUGIN_FILE}`));
        if (!loaded && !toolLockState.warned) {
            console.warn(`[Proxy] Backend at ${OPENCODE_SERVER_URL} does not load ${TOOL_LOCK_PLUGIN_FILE}; falling back to per-request tool overrides. OpenCode Zen free models reject those requests. Let the proxy start the backend (MANAGE_BACKEND=true) or add "${TOOL_LOCK_PLUGIN_PATH}" to the backend's "plugin" config.`);
            toolLockState.warned = true;
        }
        toolLockState = { ...toolLockState, loaded, checkedAt: Date.now() };
        return loaded;
    };

    const buildToolPolicy = (toolMode, internalContext = {}) => {
        if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
            const names = normalizeConfiguredToolNames(internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES)
                .map(normalizeToolName)
                .filter(Boolean);
            return names.length ? [...new Set(names)].join(',') : 'none';
        }
        return DISABLE_TOOLS ? 'none' : '*';
    };

    const sessionTitleForPolicy = (policy) => `opencode2api [tools:${policy}]`;

    // Chat session affinity (CHAT_SESSION_AFFINITY). Multi-turn chat clients
    // resend the whole history on every turn; instead of creating a fresh
    // OpenCode session per request, the proxy keeps one backend session per
    // conversation and appends only the new turns. Upstream prompt caches are
    // keyed by session, so a resumed turn replays the cached prefix instead of
    // paying for the full history again (live probes: ~99% cached tokens on a
    // second turn). Entries expire and their sessions are swept like the
    // responses state above.
    const chatSessions = new Map();
    const chatSessionActive = new Set();
    const CHAT_SESSION_TTL_MS = 30 * 60 * 1000;
    const CHAT_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
    const chatSessionSignalOf = (req, body) => {
        const explicit = req.headers?.['x-opencode-session']
            || req.headers?.['x-session-id']
            || req.headers?.['x-session-affinity']
            || req.headers?.['conversation-id']
            || body?.conversation_id
            || body?.user;
        if (explicit && typeof explicit === 'string') return `hdr:${explicit.slice(0, 200)}`;
        const msgs = Array.isArray(body?.messages) ? body.messages : [];
        for (const m of msgs) {
            if (m?.role === 'user') {
                // The FIRST user turn is stable across the turns of a
                // conversation, so it identifies the conversation. (The last
                // one changes every turn.)
                return `first:${crypto.createHash('sha256').update(String(m?.content ?? '')).digest('hex')}`;
            }
        }
        return null;
    };
    // A request is affinity-eligible only when its prompt is a pure sequence of
    // user turns (an incremental client appending to a conversation). Returns
    // the user turn texts, or null when assistant/tool/file parts are present
    // (a client resending full history keeps the fresh-session semantics).
    const chatUserTurnsOf = (parts) => {
        if (!parts.length) return null;
        const turns = [];
        for (const part of parts) {
            if (part?.type !== 'text' || typeof part.text !== 'string' || !part.text.startsWith('USER: ')) return null;
            turns.push(part.text.slice(6));
        }
        return turns;
    };
    const chatSessionsSweep = async () => {
        const now = Date.now();
        const expired = [];
        for (const [, state] of chatSessions.entries()) {
            if (state.expiresAt <= now) expired.push(state);
        }
        for (const state of expired) {
            if (chatSessions.get(state.signal) !== state) continue;
            chatSessions.delete(state.signal);
            if (chatSessionActive.has(state.sessionId)) continue;
            chatSessionActive.delete(state.sessionId);
            try {
                await client.session.delete({ path: { id: state.sessionId } });
            } catch (e) {
                logDebug('Failed to delete expired chat session', { sessionId: state.sessionId, error: e.message });
            }
        }
    };
    const chatSessionEntryStore = (signal, sessionId, userTurns, systemWithGuard, toolPolicy, toolOverrides, model) => {
        chatSessions.set(signal, {
            signal,
            sessionId,
            userTurns,
            system: systemWithGuard || '',
            toolPolicy,
            toolOverridesJson: JSON.stringify(toolOverrides ?? null),
            model,
            pending: true,
            expiresAt: Date.now() + CHAT_SESSION_TTL_MS
        });
        chatSessionActive.add(sessionId);
    };
    const chatSessionEntryComplete = (signal, sessionId, userTurns) => {
        const entry = chatSessions.get(signal);
        if (!entry || entry.sessionId !== sessionId) return;
        entry.userTurns = userTurns;
        entry.pending = false;
        entry.expiresAt = Date.now() + CHAT_SESSION_TTL_MS;
        chatSessionActive.delete(sessionId);
    };
    // Map cleanup only; the caller deletes the backend session itself (the
    // retry rotation already does).
    const chatSessionEntryDrop = (signal, sessionId) => {
        const entry = chatSessions.get(signal);
        if (entry && entry.sessionId === sessionId) chatSessions.delete(signal);
        chatSessionActive.delete(sessionId);
    };
    // Drops the affinity entry after a failed turn and deletes the backend
    // session: it carries an errored exchange, so the next turn must not
    // append to it.
    const chatSessionEntryFail = async (signal, sessionId) => {
        chatSessionEntryDrop(signal, sessionId);
        try {
            await client.session.delete({ path: { id: sessionId } });
        } catch (e) {
            logDebug('Failed to delete failed chat session', { sessionId, error: e.message });
        }
    };
    if (!chatSessions.sweepTimer) {
        const timer = setInterval(() => { chatSessionsSweep().catch(() => {}); }, CHAT_SESSION_SWEEP_INTERVAL_MS);
        if (typeof timer.unref === 'function') timer.unref();
        chatSessions.sweepTimer = timer;
    }

    // Resolves how a request's tool policy reaches the backend: a session title
    // for the tool-lock plugin, or a `tools` override map as the fallback.
    const resolveToolControl = async (toolMode, internalContext = {}) => {
        const policy = buildToolPolicy(toolMode, internalContext);
        if (await isToolLockLoaded()) {
            logInternalToolEvent('tool-policy-plugin', { toolMode, policy });
            return { title: sessionTitleForPolicy(policy), toolOverrides: null };
        }
        return { title: undefined, toolOverrides: await getToolOverridesForMode(toolMode, internalContext) };
    };

    const createSession = async (toolControl) => {
        const sessionRes = await client.session.create(toolControl?.title ? { body: { title: toolControl.title } } : undefined);
        const sessionId = sessionRes?.data?.id;
        if (!sessionId) throw new Error('Failed to create OpenCode session');
        return sessionId;
    };

    const getToolOverridesForMode = async (toolMode, internalContext = {}) => {
        if (toolMode === TOOL_MODE.EXTERNAL_BRIDGE || toolMode === TOOL_MODE.DISABLED) {
            if (toolMode === TOOL_MODE.DISABLED) {
                logInternalToolEvent('internal-tools-disabled', {
                    configuredAllowlist: internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES
                });
            }
            return getDisabledToolOverrides();
        }
        if (toolMode !== TOOL_MODE.INTERNAL_ALLOWLIST) {
            return null;
        }
        const ids = await getBackendToolIds();
        if (!Array.isArray(ids) || ids.length === 0) return null;
        const resolution = resolveInternalAllowedToolIds(ids, internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES);
        const { normalizedIds, normalizedAllowedNames, matchedToolIds, unmatchedAllowedNames } = resolution;
        if (matchedToolIds.length === 0) {
            internalToolMetrics.fallbackToDisabled += 1;
            logInternalToolEvent('internal-allowlist-unavailable', {
                configuredAllowlist: normalizedAllowedNames,
                availableToolIds: normalizedIds,
                unmatchedAllowlist: unmatchedAllowedNames,
                fallback: 'disabled'
            });
            return buildDisabledToolOverrides(normalizedIds);
        }
        const overrides = {};
        normalizedIds.forEach((id) => {
            overrides[id] = matchedToolIds.includes(id);
        });
        logInternalToolEvent('internal-allowlist-overrides-loaded', {
            configuredAllowlist: normalizedAllowedNames,
            matchedToolIds,
            unmatchedAllowlist: unmatchedAllowedNames,
            availableToolIdsCount: normalizedIds.length
        });
        return overrides;
    };

    async function promptWithTimeout(promptParams, timeoutMs) {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
        });
        return Promise.race([client.session.prompt(promptParams), timeoutPromise]);
    }

    const getCleanupRoots = () => {
        const roots = [];
        const add = (dir) => {
            if (!dir) return;
            if (!roots.includes(dir)) roots.push(dir);
        };
        add(OPENCODE_HOME_BASE ? path.join(OPENCODE_HOME_BASE, '.local', 'share', 'opencode', 'storage') : null);
        add('/home/node/.local/share/opencode/storage');
        return roots;
    };

    const cleanupConversationFiles = async () => {
        if (!AUTO_CLEANUP_CONVERSATIONS) return { removed: 0, scanned: 0 };
        const now = Date.now();
        let removed = 0;
        let scanned = 0;
        for (const storageRoot of getCleanupRoots()) {
            for (const sub of ['message', 'session']) {
                const dir = path.join(storageRoot, sub);
                if (!fs.existsSync(dir)) continue;
                let entries = [];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch (e) {
                    continue;
                }
                for (const entry of entries) {
                    const full = path.join(dir, entry.name);
                    let stat;
                    try {
                        stat = fs.statSync(full);
                    } catch (e) {
                        continue;
                    }
                    scanned += 1;
                    const mtime = stat.mtimeMs || stat.ctimeMs || now;
                    if (now - mtime < CLEANUP_MAX_AGE_MS) continue;
                    try {
                        fs.rmSync(full, { recursive: true, force: true });
                        removed += 1;
                    } catch (e) {
                        logDebug('Cleanup remove failed', { full, error: e.message });
                    }
                }
            }
        }
        if (removed > 0) {
            logDebug('Conversation cleanup completed', { removed, scanned, maxAgeMs: CLEANUP_MAX_AGE_MS });
        }
        return { removed, scanned };
    };

    if (AUTO_CLEANUP_CONVERSATIONS) {
        setTimeout(() => {
            cleanupConversationFiles().catch((e) => logDebug('Cleanup run failed', { error: e.message }));
        }, 3000);
        const cleanupTimer = setInterval(() => {
            cleanupConversationFiles().catch((e) => logDebug('Cleanup run failed', { error: e.message }));
        }, CLEANUP_INTERVAL_MS);
        if (cleanupTimer.unref) cleanupTimer.unref();
    }

    function extractFromParts(parts) {
        if (!Array.isArray(parts)) return { content: '', reasoning: '', toolParts: [] };
        const content = parts.filter(p => p.type === 'text').map(p => p.text).join('');
        const reasoning = parts.filter(p => p.type === 'reasoning').map(p => p.text).join('');
        const toolParts = parts.filter(p => p.type === 'tool');
        return { content, reasoning, toolParts };
    }

    async function pollForAssistantResponse(sessionId, timeoutMs, intervalMs = DEFAULT_POLL_INTERVAL_MS) {
        const pollStart = Date.now();
        const startedAt = Date.now();
        // Best-effort snapshot of the most recent in-flight assistant message. Polling
        // observes partial messages: a reasoning model emits its reasoning part first and
        // the text part only afterwards, so returning on the first non-empty snapshot
        // truncates the answer to the reasoning alone. Keep the partial around purely as
        // a timeout fallback and otherwise wait for the message to actually finish.
        let lastPartial = null;
        while (Date.now() - startedAt < timeoutMs) {
            const messagesRes = await client.session.messages({ path: { id: sessionId } });
            const messages = messagesRes?.data || messagesRes || [];
            if (Array.isArray(messages) && messages.length) {
                for (let i = messages.length - 1; i >= 0; i -= 1) {
                    const entry = messages[i];
                    const info = entry?.info;
                    if (info?.role !== 'assistant') continue;
                    const { content, reasoning, toolParts } = extractFromParts(entry?.parts || []);
                    const error = info?.error || null;
                    // finish === 'tool' marks an intermediate turn that pauses for a tool
                    // result; the assistant is not done producing output yet.
                    const finished = info.finish && info.finish !== 'tool';
                    const done = Boolean(finished || info.time?.completed || error);
                    if (toolParts.length > 0) {
                        logDebug('Polling found tool parts', {
                            sessionId,
                            count: toolParts.length,
                            parts: toolParts.map(p => ({
                                id: p.id,
                                tool: p.tool,
                                status: p.state?.status,
                                input: p.state?.input
                            }))
                        });
                    }
                    if (done) {
                        if (error) {
                            console.error('[Proxy] OpenCode assistant error:', error);
                        }
                        // Real counts when the backend finished the message and
                        // reported them; null tells the caller to estimate.
                        const usage = usageFromInfo(info);
                        logDebug('Polling completed', {
                            sessionId,
                            ms: Date.now() - pollStart,
                            done,
                            contentLen: content.length,
                            reasoningLen: reasoning.length,
                            error: error ? error.name : null,
                            realUsage: Boolean(usage)
                        });
                        return { content, reasoning, usage, error };
                    }
                    if (content || reasoning) {
                        lastPartial = { content, reasoning, error: null };
                    }
                    break;
                }
            }
            await sleep(intervalMs);
        }
        if (lastPartial) {
            logDebug('Polling timeout with partial response', {
                sessionId,
                ms: Date.now() - pollStart,
                contentLen: lastPartial.content.length,
                reasoningLen: lastPartial.reasoning.length
            });
            return lastPartial;
        }
        logDebug('Polling timeout', { sessionId, ms: Date.now() - pollStart });
        throw new Error(`Request timeout after ${timeoutMs}ms`);
    }

    /**
     * Collect one assistant turn from the backend event stream.
     *
     * @param {string} sessionId
     * @param {number} timeoutMs - whole-turn ceiling
     * @param {Function} [onDelta] - streaming sink
     * @param {number} [firstDeltaTimeoutMs] - give up when no delta arrives at all
     * @param {number} [idleTimeoutMs] - give up when the stream goes silent mid-turn
     * @param {object} [options]
     * @param {AbortSignal} [options.signal] - aborts the turn when the client
     *   goes away; without it a disconnected client keeps the backend busy for
     *   the whole timeout and blocks the next request in the lock queue.
     * @param {(usage: {promptTokens: number, completionTokens: number, reasoningTokens: number}) => void} [options.onUsage]
     *   - called once when the backend reports its own token counts
     * @returns {Promise<object>} `{content, reasoning, usage?, error?}`
     */
    async function collectFromEvents(sessionId, timeoutMs, onDelta, firstDeltaTimeoutMs, idleTimeoutMs, options = {}) {
        const { signal: clientSignal = null, onUsage = null } = options;
        const controller = new AbortController();
        const eventStreamResult = await client.event.subscribe({ signal: controller.signal });
        const eventStream = eventStreamResult.stream;
        let finished = false;
        let content = '';
        let reasoning = '';
        let receivedDelta = false;
        let deltaChars = 0;
        let firstDeltaAt = null;
        // The backend reports real token counts on the finished assistant
        // message; estimate only when it never does.
        let reportedUsage = null;
        // Tracks internal OpenCode tool calls that are still pending/running. While any
        // tool call is active, the stream must stay open even if no text deltas arrive
        // (the backend is executing the tool). Resolving early here is what previously
        // truncated streaming responses that relied on internal tool execution.
        const activeToolCallIds = new Set();
        const startedAt = Date.now();

        const finishPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                if (finished) return;
                finished = true;
                controller.abort();
                reject(new Error(`Request timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            // A client that has already gone must not be waited on: stop the
            // upstream subscription and report the turn as canceled so callers
            // can skip the poll fallback instead of re-running the request.
            const onClientGone = () => {
                if (finished) return;
                finished = true;
                clearTimeout(timeoutId);
                controller.abort();
                logDebug('Client disconnected, aborting upstream turn', {
                    sessionId,
                    ms: Date.now() - startedAt,
                    deltaChars
                });
                resolve({
                    content,
                    reasoning,
                    usage: reportedUsage,
                    clientGone: true,
                    receivedDelta
                });
            };
            const clientAlreadyGone = clientSignal && clientSignal.aborted;
            if (clientAlreadyGone) {
                // Nothing can be collected for a request nobody is waiting for.
                finished = true;
                clearTimeout(timeoutId);
                controller.abort();
                resolve({ content: '', reasoning: '', usage: null, clientGone: true, receivedDelta: false });
                return;
            }
            if (clientSignal) clientSignal.addEventListener('abort', onClientGone, { once: true });

            const releaseClientSignal = () => {
                if (clientSignal) clientSignal.removeEventListener('abort', onClientGone);
            };

            const firstDeltaTimer = firstDeltaTimeoutMs
                ? setTimeout(() => {
                    if (finished || receivedDelta) return;
                    finished = true;
                    controller.abort();
                    logDebug('No event data received', { sessionId, ms: Date.now() - startedAt });
                    resolve({ content: '', reasoning: '', usage: null, noData: true });
                }, firstDeltaTimeoutMs)
                : null;

            let idleTimer = null;
            const scheduleIdleTimer = () => {
                if (!idleTimeoutMs) return;
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    if (finished) return;
                    // A tool call is still executing on the backend. Keep the stream open
                    // and wait instead of cutting the response short; the follow-up text
                    // (or the final completion) will arrive once the tool finishes.
                    if (activeToolCallIds.size > 0) {
                        logDebug('Event idle while internal tool call is active, continuing to wait', {
                            sessionId,
                            ms: Date.now() - startedAt,
                            activeTools: activeToolCallIds.size
                        });
                        scheduleIdleTimer();
                        return;
                    }
                    finished = true;
                    controller.abort();
                    logDebug('Event idle timeout', {
                        sessionId,
                        ms: Date.now() - startedAt,
                        deltaChars
                    });
                    resolve({
                        content,
                        reasoning,
                        usage: reportedUsage,
                        idleTimeout: true,
                        receivedDelta
                    });
                }, idleTimeoutMs);
            };

            const trackToolActivity = (part) => {
                if (!part || part.type !== 'tool') return;
                const status = part.state?.status;
                if (status === 'pending' || status === 'running') {
                    if (part.id) activeToolCallIds.add(part.id);
                } else if (status === 'completed' || status === 'error') {
                    if (part.id) activeToolCallIds.delete(part.id);
                }
                // Tool activity means the session is still working; treat it as progress
                // so the idle timer does not terminate the stream mid-execution.
                receivedDelta = true;
                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                scheduleIdleTimer();
            };

            // Newer OpenCode servers stream deltas as `message.part.delta` events that
            // carry only a `partID` (no `part.type`). The part type is announced by the
            // preceding `message.part.updated` event, so we key partID -> type here and
            // resolve each delta against it. Without this, reasoning and answer text can
            // never be told apart and the answer is mis-routed (or dropped) entirely.
            const partTypeById = new Map();
            const rememberPartType = (part) => {
                if (part && part.id && typeof part.type === 'string') {
                    partTypeById.set(part.id, part.type);
                }
            };
            const applyTextDelta = (partType, delta) => {
                receivedDelta = true;
                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                scheduleIdleTimer();
                if (!firstDeltaAt) {
                    firstDeltaAt = Date.now();
                    logDebug('SSE first delta', {
                        sessionId,
                        ms: firstDeltaAt - startedAt,
                        type: partType
                    });
                }
                if (partType === 'reasoning') {
                    reasoning += delta;
                    if (onDelta) onDelta(delta, true);
                } else {
                    content += delta;
                    if (onDelta) onDelta(delta, false);
                }
                deltaChars += delta.length;
            };

            (async () => {
                try {
                    for await (const event of eventStream) {
                        if (event.type === 'message.part.updated' && event.properties.part?.sessionID === sessionId) {
                            const { part, delta } = event.properties;
                            rememberPartType(part);
                            trackToolActivity(part);
                            // Older OpenCode servers carried the streaming delta directly on
                            // message.part.updated; newer servers emit message.part.delta.
                            if (delta) applyTextDelta(part.type, delta);
                            continue;
                        }
                        if (event.type === 'message.part.delta' && event.properties?.sessionID === sessionId) {
                            const { partID, delta, field } = event.properties;
                            // Text and reasoning deltas both stream through field === 'text'.
                            // Tool-input deltas surface via message.part.updated tool state.
                            if (typeof delta === 'string' && field === 'text') {
                                const partType = partTypeById.get(partID);
                                if (partType === 'reasoning' || partType === 'text') {
                                    applyTextDelta(partType, delta);
                                }
                            }
                            continue;
                        }
                        if (event.type === 'message.updated' &&
                            event.properties.info?.sessionID === sessionId) {
                            const info = event.properties.info;
                            const finish = info.finish;
                            // The backend counts real tokens; keep them so the
                            // response and the per-key meter report what the
                            // provider charged instead of a character estimate.
                            if (info.tokens && !reportedUsage) {
                                reportedUsage = usageFromInfo(info);
                                if (onUsage) {
                                    try {
                                        onUsage(reportedUsage);
                                    } catch (e) {
                                        logDebug('Usage sink failed', { sessionId, error: e.message });
                                    }
                                }
                            }
                            // An aborted or failed message never produces another delta. Without
                            // this, the collector waits out the whole first-delta window before
                            // polling rediscovers the same error.
                            if (info.error && !finished) {
                                finished = true;
                                clearTimeout(timeoutId);
                                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                                if (idleTimer) clearTimeout(idleTimer);
                                releaseClientSignal();
                                logDebug('SSE upstream message error', {
                                    sessionId,
                                    ms: Date.now() - startedAt,
                                    error: info.error.name || 'UnknownError'
                                });
                                resolve({ content, reasoning, usage: reportedUsage, error: info.error });
                                break;
                            }
                            // Reconcile active tool calls from the full message snapshot so we
                            // detect pending tools even when only message.updated fires.
                            if (Array.isArray(info.parts)) {
                                for (const part of info.parts) {
                                    rememberPartType(part);
                                    if (part && part.type === 'tool') {
                                        const status = part.state?.status;
                                        if (status === 'pending' || status === 'running') {
                                            if (part.id) activeToolCallIds.add(part.id);
                                        } else if (status === 'completed' || status === 'error') {
                                            if (part.id) activeToolCallIds.delete(part.id);
                                        }
                                    }
                                }
                            }
                            if (finish === 'tool') {
                                // Assistant turn ended pending a tool call; keep waiting for the result.
                                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                                scheduleIdleTimer();
                                continue;
                            }
                            if (finish === 'stop') {
                                // Only treat the stream as completed when no tool call is still
                                // pending. OpenCode may emit an intermediate 'stop' snapshot while a
                                // tool call is in flight; resolving on it would drop the final answer.
                                if (activeToolCallIds.size > 0) {
                                    logDebug('Ignoring intermediate stop while tools are active', {
                                        sessionId,
                                        activeTools: activeToolCallIds.size
                                    });
                                    continue;
                                }
                                if (!finished) {
                                    finished = true;
                                    clearTimeout(timeoutId);
                                    if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                                    if (idleTimer) clearTimeout(idleTimer);
                                    releaseClientSignal();
                                    logDebug('SSE completed', {
                                        sessionId,
                                        ms: Date.now() - startedAt,
                                        deltaChars
                                    });
                                    resolve({ content, reasoning, usage: reportedUsage });
                                }
                                break;
                            }
                        }
                    }
                } catch (e) {
                    if (!finished) {
                        finished = true;
                        clearTimeout(timeoutId);
                        if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                        if (idleTimer) clearTimeout(idleTimer);
                        releaseClientSignal();
                        reject(e);
                    }
                }
            })();
        });

        try {
            return await finishPromise;
        } finally {
            controller.abort();
        }
    }

    // Chat completions endpoint
    app.post('/v1/chat/completions', async (req, res) => {
        try {
            await lock(async () => {
                let sessionId = null;
                // Set inside the try below; the catch must be able to read it to
                // drop the affinity mapping when a turn fails mid-flight.
                let affinitySignal = null;
                let eventStream = null;
                let stream = false;
                let pID = 'opencode';
                let mID = 'kimi-k2.5-free';
                let id = `chatcmpl-${crypto.randomUUID()}`;
                let keepaliveInterval = null;
                // Flipped as soon as the caller is gone: the turn is aborted
                // upstream and no fallback work is started for a response that
                // has nowhere to go. Declared out here because the fallback runs
                // after the collectors return.
                let clientGone = false;
                let abortIssued = false;
                // Idempotent: the close handler and the request cleanup both want
                // the backend to stop, and one abort is enough.
                const abortBackendTurn = () => {
                    if (!sessionId || abortIssued) return;
                    abortIssued = true;
                    Promise.resolve()
                        .then(() => client.session.abort({ path: { id: sessionId } }))
                        .catch((e) => logDebug('Failed to abort canceled backend turn', { sessionId, error: e.message }));
                };
                const clientAbort = new AbortController();
                // The signal aborts this request's own backend call; the session
                // itself needs an explicit abort, because a backend that is
                // mid-generation does not notice a dropped HTTP client. Do that
                // here (not in the request path) so it happens even when the
                // request is parked in an await.
                res.on('close', () => {
                    if (res.writableEnded) return;
                    clientGone = true;
                    clientAbort.abort();
                    if (sessionId) abortBackendTurn();
                });
                // One cleanup for every "the caller left" exit: stop the backend
                // turn, then drop the session. An aborted turn leaves a
                // half-written assistant message that would poison the next
                // prompt on that session, and with affinity on it must also be
                // dropped from the map first.
                const abortCanceledTurn = async () => {
                    logDebug('Client gone, aborting backend turn', { sessionId });
                    abortBackendTurn();
                    if (affinitySignal) chatSessionEntryDrop(affinitySignal, sessionId);
                    try {
                        await client.session.delete({ path: { id: sessionId } });
                    } catch (e) {
                        logDebug('Failed to cleanup canceled session:', e.message);
                    }
                };
                let canceledHandled = false;

                try {
                    const { messages, model, tools = [], tool_choice, stream: requestStream, temperature, max_tokens, top_p, frequency_penalty, presence_penalty, stop, reasoning_effort, reasoning, opencode: requestOpencodeConfig } = req.body;
                    stream = Boolean(requestStream);
                    // Multi-user metering: count the request against the key that
                    // authenticated it (even when the turn later fails — failed
                    // requests count toward `requests` but never toward tokens).
                    keyUsage.trackRequest(req.apiKeyName);
                    let usageMetered = false;
                    const meterUsage = ({ promptTokens, completionTokens }) => {
                        if (usageMetered) return;
                        usageMetered = true;
                        keyUsage.trackUsage(req.apiKeyName, { promptTokens, completionTokens });
                    };
                    if (!messages || !Array.isArray(messages) || messages.length === 0) {
                        return res.status(400).json({ error: { message: 'messages array is required' } });
                    }

                    const reasoningLevel = normalizeReasoningEffort(
                        reasoning_effort || reasoning?.effort,
                        null
                    );

                    const requestParams = {
                        temperature: typeof temperature === 'number' ? temperature : 0.7,
                        max_tokens: typeof max_tokens === 'number' ? max_tokens : null,
                        top_p: typeof top_p === 'number' ? top_p : 1.0,
                        frequency_penalty: typeof frequency_penalty === 'number' ? frequency_penalty : 0,
                        presence_penalty: typeof presence_penalty === 'number' ? presence_penalty : 0,
                        stop: Array.isArray(stop) ? stop : (stop ? [stop] : null),
                        reasoning_effort: reasoningLevel
                    };

                    logDebug('Request params', { temperature: requestParams.temperature, max_tokens: requestParams.max_tokens, top_p: requestParams.top_p, reasoning_effort: reasoningLevel });

                    const resolvedModel = await resolveRequestedModel(model);
                    pID = resolvedModel.providerID;
                    mID = resolvedModel.modelID;
                    if (resolvedModel.aliasFrom) {
                        logDebug('Resolved model alias', { from: resolvedModel.aliasFrom, to: resolvedModel.resolved });
                    }

                    const normalizeMessageContent = (content) => normalizeTextContent(content);

                    const buildPromptParts = async (rawMessages, externalToolRegistry = []) => {
                        const parts = [];
                        const systemChunks = [];
                        const userContents = [];
                        const assistantToolCalls = new Map();
                        const formatRoleLine = (role, name, text) => {
                            const roleLabel = role.toUpperCase();
                            const nameSuffix = name ? `(${name})` : '';
                            return `${roleLabel}${nameSuffix}: ${text}`;
                        };
                        
                        for (const m of rawMessages) {
                            const role = (m?.role || 'user').toLowerCase();
                            const content = m?.content;
                            
                            if (role === 'system') {
                                const text = normalizeMessageContent(content);
                                if (text) systemChunks.push(text);
                                continue;
                            }
                            
                            if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
                                const serializedToolCalls = m.tool_calls.map((toolCall, index) => ({
                                    id: toolCall?.id || `call_${index + 1}`,
                                    name: findExternalToolByName(externalToolRegistry, toolCall?.function?.name || toolCall?.name)?.namespacedName || toolCall?.function?.name || toolCall?.name,
                                    arguments: normalizeToolArguments(toolCall?.function?.arguments ?? toolCall?.arguments)
                                })).filter((toolCall) => toolCall.name);
                                if (serializedToolCalls.length) {
                                    serializedToolCalls.forEach((toolCall) => {
                                        assistantToolCalls.set(toolCall.id, toolCall.name);
                                    });
                                    parts.push({
                                        type: 'text',
                                        text: `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`
                                    });
                                }
                            }

                            if (role === 'tool') {
                                const text = normalizeMessageContent(content);
                                if (text) {
                                    const mappedTool = findExternalToolByName(externalToolRegistry, m?.name)
                                        || findExternalToolByName(externalToolRegistry, assistantToolCalls.get(m?.tool_call_id));
                                    const toolName = mappedTool?.namespacedName || assistantToolCalls.get(m?.tool_call_id) || m?.name || `${EXTERNAL_TOOL_PREFIX}unknown`;
                                    const toolCallId = m?.tool_call_id || `call_${toolName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                                    parts.push({
                                        type: 'text',
                                        text: `TOOL_RESULT: ${JSON.stringify({ tool_call_id: toolCallId, name: toolName, content: text })}`
                                    });
                                }
                                continue;
                            }

                            if (!content) continue;

                            if (typeof content === 'string') {
                                if (role === 'user') userContents.push(content);
                                parts.push({
                                    type: 'text',
                                    text: formatRoleLine(role, m?.name, content)
                                });
                            } else if (Array.isArray(content)) {
                                for (const part of content) {
                                    if (!part) continue;
                                    
                                    if (part.type === 'text') {
                                        const text = part.text || '';
                                        if (role === 'user') userContents.push(text);
                                        parts.push({
                                            type: 'text',
                                            text: formatRoleLine(role, m?.name, text)
                                        });
                                    } else if (part.type === 'image_url') {
                                        const imageUrl = typeof part.image_url === 'string' 
                                            ? part.image_url 
                                            : part.image_url?.url;
                                        if (imageUrl) {
                                            try {
                                                const dataUri = await getImageDataUri(imageUrl);
                                                const mime = dataUri.split(';')[0].split(':')[1];
                                                parts.push({
                                                    type: 'file',
                                                    mime: mime,
                                                    url: dataUri,
                                                    filename: 'image'
                                                });
                                            } catch (imgErr) {
                                                console.warn('[Proxy] Skipping image due to error:', imgErr.message);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        
                        return {
                            parts,
                            system: systemChunks.join('\n\n'),
                            fullPromptText: parts.map(p => p.text).join('\n\n'),
                            lastUserMsg: userContents[userContents.length - 1] || ''
                        };
                    };

                    const requestToolContext = createRequestToolContext(tools, tool_choice, requestOpencodeConfig);
                    const toolMode = requestToolContext.mode;
                    const externalToolContext = requestToolContext.external;
                    const externalToolRegistry = externalToolContext.registry;
                    const externalToolChoice = externalToolContext.toolChoice;
                    const internalToolContext = requestToolContext.internal;
            trackToolMode(toolMode, {
                configuredAllowlist: internalToolContext.allowedToolNames,
                requestedAllowlist: internalToolContext.requestedAllowlist,
                deniedRequestedTools: internalToolContext.deniedRequestedTools,
                resolutionPath: internalToolContext.resolutionPath,
                resultingMode: internalToolContext.resultingMode,
                route: '/v1/chat/completions'
            });

                    const { parts, system: systemMsg, fullPromptText, lastUserMsg } = await buildPromptParts(messages, externalToolRegistry);
                    const systemWithGuard = buildSystemPrompt(
                        [systemMsg, externalToolContext.prompt].filter(Boolean).join('\n\n'),
                        requestParams.reasoning_effort,
                        toolMode,
                        internalToolContext.allowedToolNames
                    );
                    if (!parts.length) {
                        return res.status(400).json({ error: { message: 'messages must include at least one non-system text message' } });
                    }
                    logDebug('Request start', {
                        model: `${pID}/${mID}`,
                        stream: Boolean(stream),
                        userMessages: messages.length,
                        system: Boolean(systemMsg),
                        lastUserLength: lastUserMsg?.length || 0,
                        parts: parts.length,
                        disableTools: DISABLE_TOOLS,
                        toolMode,
                        internalAllowedTools: internalToolContext.allowedToolNames,
                        requestedInternalTools: internalToolContext.requestedAllowlist,
                        deniedRequestedTools: internalToolContext.deniedRequestedTools,
                        resolutionPath: internalToolContext.resolutionPath,
                        resultingMode: internalToolContext.resultingMode
                    });

                    // Ensure backend is running
                    await ensureBackend(config);

                    // Set active model
                    try {
                        await client.config.update({
                            body: {
                                activeModel: { providerID: pID, modelID: mID }
                            }
                        });
                    } catch (confError) {
                        logDebug('Failed to set active model:', confError.message);
                    }

                    // Create session; with the tool-lock plugin its title carries the tool policy
                    const toolControl = await resolveToolControl(toolMode, internalToolContext);

                    // Session affinity: resume this conversation's backend session when the
                    // client is appending turns (its prompt is the same user-turn sequence
                    // the session already served, so the new turns are the suffix) and
                    // system prompt, tool policy and model are unchanged. Anything else —
                    // an assistant/tool rewrite, a policy switch, a model change, a
                    // concurrent second turn, a reused signal — falls back to a fresh
                    // session with the full history, which keeps the exact
                    // pre-affinity semantics.
                    let reuseSessionId = null;
                    let reuseUserTurns = null;
                    let reuseParts = null;
                    let signal = null;
                    if (CHAT_SESSION_AFFINITY) {
                        signal = chatSessionSignalOf(req, req.body);
                        if (signal) {
                            const entry = chatSessions.get(signal);
                            if (entry && entry.expiresAt > Date.now() && !entry.pending
                                && entry.model === `${pID}/${mID}`
                                && entry.system === (systemWithGuard || '')
                                && entry.toolPolicy === toolControl.title
                                && entry.toolOverridesJson === JSON.stringify(toolControl.toolOverrides ?? null)) {
                                const turns = chatUserTurnsOf(parts);
                                if (turns && turns.length > entry.userTurns.length
                                    && entry.userTurns.every((t, i) => t === turns[i])) {
                                    reuseSessionId = entry.sessionId;
                                    reuseUserTurns = turns;
                                    // Only the turns the session has not served yet go upstream;
                                    // the recorded prefix is already in the session (and its
                                    // upstream prompt cache).
                                    reuseParts = parts.slice(entry.userTurns.length);
                                }
                            }
                        }
                    }

                    if (reuseSessionId) {
                        sessionId = reuseSessionId;
                        logDebug('Chat session resumed', { sessionId });
                    } else {
                        sessionId = await createSession(toolControl);
                        if (CHAT_SESSION_AFFINITY) {
                            signal = signal || chatSessionSignalOf(req, req.body);
                            if (signal) {
                                const turns = chatUserTurnsOf(parts);
                                if (turns) {
                                    affinitySignal = signal;
                                    chatSessionEntryStore(signal, sessionId, turns, systemWithGuard, toolControl.title, toolControl.toolOverrides, `${pID}/${mID}`);
                                }
                            }
                        }
                    }
                    logDebug('Session created', { sessionId });

                    id = `chatcmpl-${crypto.randomUUID()}`;
                    keepaliveInterval = null;
                    let completionTokens = 0;
                    let reasoningTokens = 0;
                    // Real counts reported by the backend for this turn, when it
                    // reported any; the estimators below only fill the gaps.
                    let reportedUsage = null;

                    const promptParams = {
                        path: { id: sessionId },
                        body: {
                            model: { providerID: pID, modelID: mID },
                            system: systemWithGuard,
                            // Append a short contract reminder as the last part so the model
                            // sees it immediately before generating. With the contract only in
                            // the 16KB+ system prompt it gets buried; position matters a lot for
                            // compliance. deepseek-v4-flash-free: 50% → 100% call rate.
                            parts: externalToolContext.reminder
                                ? [...(reuseParts || parts), { type: 'text', text: externalToolContext.reminder }]
                                : (reuseParts || parts),
                            ...(requestParams.max_tokens && { max_tokens: requestParams.max_tokens }),
                            ...(requestParams.temperature !== undefined && { temperature: requestParams.temperature }),
                            ...(requestParams.top_p !== undefined && { top_p: requestParams.top_p }),
                            ...(requestParams.stop && { stop: requestParams.stop })
                        },
                        // Aborts the HTTP call itself when the client goes away, so
                        // the backend stops generating instead of finishing work
                        // nobody will read (and stops holding the lock queue).
                        signal: clientAbort.signal
                    };
                    const { toolOverrides } = toolControl;
                    if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                        promptParams.body.tools = toolOverrides;
                    }

                    const makeForcedChatToolCallRequester = () => createForcedToolCallRequester({
                        mode: externalToolChoice.mode,
                        sessionId,
                        systemWithGuard,
                        requiredTool: externalToolChoice.requiredTool || externalToolRegistry[0]?.namespacedName,
                        providerID: pID,
                        modelID: mID,
                        toolOverrides,
                        requestTimeoutMs: REQUEST_TIMEOUT_MS,
                        forbidThinkBlock: true
                    });
                    let requestForcedChatToolCall = makeForcedChatToolCallRequester();

                    res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');

                    if (stream) {
                        const shouldStripStreamingToolMarkup = externalToolRegistry.length > 0;
                        const filterContentDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup });
                        const filterReasoningDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup });
                        const parseContentToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
                        const parseReasoningToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
                        let streamedContent = '';
                        let streamedReasoning = '';
                        let rawStreamedContent = '';
                        let rawStreamedReasoning = '';
                        const streamedToolCalls = [];
                        keepaliveInterval = null;
                        completionTokens = 0;
                        reasoningTokens = 0;

                        const ensureKeepalive = () => {
                            if (!keepaliveInterval) {
                                keepaliveInterval = setInterval(() => {
                                    if (!res.destroyed) {
                                        res.write(': keepalive\n\n');
                                    }
                                }, 15000);
                            }
                        };
                        ensureKeepalive();

                        const sendDelta = (delta, isReasoning = false) => {
                            if (!delta) return;
                            if (isReasoning) rawStreamedReasoning += delta;
                            else rawStreamedContent += delta;
                            const parsedDeltaToolCalls = isReasoning
                                ? parseReasoningToolCalls(delta)
                                : parseContentToolCalls(delta);
                            parsedDeltaToolCalls.forEach((toolCall) => {
                                streamToolCallsSeen = true;
                                streamedToolCalls.push(toolCall);
                                res.write(`data: ${JSON.stringify({
                                    id,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model: `${pID}/${mID}`,
                                    choices: [{
                                        index: 0,
                                        delta: {
                                            tool_calls: [{
                                                index: streamedToolCalls.length - 1,
                                                id: toolCall.id,
                                                type: 'function',
                                                function: {
                                                    name: toolCall.function.name,
                                                    arguments: toolCall.function.arguments
                                                }
                                            }]
                                        },
                                        finish_reason: null
                                    }]
                                })}\n\n`);
                            });
                            const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                            if (!filtered) return;
                            if (isReasoning) {
                                streamedReasoning += filtered;
                                reasoningTokens += Math.ceil(filtered.length / 4);
                            } else {
                                streamedContent += filtered;
                                completionTokens += Math.ceil(filtered.length / 4);
                            }
                            // Reasoning and answer are streamed as separate fields so clients
                            // that read `reasoning_content` (DeepSeek/Qwen-style) see the thinking
                            // without it polluting `content`.
                            const deltaField = isReasoning
                                ? { reasoning_content: filtered }
                                : { content: filtered };
                            const chunk = {
                                id,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: `${pID}/${mID}`,
                                choices: [{ index: 0, delta: deltaField, finish_reason: null }]
                            };
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        };

                        let collected = null;
                        let streamToolCallsSeen = false;
                        for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
                            if (attempt > 1) {
                                // Retry on a fresh session: the failed attempt left an errored
                                // assistant message in the old one, and re-prompting the same
                                // session would append a duplicate user turn to the context.
                                // Safe to rotate because nothing has been streamed yet.
                                if (affinitySignal) chatSessionEntryDrop(affinitySignal, sessionId);
                                try {
                                    await client.session.delete({ path: { id: sessionId } });
                                } catch (e) {
                                    logDebug('Failed to delete retried session', { sessionId, error: e.message });
                                }
                                sessionId = await createSession(toolControl);
                                promptParams.path.id = sessionId;
                                requestForcedChatToolCall = makeForcedChatToolCallRequester();
                                streamedContent = '';
                                streamedReasoning = '';
                                rawStreamedContent = '';
                                rawStreamedReasoning = '';
                                streamedToolCalls.length = 0;
                                completionTokens = 0;
                                reasoningTokens = 0;
                                await sleep(RETRY_BACKOFF_BASE_MS * attempt);
                            }
                            try {
                                const collectPromise = collectFromEvents(
                                    sessionId,
                                    REQUEST_TIMEOUT_MS,
                                    sendDelta,
                                    EVENT_FIRST_DELTA_TIMEOUT_MS,
                                    EVENT_IDLE_TIMEOUT_MS,
                                    {
                                        signal: clientAbort.signal,
                                        onUsage: (usage) => { reportedUsage = usage; }
                                    }
                                );
                                const safeCollect = collectPromise.catch((err) => ({ __error: err }));
                                client.session.prompt(promptParams).catch(err => logDebug('Prompt error:', err.message));
                                collected = await safeCollect;
                            } catch (e) {
                                logDebug('Stream error:', e.message);
                            }
                            if (collected?.clientGone) clientGone = true;
                            if (clientGone) break;

                            const attemptError = collected?.error || collected?.__error || null;
                            const nothingStreamed = !rawStreamedContent
                                && !rawStreamedReasoning
                                && streamedToolCalls.length === 0;
                            if (
                                attemptError
                                && nothingStreamed
                                && attempt < RETRY_MAX_ATTEMPTS
                                && isTransientUpstreamError(attemptError)
                            ) {
                                console.warn(`[Proxy] Transient upstream error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying:`, attemptError.data?.message || attemptError.message || attemptError.name || 'unknown');
                                continue;
                            }
                            break;
                        }

                        // Every fallback below re-reads the session through polling.
                        // With the caller gone there is nobody to stream to and the
                        // turn was aborted, so re-running it would be pure cost.
                        if (collected && collected.__error && !clientGone) {
                            logDebug('SSE collect error, falling back to polling', {
                                sessionId,
                                error: collected.__error?.message
                            });
                            const polled = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            if (polled.usage) reportedUsage = polled.usage;
                            const { content, reasoning, error } = polled;
                            if (error && !content && !reasoning) {
                                sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                            } else {
                                if (reasoning) sendDelta(reasoning, true);
                                if (content) sendDelta(content, false);
                            }
                        } else if (collected && collected.noData && !clientGone) {
                            logDebug('Fallback to polling (stream)', { sessionId });
                            const polled = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            if (polled.usage) reportedUsage = polled.usage;
                            const { content, reasoning, error } = polled;
                            if (error && !content && !reasoning) {
                                sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                            } else {
                                if (reasoning) sendDelta(reasoning, true);
                                if (content) sendDelta(content, false);
                            }
                        } else if (collected && collected.idleTimeout && !clientGone) {
                            logDebug('SSE idle timeout, polling for completion', { sessionId });
                            const polled = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            if (polled.usage) reportedUsage = polled.usage;
                            const { content, reasoning, error } = polled;
                            if (error && !content && !reasoning) {
                                sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                            } else {
                                const remainingReasoning = reasoning && reasoning.startsWith(rawStreamedReasoning)
                                    ? reasoning.slice(rawStreamedReasoning.length)
                                    : reasoning;
                                const remainingContent = content && content.startsWith(rawStreamedContent)
                                    ? content.slice(rawStreamedContent.length)
                                    : content;
                                if (remainingReasoning) sendDelta(remainingReasoning, true);
                                if (remainingContent) sendDelta(remainingContent, false);
                            }
                        }

                        if (collected && !streamedContent && !streamedReasoning && (collected.reasoning || collected.content)) {
                            if (collected.reasoning) sendDelta(collected.reasoning, true);
                            if (collected.content) sendDelta(collected.content, false);
                        }

                        if (!streamedContent && !streamedReasoning && !clientGone) {
                            logDebug('SSE returned empty, falling back to polling', { sessionId });
                            const polled = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            if (polled.usage) reportedUsage = polled.usage;
                            const { content, reasoning, error } = polled;
                            if (error && !content && !reasoning) {
                                sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                            } else {
                                if (reasoning) sendDelta(reasoning, true);
                                if (content) sendDelta(content, false);
                            }
                        } else if (streamedReasoning && !streamedContent) {
                            // Reconciliation for reasoning models: the reasoning streamed but the
                            // answer text never arrived because every delta was tagged as reasoning
                            // (issue #9). The message snapshot separates the two correctly, so
                            // recover the missing answer from it instead of returning empty content.
                            logDebug('Reasoning streamed but no content, reconciling from snapshot', { sessionId });
                            const snapshot = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS).catch(() => null);
                            if (snapshot && snapshot.content) {
                                const remainingContent = rawStreamedContent
                                    ? snapshot.content.slice(rawStreamedContent.length)
                                    : snapshot.content;
                                if (remainingContent) sendDelta(remainingContent, false);
                            }
                        }

                        // Flush held buffers from the stream parsers and filters before final batch parse.
                        const flushedReasoningCalls = parseReasoningToolCalls.flush ? parseReasoningToolCalls.flush() : [];
                        const flushedContentCalls = parseContentToolCalls.flush ? parseContentToolCalls.flush() : [];
                        const flushedReasoningText = filterReasoningDelta.flush ? filterReasoningDelta.flush() : '';
                        const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : '';
                        const finalReasoningText = rawStreamedReasoning + flushedReasoningText;
                        const finalContentText = rawStreamedContent + flushedContentText;

                        // Parse each channel, then retry on the two joined. Models sometimes open a
                        // block in reasoning and close it in content, leaving neither channel with a
                        // complete block. The joined retry only runs when nothing was found, so a
                        // block contained in one channel is never counted twice.
                        const parseStreamedToolCalls = () => {
                            if (externalToolRegistry.length === 0) return [];
                            const perChannel = [
                                ...flushedReasoningCalls,
                                ...flushedContentCalls,
                                ...parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText, finalContentText)
                            ];
                            if (perChannel.length > 0) return perChannel;
                            return parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText + finalContentText);
                        };

                        let parsedToolCalls = streamedToolCalls.length > 0
                            ? streamedToolCalls
                            : parseStreamedToolCalls();
                        if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                            const forcedResponse = await requestForcedChatToolCall();
                            if (forcedResponse) {
                                parsedToolCalls = parseExternalToolCallsFromText(
                                    externalToolRegistry,
                                    forcedResponse.reasoning,
                                    forcedResponse.content
                                );
                            }
                        }
                        const { validCalls: validatedStreamedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
                        const finalStreamedToolCalls = validatedStreamedToolCalls;
                        if (finalStreamedToolCalls.length > 0 && streamedToolCalls.length === 0) {
                            const toolCallDeltas = finalStreamedToolCalls.map((toolCall, index) => ({
                                index,
                                id: toolCall.id,
                                type: 'function',
                                function: {
                                    name: toolCall.function.name,
                                    arguments: toolCall.function.arguments
                                }
                            }));
                            res.write(`data: ${JSON.stringify({
                                id,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: `${pID}/${mID}`,
                                choices: [{
                                    index: 0,
                                    delta: { tool_calls: toolCallDeltas },
                                    finish_reason: null
                                }]
                            })}\n\n`);
                        }

                        if (keepaliveInterval) clearInterval(keepaliveInterval);

                        // Nothing below can reach a caller that left; stop the
                        // backend turn now so it does not keep generating (and
                        // holding the lock queue) for the rest of the timeout.
                        if (clientGone) {
                            await abortCanceledTurn();
                            canceledHandled = true;
                            return;
                        }

                        if (affinitySignal && !streamToolCallsSeen) {
                            chatSessionEntryComplete(affinitySignal, sessionId, [...(reuseUserTurns || []), lastUserMsg]);
                        } else if (affinitySignal) {
                            chatSessionEntryFail(affinitySignal, sessionId);
                        }
                        // Usage reflects only what was sent upstream: a resumed
                        // turn transmits just the new turns, not the history the
                        // session's prompt cache already holds. Real counts from
                        // the backend win; the character estimate only fills in
                        // when it reported none.
                        const billedPromptText = reuseParts ? reuseParts.map((p) => p.text || '').join('\n\n') : fullPromptText;
                        const promptTokens = reportedUsage
                            ? reportedUsage.promptTokens
                            : Math.ceil((billedPromptText || '').length / 4);
                        const completionReported = reportedUsage
                            ? reportedUsage.completionTokens + reportedUsage.reasoningTokens
                            : completionTokens + reasoningTokens;
                        const reasoningReported = reportedUsage ? reportedUsage.reasoningTokens : reasoningTokens;
                        const totalTokens = promptTokens + completionReported;
                        meterUsage({ promptTokens, completionTokens: completionReported });

                        res.write(`data: ${JSON.stringify({ 
                            id, 
                            choices: [{ index: 0, delta: {}, finish_reason: finalStreamedToolCalls.length > 0 ? 'tool_calls' : 'stop' }],
                            usage: {
                                prompt_tokens: promptTokens,
                                completion_tokens: completionReported,
                                total_tokens: totalTokens,
                                completion_tokens_details: {
                                    reasoning_tokens: reasoningReported
                                }
                            }
                        })}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } else {
                        let content = '';
                        let reasoning = '';
                        let error = null;
                        for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
                            if (attempt > 1) {
                                // Retry on a fresh session: the failed attempt left an errored
                                // assistant message in the old one, and re-prompting the same
                                // session would append a duplicate user turn to the context.
                                if (affinitySignal) chatSessionEntryDrop(affinitySignal, sessionId);
                                try {
                                    await client.session.delete({ path: { id: sessionId } });
                                } catch (e) {
                                    logDebug('Failed to delete retried session', { sessionId, error: e.message });
                                }
                                sessionId = await createSession(toolControl);
                                promptParams.path.id = sessionId;
                                requestForcedChatToolCall = makeForcedChatToolCallRequester();
                                await sleep(RETRY_BACKOFF_BASE_MS * attempt);
                            }
                            if (clientGone) break;
                            const attemptStart = Date.now();
                            await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
                            logDebug('Prompt sent', { sessionId, ms: Date.now() - attemptStart, attempt });
                            const collected = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            content = collected.content || '';
                            reasoning = collected.reasoning || '';
                            error = collected.error || null;
                            if (collected.usage) reportedUsage = collected.usage;
                            // Bounded retry for upstream throttling mislabeled as billing
                            // errors (401 CreditsError etc.); only when nothing usable was
                            // produced, so real failures still surface after RETRY_MAX_ATTEMPTS.
                            if (
                                error
                                && !content
                                && !reasoning
                                && attempt < RETRY_MAX_ATTEMPTS
                                && isTransientUpstreamError(error)
                            ) {
                                console.warn(`[Proxy] Transient upstream error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying:`, error.data?.message || error.message || error.name || 'unknown');
                                continue;
                            }
                            break;
                        }
                        if (clientGone) {
                            // Nothing left to answer: stop the backend turn here
                            // and let the error path keep session cleanup in one
                            // place.
                            logDebug('Client disconnected before the non-streaming reply', { sessionId });
                            await abortCanceledTurn();
                            canceledHandled = true;
                            return;
                        }
                        if (error && !content && !reasoning) {
                            if (affinitySignal) await chatSessionEntryFail(affinitySignal, sessionId);
                            return res.status(502).json({
                                error: {
                                    message: error.data?.message || error.message || 'OpenCode provider error',
                                    type: error.name || 'OpenCodeError'
                                }
                            });
                        }
                        let parsedToolCalls = externalToolRegistry.length > 0
                            ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                            : [];
                        if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                            const forcedResponse = await requestForcedChatToolCall();
                            if (forcedResponse) {
                                content = forcedResponse.content || content;
                                reasoning = forcedResponse.reasoning || reasoning;
                                parsedToolCalls = parseExternalToolCallsFromText(externalToolRegistry, reasoning, content);
                            }
                        }
                        const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
                        const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
                        const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));

                        if (affinitySignal && validatedToolCalls.length === 0) {
                            chatSessionEntryComplete(affinitySignal, sessionId, [...(reuseUserTurns || []), lastUserMsg]);
                        } else if (affinitySignal) {
                            chatSessionEntryFail(affinitySignal, sessionId);
                        }

                        // Usage reflects only what was sent upstream: a resumed
                        // turn transmits just the new turns, not the history the
                        // session's prompt cache already holds. Real counts from
                        // the backend win; the character estimate fills in only
                        // when it reported none.
                        const billedPromptText = reuseParts ? reuseParts.map((p) => p.text || '').join('\n\n') : fullPromptText;
                        const promptTokens = reportedUsage
                            ? reportedUsage.promptTokens
                            : Math.ceil((billedPromptText || '').length / 4);
                        const completionTokensCalc = reportedUsage
                            ? reportedUsage.completionTokens
                            : Math.ceil((content || '').length / 4);
                        const reasoningTokensCalc = reportedUsage
                            ? reportedUsage.reasoningTokens
                            : Math.ceil((reasoning || '').length / 4);
                        const totalTokens = promptTokens + completionTokensCalc + reasoningTokensCalc;
                        meterUsage({ promptTokens, completionTokens: completionTokensCalc + reasoningTokensCalc });

                        const publicValidatedToolCalls = toPublicToolCalls(validatedToolCalls);
                        // Reasoning is emitted in its own `reasoning_content` field so clients
                        // can surface the thinking without it being wrapped in <think> tags and
                        // mixed into the answer `content`.
                        const assistantMessage = {
                            role: 'assistant',
                            content: publicValidatedToolCalls.length > 0
                                ? (safeContent || null)
                                : safeContent,
                            ...(safeReasoning ? { reasoning_content: safeReasoning } : {})
                        };
                        if (publicValidatedToolCalls.length > 0) {
                            assistantMessage.tool_calls = publicValidatedToolCalls;
                        }

                        res.json({
                            id: `chatcmpl-${crypto.randomUUID()}`,
                            object: 'chat.completion',
                            created: Math.floor(Date.now() / 1000),
                            model: `${pID}/${mID}`,
                            choices: [{
                                index: 0,
                                message: assistantMessage,
                                finish_reason: publicValidatedToolCalls.length > 0 ? 'tool_calls' : 'stop'
                            }],
                            usage: {
                                prompt_tokens: promptTokens,
                                completion_tokens: completionTokensCalc + reasoningTokensCalc,
                                total_tokens: totalTokens,
                                completion_tokens_details: {
                                    reasoning_tokens: reasoningTokensCalc
                                }
                            }
                        });
                    }
                } catch (error) {
                    console.error('[Proxy] API Error:', error.message);
                    console.error('[Proxy] Error details:', error);

                    if (keepaliveInterval) clearInterval(keepaliveInterval);

                    if (!res.headersSent) {
                        const transformed = transformUpstreamError(error);
                        res.status(transformed.statusCode).json(transformed.error);
                    } else if (!res.destroyed) {
                        res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
                        res.end();
                    }
                    if (sessionId) {
                        if (clientGone) {
                            // Caller left and the turn was canceled: stop the
                            // backend and drop the poisoned session. Already done
                            // when the request returned early from a non-streaming
                            // cancel.
                            if (!canceledHandled) await abortCanceledTurn();
                            return;
                        }
                        // With affinity on, an exception mid-turn also poisons the
                        // backend session: drop the mapping before deleting so the
                        // next turn starts a clean session with full history.
                        if (affinitySignal) chatSessionEntryDrop(affinitySignal, sessionId);
                        try {
                            await client.session.delete({ path: { id: sessionId } });
                        } catch (e) {
                            console.error('[Proxy] Failed to cleanup session on error:', e.message);
                        }
                    }
                } finally {
                    if (typeof keepaliveInterval !== 'undefined' && keepaliveInterval) clearInterval(keepaliveInterval);
                    if (eventStream && eventStream.close) {
                        eventStream.close();
                    }
                }
            }, REQUEST_TIMEOUT_MS + 20000);
        } catch (error) {
            console.error('[Proxy] Request Handler Error:', error.message);
            if (!res.headersSent) {
                res.status(500).json({ error: { message: error.message, type: error.constructor.name } });
            }
        }
    });

    const resolveDiagnosticsCaller = (req) => {
        if (!adminAuthEnabled && !multiUserEnabled) {
            return { allowed: true, role: 'admin', keyName: null };
        }
        const token = extractBearerToken(req);
        if (adminAuthEnabled && token && safeTokenEquals(token, API_KEY.trim())) {
            return { allowed: true, role: 'admin', keyName: MASTER_KEY_NAME };
        }
        const matchedUserKeyName = findMatchingUserKeyName(token);
        if (matchedUserKeyName) {
            return { allowed: true, role: 'user', keyName: matchedUserKeyName };
        }
        if (PUBLIC_DIAGNOSTICS) {
            return { allowed: true, role: 'public', keyName: null };
        }
        return { allowed: false, role: 'none', keyName: null };
    };

    const shouldAllowOperationalEndpoint = (req, { enabled }) => {
        if (!enabled) return false;
        return resolveDiagnosticsCaller(req).allowed;
    };

    // Anthropic Messages API endpoint
    app.post('/v1/messages', async (req, res) => {
        try {
            await lock(async () => {
                let sessionId = null;
                let id = `msg_${crypto.randomUUID()}`;
                let keepaliveInterval = null;
                let stream = false;
                let pID = 'opencode';
                let mID = 'kimi-k2.5-free';
                // See the Chat handler: stop generating for a caller that left.
                let clientGone = false;
                // Real counts reported by the backend, when it reported any.
                let reportedUsage = null;
                let abortIssued = false;
                const abortBackendTurn = () => {
                    if (!sessionId || abortIssued) return;
                    abortIssued = true;
                    Promise.resolve()
                        .then(() => client.session.abort({ path: { id: sessionId } }))
                        .catch((e) => logDebug('Failed to abort canceled Anthropic backend turn', { sessionId, error: e.message }));
                };
                const clientAbort = new AbortController();
                // See the Chat handler: the backend session needs an explicit
                // abort on top of dropping this request's own call.
                res.on('close', () => {
                    if (res.writableEnded) return;
                    clientGone = true;
                    clientAbort.abort();
                    if (sessionId) abortBackendTurn();
                });

                const anthropicError = (statusCode, type, message) => res.status(statusCode).json({
                    type: 'error',
                    error: { type, message }
                });

                // See the Chat handler: one cleanup for every "caller left" exit.
                const abortCanceledTurn = async () => {
                    logDebug('Client gone, aborting Anthropic backend turn', { sessionId });
                    abortBackendTurn();
                    try {
                        await client.session.delete({ path: { id: sessionId } });
                    } catch (e) {
                        logDebug('Failed to cleanup canceled Anthropic session:', e.message);
                    }
                };
                let canceledHandled = false;

                try {
                    const body = req.body || {};
                    const { model, messages, system, stream: requestStream } = body;
                    stream = Boolean(requestStream);
                    keyUsage.trackRequest(req.apiKeyName);
                    let usageMetered = false;
                    const meterUsage = ({ promptTokens, completionTokens }) => {
                        if (usageMetered) return;
                        usageMetered = true;
                        keyUsage.trackUsage(req.apiKeyName, { promptTokens, completionTokens });
                    };

                    if (!Array.isArray(messages) || messages.length === 0) {
                        return anthropicError(400, 'invalid_request_error', 'messages: messages must be a non-empty array');
                    }
                    if (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
                        return anthropicError(400, 'invalid_request_error', 'max_tokens: max_tokens is required and must be a positive integer');
                    }
                    if (!model || typeof model !== 'string') {
                        return anthropicError(400, 'invalid_request_error', 'model: model is required');
                    }

                    // Anthropic tool definitions -> OpenAI function shape
                    const tools = Array.isArray(body.tools)
                        ? body.tools.map((tool) => ({
                            type: 'function',
                            function: {
                                name: tool?.name,
                                description: tool?.description,
                                parameters: tool?.input_schema
                            }
                        })).filter((tool) => tool.function.name)
                        : [];

                    // Anthropic tool_choice -> OpenAI tool_choice
                    const rawToolChoice = body.tool_choice;
                    const disableParallelToolUse = Boolean(rawToolChoice && typeof rawToolChoice === 'object' && rawToolChoice.disable_parallel_tool_use === true);
                    let toolChoice;
                    if (rawToolChoice && typeof rawToolChoice === 'object') {
                        if (rawToolChoice.type === 'auto') toolChoice = 'auto';
                        else if (rawToolChoice.type === 'any') toolChoice = 'required';
                        else if (rawToolChoice.type === 'tool' && rawToolChoice.name) {
                            toolChoice = { type: 'function', function: { name: rawToolChoice.name } };
                        } else if (rawToolChoice.type === 'none') {
                            toolChoice = 'none';
                        }
                    } else if (rawToolChoice === 'auto' || rawToolChoice === 'required' || rawToolChoice === 'none') {
                        toolChoice = rawToolChoice;
                    }

                    const requestParams = {
                        max_tokens: body.max_tokens,
                        temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
                        top_p: typeof body.top_p === 'number' ? body.top_p : undefined,
                        stop: Array.isArray(body.stop_sequences) ? body.stop_sequences : undefined,
                        reasoning_effort: null
                    };

                    const resolvedModel = await resolveRequestedModel(model);
                    pID = resolvedModel.providerID;
                    mID = resolvedModel.modelID;
                    if (resolvedModel.aliasFrom) {
                        logDebug('Resolved model alias', { from: resolvedModel.aliasFrom, to: resolvedModel.resolved });
                    }

                    const buildAnthropicPromptParts = async (rawMessages, systemParam, externalToolRegistry = []) => {
                        const parts = [];
                        const systemChunks = [];
                        const userContents = [];
                        const assistantToolCalls = new Map();
                        const formatRoleLine = (role, text) => `${role.toUpperCase()}: ${text}`;

                        if (typeof systemParam === 'string' && systemParam.trim()) {
                            systemChunks.push(systemParam);
                        } else if (Array.isArray(systemParam)) {
                            const text = systemParam
                                .map((block) => (block && typeof block.text === 'string') ? block.text : '')
                                .filter(Boolean)
                                .join('\n\n');
                            if (text) systemChunks.push(text);
                        }

                        const pushImagePart = async (source) => {
                            let imageUrl = null;
                            let fallbackMime = 'image/jpeg';
                            if (source?.type === 'url' && typeof source.url === 'string') {
                                imageUrl = source.url;
                            } else if (source?.type === 'base64' && typeof source.data === 'string') {
                                fallbackMime = source.media_type || fallbackMime;
                                imageUrl = `data:${source.media_type || 'image/jpeg'};base64,${source.data}`;
                            }
                            if (!imageUrl) return;
                            try {
                                const dataUri = await getImageDataUri(imageUrl);
                                const mime = dataUri.split(';')[0].split(':')[1] || fallbackMime;
                                parts.push({ type: 'file', mime, url: dataUri, filename: 'image' });
                            } catch (imgErr) {
                                console.warn('[Proxy] Skipping image due to error:', imgErr.message);
                            }
                        };

                        for (const m of rawMessages) {
                            const role = m?.role === 'assistant' ? 'assistant' : 'user';
                            const content = m?.content;
                            const blocks = Array.isArray(content)
                                ? content
                                : (content !== undefined && content !== null && content !== '' ? [{ type: 'text', text: String(content) }] : []);

                            if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
                                const serializedToolCalls = m.tool_calls.map((toolCall, index) => ({
                                    id: toolCall?.id || `call_${index + 1}`,
                                    name: findExternalToolByName(externalToolRegistry, toolCall?.function?.name || toolCall?.name)?.namespacedName || toolCall?.function?.name || toolCall?.name,
                                    arguments: normalizeToolArguments(toolCall?.function?.arguments ?? toolCall?.arguments)
                                })).filter((toolCall) => toolCall.name);
                                if (serializedToolCalls.length) {
                                    serializedToolCalls.forEach((toolCall) => assistantToolCalls.set(toolCall.id, toolCall.name));
                                    parts.push({
                                        type: 'text',
                                        text: `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`
                                    });
                                }
                            }

                            for (const block of blocks) {
                                if (!block) continue;

                                if (role === 'assistant' && block.type === 'tool_use') {
                                    const name = findExternalToolByName(externalToolRegistry, block?.name)?.namespacedName || block?.name;
                                    if (!name) continue;
                                    const callId = block?.id || `call_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                                    assistantToolCalls.set(callId, name);
                                    parts.push({
                                        type: 'text',
                                        text: `ASSISTANT: <function_calls>${JSON.stringify([{
                                            id: callId,
                                            name,
                                            arguments: normalizeToolArguments(block?.input)
                                        }])}</function_calls>`
                                    });
                                    continue;
                                }

                                if (role === 'user' && block.type === 'tool_result') {
                                    const rawText = normalizeToolResultContent(block?.content);
                                    const text = block?.is_error && !rawText ? 'Tool execution error' : rawText;
                                    const mappedTool = findExternalToolByName(externalToolRegistry, block?.name)
                                        || findExternalToolByName(externalToolRegistry, assistantToolCalls.get(block?.tool_use_id));
                                    const fallbackSingleTool = !block?.tool_use_id && assistantToolCalls.size === 1
                                        ? Array.from(assistantToolCalls.values())[0]
                                        : null;
                                    const toolName = mappedTool?.namespacedName
                                        || assistantToolCalls.get(block?.tool_use_id)
                                        || block?.name
                                        || fallbackSingleTool
                                        || `${EXTERNAL_TOOL_PREFIX}unknown`;
                                    const toolCallId = block?.tool_use_id || `call_${toolName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                                    parts.push({
                                        type: 'text',
                                        text: `TOOL_RESULT: ${JSON.stringify({
                                            tool_call_id: toolCallId,
                                            name: toolName,
                                            content: text,
                                            ...(block?.is_error ? { is_error: true } : {})
                                        })}`
                                    });
                                    continue;
                                }

                                if (block.type === 'image') {
                                    await pushImagePart(block?.source);
                                    continue;
                                }

                                if (block.type === 'text' && block.text) {
                                    if (role === 'user') userContents.push(block.text);
                                    parts.push({ type: 'text', text: formatRoleLine(role, block.text) });
                                }
                            }
                        }

                        return {
                            parts,
                            system: systemChunks.join('\n\n'),
                            fullPromptText: parts.map(p => p.text).join('\n\n'),
                            lastUserMsg: userContents[userContents.length - 1] || ''
                        };
                    };

                    const requestToolContext = createRequestToolContext(tools, toolChoice, body.opencode);
                    const toolMode = requestToolContext.mode;
                    const externalToolContext = requestToolContext.external;
                    const externalToolRegistry = externalToolContext.registry;
                    const externalToolChoice = externalToolContext.toolChoice;
                    const internalToolContext = requestToolContext.internal;
                    trackToolMode(toolMode, {
                        configuredAllowlist: internalToolContext.allowedToolNames,
                        requestedAllowlist: internalToolContext.requestedAllowlist,
                        deniedRequestedTools: internalToolContext.deniedRequestedTools,
                        resolutionPath: internalToolContext.resolutionPath,
                        resultingMode: internalToolContext.resultingMode,
                        route: '/v1/messages'
                    });

                    const { parts, system: systemMsg, fullPromptText, lastUserMsg } = await buildAnthropicPromptParts(messages, system, externalToolRegistry);
                    const systemWithGuard = buildSystemPrompt(
                        [systemMsg, externalToolContext.prompt].filter(Boolean).join('\n\n'),
                        requestParams.reasoning_effort,
                        toolMode,
                        internalToolContext.allowedToolNames
                    );
                    if (!parts.length) {
                        return anthropicError(400, 'invalid_request_error', 'messages: messages must include at least one text, image or tool block');
                    }
                    logDebug('Anthropic request start', {
                        model: `${pID}/${mID}`,
                        stream,
                        userMessages: messages.length,
                        system: Boolean(systemMsg),
                        parts: parts.length,
                        toolMode
                    });

                    await ensureBackend(config);
                    try {
                        await client.config.update({
                            body: { activeModel: { providerID: pID, modelID: mID } }
                        });
                    } catch (confError) {
                        logDebug('Failed to set active model:', confError.message);
                    }

                    const toolControl = await resolveToolControl(toolMode, internalToolContext);
                    sessionId = await createSession(toolControl);
                    logDebug('Session created', { sessionId });

                    const promptParams = {
                        path: { id: sessionId },
                        body: {
                            model: { providerID: pID, modelID: mID },
                            system: systemWithGuard,
                            parts,
                            ...(requestParams.max_tokens && { max_tokens: requestParams.max_tokens }),
                            ...(requestParams.temperature !== undefined && { temperature: requestParams.temperature }),
                            ...(requestParams.top_p !== undefined && { top_p: requestParams.top_p }),
                            ...(requestParams.stop && { stop: requestParams.stop })
                        },
                        // Aborts the backend call when the caller goes away.
                        signal: clientAbort.signal
                    };
                    const { toolOverrides } = toolControl;
                    if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                        promptParams.body.tools = toolOverrides;
                    }

                    const makeForcedAnthropicToolCallRequester = () => createForcedToolCallRequester({
                        mode: externalToolChoice.mode,
                        sessionId,
                        systemWithGuard,
                        requiredTool: externalToolChoice.requiredTool || externalToolRegistry[0]?.namespacedName,
                        providerID: pID,
                        modelID: mID,
                        toolOverrides,
                        requestTimeoutMs: REQUEST_TIMEOUT_MS,
                        forbidThinkBlock: true
                    });
                    let requestForcedAnthropicToolCall = makeForcedAnthropicToolCallRequester();

                    res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');

                    const anthropicStopReason = (toolUseCount) => (toolUseCount > 0 ? 'tool_use' : 'end_turn');

                    if (stream) {
                        const shouldStripStreamingToolMarkup = externalToolRegistry.length > 0;
                        const filterContentDelta = createToolCallFilter({
                            disableTools: DISABLE_TOOLS,
                            forceStrip: shouldStripStreamingToolMarkup,
                            registry: externalToolRegistry
                        });
                        const filterReasoningDelta = createToolCallFilter({
                            disableTools: DISABLE_TOOLS,
                            forceStrip: shouldStripStreamingToolMarkup,
                            registry: externalToolRegistry
                        });
                        const parseContentToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
                        const parseReasoningToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
                        let streamedContent = '';
                        let streamedReasoning = '';
                        let rawStreamedContent = '';
                        let rawStreamedReasoning = '';
                        const streamedToolCalls = [];
                        let completionTokens = 0;
                        let reasoningTokens = 0;
                        const promptTokens = Math.ceil((fullPromptText || '').length / 4);

                        const writeEvent = (event) => {
                            if (!res.destroyed) {
                                res.write(`data: ${JSON.stringify(event)}\n\n`);
                            }
                        };

                        let messageStarted = false;
                        let blockIndex = 0;
                        let openBlock = null;

                        const ensureMessageStart = () => {
                            if (messageStarted) return;
                            messageStarted = true;
                            writeEvent({
                                type: 'message_start',
                                message: {
                                    id,
                                    type: 'message',
                                    role: 'assistant',
                                    model: `${pID}/${mID}`,
                                    content: [],
                                    stop_sequence: null,
                                    stop_reason: null,
                                    usage: { input_tokens: promptTokens, output_tokens: 0 }
                                }
                            });
                        };

                        const closeOpenBlock = () => {
                            if (!openBlock) return;
                            writeEvent({ type: 'content_block_stop', index: openBlock.index });
                            openBlock = null;
                        };

                        const emitStreamDelta = (text, isReasoning = false) => {
                            if (!text) return;
                            ensureMessageStart();
                            const targetType = isReasoning ? 'thinking' : 'text';
                            if (openBlock && openBlock.type !== targetType) {
                                closeOpenBlock();
                            }
                            if (!openBlock) {
                                const idx = blockIndex;
                                blockIndex += 1;
                                openBlock = { type: targetType, index: idx };
                                writeEvent({
                                    type: 'content_block_start',
                                    index: idx,
                                    content_block: targetType === 'thinking'
                                        ? { type: 'thinking', thinking: '' }
                                        : { type: 'text', text: '' }
                                });
                            }
                            writeEvent({
                                type: 'content_block_delta',
                                index: openBlock.index,
                                delta: targetType === 'thinking'
                                    ? { type: 'thinking_delta', thinking: text }
                                    : { type: 'text_delta', text }
                            });
                        };

                        keepaliveInterval = setInterval(() => {
                            if (!res.destroyed) {
                                res.write(': keepalive\n\n');
                            }
                        }, 15000);

                        const sendDelta = (delta, isReasoning = false) => {
                            if (!delta) return;
                            if (isReasoning) rawStreamedReasoning += delta;
                            else rawStreamedContent += delta;
                            const parsedDeltaToolCalls = isReasoning
                                ? parseReasoningToolCalls(delta)
                                : parseContentToolCalls(delta);
                            parsedDeltaToolCalls.forEach((toolCall) => streamedToolCalls.push(toolCall));
                            const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                            if (!filtered) return;
                            if (isReasoning) {
                                streamedReasoning += filtered;
                                reasoningTokens += Math.ceil(filtered.length / 4);
                                emitStreamDelta(filtered, true);
                            } else {
                                streamedContent += filtered;
                                completionTokens += Math.ceil(filtered.length / 4);
                                emitStreamDelta(filtered, false);
                            }
                        };

                        let collected = null;
                        for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
                            if (attempt > 1) {
                                // Retry on a fresh session (same rationale as chat completions).
                                try {
                                    await client.session.delete({ path: { id: sessionId } });
                                } catch (e) {
                                    logDebug('Failed to delete retried session', { sessionId, error: e.message });
                                }
                                sessionId = await createSession(toolControl);
                                promptParams.path.id = sessionId;
                                requestForcedAnthropicToolCall = makeForcedAnthropicToolCallRequester();
                                streamedContent = '';
                                streamedReasoning = '';
                                rawStreamedContent = '';
                                rawStreamedReasoning = '';
                                streamedToolCalls.length = 0;
                                completionTokens = 0;
                                reasoningTokens = 0;
                                await sleep(RETRY_BACKOFF_BASE_MS * attempt);
                            }
                            try {
                                const collectPromise = collectFromEvents(
                                    sessionId,
                                    REQUEST_TIMEOUT_MS,
                                    sendDelta,
                                    EVENT_FIRST_DELTA_TIMEOUT_MS,
                                    EVENT_IDLE_TIMEOUT_MS,
                                    {
                                        signal: clientAbort.signal,
                                        onUsage: (usage) => { reportedUsage = usage; }
                                    }
                                );
                                const safeCollect = collectPromise.catch((err) => ({ __error: err }));
                                client.session.prompt(promptParams).catch(err => logDebug('Prompt error:', err.message));
                                collected = await safeCollect;
                            } catch (e) {
                                logDebug('Anthropic stream error:', e.message);
                            }
                            if (collected?.clientGone) clientGone = true;
                            if (clientGone) break;

                            const attemptError = collected?.error || collected?.__error || null;
                            const nothingStreamed = !rawStreamedContent
                                && !rawStreamedReasoning
                                && streamedToolCalls.length === 0;
                            if (
                                attemptError
                                && nothingStreamed
                                && attempt < RETRY_MAX_ATTEMPTS
                                && isTransientUpstreamError(attemptError)
                            ) {
                                console.warn(`[Proxy] Transient upstream error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying:`, attemptError.data?.message || attemptError.message || attemptError.name || 'unknown');
                                continue;
                            }
                            break;
                        }

                        const pollFallback = async (mode) => {
                            const polled = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            if (polled.usage) reportedUsage = polled.usage;
                            const { content, reasoning, error } = polled;
                            if (error && !content && !reasoning) {
                                logDebug('Anthropic stream fallback error', { error: error.message });
                                return;
                            }
                            if (mode === 'idleTimeout') {
                                // Same guard as chat completions: the SSE pipe may have
                                // delivered a prefix before going idle, so only the
                                // remainder is sent to avoid duplicating text.
                                const remainingReasoning = reasoning && reasoning.startsWith(rawStreamedReasoning)
                                    ? reasoning.slice(rawStreamedReasoning.length)
                                    : reasoning;
                                const remainingContent = content && content.startsWith(rawStreamedContent)
                                    ? content.slice(rawStreamedContent.length)
                                    : content;
                                if (remainingReasoning) sendDelta(remainingReasoning, true);
                                if (remainingContent) sendDelta(remainingContent, false);
                                return;
                            }
                            if (reasoning) sendDelta(reasoning, true);
                            if (content) sendDelta(content, false);
                        };
                        let didFullPoll = false;
                        // Every fallback re-reads the session; with the caller gone
                        // there is nothing to send and the turn was aborted.
                        if (collected && (collected.__error || collected.noData) && !clientGone) {
                            logDebug('Anthropic SSE fallback to polling', { sessionId });
                            didFullPoll = true;
                            await pollFallback('full');
                        } else if (collected && collected.idleTimeout && (streamedContent || streamedReasoning || streamedToolCalls.length > 0) && !clientGone) {
                            logDebug('Anthropic SSE idle timeout, polling for remainder', { sessionId });
                            await pollFallback('idleTimeout');
                        }
                        if (collected && !rawStreamedContent && !rawStreamedReasoning && (collected.reasoning || collected.content)) {
                            if (collected.reasoning) sendDelta(collected.reasoning, true);
                            if (collected.content) sendDelta(collected.content, false);
                        }
                        if (!didFullPoll && !rawStreamedContent && !rawStreamedReasoning && streamedToolCalls.length === 0 && !clientGone) {
                            logDebug('Anthropic SSE returned empty, falling back to polling', { sessionId });
                            await pollFallback('full');
                        } else if (rawStreamedReasoning && !rawStreamedContent && streamedToolCalls.length === 0 && !clientGone) {
                            logDebug('Anthropic reasoning streamed without content, reconciling from snapshot', { sessionId });
                            const snapshot = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS).catch(() => null);
                            if (snapshot && snapshot.content) {
                                const remainingContent = rawStreamedContent
                                    ? snapshot.content.slice(rawStreamedContent.length)
                                    : snapshot.content;
                                if (remainingContent) sendDelta(remainingContent, false);
                            }
                        }

                        const flushedReasoningCalls = parseReasoningToolCalls.flush ? parseReasoningToolCalls.flush() : [];
                        const flushedContentCalls = parseContentToolCalls.flush ? parseContentToolCalls.flush() : [];
                        const flushedReasoningText = filterReasoningDelta.flush ? filterReasoningDelta.flush() : '';
                        const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : '';
                        if (flushedReasoningText) {
                            streamedReasoning += flushedReasoningText;
                            reasoningTokens += Math.ceil(flushedReasoningText.length / 4);
                            emitStreamDelta(flushedReasoningText, true);
                        }
                        if (flushedContentText) {
                            streamedContent += flushedContentText;
                            completionTokens += Math.ceil(flushedContentText.length / 4);
                            emitStreamDelta(flushedContentText, false);
                        }
                        closeOpenBlock();

                        const finalReasoningText = rawStreamedReasoning + flushedReasoningText;
                        const finalContentText = rawStreamedContent + flushedContentText;

                        let parsedToolCalls = streamedToolCalls.length > 0
                            ? streamedToolCalls
                            : [
                                ...flushedReasoningCalls,
                                ...flushedContentCalls,
                                ...parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText, finalContentText)
                            ];
                        if (parsedToolCalls.length === 0 && externalToolRegistry.length > 0) {
                            parsedToolCalls = parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText + finalContentText);
                        }
                        if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                            const forcedResponse = await requestForcedAnthropicToolCall();
                            if (forcedResponse) {
                                parsedToolCalls = parseExternalToolCallsFromText(
                                    externalToolRegistry,
                                    forcedResponse.reasoning,
                                    forcedResponse.content
                                );
                            }
                        }

                        const { validCalls: rawValidatedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
                        const validatedToolCalls = disableParallelToolUse && rawValidatedToolCalls.length > 1
                            ? rawValidatedToolCalls.slice(0, 1)
                            : rawValidatedToolCalls;

                        if (keepaliveInterval) clearInterval(keepaliveInterval);
                        keepaliveInterval = null;

                        // See the Chat stream: a caller that left gets no more
                        // events, and the backend turn is stopped right away.
                        if (clientGone) {
                            await abortCanceledTurn();
                            canceledHandled = true;
                            return;
                        }

                        // message_delta below reports the output count; the input
                        // count on message_start is the estimate declared above.
                        const outputTokens = reportedUsage
                            ? reportedUsage.completionTokens + reportedUsage.reasoningTokens
                            : completionTokens + reasoningTokens;

                        // Upstream failed on every attempt and fallbacks recovered
                        // nothing: surface an Anthropic error event instead of an
                        // empty 200 message (clients cannot tell that apart).
                        const terminalError = collected?.error || collected?.__error || null;
                        if (!messageStarted && !streamedContent && !streamedReasoning && validatedToolCalls.length === 0 && terminalError) {
                            writeEvent({
                                type: 'error',
                                error: {
                                    type: 'api_error',
                                    message: terminalError.data?.message || terminalError.message || 'OpenCode provider error'
                                }
                            });
                            writeEvent({ type: 'message_stop' });
                            res.end();
                            return;
                        }

                        ensureMessageStart();

                        validatedToolCalls.forEach((call) => {
                            let input = {};
                            try {
                                input = JSON.parse(call.function.arguments);
                            } catch (e) {
                                input = {};
                            }
                            writeEvent({
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: {
                                    type: 'tool_use',
                                    id: call.id,
                                    name: call.tool?.originalName || call.function.name,
                                    input: {}
                                }
                            });
                            writeEvent({
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
                            });
                            writeEvent({ type: 'content_block_stop', index: blockIndex });
                            blockIndex += 1;
                        });

                        if (clientGone) {
                            // Cancelled: nothing to report to a caller that left,
                            // and the backend turn must be stopped here because
                            // this path returns instead of throwing.
                            logDebug('Client disconnected before the Anthropic stream finished', { sessionId });
                            await abortCanceledTurn();
                            canceledHandled = true;
                            return;
                        }
                        writeEvent({
                            type: 'message_delta',
                            delta: { stop_reason: anthropicStopReason(validatedToolCalls.length), stop_sequence: null },
                            usage: { output_tokens: outputTokens }
                        });
                        // message_start was already sent with the estimated input
                        // count (nothing else is known at first delta), but the
                        // meter takes the backend's real numbers when it reported
                        // them.
                        meterUsage({
                            promptTokens: reportedUsage ? reportedUsage.promptTokens : promptTokens,
                            completionTokens: outputTokens
                        });
                        writeEvent({ type: 'message_stop' });
                        res.end();
                    } else {
                        let content = '';
                        let reasoning = '';
                        let error = null;
                        for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
                            if (attempt > 1) {
                                // Retry on a fresh session (same rationale as chat completions).
                                try {
                                    await client.session.delete({ path: { id: sessionId } });
                                } catch (e) {
                                    logDebug('Failed to delete retried session', { sessionId, error: e.message });
                                }
                                sessionId = await createSession(toolControl);
                                promptParams.path.id = sessionId;
                                requestForcedAnthropicToolCall = makeForcedAnthropicToolCallRequester();
                                await sleep(RETRY_BACKOFF_BASE_MS * attempt);
                            }
                            if (clientGone) break;
                            await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
                            const collected = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            content = collected.content || '';
                            reasoning = collected.reasoning || '';
                            error = collected.error || null;
                            if (collected.usage) reportedUsage = collected.usage;
                            if (
                                error
                                && !content
                                && !reasoning
                                && attempt < RETRY_MAX_ATTEMPTS
                                && isTransientUpstreamError(error)
                            ) {
                                console.warn(`[Proxy] Transient upstream error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying:`, error.data?.message || error.message || error.name || 'unknown');
                                continue;
                            }
                            break;
                        }
                        if (clientGone) {
                            logDebug('Client disconnected before the Anthropic reply', { sessionId });
                            await abortCanceledTurn();
                            canceledHandled = true;
                            return;
                        }
                        if (error && !content && !reasoning) {
                            // 5xx keeps a normalized Anthropic type: upstream error
                            // names (Error/OpenCodeError/...) are not valid types.
                            return anthropicError(502, 'api_error', error.data?.message || error.message || 'OpenCode provider error');
                        }
                        let parsedToolCalls = externalToolRegistry.length > 0
                            ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                            : [];
                        if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                            const forcedResponse = await requestForcedAnthropicToolCall();
                            if (forcedResponse) {
                                content = forcedResponse.content || content;
                                reasoning = forcedResponse.reasoning || reasoning;
                                parsedToolCalls = parseExternalToolCallsFromText(externalToolRegistry, reasoning, content);
                            }
                        }
                        const { validCalls: rawValidatedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
                        const validatedToolCalls = disableParallelToolUse && rawValidatedToolCalls.length > 1
                            ? rawValidatedToolCalls.slice(0, 1)
                            : rawValidatedToolCalls;
                        const stripOptions = { registry: externalToolRegistry };
                        const safeContent = stripFunctionCallMarkup(content, true, stripOptions);
                        const safeReasoning = stripFunctionCallMarkup(reasoning, true, stripOptions);

                        const anthropicContent = [];
                        if (safeReasoning) anthropicContent.push({ type: 'thinking', thinking: safeReasoning });
                        if (safeContent) anthropicContent.push({ type: 'text', text: safeContent });
                        validatedToolCalls.forEach((call) => {
                            let input = {};
                            try {
                                input = JSON.parse(call.function.arguments);
                            } catch (e) {
                                input = {};
                            }
                            anthropicContent.push({
                                type: 'tool_use',
                                id: call.id,
                                name: call.tool?.originalName || call.function.name,
                                input
                            });
                        });

                        const promptTokens = reportedUsage
                            ? reportedUsage.promptTokens
                            : Math.ceil((fullPromptText || '').length / 4);
                        const completionTokensCalc = reportedUsage
                            ? reportedUsage.completionTokens
                            : Math.ceil((content || '').length / 4);
                        const reasoningTokensCalc = reportedUsage
                            ? reportedUsage.reasoningTokens
                            : Math.ceil((reasoning || '').length / 4);
                        meterUsage({ promptTokens, completionTokens: completionTokensCalc + reasoningTokensCalc });

                        res.json({
                            id,
                            type: 'message',
                            role: 'assistant',
                            model: `${pID}/${mID}`,
                            content: anthropicContent,
                            stop_reason: anthropicStopReason(validatedToolCalls.length),
                            stop_sequence: null,
                            usage: {
                                input_tokens: promptTokens,
                                output_tokens: completionTokensCalc + reasoningTokensCalc
                            }
                        });
                    }
                } catch (error) {
                    console.error('[Proxy] Anthropic API Error:', error.message);
                    if (keepaliveInterval) clearInterval(keepaliveInterval);

                    if (error.code === 'model_not_found') {
                        if (!res.headersSent) {
                            return anthropicError(400, 'model_not_found', error.message || `Model not found: ${req.body?.model}`);
                        }
                        console.error('[Proxy] Anthropic model_not_found after headers were sent; cannot report a 400 error body');
                    }
                    if (!res.headersSent) {
                        const transformed = transformUpstreamError(error);
                        return res.status(transformed.statusCode).json({
                            type: 'error',
                            error: {
                                // model_not_found is an Anthropic error type, not an
                                // upstream error code; normalize the mapping so the
                                // shape stays consistent instead of leaking a
                                // provider-specific type on a 5xx.
                                type: transformed.statusCode >= 500
                                    ? 'api_error'
                                    : (transformed.error.code || transformed.error.type || 'api_error'),
                                message: transformed.error.message
                            }
                        });
                    }
                    if (!res.destroyed) {
                        res.write(`data: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: error.message } })}\n\n`);
                        res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                        res.end();
                    }
                    if (sessionId) {
                        if (clientGone) {
                            // Caller left and the turn was canceled; stop the
                            // backend and drop the poisoned session. The early
                            // returns above already did this.
                            if (!canceledHandled) await abortCanceledTurn();
                            return;
                        }
                        try {
                            await client.session.delete({ path: { id: sessionId } });
                        } catch (e) {
                            console.error('[Proxy] Failed to cleanup session on error:', e.message);
                        }
                    }
                } finally {
                    if (typeof keepaliveInterval !== 'undefined' && keepaliveInterval) clearInterval(keepaliveInterval);
                }
            }, REQUEST_TIMEOUT_MS + 20000);
        } catch (error) {
            console.error('[Proxy] Anthropic Request Handler Error:', error.message);
            if (!res.headersSent) {
                res.status(500).json({ type: 'error', error: { type: 'api_error', message: error.message } });
            }
        }
    });

    // Per-key usage snapshot shared by /admin/keys and /health/details.
    // In multi-user mode the legacy API_KEY appears as a pseudo-entry so
    // traffic that fell back to the master key is not invisible.
    const buildUsageRows = () => {
        const { byKey, total } = keyUsage.snapshot();
        const rows = [
            ...(adminAuthEnabled && (multiUserEnabled) && (byKey[MASTER_KEY_NAME] || keyUsage.entry(MASTER_KEY_NAME)).requests > 0
                ? [{
                    name: MASTER_KEY_NAME,
                    keyHint: keyHintFor(API_KEY || ''),
                    ...(byKey[MASTER_KEY_NAME] || keyUsage.entry(MASTER_KEY_NAME))
                }]
                : []),
            ...apiKeyEntries
                .map(({ name, key }) => ({
                    name,
                    keyHint: keyHintFor(key),
                    ...(byKey[name] || keyUsage.entry(name))
                }))
        ];
        return { rows, total };
    };

    // Admin surface for the multi-user keys. Only mounted when API_KEYS is
    // configured; every route requires the ADMIN key (the legacy API_KEY —
    // never a user key) and has no PUBLIC_DIAGNOSTICS bypass. With no API_KEY
    // there is no admin credential, so the surface answers 501.
    if (multiUserEnabled) {
        const requireAdmin = (req, res, next) => {
            if (!adminAuthEnabled) {
                return res.status(501).json({
                    error: {
                        message: 'Admin API unavailable: set API_KEY (the admin key) to manage multi-user API_KEYS',
                        type: 'not_implemented_error'
                    }
                });
            }
            const token = extractBearerToken(req);
            if (!token || !safeTokenEquals(token, API_KEY.trim())) {
                return res.status(401).json({ error: { message: 'Unauthorized: admin key required' } });
            }
            next();
        };

        app.get('/admin/keys', requireAdmin, (_req, res) => {
            res.json(buildUsageRows().rows);
        });

        app.post('/admin/keys', requireAdmin, (req, res) => {
            const body = req.body || {};
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            const key = typeof body.key === 'string' ? body.key.trim() : '';
            if (!name || !key) {
                return res.status(400).json({ error: { message: 'Both "name" and "key" are required' } });
            }
            const cleanName = normalizeApiKeyName(name, '');
            if (!cleanName) {
                return res.status(400).json({ error: { message: 'Invalid key name' } });
            }
            try {
                validateApiKeyName(cleanName);
            } catch (err) {
                return res.status(400).json({ error: { message: err.message } });
            }
            if (apiKeyByName.has(cleanName)) {
                return res.status(400).json({ error: { message: `Key name "${cleanName}" already exists` } });
            }
            if (adminAuthEnabled && safeTokenEquals(key, API_KEY.trim())) {
                return res.status(400).json({ error: { message: 'Key value must not match the admin API_KEY' } });
            }
            for (const entry of apiKeyEntries) {
                if (safeTokenEquals(key, entry.key)) {
                    return res.status(400).json({ error: { message: 'Key value already exists' } });
                }
            }
            apiKeyEntries.push({ name: cleanName, key });
            apiKeyByName.set(cleanName, key);
            keyUsage.register(cleanName);
            const created = buildUsageRows().rows.find((row) => row.name === cleanName);
            res.status(201).json(created);
        });

        app.delete('/admin/keys/:name', requireAdmin, (req, res) => {
            const name = req.params.name;
            const index = apiKeyEntries.findIndex((entry) => entry.name === name);
            if (index === -1) {
                return res.status(404).json({ error: { message: `Key "${name}" not found` } });
            }
            const [removed] = apiKeyEntries.splice(index, 1);
            apiKeyByName.delete(removed.name);
            keyUsage.delete(removed.name);
            res.status(204).end();
        });
    }

    app.get('/health', (_req, res) => res.json({
        status: 'ok',
        proxy: true
    }));

    // --- Built-in Web Panel (optional, read-only) ---
    // GET /panel serves a self-contained HTML shell (no data, no secrets).
    // The page's script fetches /panel/data.json, which assembles everything
    // from data the proxy already exposes: /v1/models, /health/details and
    // process.uptime(). It never returns OPENCODE_SERVER_PASSWORD,
    // ZEN_API_KEY, API_KEY or API_KEYS values.
    if (WEB_PANEL_ENABLED) {
        app.get('/panel', (_req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Security-Policy', PANEL_CSP);
            res.send(PANEL_HTML);
        });

        app.get('/panel/data.json', async (req, res) => {
            if (!shouldAllowOperationalEndpoint(req, { enabled: true })) {
                return res.status(401).json({ error: { message: 'Unauthorized' } });
            }
            const payload = {
                status: 'ok',
                proxy: true,
                uptime: process.uptime(),
                backend_url: OPENCODE_SERVER_URL,
                public_diagnostics: PUBLIC_DIAGNOSTICS === true,
                models: [],
                health: null
            };
            try {
                payload.models = buildModelsList(await getProvidersList());
            } catch (e) {
                logDebug('Panel model list failed', { error: e.message });
            }
            if (HEALTH_DETAILS_ENABLED) {
                payload.health = {
                    status: 'ok',
                    proxy: true,
                    internal_tools: {
                        config: { allowed_tools: SERVER_INTERNAL_ALLOWED_TOOL_NAMES },
                        metrics: { ...internalToolMetrics },
                        cache: {
                            tool_ids_cached: !!cachedToolIds,
                            tool_id_count: cachedToolIds ? cachedToolIds.length : 0,
                            age_ms: cachedToolIdsAt ? Date.now() - cachedToolIdsAt : null
                        }
                    }
                };
            }
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.json(payload);
        });
    }

    app.get('/health/details', (req, res) => {
        if (!shouldAllowOperationalEndpoint(req, { enabled: HEALTH_DETAILS_ENABLED })) {
            return res.status(HEALTH_DETAILS_ENABLED ? 401 : 404).json({
                error: { message: HEALTH_DETAILS_ENABLED ? 'Unauthorized' : 'Not found' }
            });
        }
        const metricsSnapshot = { ...internalToolMetrics };
        const diagnostics = {
            status: 'ok',
            proxy: true,
            internal_tools: {
                config: {
                    allowed_tools: SERVER_INTERNAL_ALLOWED_TOOL_NAMES
                },
                metrics: metricsSnapshot,
                cache: {
                    tool_ids_cached: !!cachedToolIds,
                    tool_id_count: cachedToolIds ? cachedToolIds.length : 0,
                    age_ms: cachedToolIdsAt ? Date.now() - cachedToolIdsAt : null
                },
                audit: {
                    available: true,
                    fields: [
                        'requestedAllowlist',
                        'allowedToolNames',
                        'deniedRequestedTools',
                        'resolutionPath',
                        'resultingMode'
                    ]
                }
            }
        };
        // Per-key usage only appears in multi-user mode so single-key
        // deployments keep their exact legacy snapshot shape. Admin callers see
        // every key; a user key only sees its own row; unauthenticated
        // PUBLIC_DIAGNOSTICS callers see the aggregate total without key names.
        if (multiUserEnabled) {
            const caller = resolveDiagnosticsCaller(req);
            const { rows, total } = buildUsageRows();
            const visibleRows = caller.role === 'admin'
                ? rows
                : (caller.role === 'user' ? rows.filter((row) => row.name === caller.keyName) : []);
            const byKey = {};
            visibleRows.forEach((row) => {
                byKey[row.name] = {
                    requests: row.requests,
                    promptTokens: row.promptTokens,
                    completionTokens: row.completionTokens,
                    totalTokens: row.totalTokens,
                    lastUsedAt: row.lastUsedAt,
                    createdAt: row.createdAt
                };
            });
            diagnostics.usage = { byKey, total };
        }
        res.json(diagnostics);
    });

    app.get('/metrics', (req, res) => {
        if (!shouldAllowOperationalEndpoint(req, { enabled: METRICS_ENABLED })) {
            return res.status(METRICS_ENABLED ? 401 : 404).send(METRICS_ENABLED ? 'Unauthorized' : 'Not found');
        }

        const metricsLines = [
            '# HELP opencode_internal_tool_mode_requests_total Count of internal tool mode selections by mode.',
            '# TYPE opencode_internal_tool_mode_requests_total counter',
            `opencode_internal_tool_mode_requests_total{mode="external_bridge"} ${internalToolMetrics.externalBridgeRequests}`,
            `opencode_internal_tool_mode_requests_total{mode="internal_allowlist"} ${internalToolMetrics.internalAllowlistRequests}`,
            `opencode_internal_tool_mode_requests_total{mode="disabled"} ${internalToolMetrics.disabledRequests}`,
            '# HELP opencode_internal_tool_discovery_failures_total Count of backend tool discovery failures.',
            '# TYPE opencode_internal_tool_discovery_failures_total counter',
            `opencode_internal_tool_discovery_failures_total ${internalToolMetrics.discoveryFailures}`,
            '# HELP opencode_internal_tool_fallback_disabled_total Count of allowlist resolutions that fell back to disabled.',
            '# TYPE opencode_internal_tool_fallback_disabled_total counter',
            `opencode_internal_tool_fallback_disabled_total ${internalToolMetrics.fallbackToDisabled}`,
            '# HELP opencode_internal_tool_cache_ids Number of cached backend tool IDs.',
            '# TYPE opencode_internal_tool_cache_ids gauge',
            `opencode_internal_tool_cache_ids ${cachedToolIds ? cachedToolIds.length : 0}`
        ];

        // Per-key usage counters, only when multi-user keys are configured.
        // Scoped the same way as /health/details: admin sees all keys, a user
        // key sees only its own counter, and unauthenticated PUBLIC_DIAGNOSTICS
        // scrapes omit per-key labels so key names are never leaked publicly.
        if (multiUserEnabled) {
            const caller = resolveDiagnosticsCaller(req);
            const { rows } = buildUsageRows();
            const visibleRows = caller.role === 'admin'
                ? rows
                : (caller.role === 'user' ? rows.filter((row) => row.name === caller.keyName) : []);
            if (visibleRows.length > 0) {
                metricsLines.push(
                    '# HELP opencode_proxy_key_requests_total Count of requests authenticated with each named API key.',
                    '# TYPE opencode_proxy_key_requests_total counter'
                );
                visibleRows.forEach((row) => {
                    metricsLines.push(`opencode_proxy_key_requests_total{key="${escapePrometheusLabel(row.name)}"} ${row.requests}`);
                });
                metricsLines.push(
                    '# HELP opencode_proxy_key_tokens_total Tokens billed per named API key and type (prompt/completion, reasoning included in completion).',
                    '# TYPE opencode_proxy_key_tokens_total counter'
                );
                visibleRows.forEach((row) => {
                    metricsLines.push(`opencode_proxy_key_tokens_total{key="${escapePrometheusLabel(row.name)}",type="prompt"} ${row.promptTokens}`);
                    metricsLines.push(`opencode_proxy_key_tokens_total{key="${escapePrometheusLabel(row.name)}",type="completion"} ${row.completionTokens}`);
                });
            }
        }

        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(`${metricsLines.join('\n')}\n`);
    });

    app.post('/v1/responses', async (req, res) => {
        // Declared outside the try so the catch block can tell a canceled turn
        // from a failure (see below).
        let sessionId = null;
        let clientGone = false;
        let abortIssued = false;
        try {
            const {
                model,
                input,
                reasoning_effort,
                reasoning: requestReasoning,
                max_output_tokens,
                tools = [],
                tool_choice,
                instructions,
                temperature,
                top_p,
                stream = false,
                messages: chatMessages,
                prompt,
                previous_response_id: previousResponseId,
                opencode: requestOpencodeConfig
            } = req.body;

            // Multi-user metering: failed requests still count toward `requests`.
            keyUsage.trackRequest(req.apiKeyName);
            let usageMetered = false;
            const meterUsage = ({ promptTokens, completionTokens }) => {
                if (usageMetered) return;
                usageMetered = true;
                keyUsage.trackUsage(req.apiKeyName, { promptTokens, completionTokens });
            };

            // See the Chat handler: a caller that disconnects cancels the turn
            // instead of leaving the backend to finish work nobody reads.
            const clientAbort = new AbortController();
            // See the Chat handler: abort the backend session explicitly.
            res.on('close', () => {
                if (res.writableEnded) return;
                clientGone = true;
                clientAbort.abort();
                if (sessionId && !abortIssued) {
                    abortIssued = true;
                    Promise.resolve()
                        .then(() => client.session.abort({ path: { id: sessionId } }))
                        .catch((e) => logDebug('Failed to abort canceled Responses backend turn', { sessionId, error: e.message }));
                }
            });

            // Stateful continuation: reuse the session behind a previous response so the
            // client only needs to send the new turn (OpenAI Responses API semantics).
            const previousState = previousResponseId ? getResponseState(previousResponseId) : null;
            if (previousResponseId && !previousState) {
                return res.status(400).json({ error: { message: 'Invalid or expired previous_response_id' } });
            }

            const reasoningLevel = normalizeReasoningEffort(
                reasoning_effort || requestReasoning?.effort,
                null
            );

            const requestToolContext = createRequestToolContext(tools, tool_choice, requestOpencodeConfig);
            const toolMode = requestToolContext.mode;
            const internalToolContext = requestToolContext.internal;
            trackToolMode(toolMode, {
                configuredAllowlist: internalToolContext.allowedToolNames,
                requestedAllowlist: internalToolContext.requestedAllowlist,
                deniedRequestedTools: internalToolContext.deniedRequestedTools,
                resolutionPath: internalToolContext.resolutionPath,
                resultingMode: internalToolContext.resultingMode,
                route: '/v1/responses'
            });
            logDebug('Responses API request', { 
                model, 
                reasoning_effort: reasoning_effort || requestReasoning?.effort,
                reasoningLevel,
                max_output_tokens,
                toolMode,
                internalAllowedTools: internalToolContext.allowedToolNames,
                requestedInternalTools: internalToolContext.requestedAllowlist,
                deniedRequestedTools: internalToolContext.deniedRequestedTools,
                resolutionPath: internalToolContext.resolutionPath,
                resultingMode: internalToolContext.resultingMode
            });
            const externalToolContext = requestToolContext.external;
            const externalToolRegistry = externalToolContext.registry;
            const externalToolChoice = externalToolContext.toolChoice;
            const assistantToolCalls = new Map();

            const rememberAssistantToolCall = (toolCallId, toolName) => {
                if (!toolCallId || !toolName) return;
                assistantToolCalls.set(toolCallId, toolName);
            };

            const buildResponsesToolResultLine = (item = {}) => {
                const text = normalizeToolResultContent(item?.content ?? item?.output ?? item?.result ?? item?.text);
                if (!text) return null;
                const mappedTool = findExternalToolByName(externalToolRegistry, item?.name)
                    || findExternalToolByName(externalToolRegistry, assistantToolCalls.get(item?.call_id || item?.tool_call_id));
                const toolName = mappedTool?.namespacedName || assistantToolCalls.get(item?.call_id || item?.tool_call_id) || item?.name || `${EXTERNAL_TOOL_PREFIX}unknown`;
                const toolCallId = item?.call_id || item?.tool_call_id || `call_${toolName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                rememberAssistantToolCall(toolCallId, toolName);
                return `TOOL_RESULT: ${JSON.stringify({ tool_call_id: toolCallId, name: toolName, content: text })}`;
            };

            const buildResponsesAssistantToolCallsLine = (item = {}) => {
                const sourceCalls = Array.isArray(item?.tool_calls)
                    ? item.tool_calls
                    : item?.type === 'function_call'
                        ? [item]
                        : [];
                if (!sourceCalls.length) return null;
                const serializedToolCalls = sourceCalls.map((toolCall, index) => {
                    const rawName = toolCall?.function?.name || toolCall?.name;
                    const mappedTool = findExternalToolByName(externalToolRegistry, rawName);
                    const namespacedName = mappedTool?.namespacedName || rawName;
                    if (!namespacedName) return null;
                    const toolCallId = toolCall?.call_id || toolCall?.id || `call_${index + 1}`;
                    rememberAssistantToolCall(toolCallId, namespacedName);
                    return {
                        id: toolCallId,
                        name: namespacedName,
                        arguments: normalizeToolArguments(toolCall?.arguments ?? toolCall?.function?.arguments)
                    };
                }).filter(Boolean);
                if (!serializedToolCalls.length) return null;
                return `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`;
            };

            const buildResponsesInputMessages = (rawItems) => {
                const normalized = [];
                if (!Array.isArray(rawItems)) return normalized;
                for (const item of rawItems) {
                    if (!item) continue;

                    if (item.type === 'function_call_output' || item.type === 'tool_result' || item.role === 'tool') {
                        const toolResultLine = buildResponsesToolResultLine(item);
                        if (toolResultLine) normalized.push({ role: 'tool', content: toolResultLine });
                        continue;
                    }

                    if (item.type === 'function_call') {
                        const assistantToolCallsLine = buildResponsesAssistantToolCallsLine(item);
                        if (assistantToolCallsLine) normalized.push({ role: 'assistant', content: assistantToolCallsLine, isToolCalls: true });
                        continue;
                    }

                    if (item.role === 'assistant' && Array.isArray(item?.tool_calls) && item.tool_calls.length) {
                        const assistantToolCallsLine = buildResponsesAssistantToolCallsLine(item);
                        if (assistantToolCallsLine) normalized.push({ role: 'assistant', content: assistantToolCallsLine, isToolCalls: true });
                    }

                    if (item.type === 'message') {
                        const role = item.role || 'user';
                        const content = normalizeTextContent(item.content);
                        if (content) normalized.push({ role, content });
                        continue;
                    }

                    if (item.type === 'input_text') {
                        if (item.text) normalized.push({ role: 'user', content: item.text });
                        continue;
                    }

                    const text = normalizeTextContent(item.content || item.text);
                    if (text) normalized.push({ role: item.role || 'user', content: text });
                }
                return normalized;
            };

            let messages = [];
            if (Array.isArray(chatMessages) && chatMessages.length) {
                messages = buildResponsesInputMessages(chatMessages);
            } else if (typeof prompt === 'string' && prompt.trim()) {
                messages = [{ role: 'user', content: prompt }];
            } else if (typeof input === 'string') {
                messages = [{ role: 'user', content: input }];
            } else if (Array.isArray(input)) {
                messages = buildResponsesInputMessages(input);
            } else if (input && typeof input === 'object') {
                if (input.type === 'message' || input.type === 'function_call' || input.type === 'function_call_output' || input.type === 'tool_result') {
                    messages = buildResponsesInputMessages([input]);
                } else {
                    const content = normalizeTextContent(input.content || input.text);
                    if (content) {
                        messages = [{ role: input.role || 'user', content }];
                    }
                }
            }

            if (!messages.length) {
                return res.status(400).json({ error: { message: 'input is required' } });
            }

            const resolvedModel = await resolveRequestedModel(model || previousState?.model);
            const pID = resolvedModel.providerID;
            const mID = resolvedModel.modelID;

            await ensureBackend(config);

            try {
                await client.config.update({
                    body: { activeModel: { providerID: pID, modelID: mID } }
                });
            } catch (e) { }

            // Continue the stored session when chaining from previous_response_id;
            // otherwise start a fresh one.
            // With the tool-lock plugin, a chained session keeps the policy it was
            // created with, so toolControl.title only matters for new sessions.
            const toolControl = await resolveToolControl(toolMode, internalToolContext);
            sessionId = previousState?.sessionId || null;
            if (!sessionId) {
                sessionId = await createSession(toolControl);
            }

            const parts = [];
            const systemChunks = [];
            let fullPromptText = '';
            const formatResponsesRoleLine = (role, text) => `${String(role || 'user').toUpperCase()}: ${text}`;
            for (const msg of messages) {
                if (msg.role === 'system') {
                    if (msg.content) systemChunks.push(msg.content);
                    continue;
                }
                if (!msg.content) continue;
                const text = msg.role === 'tool' || String(msg.content).startsWith('ASSISTANT: ') || String(msg.content).startsWith('TOOL_RESULT: ')
                    ? msg.content
                    : msg.role === 'user'
                        ? msg.content
                        : formatResponsesRoleLine(msg.role, msg.content);
                parts.push({ type: 'text', text });
                fullPromptText += `${text}\n\n`;
            }

            const systemWithGuard = buildSystemPrompt(
                [instructions, ...systemChunks, externalToolContext.prompt].filter(Boolean).join('\n\n'),
                reasoningLevel,
                toolMode,
                internalToolContext.allowedToolNames
            );

            const requestForcedResponsesToolCall = createForcedToolCallRequester({
                mode: externalToolChoice.mode,
                sessionId,
                systemWithGuard,
                requiredTool: externalToolChoice.requiredTool || externalToolRegistry[0]?.namespacedName,
                providerID: pID,
                modelID: mID,
                toolOverrides: toolControl.toolOverrides,
                requestTimeoutMs: REQUEST_TIMEOUT_MS,
                forbidThinkBlock: false
            });

            const promptParams = {
                path: { id: sessionId },
                body: {
                    model: { providerID: pID, modelID: mID },
                    ...(systemWithGuard ? { system: systemWithGuard } : {}),
                    parts: externalToolContext.reminder
                        ? [...parts, { type: 'text', text: externalToolContext.reminder }]
                        : parts,
                    ...(max_output_tokens && { max_tokens: max_output_tokens }),
                    ...(temperature !== undefined && { temperature }),
                    ...(top_p !== undefined && { top_p })
                },
                // Aborts the backend call when the caller goes away.
                signal: clientAbort.signal
            };
            const { toolOverrides } = toolControl;
            if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                promptParams.body.tools = toolOverrides;
            }

            let content = '';
            let reasoning = '';
            // Real counts from the backend, when it reported them.
            let reportedUsage = null;
            const buildResponsesFunctionCallOutputItem = (toolCall) => ({
                id: toolCall.id,
                type: 'function_call',
                status: 'completed',
                call_id: toolCall.id,
                name: toolCall.function.name,
                arguments: toolCall.function.arguments
            });

            const buildResponsesMessageOutputItem = (text) => {
                if (!text) return null;
                return {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                        {
                            type: 'output_text',
                            text
                        }
                    ]
                };
            };

            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                const responseId = `resp_${crypto.randomUUID()}`;
                const messageOutputIndex = 0;
                const reasoningOutputIndex = 1;
                const contentIndex = 0;
                const outputItemId = `msg_${crypto.randomUUID()}`;
                const reasoningItemId = 'reasoning-0';
                let nextOutputIndex = 2;
                let sequenceNumber = 0;
                let announcedOutput = false;
                let announcedContent = false;
                let announcedReasoning = false;
                const nextSeq = () => sequenceNumber++;
                const emit = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

                emit({
                    type: 'response.created',
                    sequence_number: nextSeq(),
                    response: { id: responseId, object: 'response', created: Math.floor(Date.now() / 1000), model: `${pID}/${mID}` }
                });

                const shouldStripStreamingToolMarkup = externalToolRegistry.length > 0;
                const filterContentDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup });
                const filterReasoningDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup });
                const parseContentToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
                const parseReasoningToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
                const streamedToolCalls = [];
                let rawContent = '';
                let rawReasoning = '';
                const ensureOutputScaffold = () => {
                    if (!announcedOutput) {
                        emit({
                            type: 'response.output_item.added',
                            sequence_number: nextSeq(),
                            output_index: messageOutputIndex,
                            item: {
                                id: outputItemId,
                                type: 'message',
                                status: 'in_progress',
                                role: 'assistant',
                                content: []
                            }
                        });
                        announcedOutput = true;
                    }
                    if (!announcedContent) {
                        emit({
                            type: 'response.content_part.added',
                            sequence_number: nextSeq(),
                            output_index: messageOutputIndex,
                            content_index: contentIndex,
                            item_id: outputItemId,
                            part: { type: 'output_text', text: '' }
                        });
                        announcedContent = true;
                    }
                };
                const ensureReasoningScaffold = () => {
                    if (!announcedReasoning) {
                        emit({
                            type: 'response.output_item.added',
                            sequence_number: nextSeq(),
                            output_index: reasoningOutputIndex,
                            item: {
                                id: reasoningItemId,
                                type: 'reasoning',
                                status: 'in_progress',
                                summary: [{ type: 'summary_text', text: '' }]
                            }
                        });
                        announcedReasoning = true;
                    }
                };
                const emitResponsesFunctionCall = (toolCall) => {
                    const outputIndex = nextOutputIndex++;
                    const functionCallItem = buildResponsesFunctionCallOutputItem(toolCall);
                    streamedToolCalls.push(toolCall);
                    emit({
                        type: 'response.output_item.added',
                        sequence_number: nextSeq(),
                        output_index: outputIndex,
                        item: {
                            ...functionCallItem,
                            status: 'in_progress'
                        }
                    });
                    emit({
                        type: 'response.function_call_arguments.delta',
                        sequence_number: nextSeq(),
                        output_index: outputIndex,
                        item_id: toolCall.id,
                        delta: toolCall.function.arguments
                    });
                    emit({
                        type: 'response.function_call_arguments.done',
                        sequence_number: nextSeq(),
                        output_index: outputIndex,
                        item_id: toolCall.id,
                        arguments: toolCall.function.arguments
                    });
                    emit({
                        type: 'response.output_item.done',
                        sequence_number: nextSeq(),
                        output_index: outputIndex,
                        item: functionCallItem
                    });
                };
                const sendResponsesDelta = (delta, isReasoning = false) => {
                    if (!delta) return;
                    if (isReasoning) rawReasoning += delta;
                    else rawContent += delta;
                    const parsedDeltaToolCalls = isReasoning
                        ? parseReasoningToolCalls(delta)
                        : parseContentToolCalls(delta);
                    if (parsedDeltaToolCalls.length > 0) {
                        const { validCalls: allowedDeltaToolCalls } = finalizeValidatedToolCalls(parsedDeltaToolCalls, externalToolRegistry);
                        allowedDeltaToolCalls.forEach((toolCall) => emitResponsesFunctionCall(toolCall));
                    }
                    const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                    if (!filtered) return;
                    if (isReasoning) {
                        ensureReasoningScaffold();
                        reasoning += filtered;
                        emit({
                            type: 'response.reasoning_summary_text.delta',
                            sequence_number: nextSeq(),
                            output_index: reasoningOutputIndex,
                            item_id: reasoningItemId,
                            summary_index: 0,
                            delta: filtered
                        });
                    } else {
                        if (!filtered.trim()) {
                            content += filtered;
                            return;
                        }
                        ensureOutputScaffold();
                        content += filtered;
                        emit({
                            type: 'response.output_text.delta',
                            sequence_number: nextSeq(),
                            output_index: messageOutputIndex,
                            content_index: contentIndex,
                            item_id: outputItemId,
                            delta: filtered
                        });
                    }
                };

                let collected = null;
                try {
                    const collectPromise = collectFromEvents(
                        sessionId,
                        REQUEST_TIMEOUT_MS,
                        sendResponsesDelta,
                        EVENT_FIRST_DELTA_TIMEOUT_MS,
                        EVENT_IDLE_TIMEOUT_MS,
                        {
                            signal: clientAbort.signal,
                            onUsage: (usage) => { reportedUsage = usage; }
                        }
                    );
                    const safeCollect = collectPromise.catch((err) => ({ __error: err }));
                    client.session.prompt(promptParams).catch(err => logDebug('Responses prompt error:', err.message));
                    collected = await safeCollect;
                } catch (e) {
                    collected = { __error: e };
                }
                if (collected?.clientGone) clientGone = true;

                if (!content && !reasoning && !clientGone) {
                    const polled = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                    if (polled.usage) reportedUsage = polled.usage;
                    if (polled.error && !polled.content && !polled.reasoning) throw polled.error;
                    if (polled.reasoning) sendResponsesDelta(polled.reasoning, true);
                    if (polled.content) sendResponsesDelta(polled.content, false);
                } else if (collected && collected.idleTimeout && !clientGone) {
                    const polled = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                    if (polled.usage) reportedUsage = polled.usage;
                    const remainingReasoning = polled.reasoning && polled.reasoning.startsWith(rawReasoning)
                        ? polled.reasoning.slice(rawReasoning.length)
                        : polled.reasoning;
                    const remainingContent = polled.content && polled.content.startsWith(rawContent)
                        ? polled.content.slice(rawContent.length)
                        : polled.content;
                    if (remainingReasoning) sendResponsesDelta(remainingReasoning, true);
                    if (remainingContent) sendResponsesDelta(remainingContent, false);
                } else if (collected && (collected.content || collected.reasoning)) {
                    if (!reasoning && collected.reasoning) sendResponsesDelta(collected.reasoning, true);
                    if (!content && collected.content) sendResponsesDelta(collected.content, false);
                }

                if (announcedReasoning) {
                    emit({
                        type: 'response.reasoning_summary_text.done',
                        sequence_number: nextSeq(),
                        output_index: reasoningOutputIndex,
                        item_id: reasoningItemId,
                        summary_index: 0,
                        text: reasoning
                    });
                    emit({
                        type: 'response.output_item.done',
                        sequence_number: nextSeq(),
                        output_index: reasoningOutputIndex,
                        item: {
                            id: reasoningItemId,
                            type: 'reasoning',
                            status: 'completed',
                            summary: [{ type: 'summary_text', text: reasoning }]
                        }
                    });
                }

                const hasMeaningfulContent = Boolean(content && content.trim());

                if (clientGone) {
                    // Caller left: the turn was canceled, so there is no
                    // completion to report and no snapshot worth polling for.
                    // The catch block aborts the backend turn and drops the
                    // session.
                    logDebug('Client disconnected, abandoning the Responses stream', { sessionId });
                    throw new Error('client disconnected');
                }

                if (announcedContent && hasMeaningfulContent) {
                    emit({
                        type: 'response.output_text.done',
                        sequence_number: nextSeq(),
                        output_index: messageOutputIndex,
                        content_index: contentIndex,
                        item_id: outputItemId,
                        text: content
                    });
                    emit({
                        type: 'response.content_part.done',
                        sequence_number: nextSeq(),
                        output_index: messageOutputIndex,
                        content_index: contentIndex,
                        item_id: outputItemId,
                        part: { type: 'output_text', text: content }
                    });
                    emit({
                        type: 'response.output_item.done',
                        sequence_number: nextSeq(),
                        output_index: messageOutputIndex,
                        item: {
                            id: outputItemId,
                            type: 'message',
                            status: 'completed',
                            role: 'assistant',
                            content: [{ type: 'output_text', text: content }]
                        }
                    });
                }

                let polledForToolCalls = null;
                if (externalToolRegistry.length > 0 && streamedToolCalls.length === 0) {
                    try {
                        polledForToolCalls = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                    } catch (e) { }
                }

                // Flush held buffers from the stream parsers and filters before final batch parse.
                const flushedReasoningCalls = parseReasoningToolCalls.flush ? parseReasoningToolCalls.flush() : [];
                const flushedContentCalls = parseContentToolCalls.flush ? parseContentToolCalls.flush() : [];
                const flushedReasoningText = filterReasoningDelta.flush ? filterReasoningDelta.flush() : '';
                const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : '';
                const finalReasoningText = (polledForToolCalls?.reasoning || rawReasoning) + flushedReasoningText;
                const finalContentText = (polledForToolCalls?.content || rawContent) + flushedContentText;

                // Parse each channel, then retry on the two joined. See the matching comment
                // in /v1/chat/completions for why the joined retry is gated on finding nothing.
                const parseStreamedToolCalls = () => {
                    if (externalToolRegistry.length === 0) return [];
                    const perChannel = [
                        ...flushedReasoningCalls,
                        ...flushedContentCalls,
                        ...parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText, finalContentText)
                    ];
                    if (perChannel.length > 0) return perChannel;
                    return parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText + finalContentText);
                };

                let parsedToolCalls = streamedToolCalls.length > 0
                    ? streamedToolCalls
                    : parseStreamedToolCalls();
                if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                    const forcedResponse = await requestForcedResponsesToolCall();
                    if (forcedResponse) {
                        parsedToolCalls = parseExternalToolCallsFromText(
                            externalToolRegistry,
                            forcedResponse.reasoning,
                            forcedResponse.content
                        );
                    }
                }
                const { validCalls: validatedStreamedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
                const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
                const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));
                if (streamedToolCalls.length === 0) {
                    validatedStreamedToolCalls.forEach((toolCall) => {
                        emitResponsesFunctionCall(toolCall);
                    });
                }
                const streamOutput = [];
                const streamMessageOutputItem = buildResponsesMessageOutputItem(safeContent && safeContent.trim() ? safeContent : '');
                if (streamMessageOutputItem) streamOutput.push(streamMessageOutputItem);
                validatedStreamedToolCalls.forEach((toolCall) => {
                    streamOutput.push(buildResponsesFunctionCallOutputItem(toolCall));
                });
                const promptTokens = reportedUsage
                    ? reportedUsage.promptTokens
                    : Math.ceil(fullPromptText.length / 4);
                const completionTokens = reportedUsage
                    ? reportedUsage.completionTokens
                    : Math.ceil(content.length / 4);
                const reasoningTokens = reportedUsage
                    ? reportedUsage.reasoningTokens
                    : Math.ceil(reasoning.length / 4);
                meterUsage({ promptTokens, completionTokens: completionTokens + reasoningTokens });
                const response = {
                    id: responseId,
                    object: 'response',
                    created: Math.floor(Date.now() / 1000),
                    model: `${pID}/${mID}`,
                    reasoning: safeReasoning ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) } : undefined,
                    output: streamOutput,
                    usage: {
                        input_tokens: promptTokens,
                        output_tokens: completionTokens + reasoningTokens,
                        total_tokens: promptTokens + completionTokens + reasoningTokens,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: reasoningTokens }
                    }
                };
                emit({ type: 'response.completed', sequence_number: nextSeq(), response });
                res.write('data: [DONE]\n\n');
                storeResponseState(responseId, sessionId, `${pID}/${mID}`);
                return res.end();
            }

            const responseRes = await client.session.prompt(promptParams);
            const responseParts = responseRes.data?.parts || [];
            // 1.x answers the prompt with the finished message, tokens included.
            if (!reportedUsage) reportedUsage = usageFromInfo(responseRes.data?.info);
            const promptContent = responseParts.filter(p => p.type === 'text').map(p => p.text).join('\n');
            const promptReasoning = responseParts.filter(p => p.type === 'reasoning').map(p => p.text).join('\n');
            const promptParsedToolCalls = externalToolRegistry.length > 0
                ? parseExternalToolCallsFromText(externalToolRegistry, promptReasoning, promptContent)
                : [];

            content = promptParsedToolCalls.length > 0 ? '' : promptContent;
            reasoning = promptReasoning;

            let promptBasedToolCalls = promptParsedToolCalls;
            const shouldPollForResponses = !promptContent && !promptReasoning;
            if (shouldPollForResponses) {
                const polledResponse = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                if (polledResponse.error && !polledResponse.content && !polledResponse.reasoning) {
                    throw polledResponse.error;
                }
                content = polledResponse.content || content;
                reasoning = polledResponse.reasoning || reasoning;
                promptBasedToolCalls = externalToolRegistry.length > 0
                    ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                    : [];
            }

            if (!content && !reasoning && responseRes.data && promptBasedToolCalls.length === 0) {
                const data = responseRes.data;
                content = typeof data === 'string' ? data : data?.message || JSON.stringify(data);
            }

            let parsedToolCalls = promptBasedToolCalls.length > 0
                ? promptBasedToolCalls
                : (externalToolRegistry.length > 0
                    ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                    : []);
            if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                const forcedResponse = await requestForcedResponsesToolCall();
                if (forcedResponse) {
                    content = forcedResponse.content || content;
                    reasoning = forcedResponse.reasoning || reasoning;
                    parsedToolCalls = parseExternalToolCallsFromText(externalToolRegistry, reasoning, content);
                }
            }
            const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
            const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
            const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));

            const promptTokens = reportedUsage
                ? reportedUsage.promptTokens
                : Math.ceil(fullPromptText.length / 4);
            const completionTokens = reportedUsage
                ? reportedUsage.completionTokens
                : Math.ceil(content.length / 4);
            const reasoningTokens = reportedUsage
                ? reportedUsage.reasoningTokens
                : Math.ceil(reasoning.length / 4);
            meterUsage({ promptTokens, completionTokens: completionTokens + reasoningTokens });
            const output = [];
            const messageOutputItem = buildResponsesMessageOutputItem(safeContent);
            if (messageOutputItem) output.push(messageOutputItem);
            validatedToolCalls.forEach((toolCall) => {
                output.push(buildResponsesFunctionCallOutputItem(toolCall));
            });

            const responseId = `resp_${crypto.randomUUID()}`;
            const response = {
                id: responseId,
                object: 'response',
                created: Math.floor(Date.now() / 1000),
                model: `${pID}/${mID}`,
                reasoning: safeReasoning ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) } : undefined,
                output,
                usage: {
                    input_tokens: promptTokens,
                    output_tokens: completionTokens + reasoningTokens,
                    total_tokens: promptTokens + completionTokens + reasoningTokens,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: reasoningTokens }
                }
            };

            storeResponseState(responseId, sessionId, `${pID}/${mID}`);

            return res.json(response);
        } catch (error) {
            // Cancelled turns are not failures: the caller is gone, so stop the
            // backend turn and leave the (closed) stream alone instead of
            // reporting a response.failed nobody can read.
            if (clientGone) {
                logDebug('Cancelled Responses turn, aborting backend', { sessionId });
                if (sessionId && !abortIssued) {
                    abortIssued = true;
                    try {
                        await client.session.abort({ path: { id: sessionId } });
                    } catch (e) {
                        logDebug('Failed to abort canceled Responses turn', { sessionId, error: e.message });
                    }
                }
                return;
            }
            console.error('[Proxy] Responses API Error:', error?.message || error?.data?.message || error?.name || error);
            const transformed = transformUpstreamError(error);
            // Once the SSE headers are out, res.json() throws ERR_HTTP_HEADERS_SENT. That throw
            // escapes this async handler as an unhandled rejection, which terminates the whole
            // process under Node's default --unhandled-rejections=throw. Report the failure on
            // the already-open stream instead.
            if (res.headersSent) {
                try {
                    res.write(`data: ${JSON.stringify({
                        type: 'response.failed',
                        response: { error: transformed.error.error || transformed.error }
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                } catch (writeError) {
                    logDebug('Failed to report error on open response stream', { error: writeError.message });
                }
                return res.end();
            }
            return res.status(transformed.statusCode).json(transformed.error);
        }
    });

    app.use((req, res) => {
        res.status(404).json({
            error: {
                message: `Route not found: ${req.method} ${req.path}`,
                type: 'not_found_error'
            }
        });
    });

    return { app, client, persistUsageNow };
}

// Backend management state (per-instance)
const backendState = new Map();

// Merges the tool-lock plugin into OPENCODE_CONFIG_CONTENT for the backend the
// proxy spawns, keeping any config the operator already passes that way.
export function buildBackendConfigContent(existing = process.env.OPENCODE_CONFIG_CONTENT) {
    let base = {};
    if (existing) {
        try {
            const parsed = JSON.parse(existing);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
        } catch (e) {
            console.warn('[Proxy] Ignoring invalid OPENCODE_CONFIG_CONTENT:', e.message);
        }
    }
    const plugins = Array.isArray(base.plugin) ? [...base.plugin] : [];
    if (!plugins.includes(TOOL_LOCK_PLUGIN_PATH)) plugins.push(TOOL_LOCK_PLUGIN_PATH);
    return JSON.stringify({ ...base, plugin: plugins });
}

/**
 * Backend Lifecycle Management
 */
async function ensureBackend(config) {
    const {
        OPENCODE_SERVER_URL,
        OPENCODE_PATH,
        USE_ISOLATED_HOME,
        ZEN_API_KEY,
        OPENCODE_SERVER_PASSWORD,
        MANAGE_BACKEND
    } = config;
    const stateKey = OPENCODE_SERVER_URL;

    if (!backendState.has(stateKey)) {
        backendState.set(stateKey, {
            isStarting: false,
            process: null,
            jailRoot: null
        });
    }

    const state = backendState.get(stateKey);

    if (state.isStarting) {
        // Wait for startup to complete
        for (let i = 0; i < STARTING_WAIT_ITERATIONS; i++) {
            await new Promise(r => setTimeout(r, STARTING_WAIT_INTERVAL_MS));
            try {
                await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
                return;
            } catch (e) { }
        }
        throw new Error('Backend startup timeout');
    }

    try {
        await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
    } catch (err) {
        if (!MANAGE_BACKEND) {
            for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
                await new Promise(r => setTimeout(r, STARTUP_WAIT_INTERVAL_MS));
                try {
                    await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
                    return;
                } catch (e) { }
            }
            throw err;
        }

        state.isStarting = true;
        console.log(`[Proxy] OpenCode backend not found at ${OPENCODE_SERVER_URL}. Starting...`);

        // Kill existing process if any
        if (state.process) {
            try {
                state.process.kill();
            } catch (e) { }
        }

        // Cleanup old temp dir
        if (state.jailRoot && fs.existsSync(state.jailRoot)) {
            try {
                fs.rmSync(state.jailRoot, { recursive: true, force: true });
            } catch (e) { }
        }

        // The tool-lock plugin keeps Zen free models usable (see plugin/), the
        // server password protects the backend API, and the Zen key unlocks
        // paid models. `opencode serve` reads all three from the environment.
        const backendEnv = {
            OPENCODE_CONFIG_CONTENT: buildBackendConfigContent(),
            ...(OPENCODE_SERVER_PASSWORD ? { OPENCODE_SERVER_PASSWORD } : {}),
            ...(ZEN_API_KEY ? { OPENCODE_API_KEY: ZEN_API_KEY } : {})
        };

        const isWindows = process.platform === 'win32';
        const useIsolatedHome = typeof USE_ISOLATED_HOME === 'boolean'
            ? USE_ISOLATED_HOME
            : String(process.env.OPENCODE_USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_USE_ISOLATED_HOME === '1';

        // On Windows, don't use isolated fake-home to avoid path issues
        // On Unix-like systems, use jail for isolation
        const salt = Math.random().toString(36).substring(7);
        const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail', salt);
        state.jailRoot = jailRoot;
        config.OPENCODE_HOME_BASE = jailRoot;
        const workspace = path.join(jailRoot, 'empty-workspace');

        let envVars;
        let cwd;

        if (isWindows) {
            // Windows: use normal user home to avoid opencode storage path issues
            fs.mkdirSync(workspace, { recursive: true });
            cwd = workspace;
            envVars = {
                ...process.env,
                ...backendEnv,
                OPENCODE_PROJECT_DIR: workspace
            };
            console.log('[Proxy] Running on Windows, using standard user home directory');
        } else {
            fs.mkdirSync(workspace, { recursive: true });
            cwd = workspace;

            if (useIsolatedHome) {
                // Unix-like: use isolated fake-home
                const fakeHome = path.join(jailRoot, 'fake-home');

                // Create necessary opencode directories
                const opencodeDir = path.join(fakeHome, '.local', 'share', 'opencode');
                const storageDir = path.join(opencodeDir, 'storage');
                const messageDir = path.join(storageDir, 'message');
                const sessionDir = path.join(storageDir, 'session');

                [fakeHome, opencodeDir, storageDir, messageDir, sessionDir].forEach(d => {
                    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
                });

                envVars = {
                    ...process.env,
                    HOME: fakeHome,
                    USERPROFILE: fakeHome,
                    ...backendEnv,
                    OPENCODE_PROJECT_DIR: workspace
                };

                console.log('[Proxy] Using isolated home for OpenCode');
            } else {
                envVars = {
                    ...process.env,
                    ...backendEnv,
                    OPENCODE_PROJECT_DIR: workspace
                };
                console.log('[Proxy] Using real HOME for OpenCode (isolation disabled)');
            }
        }

        const [, , portStr] = OPENCODE_SERVER_URL.split(':');
        const port = portStr ? portStr.split('/')[0] : '10001';
        const resolved = resolveOpencodePath(OPENCODE_PATH);
        const opencodeBin = resolved.path || OPENCODE_PATH || OPENCODE_BASENAME;
        if (resolved.path) {
            console.log(`[Proxy] Using OpenCode binary: ${opencodeBin} (source: ${resolved.source})`);
        } else {
            console.warn(`[Proxy] Unable to resolve OpenCode binary for '${OPENCODE_PATH}'. Using as-is.`);
        }

        // Cross-platform spawn options
        const useShell = process.platform === 'win32' || !resolved.path ||
            opencodeBin.endsWith('.cmd') || opencodeBin.endsWith('.bat');
        const spawnOptions = {
            stdio: 'inherit',
            cwd: cwd,
            env: envVars,
            shell: useShell  // Use shell only when needed (e.g., Windows .cmd or unresolved PATH)
        };

        const spawnArgs = ['serve', '--port', port, '--hostname', '127.0.0.1'];
        state.process = spawn(opencodeBin, spawnArgs, spawnOptions);

        // Handle spawn errors
        state.process.on('error', (err) => {
            console.error(`[Proxy] Failed to spawn OpenCode: ${err.message}`);
            if (err.code === 'ENOENT') {
                console.error(`[Proxy] Command '${OPENCODE_PATH}' not found. Please ensure OpenCode is installed and in your PATH.`);
                console.error(`[Proxy] You can specify the full path in config.json using 'OPENCODE_PATH'`);
            }
        });

        // Wait for backend to be ready
        let started = false;
        for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
            await new Promise(r => setTimeout(r, STARTUP_WAIT_INTERVAL_MS));
            try {
                await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
                console.log('[Proxy] OpenCode backend ready.');
                started = true;
                break;
            } catch (e) { }
        }

        state.isStarting = false;

        if (!started) {
            console.warn('[Proxy] Backend start timed out.');
            throw new Error('Backend start timeout');
        }
    }
}

/**
 * Starts the OpenCode-to-OpenAI Proxy server.
 */
export function startProxy(options) {
    const normalizeBool = (value) => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value === 1;
        if (typeof value === 'string') {
            const v = value.trim().toLowerCase();
            if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
            if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
        }
        return undefined;
    };

    const disableTools =
        normalizeBool(options.DISABLE_TOOLS) ??
        normalizeBool(options.disableTools) ??
        normalizeBool(process.env.OPENCODE_DISABLE_TOOLS) ??
        false;

    const cleanupIntervalMs = Number(options.CLEANUP_INTERVAL_MS || process.env.OPENCODE_PROXY_CLEANUP_INTERVAL_MS || 12 * 60 * 60 * 1000);
    const cleanupMaxAgeMs = Number(options.CLEANUP_MAX_AGE_MS || process.env.OPENCODE_PROXY_CLEANUP_MAX_AGE_MS || 24 * 60 * 60 * 1000);

    const config = {
        PORT: options.PORT || 10000,
        API_KEY: options.API_KEY || '',
        API_KEYS: options.API_KEYS !== undefined ? options.API_KEYS : (process.env.OPENCODE_API_KEYS || []),
        OPENCODE_SERVER_URL: options.OPENCODE_SERVER_URL || 'http://127.0.0.1:10001',
        OPENCODE_SERVER_PASSWORD: options.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || '',
        OPENCODE_PATH: options.OPENCODE_PATH || 'opencode',
        BIND_HOST: options.BIND_HOST || options.bindHost || process.env.OPENCODE_PROXY_BIND_HOST || '0.0.0.0',
        USE_ISOLATED_HOME: typeof options.USE_ISOLATED_HOME === 'boolean'
            ? options.USE_ISOLATED_HOME
            : String(options.USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
            options.USE_ISOLATED_HOME === '1' ||
            String(process.env.OPENCODE_USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_USE_ISOLATED_HOME === '1',
        REQUEST_TIMEOUT_MS: Number(options.REQUEST_TIMEOUT_MS || process.env.OPENCODE_PROXY_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS),
        MANAGE_BACKEND: normalizeBool(options.MANAGE_BACKEND) ??
            normalizeBool(process.env.OPENCODE_PROXY_MANAGE_BACKEND) ??
            true,
        DISABLE_TOOLS: disableTools,
        CHAT_SESSION_AFFINITY: normalizeBool(options.CHAT_SESSION_AFFINITY) ??
            normalizeBool(process.env.OPENCODE_CHAT_SESSION_AFFINITY) ??
            false,
        INTERNAL_ALLOWED_TOOLS: Array.isArray(options.INTERNAL_ALLOWED_TOOLS)
            ? options.INTERNAL_ALLOWED_TOOLS
            : typeof process.env.OPENCODE_INTERNAL_ALLOWED_TOOLS === 'string'
                ? process.env.OPENCODE_INTERNAL_ALLOWED_TOOLS.split(',').map(entry => entry.trim()).filter(Boolean)
                : [],
        HEALTH_DETAILS_ENABLED: normalizeBool(options.HEALTH_DETAILS_ENABLED) ??
            normalizeBool(process.env.OPENCODE_HEALTH_DETAILS_ENABLED) ??
            true,
        METRICS_ENABLED: normalizeBool(options.METRICS_ENABLED) ??
            normalizeBool(process.env.OPENCODE_METRICS_ENABLED) ??
            false,
        PUBLIC_DIAGNOSTICS: normalizeBool(options.PUBLIC_DIAGNOSTICS) ??
            normalizeBool(process.env.OPENCODE_PUBLIC_DIAGNOSTICS) ??
            false,
        DEBUG: String(options.DEBUG || '').toLowerCase() === 'true' ||
            options.DEBUG === '1' ||
            String(process.env.OPENCODE_PROXY_DEBUG || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_PROXY_DEBUG === '1',
        ZEN_API_KEY: options.ZEN_API_KEY || process.env.OPENCODE_ZEN_API_KEY || '',
        OMIT_SYSTEM_PROMPT: normalizeBool(options.OMIT_SYSTEM_PROMPT) ??
            normalizeBool(process.env.OPENCODE_PROXY_OMIT_SYSTEM_PROMPT) ??
            false,
        AUTO_CLEANUP_CONVERSATIONS: normalizeBool(options.AUTO_CLEANUP_CONVERSATIONS) ??
            normalizeBool(process.env.OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS) ??
            false,
        CLEANUP_INTERVAL_MS: Number.isFinite(cleanupIntervalMs) && cleanupIntervalMs > 0 ? cleanupIntervalMs : 12 * 60 * 60 * 1000,
        CLEANUP_MAX_AGE_MS: Number.isFinite(cleanupMaxAgeMs) && cleanupMaxAgeMs > 0 ? cleanupMaxAgeMs : 24 * 60 * 60 * 1000,
        WEB_PANEL_ENABLED: normalizeBool(options.WEB_PANEL_ENABLED) ??
            normalizeBool(process.env.OPENCODE_WEB_PANEL_ENABLED) ??
            false,
        OPENCODE_HOME_BASE: options.OPENCODE_HOME_BASE || null,
        EVENT_IDLE_TIMEOUT_MS: options.EVENT_IDLE_TIMEOUT_MS,
        EVENT_FIRST_DELTA_TIMEOUT_MS: options.EVENT_FIRST_DELTA_TIMEOUT_MS,
        // Per-key counters are only meaningful with named keys, so persistence
        // follows multi-user mode: on when configured keys exist, off otherwise.
        USAGE_PERSISTENCE: normalizeBool(options.USAGE_PERSISTENCE) ??
            normalizeBool(process.env.OPENCODE_USAGE_PERSISTENCE) ??
            true,
        USAGE_FILE: options.USAGE_FILE || process.env.OPENCODE_USAGE_FILE || defaultUsageFilePath(options.configPath),
        USAGE_SAVE_INTERVAL_MS: Number(options.USAGE_SAVE_INTERVAL_MS || process.env.OPENCODE_USAGE_SAVE_INTERVAL_MS || DEFAULT_USAGE_SAVE_INTERVAL_MS)
    };

    const { app, persistUsageNow } = createApp(config);
    
    const server = app.listen(config.PORT, config.BIND_HOST, async () => {
        console.log(`[Proxy] Active at http://${config.BIND_HOST}:${config.PORT}`);
        try {
            await ensureBackend(config);
        } catch (error) {
            console.error('[Proxy] Backend warmup failed:', error.message);
        }
    });

    return {
        server,
        /**
         * Flush the per-key usage snapshot. Call this from the signal handler
         * before closing the server: a restart must not cost a metering window.
         */
        persistUsage: () => persistUsageNow(),
        killBackend: () => {
            const state = backendState.get(config.OPENCODE_SERVER_URL);
            if (state && state.process) {
                state.process.kill();
            }
            // Cleanup temp dir (only on non-Windows where we use jail)
            if (state && state.jailRoot && process.platform !== 'win32') {
                try {
                    fs.rmSync(state.jailRoot, { recursive: true, force: true });
                } catch (e) { }
            }
        }
    };
}

// --- Mutex Logic with Timeout ---
