// Preload for the test server: every discovery created by univ4.createDiscovery reports STUB_RAW_DISC_ERR,
// unredacted, as status.error. A real scan resets lastError before anything reads it, so the only way to put
// an unredacted persisted lastError in front of the callers (watch.js, server.js) is to substitute it here.
"use strict";
const v4 = require("../../univ4");
const make = v4.createDiscovery;
v4.createDiscovery = function (...args) {
  const d = make.apply(this, args);
  return new Proxy(d, {
    get(t, p) {
      if (p === "status") return { ...t.status, error: process.env.STUB_RAW_DISC_ERR };
      return Reflect.get(t, p, t);
    },
  });
};
