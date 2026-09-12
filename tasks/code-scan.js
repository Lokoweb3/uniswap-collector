"use strict";
const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT    = path.join(__dirname, "..");
const OUT_DIR = path.join(__dirname, "output");
const OUT     = path.join(OUT_DIR, "code-scan.json");
const SKIP    = ["node_modules",".git","backups","test","docs","brain","agent-memory","tasks/output","vm","tools"];

function exec(cmd,cwd=ROOT){try{return execSync(cmd,{cwd,encoding:"utf8",stdio:["pipe","pipe","pipe"]}).trim()}catch(e){return e.stdout?.trim()||""}}

function scanTodos(){
  const raw=exec(`grep -rn "TODO\\|FIXME\\|HACK\\|XXX\\|TEMP" --include="*.js" --include="*.mjs" --exclude-dir={${SKIP.join(",")}} .`);
  return raw.split("\n").filter(Boolean).map(l=>{const m=l.match(/^(.+?):(\d+):\s*(.+)/);return m?{file:m[1].replace(/^\.\//,""),line:+m[2],text:m[3].trim()}:null}).filter(Boolean);
}

function findUntested(){
  const src=exec(`find . -maxdepth 1 -name "*.js" -not -name "*.test.js" ${SKIP.map(s=>`-not -path "./${s}/*"`).join(" ")}`).split("\n").filter(Boolean).map(f=>f.replace("./",""));
  const tests=exec(`find test -name "*.test.js" 2>/dev/null||true`).split("\n").filter(Boolean).map(f=>path.basename(f).replace(".test.js",""));
  return src.filter(f=>!tests.includes(path.basename(f,".js")));
}

function findHardcoded(){
  const patterns=[
    {val:"0\\.002",label:"WETH threshold 0.002"},
    {val:"\\b20\\b",label:"collect threshold $20"},
    {val:"529787973",label:"Telegram chat ID hardcoded"},
    {val:"8787",label:"port 8787 hardcoded"},
  ];
  return patterns.map(p=>{
    // -P: the patterns use \b word boundaries, which basic grep does not understand
    const files=exec(`grep -rPln "${p.val}" --include="*.js" --include="*.mjs" --exclude-dir={${SKIP.join(",")}} .`).split("\n").filter(Boolean);
    return files.length>2?{label:p.label,files:files.map(f=>f.replace("./","")),count:files.length}:null;
  }).filter(Boolean);
}

function recentlyChanged(){
  const raw=exec(`git log --since="24 hours ago" --name-only --pretty=format: --diff-filter=AM -- "*.js" "*.mjs"`);
  return [...new Set(raw.split("\n").filter(f=>f.endsWith(".js")||f.endsWith(".mjs")))].slice(0,10);
}

function main(){
  console.log("[code-scan] scanning codebase...");
  const todos=scanTodos();
  const untested=findUntested();
  const hardcoded=findHardcoded();
  const changed=recentlyChanged();
  const issues=[];
  const suggestions=[];

  if(todos.length>0){
    issues.push({severity:"LOW",msg:`${todos.length} TODO/FIXME comments in codebase`});
    const byFile={};todos.forEach(t=>{byFile[t.file]=(byFile[t.file]||0)+1});
    const top=Object.entries(byFile).sort((a,b)=>b[1]-a[1]).slice(0,3);
    suggestions.push(`Address TODOs: ${top.map(([f,n])=>`${f} (${n})`).join(", ")}`);
  }
  const important=untested.filter(f=>["server","collector","guardian","attribution","strategy","alerts","treasury"].some(k=>f.includes(k)));
  if(important.length>0){
    issues.push({severity:"MEDIUM",msg:`${important.length} key files have no test coverage`});
    suggestions.push(`Write tests for: ${important.slice(0,3).join(", ")}`);
  }
  if(hardcoded.length>0){
    issues.push({severity:"LOW",msg:`${hardcoded.length} hardcoded values in multiple files`});
    suggestions.push(`Extract to settings.json: ${hardcoded.map(h=>h.label).join(", ")}`);
  }
  if(changed.length>0) suggestions.push(`Files changed in last 24h: ${changed.slice(0,5).join(", ")}`);

  const report={timestamp:new Date().toISOString(),todos,untested,hardcoded,recentlyChanged:changed,issues,suggestions};
  fs.mkdirSync(OUT_DIR,{recursive:true});
  fs.writeFileSync(OUT,JSON.stringify(report,null,2));
  console.log(`[code-scan] ${issues.length} issues, ${suggestions.length} suggestions`);
  issues.forEach(i=>console.log(`  [${i.severity}] ${i.msg}`));
  return report;
}

module.exports={main};
if(require.main===module){main();process.exit(0);}
