"use strict";
const http = require("http");

function post(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname:"127.0.0.1", port:8787, path:endpoint, method:"POST",
        headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(data)} },
      (res) => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); }
    );
    req.on("error", reject);
    req.write(data); req.end();
  });
}

async function main() {
  const proposal = {
    author: "Human",
    source: "manual",
    horizonDays: 7,
    rationale: "Pool scout: 2d+ consistent signal, >$100K TVL, moved to higher APR siblings",
    items: [
      // Closes
      { wallet:"Main",    pair:"ETH / USDG",    tokenId:"v4-2302341", action:"close", expected:null },
      { wallet:"Trading", pair:"ETH / PONS",     tokenId:"2200242",   action:"close", expected:null },
      { wallet:"Main",    pair:"ETH / MEME",     tokenId:"2383450",   action:"close", expected:null },
      // Opens — expected APR from 3-day scout avg
      { wallet:"Main",    pair:"WETH / USDG",   tokenId:"1147651",   action:"open",
        expected:{ feeAprPct:109, feesUsd:null, netResultUsd:null } },
      { wallet:"Main",    pair:"WETH / USDG",   tokenId:null,         action:"open",
        expected:{ feeAprPct:129, feesUsd:null, netResultUsd:null } },
      { wallet:"Main",    pair:"MEME / WETH",   tokenId:null,         action:"open",
        expected:{ feeAprPct:1481, feesUsd:null, netResultUsd:null } },
    ],
  };

  console.log("Recording today's LP moves into strategy-track...");
  const result = await post("/api/strategy/proposals", proposal);

  if (result.ok) {
    console.log("✅ Recorded:", result.id);
    console.log("   Items:", result.items);
    console.log("   Scores in 7 days:", new Date(Date.now() + 7*86400000).toLocaleDateString());
  } else {
    console.error("❌ Failed:", JSON.stringify(result));
  }
}

main().catch(e => console.error("Error:", e.message));
