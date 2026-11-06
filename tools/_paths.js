// Shared default paths for the Arc tools: no hard-coded home directory.
"use strict";
const path = require("path");
const os = require("os");

/** Arc settings.json: LP_ARC_SETTINGS, else <LP_ARC_DATA_DIR or ~/arc-data>/settings.json. */
function arcSettingsPath(env = process.env, home = os.homedir()) {
  return env.LP_ARC_SETTINGS || path.join(env.LP_ARC_DATA_DIR || path.join(home, "arc-data"), "settings.json");
}
/** Robinhood settings.json (read-only): LP_RH_SETTINGS, else the one next to the code. */
function rhSettingsPath(env = process.env) {
  return env.LP_RH_SETTINGS || path.join(__dirname, "..", "settings.json");
}
/** True when the caller named the Arc settings: --settings=, LP_ARC_SETTINGS or LP_ARC_DATA_DIR. */
function explicitArcSettings(argv = process.argv, env = process.env) {
  return argv.some((a) => a.startsWith("--settings=") && a.length > 11) || !!env.LP_ARC_SETTINGS || !!env.LP_ARC_DATA_DIR;
}
/** Write tools call this when their write flag is set: the home-dir default is never written implicitly. */
function requireExplicitArcSettings(writing, argv = process.argv, env = process.env, home = os.homedir()) {
  if (!writing || explicitArcSettings(argv, env)) return;
  console.error(`pass --settings= (or LP_ARC_SETTINGS) explicitly to write; default would be ${arcSettingsPath(env, home)}`);
  process.exit(2);
}
module.exports = { arcSettingsPath, rhSettingsPath, explicitArcSettings, requireExplicitArcSettings };
