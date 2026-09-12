"use strict";
require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT    = path.join(__dirname, "..");
const OUT_DIR = path.join(__dirname, "output");
const BRAIN   = path.join(__dirname, "..", "brain", "proposals.md");
const OUT     = path.join(OUT_DIR, "code-review.json");

const KEY_FILES = [
  "server.js","collector.js","guardian-logic.js",
  "attribution.js","strategy.js","alerts.js",
  "tasks/improvement-loop.js",
];

function exec(cmd,cwd=ROOT){try{return execSync(cmd,{cwd,encoding:"utf8",stdio:["pipe","pipe","pipe"]}).trim()}catch(e){return e.stdout?.trim()||""}}

function readFileSafe(filePath,maxLines=300){
  try{
    const abs=path.join(ROOT,filePath);
    if(!fs.existsSync(abs))return null;
    const lines=fs.readFileSync(abs,"utf8").split("\n");
    return{content:lines.slice(0,maxLines).join("\n"),lines:lines.length,truncated:lines.length>maxLines};
  }catch(_){return null}
}

function getChangedFiles(hours=6){
  const raw=exec(`git log --since="${hours} hours ago" --name-only --pretty=format: --diff-filter=AM -- "*.js" "*.mjs"`);
  return [...new Set(raw.split("\n").filter(f=>(f.endsWith(".js")||f.endsWith(".mjs"))&&!f.includes("node_modules")&&!f.includes("tasks/output")))].slice(0,6);
}

async function callClaude(prompt){
  const res=await fetch("https://ollama.com/api/chat",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":"Bearer "+process.env.OLLAMA_API_KEY,
    },
    body:JSON.stringify({
      model: process.env.OLLAMA_MODEL || "llama3.1",
      messages:[{role:"user",content:prompt}],
      stream:false,
    }),
  });
  if(!res.ok)throw new Error(`Ollama Cloud ${res.status}: ${await res.text()}`);
  const data=await res.json();
  return data.message?.content||"";
}

async function reviewFile(filePath,reason){
  const f=readFileSafe(filePath);
  if(!f)return null;
  console.log(`[code-review] reviewing ${filePath} (${f.lines} lines)...`);
  const prompt=`You are a senior Node.js engineer reviewing LP dashboard code for a DeFi LP position manager on Robinhood Chain.

File: ${filePath}
Reason: ${reason}
${f.truncated?`(first 300 of ${f.lines} lines)`:""}

\`\`\`javascript
${f.content}
\`\`\`

Review for: bugs, missing null guards, bad error handling, hardcoded values, logic errors that could cause wrong LP decisions.

Respond ONLY as JSON, no markdown:
{"score":1-10,"summary":"one sentence","issues":[{"severity":"HIGH|MEDIUM|LOW","line":0,"msg":"description","fix":"fix"}],"suggestions":["improvement"]}`;
  try{
    const raw=await callClaude(prompt);
    const result=JSON.parse(raw.replace(/```json|```/g,"").trim());
    return{file:filePath,reason,...result};
  }catch(e){console.warn(`[code-review] parse error ${filePath}:`,e.message);return null}
}

async function reviewDiff(changedFiles){
  if(!changedFiles.length)return null;
  const diffs=[];
  for(const f of changedFiles.slice(0,3)){
    const d=exec(`git diff HEAD~1 -- "${f}" 2>/dev/null||true`);
    if(d)diffs.push(`--- ${f} ---\n${d.split("\n").slice(0,60).join("\n")}`);
  }
  if(!diffs.length)return null;
  const prompt=`Senior engineer reviewing recent changes to a DeFi LP dashboard.

${diffs.join("\n\n")}

Check for: bugs introduced, missing error handling, breaking LP logic, security issues (private keys, fund movements).

Respond ONLY as JSON:
{"riskLevel":"HIGH|MEDIUM|LOW|NONE","summary":"one sentence","concerns":[{"severity":"HIGH|MEDIUM|LOW","msg":"concern"}],"suggestions":["improvement"]}`;
  try{
    const raw=await callClaude(prompt);
    return JSON.parse(raw.replace(/```json|```/g,"").trim());
  }catch(e){console.warn("[code-review] diff parse error:",e.message);return null}
}

async function main(){
  console.log("[code-review] starting AI code review...");
  const ts=new Date().toISOString();
  const changedFiles=getChangedFiles(6);
  console.log(`[code-review] ${changedFiles.length} files changed in last 6h`);

  const keyFile=KEY_FILES[new Date().getHours()%KEY_FILES.length];
  const toReview=new Set([...changedFiles.slice(0,3),keyFile]);

  const fileReviews=[];
  for(const f of toReview){
    const r=await reviewFile(f,changedFiles.includes(f)?"changed in last 6h":"key-file rotation");
    if(r)fileReviews.push(r);
    await new Promise(r=>setTimeout(r,500));
  }
  const diffReview=changedFiles.length>0?await reviewDiff(changedFiles):null;

  const allIssues=[];const allSuggestions=[];
  if(diffReview){
    diffReview.concerns?.forEach(c=>allIssues.push({...c,source:"diff"}));
    diffReview.suggestions?.forEach(s=>allSuggestions.push(s));
  }
  for(const r of fileReviews){
    r.issues?.forEach(i=>allIssues.push({...i,source:r.file}));
    r.suggestions?.forEach(s=>allSuggestions.push(`${r.file}: ${s}`));
  }
  allIssues.sort((a,b)=>({HIGH:0,MEDIUM:1,LOW:2}[a.severity]||2)-({HIGH:0,MEDIUM:1,LOW:2}[b.severity]||2));

  const highCount=allIssues.filter(i=>i.severity==="HIGH").length;
  const status=highCount>0?"🔴 CODE ISSUES":allIssues.length>0?"🟡 CODE WATCH":"🟢 CODE OK";

  const lines=[``,`---`,`## Code Review — ${ts}`,
    `**${status}** | ${allIssues.length} issues across ${fileReviews.length} files`,``];
  if(diffReview)lines.push(`### Recent changes`,`Risk: ${diffReview.riskLevel} — ${diffReview.summary}`,``);
  if(fileReviews.length){lines.push(`### File scores`);fileReviews.forEach(r=>lines.push(`- **${r.file}** — ${r.score}/10 — ${r.summary}`));lines.push(``)}
  if(allIssues.length){lines.push(`### Issues`);allIssues.forEach(i=>{lines.push(`- [${i.severity}] \`${i.source}${i.line?":"+i.line:""}\` — ${i.msg}`);if(i.fix)lines.push(`  → ${i.fix}`)});lines.push(``)}
  if(allSuggestions.length){lines.push(`### Suggestions`);allSuggestions.slice(0,6).forEach((s,i)=>lines.push(`${i+1}. ${s}`));lines.push(``)}
  lines.push(`### Reviewed: ${[...toReview].join(", ")}`,`---`);

  fs.mkdirSync(OUT_DIR,{recursive:true});
  fs.writeFileSync(OUT,JSON.stringify({ts,status,changedFiles,fileReviews,allIssues,allSuggestions},null,2));
  fs.mkdirSync(path.dirname(BRAIN),{recursive:true});
  fs.appendFileSync(BRAIN,"\n"+lines.join("\n")+"\n");

  console.log(`[code-review] ${status} — ${allIssues.length} issues`);
  allIssues.slice(0,3).forEach(i=>console.log(`  [${i.severity}] ${i.source}: ${i.msg}`));
  return{status,allIssues,allSuggestions,fileReviews};
}

module.exports={main};
if(require.main===module){main().catch(e=>{console.error("[code-review] FATAL:",e.message);process.exit(1)})}
