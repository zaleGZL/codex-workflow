import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { clearPause, rerunAgent, requestPause, resumeRun, stopAgent } from "./runtime.mjs";
import { readState } from "./state.mjs";

export async function serve(cwd, runId, port = undefined, options = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/") return sendHtml(res, page(runId));
      if (req.method === "GET" && url.pathname === "/state.json") return sendJson(res, await readState(cwd, runId));
      if (req.method === "POST" && url.pathname === "/pause") return sendJson(res, await requestPause(cwd, runId));
      if (req.method === "POST" && url.pathname === "/resume") {
        await clearPause(cwd, runId);
        resumeRun(cwd, runId).catch(() => {});
        return sendJson(res, await readState(cwd, runId));
      }
      const controlMatch = url.pathname.match(/^\/agents\/([^/]+)\/(stop|rerun)$/);
      if (req.method === "POST" && controlMatch) {
        const agentId = decodeURIComponent(controlMatch[1]);
        if (controlMatch[2] === "stop") return sendJson(res, await stopAgent(cwd, runId, agentId));
        return sendJson(res, await rerunAgent(cwd, runId, agentId));
      }
      const agentMatch = url.pathname.match(/^\/agents\/([^/]+)(\/events)?$/);
      if (req.method === "GET" && agentMatch) {
        const state = await readState(cwd, runId);
        const agent = state.agents.find(a => a.id === agentMatch[1]);
        if (!agent) return notFound(res);
        if (agentMatch[2]) return sendText(res, await safeRead(agent.events_path));
        return sendHtml(res, agentPage(agent));
      }
      return notFound(res);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(error.stack || error.message);
    }
  });
  await listen(server, port, options.portExplicit === true);
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/`;
  console.log(`Codex workflow dashboard: ${url}`);
  if (options.exitOnDone === true) closeWhenDone(server, cwd, runId);
  if (options.open !== false) openBrowser(url);
  return server;
}

function listen(server, port, explicit) {
  const start = Number(port ?? 8765);
  return new Promise((resolve, reject) => {
    const tryPort = candidate => {
      const onError = error => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && !explicit && candidate < start + 100) {
          tryPort(candidate + 1);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(candidate);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidate, "127.0.0.1");
    };
    tryPort(start);
  });
}

function closeWhenDone(server, cwd, runId) {
  const timer = setInterval(async () => {
    try {
      const state = await readState(cwd, runId);
      if (state.status === "done" || state.status === "failed") {
        clearInterval(timer);
        server.close();
      }
    } catch {}
  }, 1000);
  server.on("close", () => clearInterval(timer));
}

export function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

async function safeRead(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function sendJson(res, value) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value, null, 2));
}

function sendText(res, value) {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(value);
}

function sendHtml(res, value) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(value);
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

function page(runId) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Workflow ${escapeHtml(runId)}</title>
  <style>
    :root{color-scheme:light;--bg:#f6f8fb;--panel:#fff;--panel-2:#f8fafc;--text:#111827;--muted:#64748b;--border:#dbe3ef;--accent:#2563eb;--accent-2:#16a34a;--shadow:0 16px 40px rgba(15,23,42,.08);--code:#0f172a;--code-bg:#eef2f7}
    html[data-theme="dark"]{color-scheme:dark;--bg:#0f172a;--panel:#111c2f;--panel-2:#17233a;--text:#f8fafc;--muted:#94a3b8;--border:#2d3a52;--accent:#60a5fa;--accent-2:#22c55e;--shadow:0 18px 48px rgba(0,0,0,.28);--code:#dbeafe;--code-bg:#0b1220}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    a{color:var(--accent);text-decoration:none}
    a:hover{text-decoration:underline}
    button{appearance:none;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--text);cursor:pointer;font:600 13px/1 ui-sans-serif,system-ui;padding:9px 12px;transition:background .18s ease,border-color .18s ease,transform .18s ease}
    button:hover{background:var(--panel-2);border-color:var(--accent)}
    button:active{transform:translateY(1px)}
    button:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 35%,transparent);outline-offset:2px}
    .app{max-width:1280px;margin:0 auto;padding:24px}
    .topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}
    .eyebrow{color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
    h1{font-size:26px;line-height:1.2;margin:4px 0 0}
    .actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .summary-grid{display:grid;grid-template-columns:repeat(7,minmax(110px,1fr));gap:10px;margin:18px 0}
    .metric{background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);padding:12px}
    .metric span{display:block;color:var(--muted);font-size:12px;font-weight:600}
    .metric strong{display:block;font-size:22px;line-height:1.1;margin-top:6px}
    .panel{background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);overflow:hidden}
    .panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border)}
    h2{font-size:15px;margin:0}
    .table-wrap{overflow:auto}
    table{border-collapse:collapse;width:100%;min-width:1040px}
    th,td{border-bottom:1px solid var(--border);padding:10px 12px;text-align:left;font-size:13px;vertical-align:top}
    th{background:var(--panel-2);color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
    tr:hover td{background:color-mix(in srgb,var(--panel-2) 72%,transparent)}
    code{display:inline-block;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:6px;background:var(--code-bg);color:var(--code);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:1px 5px}
    .status{display:inline-flex;align-items:center;gap:6px;border-radius:999px;font-weight:700;padding:4px 8px;text-transform:capitalize}
    .status:before{content:"";width:7px;height:7px;border-radius:999px;background:currentColor}
    .done{background:#dcfce7;color:#047857}.failed{background:#fee2e2;color:#b91c1c}.running{background:#dbeafe;color:#1d4ed8}.paused{background:#fef3c7;color:#92400e}.stale{background:#ede9fe;color:#7c3aed}.pending{background:#e2e8f0;color:#475569}.stopped{background:#f1f5f9;color:#334155}
    html[data-theme="dark"] .done{background:#06351f;color:#4ade80}html[data-theme="dark"] .failed{background:#451a1a;color:#f87171}html[data-theme="dark"] .running{background:#132d55;color:#93c5fd}html[data-theme="dark"] .paused{background:#422006;color:#fbbf24}html[data-theme="dark"] .stale{background:#2e1065;color:#c4b5fd}html[data-theme="dark"] .pending{background:#263244;color:#cbd5e1}html[data-theme="dark"] .stopped{background:#1f2937;color:#cbd5e1}
    .empty{padding:28px 16px;color:var(--muted);text-align:center}
    @media (max-width:900px){.app{padding:16px}.topbar{display:block}.actions{justify-content:flex-start;margin-top:14px}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media (prefers-reduced-motion:reduce){button{transition:none}}
  </style>
</head>
<body>
  <main class="app">
    <section class="topbar">
      <div>
        <div class="eyebrow">Codex Workflow</div>
        <h1 id="title">Loading workflow</h1>
      </div>
      <div class="actions">
        <button id="theme" onclick="toggleTheme()" aria-label="Toggle dark mode">Dark</button>
      </div>
    </section>
    <section class="summary-grid" aria-label="Workflow status summary">
      <div class="metric"><span>Status</span><strong id="status">...</strong></div>
      <div class="metric"><span>Done</span><strong id="done">0</strong></div>
      <div class="metric"><span>Failed</span><strong id="failed">0</strong></div>
      <div class="metric"><span>Running</span><strong id="running">0</strong></div>
      <div class="metric"><span>Pending</span><strong id="pending">0</strong></div>
      <div class="metric"><span>Stale</span><strong id="stale">0</strong></div>
      <div class="metric"><span>Stopped</span><strong id="stopped">0</strong></div>
    </section>
    <section class="panel">
      <div class="panel-head">
        <h2>Agents</h2>
        <span id="updated" class="eyebrow"></span>
      </div>
      <div class="table-wrap">
        <table><thead><tr><th>ID</th><th>Label</th><th>Mode</th><th>Status</th><th>Tokens</th><th>Files</th><th>Branch</th><th>Warning</th><th>Actions</th></tr></thead><tbody id="agents"></tbody></table>
      </div>
    </section>
  </main>
  <script>
    const root = document.documentElement;
    const storedTheme = localStorage.getItem('codexWorkflowTheme');
    const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(storedTheme || (systemDark ? 'dark' : 'light'));
    function setTheme(theme){
      root.dataset.theme = theme;
      localStorage.setItem('codexWorkflowTheme', theme);
      const button = document.getElementById('theme');
      if (button) button.textContent = theme === 'dark' ? 'Light' : 'Dark';
    }
    function toggleTheme(){ setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'); }
    async function load(){
      const s = await (await fetch('/state.json')).json();
      document.getElementById('title').textContent = s.name + ' / ' + s.run_id;
      const c = s.counts || {};
      for (const key of ['done','failed','running','pending','stale','stopped']) document.getElementById(key).textContent = c[key] || 0;
      document.getElementById('status').textContent = s.status || 'unknown';
      document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
      const agents = s.agents || [];
      document.getElementById('agents').innerHTML = agents.length ? agents.map(a => '<tr><td><a href="/agents/'+a.id+'">'+a.id+'</a></td><td>'+esc(a.label||'')+'</td><td>'+esc(a.mode||'')+'</td><td><span class="status '+esc(a.status||'pending')+'">'+esc(a.status||'pending')+'</span></td><td><code title="'+esc(tokensTitle(a))+'">'+esc(tokensText(a))+'</code></td><td><code title="'+esc(filesText(a))+'">'+esc(filesText(a))+'</code></td><td><code title="'+esc(a.branch||'')+'">'+esc(a.branch||'-')+'</code></td><td>'+esc(a.warning||'')+'</td><td>'+actions(a)+'</td></tr>').join('') : '<tr><td colspan="9" class="empty">No agents scheduled yet.</td></tr>';
    }
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-agent-action]');
      if (button) control(button.dataset.agentId, button.dataset.agentAction);
    });
    async function control(id, action){ await fetch('/agents/'+encodeURIComponent(id)+'/'+action, { method: 'POST' }); await load(); }
    function actions(a){
      if (a.status === 'running') return '<button data-agent-id="'+esc(a.id)+'" data-agent-action="stop">Stop</button>';
      if (['done','failed','stopped','stale'].includes(a.status)) return '<button data-agent-id="'+esc(a.id)+'" data-agent-action="rerun">Rerun</button>';
      return '';
    }
    function tokensText(a){ return a.usage ? fmt(a.usage.total_tokens) : '-'; }
    function tokensTitle(a){ return a.usage ? 'input '+fmt(a.usage.input_tokens)+', cached '+fmt(a.usage.cached_input_tokens)+', output '+fmt(a.usage.output_tokens)+', reasoning '+fmt(a.usage.reasoning_output_tokens) : '-'; }
    function fmt(n){ return Number(n || 0).toLocaleString(); }
    function filesText(a){ return (a.files || []).length ? a.files.join(', ') : '-'; }
    function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
    load(); setInterval(load, 2000);
  </script>
</body>
</html>`;
}

