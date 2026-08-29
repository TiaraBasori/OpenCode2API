import { findExternalToolByName } from './registry.js';

/**
 * Tool-call markup parsing.
 *
 * The proxy asks models to emit tool calls as `<function_calls>{json}</function_calls>`.
 * Models served by OpenCode's free tier frequently ignore that contract and fall back to
 * whatever markup their own training used. Observed alternatives, all captured verbatim
 * from live responses, are listed in FOREIGN FORMATS below.
 *
 * Rather than teach every call site about each dialect, everything is normalized to the
 * canonical `<function_calls>` form at the parser boundary. Downstream code is unchanged.
 *
 * FOREIGN FORMATS
 *   1. DSML (DeepSeek native)
 *        <｜｜DSML｜｜tool_calls>
 *        <｜｜DSML｜｜invoke name="external__bash">
 *        <｜｜DSML｜｜parameter name="command" string="true">ls -la</｜｜DSML｜｜parameter>
 *        </｜｜DSML｜｜invoke>
 *        </｜｜DSML｜｜tool_calls>
 *      The `｜` is U+FF5C (fullwidth vertical line), not an ASCII pipe. The marker is
 *      treated as optional so plain `<invoke>`/`<parameter>` markup parses too.
 *   2. JSON wrapper:      <tool_call>{"name":...,"arguments":{...}}</tool_call>
 *   3. Tag with attrs:    <external__bash arguments='{"command":"ls"}' name="external__bash"/>
 *   4. Tag with body:     <external__bash>{"command":"ls"}</external__bash>
 *                         <external__bash><parameters>{...}</parameters></external__bash>
 *                         <external__bash "Run a shell command">\n{"command":"ls"}
 *   5. Bare JSON:         {"name":"external__bash","arguments":{"command":"ls"}}
 *
 * AMBIGUITY POLICY
 * Formats 1, 2 and the canonical form carry their own delimiters, so they are recognized
 * unconditionally. Formats 3-5 are only recognized when the name matches a tool in the
 * request's registry, because `<summary>` or a JSON snippet in prose must never be
 * mistaken for a tool call. Format 5 additionally requires the JSON to span the entire
 * message body, so payload examples quoted mid-sentence are ignored.
 */

// U+FF5C fullwidth vertical line, or an ASCII pipe, around an optional DSML tag.
// Matches "｜｜DSML｜｜", "|DSML|", or nothing at all.
const MARK = '[\\uFF5C|]*(?:DSML)?[\\uFF5C|]*';

const CANONICAL_OPEN = '<function_calls>';
const CANONICAL_CLOSE = '</function_calls>';

