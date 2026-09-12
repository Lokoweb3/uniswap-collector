const http = require("http");
const MIN_TVL=100_000,MIN_APR=50,BASE="http://127.0.0.1:8787";
function get(e){return new Promise((r,j)=>{const q=http.get(`${BASE}${e}`,s=>{let d="";s.on("data",c=>d+=c);s.on("end",()=>{try{r(JSON.parse(d))}catch(e){j(new Error(`JSON parse: ${e.message}`))}})});q.setTimeout(15000,()=>q.destroy(new Error("Timeout")));q.on("error",j)})}
function tvlLabel(t){return t>=1e6?`$${(t/1e6).toFixed(1)}M`:t>=1e3?`$${(t/1e3).toFixed(0)}K`:`$${Math.round(t)}`}
function score(apr,tvl){return apr*(0.4+0.6*Math.min(tvl/1e6,1))}
async function main(){
  console.log("\n════════════════════════════════════════════");
  console.log(" Pool Scanner — best pools for your tokens");
  console.log("════════════════════════════════════════════\n");
  // A failed endpoint is reported, not hidden: a down backend must read as an error, not as an empty scan.
  const endpoints=["/api/attribution?days=1","/api/strategy/scout?days=3","/api/advisor"];
  const results=await Promise.allSettled(endpoints.map(get));
  const failed=results.map((r,i)=>r.status==="rejected"?`${endpoints[i]}: ${r.reason?.message||r.reason}`:null).filter(Boolean);
  if(failed.length===endpoints.length)throw new Error(`dashboard unreachable at ${BASE} — ${failed.join("; ")}`);
  for(const f of failed)console.warn(`⚠️  ${f} — its data is missing from this scan`);
  const [posData,scoutData,advisorData]=results.map(r=>r.status==="fulfilled"?r.value:null);
  const positions=posData?.positions||[];
  const scoutRows=scoutData?.rows||[];
  const advisorPools=Object.values(advisorData?.pools||{});
  const poolMap=new Map();
  for(const row of scoutRows){
    const k=row.pair.trim();
    if(!poolMap.has(k))poolMap.set(k,new Map());
    const m=poolMap.get(k);
    const ck=`${row.pair} (current)`;
    if(!m.has(ck))m.set(ck,{name:ck,aprs:[],tvls:[],isCurrent:true});
    m.get(ck).aprs.push(row.ownAprPct);
    const sk=row.bestSibling;
    if(!m.has(sk))m.set(sk,{name:sk,aprs:[],tvls:[],isCurrent:false});
    m.get(sk).aprs.push(row.bestAprPct);
    m.get(sk).tvls.push(row.bestTvl);
  }
  for(const p of advisorPools){
    if(!p.pair||!p.aprPct)continue;
    const k=p.pair.trim();
    if(!poolMap.has(k))poolMap.set(k,new Map());
    const m=poolMap.get(k);
    const key=`${p.pair} ${p.feePct||p.fee||""}`.trim();
    if(!m.has(key))m.set(key,{name:key,aprs:[],tvls:[],isCurrent:false});
    m.get(key).aprs.push(p.aprPct);
    if(p.tvlUsd)m.get(key).tvls.push(p.tvlUsd);
  }
  const seen=new Set();
  for(const pos of positions){
    const pairKey=pos.pair?.trim();
    if(!pairKey||seen.has(pairKey))continue;
    seen.add(pairKey);
    const pairPools=poolMap.get(pairKey);
    if(!pairPools||pairPools.size===0){console.log(`${pairKey} — no scout data yet\n`);continue}
    const ranked=[...pairPools.values()]
      .map(p=>({...p,avgApr:p.aprs.length?Math.round(p.aprs.reduce((a,b)=>a+b,0)/p.aprs.length):0,maxApr:p.aprs.length?Math.round(Math.max(...p.aprs)):0,avgTvl:p.tvls.length?Math.round(p.tvls.reduce((a,b)=>a+b,0)/p.tvls.length):0,maxTvl:p.tvls.length?Math.round(Math.max(...p.tvls)):0,samples:p.aprs.length}))
      .map(p=>({...p,score:score(p.avgApr,p.avgTvl)}))
      .sort((a,b)=>b.score-a.score);
    const cur=ranked.find(p=>p.isCurrent);
    const curApr=cur?.avgApr||pos.aprPct||0;
    console.log(`╔══════════════════════════════════════════════`);
    console.log(`║ ${pairKey} #${pos.tokenId} (${pos.wallet||"Main"})`);
    console.log(`║ Current APR: ${Math.round(curApr)}% | Value: $${pos.valueUsd?.toFixed(0)||"?"}`);
    console.log(`╚══════════════════════════════════════════════`);
    let rank=0;
    for(const p of ranked){
      if(p.isCurrent){console.log(`  📍 CURRENT  ${p.name}\n     APR avg:${p.avgApr}%`);continue}
      if(p.avgApr<MIN_APR)continue;
      rank++;
      const tvlOk=p.avgTvl>=MIN_TVL,aprOk=p.avgApr>curApr*1.5;
      const verdict=tvlOk&&aprOk?"✅ MOVE HERE":!tvlOk?"❌ TVL too low":!aprOk?"⚪ Not enough better":"🟡 Watch";
      console.log(`\n  #${rank} ${p.name}`);
      console.log(`     APR  avg:${p.avgApr}% · max:${p.maxApr}%`);
      console.log(`     TVL  avg:${tvlLabel(p.avgTvl)} · max:${tvlLabel(p.maxTvl)}`);
      console.log(`     Score: ${Math.round(p.score)} · Samples: ${p.samples}`);
      console.log(`     ${verdict}`);
    }
    console.log("");
  }
  console.log("════════════════════════════════════════════");
  console.log(" TVL > $100K · APR > 1.5x current · 3-day data");
  console.log("════════════════════════════════════════════\n");
}
main().catch(e=>{console.error("FATAL:",e.message);process.exit(1)});
