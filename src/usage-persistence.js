/**
 * Disk persistence for the per-key usage counters.
 *
 * The registry itself is in memory and rebuilt on start; this module is the
 * only thing that writes it down. Two properties matter more than speed:
 *
 *  - a half-written file must never be read back as truth, so the snapshot is
 *    written to a temporary file in the same directory and renamed over the
 *    target (rename is atomic within a filesystem);
 *  - losing metering data must never stop the proxy from serving, so a load
 *    error is reported and treated as "no snapshot yet".
 *
 * Usage: `createUsageStore({ file, intervalMs, log })` returns a store whose
 * `attach(registry)` wires it to a registry and whose `close()` writes a final
 * snapshot and stops the timer. `createKeyUsageRegistry({ store })` uses the
 * same contract (`read()` / `register(registry)`), so tests can pass a fake.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SNAPSHOT_VERSION = 1;

// `src/` is not part of the published package layout assumption, so resolve
// relative to this file and step up to the package root.
const DEFAULT_PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Default snapshot location: beside the config the process was started with,
 * and beside this package when no config path is known — never the process
 * working directory, which for a `node bin/…` launch can be anywhere and would
 * scatter `usage.json` across the filesystem.
 */
export function defaultUsageFilePath(configPath) {
    const dir = configPath ? path.dirname(configPath) : DEFAULT_PACKAGE_DIR;
    return path.join(dir, 'usage.json');
}

/**
 * Atomic replace: write a sibling temp file, then rename it over the target.
 * The temp name is unique per write so two writers cannot clobber each other's
 * partial output.
 */
function writeFileAtomic(file, data, mode) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.writeFileSync(tmp, data, { mode });
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw error;
    }
}

/**
 * Coerce a snapshot row into a registry entry, discarding anything unusable.
 * Returns null when the row is not an object at all.
 */
function normalizeSnapshotEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const num = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    };
    return {
        requests: num(raw.requests),
        promptTokens: num(raw.promptTokens),
        completionTokens: num(raw.completionTokens),
        totalTokens: num(raw.totalTokens),
        lastUsedAt: Number.isFinite(Number(raw.lastUsedAt)) && raw.lastUsedAt !== null
            ? Number(raw.lastUsedAt)
            : null,
        createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now()
    };
}

/**
 * Create a snapshot store bound to `file`.
 *
 * @param {object} options
 * @param {string} options.file - snapshot path
 * @param {number} [options.intervalMs] - periodic save interval; 0 disables
 * @param {(message: string, detail?: object) => void} [options.log] - warnings
 * @returns {{attach: Function, read: Function, save: Function, close: Function, file: string}}
 */
export function createUsageStore({ file, intervalMs = 5 * 60 * 1000, log = () => {} } = {}) {
    let registry = null;
    let timer = null;
    let closed = false;

    const store = {
        file,
        /** Wire the store to a registry and start periodic saves. */
        attach(target) {
            registry = target;
            if (intervalMs > 0 && !timer && !closed) {
                timer = setInterval(() => {
                    store.save().catch((error) => log(`[Usage] Periodic save failed: ${error.message}`));
                }, intervalMs);
                // Never hold the process open just to persist counters.
                if (typeof timer.unref === 'function') timer.unref();
            }
            return store;
        },
        /**
         * Registry hook: equal to `attach`, named for what the registry calls
         * when it is constructed with `{ store }`.
         */
        register(target) {
            return store.attach(target);
        },
        /**
         * Read the snapshot. Missing file means a first start; a malformed file
         * is reported and ignored so the proxy still comes up.
         */
        read() {
            let raw;
            try {
                raw = fs.readFileSync(file, 'utf8');
            } catch (error) {
                if (error.code !== 'ENOENT') log(`[Usage] Cannot read ${file}: ${error.message}`);
                return null;
            }
            try {
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object') throw new Error('snapshot is not an object');
                const byKey = parsed.byKey && typeof parsed.byKey === 'object' ? parsed.byKey : {};
                const restored = {};
                for (const [name, row] of Object.entries(byKey)) {
                    const entry = normalizeSnapshotEntry(row);
                    if (entry) restored[name] = entry;
                }
                return restored;
            } catch (error) {
                log(`[Usage] Ignoring unreadable snapshot ${file}: ${error.message}`);
                return null;
            }
        },
        /** Write the current counters (no-op before `attach`). */
        async save() {
            if (!registry) return false;
            const { byKey } = registry.snapshot();
            const payload = {
                version: SNAPSHOT_VERSION,
                savedAt: new Date().toISOString(),
                byKey
            };
            // 0600: the counters describe customers, not the operator.
            writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
            return true;
        },
        /** Final save, then stop the timer. Safe to call more than once. */
        close() {
            if (closed) return Promise.resolve(false);
            closed = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            return store.save().catch((error) => {
                log(`[Usage] Final save failed: ${error.message}`);
                return false;
            });
        }
    };
    return store;
}