function agentPage(agent) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(agent.id)}</title>
<style>
  :root{color-scheme:light;--bg:#f6f8fb;--panel:#fff;--text:#111827;--muted:#64748b;--border:#dbe3ef;--accent:#2563eb;--code:#0f172a;--code-bg:#eef2f7}
  html[data-theme="dark"]{color-scheme:dark;--bg:#0f172a;--panel:#111c2f;--text:#f8fafc;--muted:#94a3b8;--border:#2d3a52;--accent:#60a5fa;--code:#dbeafe;--code-bg:#0b1220}
  body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui;padding:24px}
  main{max-width:960px;margin:auto;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:20px}
  a{color:var(--accent)} h1{font-size:24px;margin:0 0 16px} p{color:var(--muted)} code,pre{background:var(--code-bg);color:var(--code);border-radius:6px} code{padding:2px 5px} pre{overflow:auto;padding:14px}
</style></head><body>
<main>
  <p><a href="/">Back to dashboard</a></p>
  <h1>${escapeHtml(agent.id)} / ${escapeHtml(agent.status)}</h1>
  <p><b>Label:</b> ${escapeHtml(agent.label || "")}</p>
  <p><b>PID:</b> <code>${escapeHtml(agent.pid || "")}</code></p>
  <p><b>Worktree:</b> <code>${escapeHtml(agent.worktree || "")}</code></p>
  <p><b>Branch:</b> <code>${escapeHtml(agent.branch || "")}</code></p>
  <p>${agentAction(agent)}</p>
  <p><a href="/agents/${encodeURIComponent(agent.id)}/events">events.jsonl</a></p>
  <pre>${escapeHtml(JSON.stringify(agent, null, 2))}</pre>
</main>
<script>
  const storedTheme = localStorage.getItem('codexWorkflowTheme');
  const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = storedTheme || (systemDark ? 'dark' : 'light');
</script>
</body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}

function agentAction(agent) {
  if (agent.status === "running") {
    return `<button onclick="fetch('/agents/${encodeURIComponent(agent.id)}/stop',{method:'POST'}).then(()=>location.reload())">Stop</button>`;
  }
  if (["done", "failed", "stopped", "stale"].includes(agent.status)) {
    return `<button onclick="fetch('/agents/${encodeURIComponent(agent.id)}/rerun',{method:'POST'}).then(()=>location.reload())">Rerun</button>`;
  }
  return "";
}
