/**
 * Minimal QR code encoder (byte mode, error correction level L, versions 1-10),
 * enough for a URL. No dependencies. Served to the browser as /qr.js and used
 * by the server-side tests; exposes `qrMatrix(text)` -> array of rows of 0/1
 * and `qrSvg(text, size)` -> an SVG string.
 *
 * Implements the QR spec directly: Reed-Solomon over GF(256) for the EC
 * codewords, mask 0 only (a fixed mask is valid; scanners do not require the
 * lowest-penalty mask), format bits from the standard table.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QR = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  // Capacity (data codewords) and EC codewords per block for level L, versions 1..10: [totalCodewords, ecPerBlock, blocks]
  const VERSIONS = [null,
    [26, 7, 1], [44, 10, 1], [70, 15, 1], [100, 20, 1], [134, 26, 1],
    [172, 18, 2], [196, 20, 2], [242, 24, 2], [292, 30, 2], [346, 18, 4],
  ];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  // Format info for EC level L (01) with masks 0..7, already BCH-coded and XOR-masked.
  const FORMAT_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];

  // GF(256) tables.
  const EXP = new Array(512), LOG = new Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function generator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= mul(g[j], EXP[i]);
      }
      g = next;
    }
    return g;
  }
  function ecCodewords(data, n) {
    const g = generator(n);
    const res = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ res[0];
      res.shift();
      res.push(0);
      if (f) for (let j = 0; j < n; j++) res[j] ^= mul(g[j + 1], f);
    }
    return res;
  }

  function utf8(text) {
    const out = [];
    for (const ch of unescape(encodeURIComponent(text))) out.push(ch.charCodeAt(0));
    return out;
  }

  function choose(bytes) {
    for (let v = 1; v <= 10; v++) {
      const [total, ecPer, blocks] = VERSIONS[v];
      const dataCw = total - ecPer * blocks;
      const lenBits = v <= 9 ? 8 : 16;
      if (4 + lenBits + bytes * 8 <= dataCw * 8) return v;
    }
    throw new Error("text too long for this QR encoder (version 10, level L)");
  }

  function encode(text) {
    const bytes = utf8(text);
    const v = choose(bytes.length);
    const [total, ecPer, blocks] = VERSIONS[v];
    const dataCw = total - ecPer * blocks;
    const lenBits = v <= 9 ? 8 : 16;
    // Bit stream: mode 0100, length, data, terminator, pad.
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(4, 4);
    push(bytes.length, lenBits);
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, dataCw * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    for (let p = 0; data.length < dataCw; p++) data.push(p % 2 ? 0x11 : 0xec);
    // Blocks (level L versions 1-10 have equal-sized blocks, possibly with the last blocks one byte longer).
    const shortLen = Math.floor(dataCw / blocks), longBlocks = dataCw % blocks;
    const dataBlocks = [], ecBlocks = [];
    let pos = 0;
    for (let b = 0; b < blocks; b++) {
      const len = shortLen + (b >= blocks - longBlocks ? 1 : 0);
      const chunk = data.slice(pos, pos + len);
      pos += len;
      dataBlocks.push(chunk);
      ecBlocks.push(ecCodewords(chunk, ecPer));
    }
    const out = [];
    for (let i = 0; i < shortLen + 1; i++) for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
    for (let i = 0; i < ecPer; i++) for (const blk of ecBlocks) out.push(blk[i]);
    return { version: v, codewords: out };
  }

  function matrix(text) {
    const { version, codewords } = encode(text);
    const n = 17 + 4 * version;
    const m = Array.from({ length: n }, () => new Array(n).fill(null)); // null = unset data module
    const set = (r, c, v) => { if (r >= 0 && r < n && c >= 0 && c < n) m[r][c] = v; };
    const finder = (r, c) => {
      for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
        const on = i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4));
        set(r + i, c + j, on ? 1 : 0);
      }
    };
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
    for (let i = 8; i < n - 8; i++) { m[6][i] = i % 2 === 0 ? 1 : 0; m[i][6] = i % 2 === 0 ? 1 : 0; }
    for (const r of ALIGN[version]) for (const c of ALIGN[version]) {
      if (m[r][c] !== null) continue; // overlaps a finder
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1 ? 1 : 0);
    }
    // Reserve format areas (filled below) and the dark module.
    for (let i = 0; i < 8; i++) { if (m[8][i] === null) m[8][i] = 0; if (m[i][8] === null) m[i][8] = 0; if (m[8][n - 1 - i] === null) m[8][n - 1 - i] = 0; if (m[n - 1 - i][8] === null) m[n - 1 - i][8] = 0; }
    m[8][8] = 0;
    m[n - 8][8] = 1;
    // Version info for v >= 7.
    if (version >= 7) {
      const VERSION_BITS = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };
      const bitsV = VERSION_BITS[version];
      for (let i = 0; i < 18; i++) {
        const bit = (bitsV >> i) & 1;
        m[Math.floor(i / 3)][n - 11 + (i % 3)] = bit;
        m[n - 11 + (i % 3)][Math.floor(i / 3)] = bit;
      }
    }
    // Data placement in the zig-zag, mask 0: (r + c) % 2 === 0 flips.
    const bits = [];
    for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
    let idx = 0, upward = true;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let k = 0; k < n; k++) {
        const r = upward ? n - 1 - k : k;
        for (const c of [col, col - 1]) {
          if (m[r][c] !== null) continue;
          const bit = idx < bits.length ? bits[idx++] : 0;
          m[r][c] = ((r + c) % 2 === 0) ? bit ^ 1 : bit;
        }
      }
      upward = !upward;
    }
    // Format bits (mask 0).
    const f = FORMAT_L[0];
    const fb = (i) => (f >> (14 - i)) & 1; // bit index 0 = most significant, as in the spec's placement diagram
    const posA = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    for (let i = 0; i < 15; i++) m[posA[i][0]][posA[i][1]] = fb(i);
    for (let i = 0; i < 7; i++) m[n - 1 - i][8] = fb(i);
    for (let i = 7; i < 15; i++) m[8][n - 15 + i] = fb(i);
    return m;
  }

  function svg(text, size = 160) {
    const m = matrix(text);
    const n = m.length, q = 4, scale = size / (n + 2 * q);
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) d += `M${((c + q) * scale).toFixed(2)} ${((r + q) * scale).toFixed(2)}h${scale.toFixed(2)}v${scale.toFixed(2)}h-${scale.toFixed(2)}z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  return { qrMatrix: matrix, qrSvg: svg, encode };
});
