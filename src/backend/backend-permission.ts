// Backend permission lockdown (pure, no Express/SDK deps).
//
// Why: the headless backend (opencode serve) must never `ask` — nobody can
// approve, so the prompt hangs until the proxy 180s timeout — and must not
// silently execute tools the proxy did not authorize. The free-tier strip
// (selectPromptToolOverrides, src/proxy.ts) omits the prompt `tools` map for
// suspect models, which makes the backend fall back to agent defaults (all
// internal tools on). Observed live: backend invoked real internal `read` on
// /tmp/*, hit `external_directory ask`, hung forever.
//
// Posture: deny-all by default; only explicitly allowlisted internal tools
// are allowed (explicit opt-in preserved). external_directory is always
// jailed to the backend project dir so allowed file tools cannot escape it.
// Unknown allowlist names are ignored (never emitted) to stay schema-valid
// per https://opencode.ai/config.json (PermissionConfig keys).
//
// Free-tier gate: OpenCode's Permission.disabled() (used by resolveTools())
// runs findLast over the permission rules, matching the TOOL NAME only, then
// checks whether that selected rule's pattern is `*` with action `deny`. A
// final `*: deny` therefore hides `read`; hiding it drops `read` from the
// upstream tools[] and Zen free tier answers 403 FreeTierError. `read` thus
// emits an ordered rule object ({ "*": deny, [FREE_TIER_READ_GATE_PATH]:
// allow }) whose selected (last) rule is the non-wildcard sentinel allow, so
// the tool-name check does not disable `read`. Execution-time path matching is
// separate: it evaluates the actual path, which matches only the leading
// `*: deny`, so every real path is denied. The sentinel is NUL-terminated: no
// real file path can contain NUL, so no real read path can match it, even
// after OpenCode's Wildcard.match normalizes backslashes to slashes (which
// would otherwise let a workspace file named
// `\__opencode_free_tier_gate_never__` collide with a bare absolute sentinel).
// The sentinel is an upstream free-tier gate token, NOT a real permission
// grant; explicit `read` opt-in still emits "allow". Do not "simplify" it
// back to "deny".

/** Backend project dir inside the container (session working scope). */
export const BACKEND_PROJECT_DIR = '/home/node/project';

/** NUL-terminated sentinel rule path for the free-tier `read` gate (see
 * header). No real file path can contain NUL, so no actual read path can
 * match it, including after OpenCode's Wildcard.match backslash-to-slash
 * normalization. It only keeps `read` visible to OpenCode's findLast-based
 * permission filter so the upstream tools[] carries `read`. This is not a
 * permission grant. */
export const FREE_TIER_READ_GATE_PATH = '/__opencode_free_tier_gate_never__\u0000';

/** Schema-valid opencode permission keys (PermissionConfig). Flat-action keys
 * (todowrite/question/webfetch/websearch/doom_loop) take a bare
 * "allow"/"deny" string, never an object. */
export const BACKEND_PERMISSION_TOOL_KEYS: readonly string[] = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'lsp',
  'doom_loop',
  'skill',
];

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase().replace(/[_-]+/g, '');
}

function normalizedKeyMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const key of BACKEND_PERMISSION_TOOL_KEYS) {
    map.set(key.toLowerCase().replace(/[_-]+/g, ''), key);
  }
  return map;
}

/**
 * Build the backend `permission` record.
 * @param allowedTools explicit internal allowlist (array of names, any case;
 *   `web_fetch`/`WEB-FETCH` alias to the `webfetch` schema key). Unknown
 *   names are ignored.
 * @param webFetchEnabled legacy shortcut: allow `webfetch` when no explicit
 *   list is configured (mirrors the proxy internal-allowlist resolution).
 * @param projectDir backend project scope for the external_directory jail
 *   (container default; isolated-home callers pass their jail workspace).
 */
export function buildBackendPermission(
  allowedTools: unknown = [],
  webFetchEnabled: unknown = false,
  projectDir: unknown = BACKEND_PROJECT_DIR,
): Record<string, unknown> {
  const keyByNormalized = normalizedKeyMap();
  const allowed = new Set<string>();
  const entries = Array.isArray(allowedTools) ? allowedTools : [];
  for (const entry of entries) {
    const schemaKey = keyByNormalized.get(normalizeToolName(entry) ?? '');
    if (schemaKey && schemaKey !== 'external_directory') allowed.add(schemaKey);
  }
  if (allowed.size === 0 && webFetchEnabled === true) allowed.add('webfetch');

  const scope = typeof projectDir === 'string' && projectDir.trim() ? projectDir.trim() : BACKEND_PROJECT_DIR;
  const permission: Record<string, unknown> = {};
  for (const key of BACKEND_PERMISSION_TOOL_KEYS) {
    if (key === 'external_directory') {
      permission[key] = { [`${scope}/**`]: 'allow', '*': 'deny' };
    } else if (key === 'read' && !allowed.has(key)) {
      // Permission.disabled() runs findLast against the tool name only, then
      // checks the selected rule's pattern: a final `*: deny` hides `read`.
      // The NUL-terminated sentinel allow must stay last so the selected rule
      // is not `*`. Execution-time path matching is separate and still denies
      // every real path via the leading `*: deny` (no real path contains NUL,
      // so none can match the sentinel). Do not replace this with 'deny'
      // (re-breaks Zen free tier) or 'allow' (real read execution).
      permission[key] = { '*': 'deny', [FREE_TIER_READ_GATE_PATH]: 'allow' };
    } else {
      permission[key] = allowed.has(key) ? 'allow' : 'deny';
    }
  }
  return permission;
}
