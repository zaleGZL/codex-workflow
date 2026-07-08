import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { clearPause, requestPause, resumeRun } from "./runtime.mjs";
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
  <title>Codex Workflow ${escapeHtml(runId)}</title>
  <style>
    body{font-family:ui-sans-serif,system-ui;margin:24px;color:#1f2937;background:#f8fafc}
    button{margin-right:8px;padding:6px 10px}
    table{border-collapse:collapse;width:100%;background:white}
    th,td{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left;font-size:14px}
    .done{color:#047857}.failed{color:#b91c1c}.running{color:#1d4ed8}.paused{color:#92400e}.stale{color:#7c3aed}
    code{font-size:12px}
  </style>
</head>
<body>
  <h1 id="title">Codex Workflow</h1>
  <p id="summary"></p>
  <button onclick="post('/pause')">Pause</button>
  <button onclick="post('/resume')">Resume</button>
  <h2>Agents</h2>
  <table><thead><tr><th>ID</th><th>Label</th><th>Mode</th><th>Status</th><th>Files</th><th>Branch</th><th>Warning</th></tr></thead><tbody id="agents"></tbody></table>
  <script>
    async function post(path){ await fetch(path,{method:'POST'}); await load(); }
    async function load(){
      const s = await (await fetch('/state.json')).json();
      document.getElementById('title').textContent = s.name + ' / ' + s.run_id;
      const c = s.counts || {};
      document.getElementById('summary').textContent = s.status + ' done:'+(c.done||0)+' failed:'+(c.failed||0)+' running:'+(c.running||0)+' pending:'+(c.pending||0)+' stale:'+(c.stale||0);
      document.getElementById('agents').innerHTML = (s.agents||[]).map(a => '<tr><td><a href="/agents/'+a.id+'">'+a.id+'</a></td><td>'+esc(a.label||'')+'</td><td>'+esc(a.mode||'')+'</td><td class="'+esc(a.status||'')+'">'+esc(a.status||'')+'</td><td><code>'+esc((a.files||[]).join(', '))+'</code></td><td><code>'+esc(a.branch||'')+'</code></td><td>'+esc(a.warning||'')+'</td></tr>').join('');
    }
    function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
    load(); setInterval(load, 2000);
  </script>
</body>
</html>`;
}

function agentPage(agent) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(agent.id)}</title></head><body>
<h1>${escapeHtml(agent.id)} ${escapeHtml(agent.status)}</h1>
<p><b>Label:</b> ${escapeHtml(agent.label || "")}</p>
<p><b>Worktree:</b> <code>${escapeHtml(agent.worktree || "")}</code></p>
<p><b>Branch:</b> <code>${escapeHtml(agent.branch || "")}</code></p>
<p><a href="/agents/${encodeURIComponent(agent.id)}/events">events.jsonl</a></p>
<pre>${escapeHtml(JSON.stringify(agent, null, 2))}</pre>
</body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}
