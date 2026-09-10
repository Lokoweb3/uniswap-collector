#!/usr/bin/env node
/**
 * One-time migration: config.json + wallets.json -> settings.json.
 *
 *   node tools/migrate-settings.js            # writes settings.json (refuses to overwrite)
 *   node tools/migrate-settings.js --force    # overwrites
 *
 * Telegram chat ids move into settings.alerts from the environment when set
 * (TELEGRAM_GROUP_CHAT_ID -> telegramChat, TELEGRAM_CHAT_ID -> fallbackChat,
 * TELEGRAM_TREASURY_CHAT_ID -> treasuryChat); the bot token stays in .env.
 * Nothing from .env is printed. The old files are left in place for you to
 * delete once ./run-collector.sh simulate reads the new file.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const settings = require("../settings");

const ROOT = path.join(__dirname, "..");
const out = settings.FILE;
if (fs.existsSync(out) && !process.argv.includes("--force")) {
  console.error(`${path.basename(out)} already exists; use --force to overwrite`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
let wallets = null;
try { wallets = JSON.parse(fs.readFileSync(path.join(ROOT, "wallets.json"), "utf8")); } catch {}
const chats = { group: process.env.TELEGRAM_GROUP_CHAT_ID || "", main: process.env.TELEGRAM_CHAT_ID || "", treasury: process.env.TELEGRAM_TREASURY_CHAT_ID || "" };
const raw = settings.fromLegacy(cfg, wallets, chats);
fs.writeFileSync(out, JSON.stringify(raw, null, 2) + "\n");
const flat = settings.toLegacy(raw);
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "—");
console.log(`wrote ${path.basename(out)}: chain ${flat.chainId}, main wallet ${short(flat.ownerAddress)} (${flat.ownerLabel}), ${flat.wallets.list.length} watched wallet(s), ${flat.memecoins.length} risk entr${flat.memecoins.length === 1 ? "y" : "ies"}, vault ${flat.treasuryTBA ? short(flat.treasuryTBA) : "off"}, chats ${[chats.group && "group", chats.main && "personal", chats.treasury && "treasury"].filter(Boolean).join("+") || "none (set them under alerts)"}`);
