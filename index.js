import { startProxy } from './src/proxy.js';
import { parseApiKeysConfig } from './src/proxy.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseBool(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
        if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
    }
    if (value === undefined || value === null) return fallback;
    return Boolean(value);
}

function parseToolAllowlist(value, fallback = []) {
    if (Array.isArray(value)) {
        return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
    }
    if (typeof value === 'string') {
        return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
    }
    if (value === undefined || value === null || value === '') return fallback;
    return fallback;
}

/**
 * Normalize the optional multi-user API_KEYS value coming from env / config.json.
 * Arrays pass through (each entry may be an object {name, key} or "name:key");
 * strings are parsed as a comma-separated "name:key" / bare-key list (env-friendly).
 * @param {*} value - Raw API_KEYS value
 * @returns {Array|undefined} normalized array, or undefined when unset
 */
function parseApiKeysValue(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (Array.isArray(value)) {
        return value
            .map((entry) => (typeof entry === 'string'
                ? entry.trim()
                : (entry && typeof entry === 'object'
                    ? { name: entry.name, key: entry.key }
                    : entry)))
            .filter((entry) => (typeof entry === 'string' ? entry !== '' : Boolean(entry)));
    }
    if (typeof value === 'string') {
        return value.split(',').map((entry) => entry.trim()).filter(Boolean);
    }
    return undefined;
}

// Default configuration
const defaultConfig = {
    PORT: parseInt(process.env.OPENCODE_PROXY_PORT) || 10000,
    API_KEY: '',
    API_KEYS: parseApiKeysValue(process.env.OPENCODE_API_KEYS),
    OPENCODE_SERVER_URL: `http://127.0.0.1:${process.env.OPENCODE_SERVER_PORT || 10001}`,
    OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD || '',
    MANAGE_BACKEND: true,
    OPENCODE_PATH: 'opencode',
    BIND_HOST: '0.0.0.0',
    DISABLE_TOOLS: true,
    INTERNAL_ALLOWED_TOOLS: parseToolAllowlist(process.env.OPENCODE_INTERNAL_ALLOWED_TOOLS, []),
    HEALTH_DETAILS_ENABLED: parseBool(process.env.OPENCODE_HEALTH_DETAILS_ENABLED, true),
    METRICS_ENABLED: parseBool(process.env.OPENCODE_METRICS_ENABLED, false),
    PUBLIC_DIAGNOSTICS: parseBool(process.env.OPENCODE_PUBLIC_DIAGNOSTICS, false),
    OMIT_SYSTEM_PROMPT: parseBool(process.env.OPENCODE_PROXY_OMIT_SYSTEM_PROMPT, false),
    AUTO_CLEANUP_CONVERSATIONS: parseBool(process.env.OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS, false),
    CLEANUP_INTERVAL_MS: parseInt(process.env.OPENCODE_PROXY_CLEANUP_INTERVAL_MS) || 43200000,
    CLEANUP_MAX_AGE_MS: parseInt(process.env.OPENCODE_PROXY_CLEANUP_MAX_AGE_MS) || 86400000,
    WEB_PANEL_ENABLED: false,
    // Event-stream timeouts. These used to be environment-only, which made them
    // easy to lose depending on how the process was started; they can now also
    // live in config.json so every launch path picks them up.
    EVENT_IDLE_TIMEOUT_MS: parseInt(process.env.OPENCODE2API_EVENT_IDLE_TIMEOUT_MS) || 0,
    EVENT_FIRST_DELTA_TIMEOUT_MS: parseInt(process.env.OPENCODE2API_EVENT_FIRST_DELTA_TIMEOUT_MS) || 0
};

// Load config from file
const configPath = path.join(__dirname, 'config.json');
let fileConfig = {};

if (fs.existsSync(configPath)) {
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        fileConfig = JSON.parse(content);
        console.log('[Config] Loaded from config.json');
    } catch (err) {
        console.error('[Config] Error parsing config.json:', err.message);
    }
}

