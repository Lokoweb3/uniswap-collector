const fs = require("fs");
const path = require("path");
const ROOT = process.cwd();

// ── PATCH 1: server.js → POST /api/tasks/run ─────────────────────────────────
const serverPath = path.join(ROOT, "server.js");
let server = fs.readFileSync(serverPath, "utf8");

const serverPatch = `
  // === tasks: manual trigger for run-all.sh ===
  if (url.pathname === "/api/tasks/run" && req.method === "POST") {
    const { spawn } = require("child_process");
    const task = url.searchParams.get("task");
    const script = task ? \`node tasks/\${task}.js\` : "bash tasks/run-all.sh";
    const child = spawn("bash", ["-c", script], {
      cwd: __dirname, detached: true, stdio: ["ignore","pipe","pipe"],
    });
    const started = new Date().toISOString();
    child.unref();
    return res.end(JSON.stringify({ ok: true, started, script, pid: child.pid }));
  }
  // === end tasks ===
`;

if (server.includes('"/api/tasks/run"')) {
  console.log("SKIP server.js — already patched");
} else {
  server = server.replace(
    'if (url.pathname === "/api/backup" && req.method === "POST")',
    serverPatch + '\n  if (url.pathname === "/api/backup" && req.method === "POST")'
  );
  fs.writeFileSync(serverPath, server);
  console.log("✅ server.js — POST /api/tasks/run added");
}

// ── PATCH 2: lp-mcp.mjs → 3 new tools ───────────────────────────────────────
const mcpPath = path.join(ROOT, "lp-mcp.mjs");
let mcp = fs.readFileSync(mcpPath, "utf8");

const mcpTools = `
// ── Task runner tools ────────────────────────────────────────────────────────

server.tool("run_tasks", {
  description: "Run LP improvement loop and code review. Pass task name to run one: improvement-loop, code-scan, code-review, pool-scan. Omit to run all.",
  inputSchema: { type:"object", properties: { task: { type:"string", enum:["improvement-loop","code-scan","code-review","pool-scan"] } } },
}, async ({ task } = {}) => {
  const url = task
    ? \`http://127.0.0.1:\${PORT}/api/tasks/run?task=\${task}\`
    : \`http://127.0.0.1:\${PORT}/api/tasks/run\`;
  const r = await fetch(url, { method: "POST" });
  const d = await r.json();
  return { content: [{ type:"text", text: d.ok
    ? \`✅ Started — \${d.script} (pid \${d.pid}) at \${d.started}\`
    : \`❌ Failed: \${JSON.stringify(d)}\` }] };
});

server.tool("get_proposals", {
  description: "Read the latest improvement proposals from brain/proposals.md.",
  inputSchema: { type:"object", properties: { lines: { type:"number", description:"Lines from end (default 80)" } } },
}, async ({ lines = 80 } = {}) => {
  const brainPath = new URL("brain/proposals.md", import.meta.url).pathname;
  try {
    const content = fs.readFileSync(brainPath, "utf8");
    const tail = content.split("\\n").slice(-Math.abs(lines)).join("\\n");
    return { content: [{ type:"text", text: tail || "No proposals yet." }] };
  } catch(e) {
    return { content: [{ type:"text", text: \`No proposals file yet.\` }] };
  }
});

server.tool("get_task_output", {
  description: "Get latest JSON output from a task: improvement-loop, code-scan, code-review, pool-scan.",
  inputSchema: { type:"object", required:["task"], properties: { task: { type:"string", enum:["improvement-loop","code-scan","code-review","pool-scan"] } } },
}, async ({ task }) => {
  const outPath = new URL(\`tasks/output/\${task}.json\`, import.meta.url).pathname;
  try {
    const d = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const lines = [\`Task: \${task}\`, \`Run: \${d.ts||d.timestamp||"?"}\`, \`Status: \${d.status||"n/a"}\`];
    if (d.issues?.length) { lines.push(\`\\nIssues (\${d.issues.length}):\`); d.issues.slice(0,10).forEach(i=>lines.push(\`  [\${i.severity}] \${i.msg}\`)); }
    if (d.suggestions?.length) { lines.push(\`\\nSuggestions:\`); d.suggestions.slice(0,5).forEach((s,i)=>lines.push(\`  \${i+1}. \${s}\`)); }
    if (d.scout?.length) { lines.push(\`\\nPool moves:\`); d.scout.forEach(m=>lines.push(\`  [\${m.urgency}] \${m.pair} → \${m.bestSibling} (\${m.mult}x)\`)); }
    return { content: [{ type:"text", text: lines.join("\\n") }] };
  } catch(e) {
    return { content: [{ type:"text", text: \`No output for \${task} yet. Run it first.\` }] };
  }
});

// ── End task runner tools ─────────────────────────────────────────────────────
`;

if (mcp.includes("run_tasks")) {
  console.log("SKIP lp-mcp.mjs — already patched");
} else {
  // Insert before the connect/start line
  mcp = mcp.replace(/^(const transport[\s\S]*?server\.connect)/m, mcpTools + "\n$1");
  if (!mcp.includes("run_tasks")) {
    mcp = mcp.trimEnd() + "\n" + mcpTools + "\n";
  }
  fs.writeFileSync(mcpPath, mcp);
  console.log("✅ lp-mcp.mjs — run_tasks, get_proposals, get_task_output added");
}
