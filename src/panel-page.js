/**
 * Built-in Web Panel page (GET /panel).
 *
 * A single self-contained HTML document: no external CSS/JS, no fonts, no
 * images. The CSP meta tag allows only same-origin fetches and inline
 * style/script, so the page cannot load anything from the outside. The shell
 * contains zero data (and zero secrets); the page's script fetches
 * /panel/data.json with a Bearer key kept in localStorage and renders the
 * read-only status/models/diagnostics view from it.
 *
 * NOTE: this file is a template literal — it must not contain backticks or
 * "${" sequences, and the page script must not contain "</script>".
 */
export const PANEL_META_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";
export const PANEL_CSP = `${PANEL_META_CSP}; frame-ancestors 'none'`;

export const PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="${PANEL_META_CSP}">
<title>OpenCode2API · Panel</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0d1117; color: #e6edf3; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px; border-bottom: 1px solid #21262d; background: #010409; position: sticky; top: 0; }
h1 { font-size: 16px; margin: 0; font-weight: 600; }
h1 .tag { color: #8b949e; font-weight: 400; }
.head-actions { display: flex; align-items: center; gap: 10px; color: #8b949e; font-size: 12px; }
main { max-width: 960px; margin: 0 auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
.card h2 { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #8b949e; }
.badge { display: inline-block; background: #30363d; border-radius: 10px; padding: 1px 8px; font-size: 11px; color: #e6edf3; margin-left: 6px; vertical-align: 1px; }
.kv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.kv { border: 1px solid #21262d; border-radius: 6px; padding: 8px 10px; }
.kv .k { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.kv .v { margin-top: 2px; word-break: break-all; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; white-space: nowrap; }
th { color: #8b949e; font-weight: 600; font-size: 12px; }
tbody tr:hover { background: #1c2128; }
.muted { color: #8b949e; font-size: 12px; }
.error { color: #f85149; background: #161b22; border: 1px solid #f85149; border-radius: 8px; padding: 10px 14px; margin: 0; }
.auth-row { display: flex; gap: 8px; margin: 8px 0; }
input[type="password"] { flex: 1; background: #0d1117; border: 1px solid #30363d; color: #e6edf3; border-radius: 6px; padding: 6px 10px; }
button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
button:hover { background: #30363d; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; margin-right: 6px; }
</style>
</head>
<body>
<header>
  <h1>OpenCode2API <span class="tag">/ web panel</span></h1>
  <div class="head-actions"><span id="refresh-info"></span><button id="refresh" type="button">Refresh</button></div>
</header>
<main>
  <section id="auth-box" class="card" hidden>
    <h2>Authentication</h2>
    <p id="auth-error" class="muted"></p>
    <div class="auth-row">
      <input id="auth-key" type="password" placeholder="Proxy API key" autocomplete="off" aria-label="Proxy API key">
      <button id="auth-save" type="button">Save &amp; load</button>
    </div>
    <p class="muted">The key is kept in this browser's localStorage and sent as a Bearer token to /panel/data.json.</p>
  </section>
  <p id="error-box" class="error" hidden></p>
  <section id="status-card" class="card" hidden>
    <h2>Runtime status</h2>
    <div id="status-list" class="kv-grid"></div>
  </section>
  <section id="models-card" class="card" hidden>
    <h2>Models <span id="models-count" class="badge"></span></h2>
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>Name</th><th>Owned by</th></tr></thead>
      <tbody id="models-body"></tbody>
    </table></div>
  </section>
  <section id="diag-card" class="card" hidden>
    <h2>Backend diagnostics</h2>
    <div id="diag-list" class="kv-grid"></div>
  </section>
</main>
<script>
(function () {
    'use strict';
    var KEY_STORAGE = 'opencode2api.panelKey';

    function $(id) { return document.getElementById(id); }
    function show(node) { node.hidden = false; }
    function hide(node) { node.hidden = true; }
    function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }
    function storedKey() {
        try { return localStorage.getItem(KEY_STORAGE); } catch (e) { return null; }
    }
    function saveKey(key) {
        try { localStorage.setItem(KEY_STORAGE, key); } catch (e) { /* storage unavailable */ }
    }
    function clearKey() {
        try { localStorage.removeItem(KEY_STORAGE); } catch (e) { /* storage unavailable */ }
    }
    function fmtUptime(seconds) {
        var s = Math.floor(Number(seconds) || 0);
        var d = Math.floor(s / 86400);
        var h = Math.floor((s % 86400) / 3600);
        var m = Math.floor((s % 3600) / 60);
        var out = '';
        if (d) out += d + 'd ';
        if (d || h) out += h + 'h ';
        if (d || h || m) out += m + 'm ';
        return out + (s % 60) + 's';
    }
    function kvRow(label, value) {
        var k = document.createElement('div'); k.className = 'k'; k.textContent = label;
        var v = document.createElement('div'); v.className = 'v'; v.textContent = String(value);
        var wrap = document.createElement('div'); wrap.className = 'kv';
        wrap.appendChild(k); wrap.appendChild(v);
        return wrap;
    }
    function fillRows(tbodyId, rows) {
        var tbody = $(tbodyId);
        clearChildren(tbody);
        rows.forEach(function (cells) {
            var tr = document.createElement('tr');
            cells.forEach(function (value) {
                var td = document.createElement('td');
                td.textContent = value === null || value === undefined ? '-' : String(value);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
    }

    function render(data) {
        hide($('auth-box')); hide($('error-box'));

        var statusList = $('status-list');
        clearChildren(statusList);
        statusList.appendChild(kvRow('Status', ''));
        var statusValue = statusList.lastChild.querySelector('.v');
        var statusLabel = document.createElement('span');
        statusLabel.className = 'dot';
        statusValue.appendChild(statusLabel);
        statusValue.appendChild(document.createTextNode((data && data.status) || 'unknown'));
        statusList.appendChild(kvRow('Uptime', fmtUptime(data && data.uptime)));
        statusList.appendChild(kvRow('Backend', (data && data.backend_url) || '-'));
        show($('status-card'));

        var models = Array.isArray(data && data.models) ? data.models : [];
        fillRows('models-body', models.map(function (m) { return [m.id, m.name, m.owned_by]; }));
        $('models-count').textContent = String(models.length);
        show($('models-card'));

        var health = (data && data.health) || {};
        var tools = health.internal_tools || {};
        var metrics = tools.metrics || {};
        var cache = tools.cache || {};
        var diagList = $('diag-list');
        clearChildren(diagList);
        diagList.appendChild(kvRow('Health status', health.status || 'unknown'));
        if (metrics && typeof metrics === 'object') {
            var allowed = tools.config && Array.isArray(tools.config.allowed_tools) ? tools.config.allowed_tools : [];
            diagList.appendChild(kvRow('Allowed internal tools', allowed.length ? allowed.join(', ') : '(none)'));
            diagList.appendChild(kvRow('Tool mode requests',
                'external-bridge ' + (metrics.externalBridgeRequests || 0) +
                ' / internal-allowlist ' + (metrics.internalAllowlistRequests || 0) +
                ' / disabled ' + (metrics.disabledRequests || 0)));
            diagList.appendChild(kvRow('Discovery failures', String(metrics.discoveryFailures || 0)));
            diagList.appendChild(kvRow('Fallbacks to disabled', String(metrics.fallbackToDisabled || 0)));
            diagList.appendChild(kvRow('Tool ID cache',
                (cache.tool_ids_cached ? 'cached' : 'empty') +
                ' / ' + (cache.tool_id_count || 0) + ' ids' +
                (cache.age_ms !== null && cache.age_ms !== undefined ? ' / ' + Math.round(cache.age_ms / 1000) + 's old' : '')));
        } else {
            diagList.appendChild(kvRow('Diagnostics', 'Not exposed (health details disabled)'));
        }
        show($('diag-card'));

        $('refresh-info').textContent = 'Updated ' + new Date().toLocaleTimeString();
    }

    function showAuth(message) {
        $('auth-error').textContent = message || '';
        hide($('status-card')); hide($('models-card')); hide($('diag-card'));
        show($('auth-box'));
        $('auth-key').focus();
    }

    function fetchPanel() {
        var key = storedKey();
        var headers = {};
        if (key) headers['Authorization'] = 'Bearer ' + key;
        fetch('/panel/data.json', { headers: headers, cache: 'no-store' })
            .then(function (res) {
                if (res.status === 401) {
                    if (key) clearKey();
                    showAuth('This panel requires the proxy API key.');
                    return null;
                }
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) { if (data) render(data); })
            .catch(function (err) {
                hide($('auth-box'));
                show($('error-box'));
                $('error-box').textContent = 'Failed to load panel data: ' +
                    (err && err.message ? err.message : 'unknown error');
            });
    }

    $('auth-save').addEventListener('click', function () {
        var key = $('auth-key').value.trim();
        if (!key) {
            $('auth-error').textContent = 'Enter the proxy API key.';
            return;
        }
        saveKey(key);
        fetchPanel();
    });
    $('auth-key').addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') $('auth-save').click();
    });
    $('refresh').addEventListener('click', fetchPanel);

    fetchPanel();
})();
</script>
</body>
</html>
`;