const RE = {
    canonicalBlock: /<function_calls>([\s\S]*?)<\/function_calls>/g,
    canonicalStrayTag: /<\/?function_calls>/g,
    // DSML/plain <tool_calls> container. Contents are parsed for invoke blocks.
    dsmlContainer: new RegExp(`<${MARK}tool_calls\\s*>([\\s\\S]*?)</${MARK}tool_calls\\s*>`, 'g'),
    invokeBlock: new RegExp(`<${MARK}invoke\\s+name\\s*=\\s*["']([^"']+)["']\\s*>([\\s\\S]*?)</${MARK}invoke\\s*>`, 'g'),
    invokeParam: new RegExp(`<${MARK}parameter\\s+name\\s*=\\s*["']([^"']+)["']([^>]*)>([\\s\\S]*?)</${MARK}parameter\\s*>`, 'g'),
    // Singular <tool_call> JSON wrapper. Plural is handled by dsmlContainer, which
    // falls through to JSON parsing when it holds no invoke blocks.
    jsonWrapper: /<tool_call\s*>([\s\S]*?)<\/tool_call\s*>/g,
    codeFence: /^\s*```(?:[a-zA-Z0-9_-]*)\s*\n([\s\S]*?)\n?\s*```\s*$/,
    leadingNewline: /^\r?\n/,
    trailingNewline: /\r?\n[ \t]*$/
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Tool names accepted for the registry-gated formats, longest first so `<foo_2` wins over `<foo`. */
function registryNames(registry) {
    if (!Array.isArray(registry)) return [];
    const names = new Set();
    registry.forEach((tool) => {
        if (tool?.namespacedName) names.add(tool.namespacedName);
        if (tool?.originalName) names.add(tool.originalName);
    });
    return [...names].sort((a, b) => b.length - a.length);
}

/** Map every accepted tool name (namespaced and original) to its declared JSON schema. */
function registrySchemas(registry) {
    const schemas = new Map();
    if (!Array.isArray(registry)) return schemas;
    registry.forEach((tool) => {
        if (!tool?.parameters) return;
        if (tool.namespacedName) schemas.set(tool.namespacedName, tool.parameters);
        if (tool.originalName) schemas.set(tool.originalName, tool.parameters);
    });
    return schemas;
}

/**
 * DSML parameter bodies usually sit on their own line. Drop one leading and one trailing
 * newline so `<parameter>\nvalue\n</parameter>` yields "value", while interior whitespace
 * and intentional trailing spaces inside multi-line values survive untouched.
 */
function trimParamValue(raw) {
    return String(raw ?? '')
        .replace(RE.leadingNewline, '')
        .replace(RE.trailingNewline, '');
}

/** `string="true"` forces a string; otherwise numbers/booleans/objects are decoded. */
function coerceParamValue(value, attrs) {
    if (/string\s*=\s*["']true["']/i.test(attrs || '')) return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (!/^(-?\d|true$|false$|null$|\{|\[|")/.test(trimmed)) return value;
    try {
        return JSON.parse(trimmed);
    } catch {
        return value;
    }
}

/** Pull `{ id?, name, arguments }` out of the many JSON shapes models produce. */
function rawCallFromJson(node) {
    if (!node || typeof node !== 'object') return null;
    const name = node?.function?.name || node?.name || node?.tool_name || node?.tool;
    if (!name || typeof name !== 'string') return null;
    let args = node?.function?.arguments ?? node?.arguments ?? node?.parameters ?? node?.args ?? {};
    if (typeof args === 'string') {
        const trimmed = args.trim();
        if (!trimmed) {
            args = {};
        } else {
            try {
                args = JSON.parse(trimmed);
            } catch {
                return { id: node?.id, name, arguments: trimmed };
            }
        }
    }
    return { id: node?.id, name, arguments: args };
}

/** Expand a decoded JSON payload, which may be a single call, an array, or a wrapper object. */
function rawCallsFromJsonPayload(parsed) {
    const candidates = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.tool_calls)
            ? parsed.tool_calls
            : Array.isArray(parsed?.invokes)
                ? parsed.invokes
                : [parsed];
    return candidates.map(rawCallFromJson).filter(Boolean);
}

function rawCallsFromJsonText(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return [];
    try {
        return rawCallsFromJsonPayload(JSON.parse(trimmed));
    } catch {
        // The body may be prefixed by stray markup — a nested <function_calls> tag copied
        // from the contract reminder, or a tool wrapper tag emitted by the model before
        // the JSON payload. Scan for the first balanced JSON value and try again.
        const found = findFirstJsonValue(trimmed);
        if (!found) return [];
        try {
            return rawCallsFromJsonPayload(JSON.parse(found.json));
        } catch {
            return [];
        }
    }
}

/** Byte offset just past the JSON value starting at `start`, or -1 if it never closes. */
function findJsonEnd(text, start) {
    const opener = text[start];
    if (opener !== '{' && opener !== '[') return -1;
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === opener) depth += 1;
        else if (ch === closer) {
            depth -= 1;
            if (depth === 0) return i + 1;
        }
    }
    return -1;
}

/** First balanced JSON object/array in `text`, as `{ json, start, end }`. */
function findFirstJsonValue(text) {
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] !== '{' && text[i] !== '[') continue;
        const end = findJsonEnd(text, i);
        if (end === -1) continue;
        const json = text.slice(i, end);
        try {
            JSON.parse(json);
            return { json, start: i, end };
        } catch {
            // Keep scanning; this brace was not the start of a valid value.
        }
    }
    return null;
}

// --- format extractors -----------------------------------------------------
// Each returns { calls, spans } where spans are [start, end) ranges of consumed markup.

