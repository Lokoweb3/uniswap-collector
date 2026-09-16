/**
 * data-dir.js — where this process keeps its *data*.
 *
 * One installation of the code can drive more than one chain: the ledgers,
 * state files and settings.json live in a data directory, while the code,
 * pages and shell scripts always stay next to the source.
 *
 *   node server.js                                   -> data next to the code (default)
 *   node server.js --data-dir=/home/steven/arc-data  -> data over there
 *   LP_DATA_DIR=/home/steven/arc-data node server.js -> same, from the environment
 *
 * Resolved once, at require time, from the process's own arguments, so every
 * module in the process agrees. Only ever use this for files the instance
 * writes or that describe the instance (settings.json, *.json ledgers, logs).
 * Code, HTML, assets and scripts are __dirname in their own module.
 */
"use strict";
const path = require("path");

const arg = process.argv.find((a) => a.startsWith("--data-dir="));
const raw = arg ? arg.slice("--data-dir=".length) : process.env.LP_DATA_DIR || "";

/** Absolute path to this instance's data directory; the source tree by default. */
const DATA_DIR = raw ? path.resolve(raw) : __dirname;

/** True when data lives somewhere other than the source tree. */
const CUSTOM = DATA_DIR !== __dirname;

/** Join a data-file name onto the data directory. */
const dataPath = (...parts) => path.join(DATA_DIR, ...parts);

module.exports = { DATA_DIR, CUSTOM, dataPath, CODE_DIR: __dirname };
