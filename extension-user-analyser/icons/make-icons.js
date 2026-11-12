// Generates the three PNG icons with zero dependencies: a raw RGBA raster,
// deflated with Node's built-in zlib and wrapped in PNG chunks. Run from this
// folder with `node icons/make-icons.js`.
//
// A deliberately plain mark -- a rounded square in the panel's accent blue with
// a lighter inset bar. Placeholder-honest: it identifies the extension in the
// toolbar without pretending to be finished brand work.
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const ACCENT = [31, 95, 139, 255];
  const INSET = [226, 238, 246, 255];
  const r = Math.max(2, Math.round(size * 0.18)); // corner radius
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0 + RGBA
    for (let x = 0; x < size; x++) {
      // Rounded-corner test.
      const dx = x < r ? r - x : x >= size - r ? x - (size - r - 1) : 0;
      const dy = y < r ? r - y : y >= size - r ? y - (size - r - 1) : 0;
      const outside = dx > 0 && dy > 0 && dx * dx + dy * dy > r * r;
      // Inset bar across the middle third.
      const barTop = Math.round(size * 0.42), barBot = Math.round(size * 0.58);
      const barL = Math.round(size * 0.24), barR = Math.round(size * 0.76);
      const inBar = y >= barTop && y < barBot && x >= barL && x < barR;
      const px = outside ? [0, 0, 0, 0] : inBar ? INSET : ACCENT;
      row.set(px, 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  const out = path.join(__dirname, `icon${size}.png`);
  fs.writeFileSync(out, png(size));
  console.log(`wrote ${path.basename(out)} (${fs.statSync(out).size} bytes)`);
}