function extractCanonical(text) {
    const calls = [];
    const spans = [];
    for (const match of text.matchAll(RE.canonicalBlock)) {
        spans.push([match.index, match.index + match[0].length]);
        calls.push(...rawCallsFromJsonText(match[1]));
    }
    return { calls, spans };
}

function extractInvokeBlocks(segment) {
    const calls = [];
    for (const invoke of segment.matchAll(RE.invokeBlock)) {
        const args = {};
        for (const param of invoke[2].matchAll(RE.invokeParam)) {
            args[param[1]] = coerceParamValue(trimParamValue(param[3]), param[2]);
        }
        calls.push({ name: invoke[1], arguments: args });
    }
    return calls;
}

/** DSML/plain `<tool_calls>` containers, plus bare `<invoke>` blocks outside any container. */
function extractDsml(text) {
    const calls = [];
    const spans = [];
    let remainder = text;

    for (const container of text.matchAll(RE.dsmlContainer)) {
        spans.push([container.index, container.index + container[0].length]);
        const inner = extractInvokeBlocks(container[1]);
        // A <tool_calls> wrapper around plain JSON is also common.
        calls.push(...(inner.length ? inner : rawCallsFromJsonText(container[1])));
        remainder = remainder.replace(container[0], ' '.repeat(container[0].length));
    }

    for (const invoke of remainder.matchAll(RE.invokeBlock)) {
        spans.push([invoke.index, invoke.index + invoke[0].length]);
        calls.push(...extractInvokeBlocks(invoke[0]));
    }

    return { calls, spans };
}

function extractJsonWrapper(text) {
    const calls = [];
    const spans = [];
    for (const match of text.matchAll(RE.jsonWrapper)) {
        spans.push([match.index, match.index + match[0].length]);
        calls.push(...rawCallsFromJsonText(match[1]));
    }
    return { calls, spans };
}

/**
 * Pull the arguments attribute value out of a tag's attribute text. Handles quoted
 * values (`arguments='{...}'`) and bare ones (`arguments={...}`), which models emit
 * interchangeably.
 */
function argsFromAttrs(attrs) {
    const marker = attrs.match(/(?:arguments|parameters|args|input)\s*=\s*/i);
    if (!marker) return null;
    const start = marker.index + marker[0].length;
    const opener = attrs[start];

    if (opener === '"' || opener === "'") {
        let i = start + 1;
        let out = '';
        while (i < attrs.length && attrs[i] !== opener) {
            if (attrs[i] === '\\' && i + 1 < attrs.length) {
                out += attrs[i + 1];
                i += 2;
                continue;
            }
            out += attrs[i];
            i += 1;
        }
        return out;
    }

    if (opener === '{' || opener === '[') {
        const end = findJsonEnd(attrs, start);
        if (end !== -1) return attrs.slice(start, end);
    }
    return null;
}

/**
 * Coerce an XML child element's text using the declared JSON-schema type. A schema type of
 * `string` is honoured verbatim so a path like `123.txt` or a body of JSON-looking text is
 * not silently turned into a number or an object.
 */