// Merge configs: env > file > default
const finalConfig = {
    PORT: parseInt(process.env.OPENCODE_PROXY_PORT) || parseInt(process.env.PORT) || fileConfig.PORT || defaultConfig.PORT,
    API_KEY: process.env.API_KEY || fileConfig.API_KEY || defaultConfig.API_KEY,
    // env (OPENCODE_API_KEYS, comma-separated "name:key") > config.json
    // (array of {name, key}) > default (env only). When neither source sets
    // it, the field stays undefined and single-key mode is untouched.
    API_KEYS: parseApiKeysValue(process.env.OPENCODE_API_KEYS) ?? parseApiKeysValue(fileConfig.API_KEYS) ?? defaultConfig.API_KEYS,
    OPENCODE_SERVER_URL: process.env.OPENCODE_SERVER_URL || fileConfig.OPENCODE_SERVER_URL || defaultConfig.OPENCODE_SERVER_URL,
    OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD || fileConfig.OPENCODE_SERVER_PASSWORD || defaultConfig.OPENCODE_SERVER_PASSWORD,
    MANAGE_BACKEND: parseBool(process.env.OPENCODE_PROXY_MANAGE_BACKEND, parseBool(fileConfig.MANAGE_BACKEND, defaultConfig.MANAGE_BACKEND)),
    OPENCODE_PATH: process.env.OPENCODE_PATH || fileConfig.OPENCODE_PATH || defaultConfig.OPENCODE_PATH,
    BIND_HOST: process.env.BIND_HOST || fileConfig.BIND_HOST || defaultConfig.BIND_HOST,
    DISABLE_TOOLS: parseBool(process.env.OPENCODE_DISABLE_TOOLS, parseBool(fileConfig.DISABLE_TOOLS, defaultConfig.DISABLE_TOOLS)),
    INTERNAL_ALLOWED_TOOLS: parseToolAllowlist(process.env.OPENCODE_INTERNAL_ALLOWED_TOOLS, parseToolAllowlist(fileConfig.INTERNAL_ALLOWED_TOOLS, defaultConfig.INTERNAL_ALLOWED_TOOLS)),
    HEALTH_DETAILS_ENABLED: parseBool(process.env.OPENCODE_HEALTH_DETAILS_ENABLED, parseBool(fileConfig.HEALTH_DETAILS_ENABLED, defaultConfig.HEALTH_DETAILS_ENABLED)),
    METRICS_ENABLED: parseBool(process.env.OPENCODE_METRICS_ENABLED, parseBool(fileConfig.METRICS_ENABLED, defaultConfig.METRICS_ENABLED)),
    PUBLIC_DIAGNOSTICS: parseBool(process.env.OPENCODE_PUBLIC_DIAGNOSTICS, parseBool(fileConfig.PUBLIC_DIAGNOSTICS, defaultConfig.PUBLIC_DIAGNOSTICS)),
    USE_ISOLATED_HOME: parseBool(process.env.OPENCODE_USE_ISOLATED_HOME, parseBool(fileConfig.USE_ISOLATED_HOME, false)),
    REQUEST_TIMEOUT_MS: parseInt(process.env.OPENCODE_PROXY_REQUEST_TIMEOUT_MS) || fileConfig.REQUEST_TIMEOUT_MS || 180000,
    DEBUG: parseBool(process.env.OPENCODE_PROXY_DEBUG, parseBool(fileConfig.DEBUG, false)),
    ZEN_API_KEY: process.env.OPENCODE_ZEN_API_KEY || fileConfig.ZEN_API_KEY || '',
    OMIT_SYSTEM_PROMPT: parseBool(process.env.OPENCODE_PROXY_OMIT_SYSTEM_PROMPT, parseBool(fileConfig.OMIT_SYSTEM_PROMPT, defaultConfig.OMIT_SYSTEM_PROMPT)),
    AUTO_CLEANUP_CONVERSATIONS: parseBool(process.env.OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS, parseBool(fileConfig.AUTO_CLEANUP_CONVERSATIONS, defaultConfig.AUTO_CLEANUP_CONVERSATIONS)),
    CLEANUP_INTERVAL_MS: parseInt(process.env.OPENCODE_PROXY_CLEANUP_INTERVAL_MS) || fileConfig.CLEANUP_INTERVAL_MS || defaultConfig.CLEANUP_INTERVAL_MS,
    CLEANUP_MAX_AGE_MS: parseInt(process.env.OPENCODE_PROXY_CLEANUP_MAX_AGE_MS) || fileConfig.CLEANUP_MAX_AGE_MS || defaultConfig.CLEANUP_MAX_AGE_MS,
    WEB_PANEL_ENABLED: parseBool(process.env.OPENCODE_WEB_PANEL_ENABLED, parseBool(fileConfig.WEB_PANEL_ENABLED, defaultConfig.WEB_PANEL_ENABLED)),
    // undefined => keep the library default (8000 / 30000)
    EVENT_IDLE_TIMEOUT_MS: parseInt(process.env.OPENCODE2API_EVENT_IDLE_TIMEOUT_MS) || parseInt(fileConfig.EVENT_IDLE_TIMEOUT_MS) || undefined,
    EVENT_FIRST_DELTA_TIMEOUT_MS: parseInt(process.env.OPENCODE2API_EVENT_FIRST_DELTA_TIMEOUT_MS) || parseInt(fileConfig.EVENT_FIRST_DELTA_TIMEOUT_MS) || undefined
};

