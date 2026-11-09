// Preloaded AFTER stub-elysium-network.js: fetch() answers eth_chainId with STUB_FETCH_CHAIN_ID (default 1), as an RPC
// that is really another chain would. No socket is opened.
"use strict";
global.fetch = async () => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + Number(process.env.STUB_FETCH_CHAIN_ID || 1).toString(16) }) });