function coerceSchemaValue(value, schema) {
    const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
    if (type === 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (type === 'number' || type === 'integer') {
        const num = Number(trimmed);
        return Number.isFinite(num) ? num : value;
    }
    if (type === 'boolean') {
        if (/^true$/i.test(trimmed)) return true;
        if (/^false$/i.test(trimmed)) return false;
        return value;
    }
    if (type === 'object' || type === 'array') {
        try {
            return JSON.parse(trimmed);
        } catch {
            return value;
        }
    }
    // Untyped: fall back to the permissive decoding used elsewhere.
    return coerceParamValue(value, '');
}

/**
 * Arguments carried as XML child elements rather than JSON:
 *
 *   <read>
 *     <path>a.txt</path>
 *     <offset>10</offset>
 *   </read>
 *
 * Widely used by Cline/Roo-style harnesses, so many models emit it from training even when
 * asked for JSON. Only child names declared in the tool's own schema are accepted, which
 * keeps prose containing angle brackets from being mistaken for arguments.
 */
function argsFromXmlChildren(body, parameters) {
    const properties = parameters && typeof parameters === 'object' ? parameters.properties : null;
    if (!properties || typeof properties !== 'object') return null;
    const allowed = Object.keys(properties);
    if (!allowed.length) return null;

    const args = {};
    let matched = 0;
    for (const key of allowed) {
        const re = new RegExp(`<${escapeRegExp(key)}\\s*>([\\s\\S]*?)</${escapeRegExp(key)}\\s*>`, 'i');
        const found = body.match(re);
        if (!found) continue;
        matched += 1;
        args[key] = coerceSchemaValue(trimParamValue(found[1]), properties[key]);
    }
    return matched > 0 ? args : null;
}

/**
 * End index of a tag's attribute region, skipping over quoted strings and balanced JSON
 * so that a `>` inside an attribute value (`arguments={"command":"ls > out"}`) does not
 * terminate the tag early.
 */
function findTagEnd(text, from) {
    let i = from;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"' || ch === "'") {
            const quote = ch;
            i += 1;
            while (i < text.length && text[i] !== quote) {
                if (text[i] === '\\') i += 1;
                i += 1;
            }
            i += 1;
            continue;
        }
        if (ch === '{' || ch === '[') {
            const end = findJsonEnd(text, i);
            if (end !== -1) {
                i = end;
                continue;
            }
        }
        if (ch === '>') return i;
        i += 1;
    }
    return -1;
}

/**
 * Registry-gated tag formats: `<tool .../>`, `<tool ...>body</tool>`, and an unclosed
 * `<tool ...>` followed by a JSON body.
 */
function extractTagNamed(text, names, schemas = new Map()) {
    const calls = [];
    const spans = [];
    if (!names.length) return { calls, spans };

    const opener = new RegExp(`<(${names.map(escapeRegExp).join('|')})(?=[\\s/>"'])`, 'g');

    for (const match of text.matchAll(opener)) {
        const name = match[1];
        const attrsStart = match.index + match[0].length;
        const tagEnd = findTagEnd(text, attrsStart);
        if (tagEnd === -1) continue;
        const attrs = text.slice(attrsStart, tagEnd);
        const openEnd = tagEnd + 1;

        // Arguments carried as an attribute: arguments='{"a":1}' or arguments={"a":1}
        const attrArgs = argsFromAttrs(attrs);
        if (attrArgs !== null) {
            const parsed = rawCallsFromJsonText(attrArgs);
            if (parsed.length) {
                calls.push(...parsed.map((call) => ({ ...call, name: call.name || name })));
            } else {
                try {
                    calls.push({ name, arguments: JSON.parse(attrArgs) });
                } catch {
                    calls.push({ name, arguments: {} });
                }
            }
            spans.push([match.index, openEnd]);
            continue;
        }

        if (attrs.trim().endsWith('/')) {
            calls.push({ name, arguments: {} });
            spans.push([match.index, openEnd]);
            continue;
        }

        // Body may be wrapped in a matching close tag, or simply trail the opener.
        const closeTag = `</${name}>`;
        const closeIdx = text.indexOf(closeTag, openEnd);
        const body = closeIdx === -1 ? text.slice(openEnd) : text.slice(openEnd, closeIdx);
        const json = findFirstJsonValue(body);
        const consumedEnd = closeIdx === -1
            ? (json ? openEnd + json.end : openEnd)
            : closeIdx + closeTag.length;

        if (json) {
            const parsed = rawCallsFromJsonText(json.json);
            const named = parsed.filter((call) => call.name);
            if (named.length) {
                calls.push(...named);
            } else {
                try {
                    calls.push({ name, arguments: JSON.parse(json.json) });
                } catch {
                    calls.push({ name, arguments: {} });
                }
            }
        } else {
            // No JSON body. Arguments may still be present as XML child elements named
            // after the schema's properties; dropping them here produced tool calls with
            // empty arguments, which fail validation for any tool with required fields.
            const xmlArgs = argsFromXmlChildren(body, schemas.get(name));
            calls.push({ name, arguments: xmlArgs || {} });
        }
        spans.push([match.index, consumedEnd]);
    }

    return { calls, spans };
}