// Validate required configuration
if (!finalConfig.OPENCODE_PATH) {
    console.error('[Error] OPENCODE_PATH is not set. Please configure it in config.json or environment variable.');
    process.exit(1);
}

// Fail fast on a malformed multi-user key configuration (duplicates, missing
// keys, bad shapes) instead of discovering it per request. startProxy would
// also surface this, but exiting here gives a clear startup error.
let parsedApiKeys = [];
try {
    if (finalConfig.API_KEYS !== undefined) {
        parsedApiKeys = parseApiKeysConfig(finalConfig.API_KEYS);
        if (parsedApiKeys.length > 0) {
            console.log(`[Config] API_KEYS: ${parsedApiKeys.length} user key(s) configured (${parsedApiKeys.map((entry) => entry.name).join(', ')})`);
        }
    }
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

// Check if opencode is available
import { execSync } from 'child_process';
try {
    execSync(`"${finalConfig.OPENCODE_PATH}" --version`, { stdio: 'ignore' });
} catch (e) {
    console.warn(`[Warning] Cannot verify OpenCode installation: ${finalConfig.OPENCODE_PATH}`);
    console.warn('[Warning] Please ensure OpenCode is installed:');
    console.warn('  Windows: npm install -g opencode-ai@1.19.0');
    console.warn('  Linux/macOS: curl -fsSL https://opencode.ai/install | bash');
    console.warn('[Warning] Or specify the full path in config.json:');
    console.warn('  { "OPENCODE_PATH": "C:\\\\Users\\\\YourName\\\\AppData\\\\Roaming\\\\npm\\\\opencode.cmd" }');
}

console.log('[Config] Starting with configuration:');
console.log(`  - Port: ${finalConfig.PORT}`);
console.log(`  - Bind Host: ${finalConfig.BIND_HOST}`);
console.log(`  - Backend: ${finalConfig.OPENCODE_SERVER_URL}`);
console.log(`  - Backend Password: ${finalConfig.OPENCODE_SERVER_PASSWORD ? 'Configured' : 'Not configured'}`);
console.log(`  - OpenCode Path: ${finalConfig.OPENCODE_PATH}`);
console.log(`  - API Key: ${finalConfig.API_KEY ? 'Configured' : 'Not configured (no auth)'}`);
console.log(`  - API Keys (multi-user): ${parsedApiKeys.length > 0 ? `${parsedApiKeys.length} user key(s)` : 'Not configured'}`);
console.log(`  - Zen API Key: ${finalConfig.ZEN_API_KEY ? 'Configured' : 'Not configured'}`);
console.log(`  - Disable Tools: ${finalConfig.DISABLE_TOOLS ? 'Yes' : 'No'}`);
console.log(`  - Chat Session Affinity: ${finalConfig.CHAT_SESSION_AFFINITY ? 'Yes' : 'No (new session per request)'}`);
console.log(`  - Manage Backend: ${finalConfig.MANAGE_BACKEND ? 'Yes' : 'No'}`);
console.log(`  - Internal Allowed Tools: ${finalConfig.INTERNAL_ALLOWED_TOOLS.length ? finalConfig.INTERNAL_ALLOWED_TOOLS.join(', ') : '(none)'}`);
console.log(`  - Health Details Enabled: ${finalConfig.HEALTH_DETAILS_ENABLED ? 'Yes' : 'No'}`);
console.log(`  - Metrics Enabled: ${finalConfig.METRICS_ENABLED ? 'Yes' : 'No'}`);
console.log(`  - Public Diagnostics: ${finalConfig.PUBLIC_DIAGNOSTICS ? 'Yes (no auth on /health/details & /metrics)' : 'No'}`);
console.log(`  - Web Panel: ${finalConfig.WEB_PANEL_ENABLED ? 'Yes (/panel)' : 'No'}`);
console.log(`  - Use Isolated Home: ${finalConfig.USE_ISOLATED_HOME ? 'Yes' : 'No'}`);
console.log(`  - Request Timeout: ${finalConfig.REQUEST_TIMEOUT_MS}ms`);
console.log(`  - Omit System Prompt: ${finalConfig.OMIT_SYSTEM_PROMPT ? 'Yes' : 'No'}`);
console.log(`  - Auto Cleanup Conversations: ${finalConfig.AUTO_CLEANUP_CONVERSATIONS ? 'Yes' : 'No'}`);
console.log(`  - Cleanup Interval: ${finalConfig.CLEANUP_INTERVAL_MS}ms`);
console.log(`  - Cleanup Max Age: ${finalConfig.CLEANUP_MAX_AGE_MS}ms`);
console.log(`  - Event Idle Timeout: ${finalConfig.EVENT_IDLE_TIMEOUT_MS || 'default (8000)'}ms`);
console.log(`  - Event First Delta Timeout: ${finalConfig.EVENT_FIRST_DELTA_TIMEOUT_MS || 'default (30000)'}ms`);
console.log(`  - Debug: ${finalConfig.DEBUG ? 'Yes' : 'No'}`);

// A rejected promise inside a request handler must not take the whole proxy down.
// Node's default --unhandled-rejections=throw turns one bad request into a process
// exit, which reads to users as "the service stopped working after a while".
process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : typeof reason === 'string' ? reason : JSON.stringify(reason);
    console.error('[Proxy] Unhandled rejection (request dropped, server continues):', detail);
    if (reason instanceof Error && reason.stack) console.error(reason.stack);
});

// Start the proxy
try {
    const proxy = startProxy(finalConfig);
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n[Shutdown] Received SIGINT, shutting down gracefully...');
        proxy.killBackend();
        proxy.server.close(() => {
            console.log('[Shutdown] Server closed');
            process.exit(0);
        });
    });
    
    process.on('SIGTERM', () => {
        console.log('\n[Shutdown] Received SIGTERM, shutting down gracefully...');
        proxy.killBackend();
        proxy.server.close(() => {
            console.log('[Shutdown] Server closed');
            process.exit(0);
        });
    });
} catch (error) {
    console.error('[Fatal] Failed to start proxy:', error.message);
    process.exit(1);
}
