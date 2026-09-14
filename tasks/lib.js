"use strict";
// tasks/lib.js — helpers shared by the task scripts (code-review, improvement-loop,
// dashboard-review): the proposals file with rotation, the Ollama Cloud model call with a
// timeout budget, and the normaliser for the model's untrusted JSON.
const fs   = require("fs");
const path = require("path");

/** brain/proposals.md grows with every run: rotate it aside once it passes maxBytes. */
function appendWithRotation(filePath, content, { maxBytes = 500_000, tag = "tasks" } = {}) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      const backup = filePath.replace(".md", `-${Date.now()}.md`);
      fs.renameSync(filePath, backup);
      console.log(`[${tag}] rotated proposals to ${backup}`);
    }
  } catch (e) {
    // No file yet is normal; anything else (permissions, rename failure) would let the file grow unbounded.
    if (e.code !== "ENOENT") console.warn(`[${tag}] rotation check failed for ${filePath}: ${e.message}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, content);
}

/**
 * Ollama Cloud chat with a timeout budget. OLLAMA_TIMEOUT (seconds, default 300) is the base;
 * budgetForLines() adds 0.5 s per line sent, capped at 600 s, because a flat 120 s lost the two
 * longest files of the 2026-09-14 run. An abort surfaces as an ordinary Error the caller counts
 * as a failed review.
 */
function createModel({ apiKey = process.env.OLLAMA_API_KEY, model = process.env.OLLAMA_MODEL || "kimi-k2.7-code",
                       baseTimeoutMs = (Number(process.env.OLLAMA_TIMEOUT) > 0 ? Number(process.env.OLLAMA_TIMEOUT) : 300) * 1000,
                       maxTimeoutMs = 600 * 1000, endpoint = "https://ollama.com/api/chat" } = {}) {
  const budgetForLines = (linesSent) => Math.min(maxTimeoutMs, baseTimeoutMs + Math.round(linesSent * 500));
  async function call(prompt, { timeoutMs = baseTimeoutMs } = {}) {
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e.name === "TimeoutError" || e.name === "AbortError") throw new Error(`Ollama Cloud timed out after ${Math.round(timeoutMs / 1000)}s (OLLAMA_TIMEOUT base ${baseTimeoutMs / 1000}s)`);
      throw e;
    }
    if (!res.ok) throw new Error(`Ollama Cloud ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.message?.content || "";
  }
  return { call, budgetForLines, model, enabled: !!apiKey, baseTimeoutMs, maxTimeoutMs };
}

/** The model wraps JSON in a fence more often than not. */
function stripFence(raw) { return String(raw || "").replace(/```json|```/g, "").trim(); }

// The model's JSON is untrusted: coerce the fields the reports sort and print on, drop issues without a message.
const SEVERITIES = new Set(["HIGH", "MEDIUM", "LOW"]);
function normSeverity(s) { s = String(s || "").toUpperCase(); return SEVERITIES.has(s) ? s : "LOW"; }
function normIssues(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((i) => i && typeof i.msg === "string" && i.msg.trim()).map((i) => {
    const line = Number(i.line);
    return { ...i, severity: normSeverity(i.severity), line: Number.isInteger(line) && line > 0 ? line : null, fix: typeof i.fix === "string" ? i.fix : undefined };
  });
}
function normReview(r) {
  const score = Math.round(Number(r.score));
  return { ...r, score: Number.isInteger(score) && score >= 1 && score <= 10 ? score : null, summary: typeof r.summary === "string" ? r.summary : "",
    issues: normIssues(r.issues), suggestions: Array.isArray(r.suggestions) ? r.suggestions.filter((s) => typeof s === "string") : [] };
}

module.exports = { appendWithRotation, createModel, stripFence, normSeverity, normIssues, normReview, SEVERITIES };