/**
 * Registry-gated bare JSON. Requires the JSON to be the whole message body (optionally
 * inside one code fence) so that payloads quoted inside prose are left alone.
 */
function extractBareJson(text, names) {
    if (!names.length) return { calls: [], spans: [] };
    const trimmed = text.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[' && !trimmed.startsWith('```'))) {
        return { calls: [], spans: [] };
    }

    const fenced = trimmed.match(RE.codeFence);
    const body = (fenced ? fenced[1] : trimmed).trim();
    if (!body || (body[0] !== '{' && body[0] !== '[')) return { calls: [], spans: [] };

    const calls = rawCallsFromJsonText(body).filter((call) => names.includes(call.name));
    if (!calls.length) return { calls: [], spans: [] };
    return { calls, spans: [[0, text.length]] };
}

/**
 * `<function=name>` / `<parameter=key>value</parameter>` markup, the native tool-call
 * dialect of Qwen/GLM-family models and some OpenCode free-tier models:
 *
 *   <tool_call>
 *   <function=webfetch>
 *   <parameter=url>https://example.com</parameter>
 *   <parameter=format>html</parameter>
 *   </function>
 *   </tool_call>
 *
 * The surrounding `<tool_call>` container is already consumed by extractJsonWrapper
 * (which strips it as a span even when the body is not JSON), so here we only recognise
 * the `<function=...>` opener, collect its `<parameter=...>` children, and mark the
 * whole `<function>...</function>` block for hiding. Name mapping (e.g. `webfetch` →
 * `web_fetch`) is resolved later against the request's registry.
 */
function extractFunctionEquals(text) {
    const calls = [];
    const spans = [];
    const openerRe = /<function\s*=\s*([^\s/>]+)\s*>/gi;
    for (const match of text.matchAll(openerRe)) {
        const name = match[1].trim();
        if (!name) continue;
        const openEnd = match.index + match[0].length;
        const closeIdx = text.indexOf('</function>', openEnd);
        const end = closeIdx === -1 ? text.length : closeIdx + '</function>'.length;
        const body = closeIdx === -1 ? text.slice(openEnd) : text.slice(openEnd, closeIdx);

        const args = {};
        const paramRe = /<parameter\s*=\s*([^\s/>]+)\s*>([\s\S]*?)<\/parameter\s*>/gi;
        for (const param of body.matchAll(paramRe)) {
            args[param[1].trim()] = trimParamValue(param[2]);
        }

        calls.push({ name, arguments: args });
        spans.push([match.index, end]);
    }
    return { calls, spans };
}

/** Every format in one pass. `spans` cover all markup that should be hidden from users. */
function collectAll(text, registry) {
    const source = typeof text === 'string' ? text : '';
    if (!source) return { calls: [], spans: [] };
    const names = registryNames(registry);
    const schemas = registrySchemas(registry);

    const results = [
        extractCanonical(source),
        extractDsml(source),
        extractJsonWrapper(source),
        extractFunctionEquals(source),
        extractTagNamed(source, names, schemas),
        extractBareJson(source, names)
    ];

    const seen = new Set();
    const calls = [];
    results.forEach((result) => {
        result.calls.forEach((call) => {
            // Distinct formats can describe the same call (e.g. a tag wrapping JSON that
            // also names the tool); keep one entry per name+arguments pair.
            const key = `${call.name}::${JSON.stringify(call.arguments)}`;
            if (seen.has(key)) return;
            seen.add(key);
            calls.push(call);
        });
    });

    return { calls, spans: results.flatMap((result) => result.spans) };
}

function toFinalCalls(rawCalls, seed = 0) {
    return rawCalls.map((call, index) => ({
        id: call.id || `call_${Date.now()}_${seed + index + 1}`,
        type: 'function',
        function: {
            name: call.name,
            arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {})
        }
    }));
}

// --- public API ------------------------------------------------------------

/** Canonical `<function_calls>` blocks only. Kept for callers that must not guess. */
export function parseToolCallsFromText(...chunks) {
    const calls = [];
    chunks.forEach((chunk) => {
        if (!chunk || typeof chunk !== 'string') return;
        calls.push(...extractCanonical(chunk).calls);
    });
    return toFinalCalls(calls);
}

/**
 * Remove tool-call markup from user-visible text.
 * Registry-gated formats are only stripped when `options.registry` is supplied; the
 * self-delimiting formats are always stripped.
 */
export function stripFunctionCallMarkup(text, trim = true, options = {}) {
    if (!text) return text;
    const { spans } = collectAll(text, options.registry);

    let cleaned = text;
    if (spans.length) {
        const merged = [...spans].sort((a, b) => a[0] - b[0]).reduce((acc, span) => {
            const last = acc[acc.length - 1];
            if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
            else acc.push([...span]);
            return acc;
        }, []);
        cleaned = merged.reduceRight((acc, [start, end]) => acc.slice(0, start) + acc.slice(end), cleaned);
    }

    cleaned = cleaned.replace(RE.canonicalStrayTag, '');
    return trim ? cleaned.trim() : cleaned;
}

/** Parse tool calls and map them onto the request's registry, dropping unknown tools. */
export function parseExternalToolCallsFromText(registry, ...chunks) {
    if (!Array.isArray(registry) || registry.length === 0) return [];
    const rawCalls = [];
    chunks.forEach((chunk) => {
        if (!chunk || typeof chunk !== 'string') return;
        rawCalls.push(...collectAll(chunk, registry).calls);
    });

    const counts = new Map();
    return rawCalls.flatMap((rawCall) => {
        const tool = findExternalToolByName(registry, rawCall.name);
        if (!tool) return [];
        const nextCount = (counts.get(tool.namespacedName) || 0) + 1;
        counts.set(tool.namespacedName, nextCount);
        return [{
            id: rawCall.id || `call_${tool.namespacedName.replace(/[^a-zA-Z0-9_]/g, '_')}_${nextCount}`,
            type: 'function',
            function: {
                name: tool.originalName,
                arguments: typeof rawCall.arguments === 'string'
                    ? rawCall.arguments
                    : JSON.stringify(rawCall.arguments ?? {})
            }
        }];
    });
}

/**
 * Openers that may begin tool markup. Used to decide whether a partial chunk should be
 * withheld from the client until we know what it is.
 */
function markerOpeners(registry) {
    const openers = ['<function_calls', '<function=', '<tool_call', '<tool_calls', '<invoke', '<parameter', '<\uFF5C', '<|'];
    registryNames(registry).forEach((name) => openers.push(`<${name.toLowerCase()}`));
    return openers;
}

/** True when `candidate` is a prefix of an opener, or already contains one. */
function couldBeMarker(candidate, openers) {
    const lower = candidate.toLowerCase();
    return openers.some((opener) => opener.startsWith(lower) || lower.startsWith(opener));
}

/** Complete self-delimiting blocks are dropped inline; other formats wait for flush(). */
const INLINE_BLOCKS = [
    { open: new RegExp(`^<${MARK}tool_calls\\s*>`, 'i'), close: new RegExp(`</${MARK}tool_calls\\s*>`, 'i') },
    { open: new RegExp(`^<${MARK}invoke\\s`, 'i'), close: new RegExp(`</${MARK}invoke\\s*>`, 'i') },
    { open: /^<tool_call\s*>/i, close: /<\/tool_call\s*>/i },
    { open: new RegExp(`^${escapeRegExp(CANONICAL_OPEN)}`, 'i'), close: new RegExp(escapeRegExp(CANONICAL_CLOSE), 'i') }
];

/**
 * Close tags for the known block formats. OpenCode streams reasoning and content as
 * separate channels, so a model can open a block in one and close it in the other. The
 * channel that only receives the closer must drop it instead of printing it as prose.
 */
const KNOWN_CLOSE_TAG = new RegExp(
    `^</${MARK}(?:function_calls|function|tool_calls|tool_call|invoke|parameter)\\s*>`,
    'i'
);

/** A close tag truncated at a chunk boundary, e.g. "</function_". */
const PARTIAL_CLOSE_TAG = /^<\/[a-z0-9_\uFF5C|]*$/i;

function matchInlineBlock(buffer) {
    for (const block of INLINE_BLOCKS) {
        if (!block.open.test(buffer)) continue;
        const close = buffer.match(block.close);
        if (!close) return { pending: true };
        return { end: close.index + close[0].length };
    }
    return null;
}

/**
 * Streaming text filter. Emits user-visible text and withholds anything that may be tool
 * markup. Call `flush()` when the stream ends to release or discard held text.
 */
export function createToolCallFilter({ disableTools, forceStrip = false, registry = null } = {}) {
    if (!disableTools && !forceStrip) {
        const passthrough = (chunk) => chunk;
        passthrough.flush = () => '';
        return passthrough;
    }

    const openers = markerOpeners(registry);
    let buffer = '';
    let emittedVisible = false;
    let held = false;

    const filter = (chunk) => {
        if (!chunk) return '';
        buffer += chunk;
        let output = '';

        while (buffer.length) {
            if (held) return output;

            const inline = matchInlineBlock(buffer);
            if (inline?.pending) return output;
            if (inline) {
                buffer = buffer.slice(inline.end);
                continue;
            }

            // Orphaned close tag from a block that opened in the other channel.
            const orphanClose = buffer.match(KNOWN_CLOSE_TAG);
            if (orphanClose) {
                buffer = buffer.slice(orphanClose[0].length);
                continue;
            }
            if (PARTIAL_CLOSE_TAG.test(buffer)) return output;

            // A leading `{` may be a whole-body JSON call; hold it until flush decides.
            if (!emittedVisible && !output.trim() && /^\s*[{[]/.test(buffer)) {
                held = true;
                return output;
            }

            const markerIdx = buffer.indexOf('<');
            if (markerIdx === -1) {
                output += buffer;
                buffer = '';
                break;
            }

            if (markerIdx > 0) {
                output += buffer.slice(0, markerIdx);
                buffer = buffer.slice(markerIdx);
                continue;
            }

            if (!couldBeMarker(buffer, openers)) {
                output += buffer[0];
                buffer = buffer.slice(1);
                continue;
            }

            // Either an incomplete opener or a registry-gated format. Hold for flush().
            const complete = /^<[^\s/>]+[^>]*>/.test(buffer);
            if (!complete) return output;
            held = true;
            return output;
        }

        if (output.trim()) emittedVisible = true;
        return output;
    };

    filter.flush = () => {
        const remaining = buffer;
        buffer = '';
        held = false;
        if (!remaining) return '';
        // Strip whatever markup is actually present and release the rest. Also drop a
        // trailing orphaned close tag that was still being buffered when the stream ended.
        const stripped = stripFunctionCallMarkup(remaining, false, { registry });
        return KNOWN_CLOSE_TAG.test(stripped.trim()) ? '' : stripped;
    };

    return filter;
}

/**
 * Streaming tool-call extractor. Self-delimiting blocks surface as soon as they close;
 * registry-gated formats surface from `flush()` at end of stream.
 */
export function createExternalToolCallStreamParser(registry) {
    if (!Array.isArray(registry) || registry.length === 0) {
        const noop = () => [];
        noop.flush = () => [];
        return noop;
    }

    const openers = markerOpeners(registry);
    let buffer = '';
    let sequence = 0;

    const withUniqueIds = (calls) => calls.map((call) => {
        sequence += 1;
        return { ...call, id: `${call.id}_${sequence}` };
    });

    const parser = (chunk) => {
        if (!chunk) return [];
        buffer += chunk;
        const calls = [];

        while (buffer.length) {
            const markerIdx = buffer.search(/<[^\s]/);
            if (markerIdx === -1) break;

            const candidate = buffer.slice(markerIdx);
            const inline = matchInlineBlock(candidate);
            if (inline?.pending) break;
            if (inline) {
                const block = candidate.slice(0, inline.end);
                calls.push(...withUniqueIds(parseExternalToolCallsFromText(registry, block)));
                buffer = candidate.slice(inline.end);
                continue;
            }

            if (couldBeMarker(candidate, openers)) break;
            buffer = candidate.slice(1);
        }

        return calls;
    };

    parser.flush = () => {
        const remaining = buffer;
        buffer = '';
        if (!remaining.trim()) return [];
        return withUniqueIds(parseExternalToolCallsFromText(registry, remaining));
    };

    return parser;
}
