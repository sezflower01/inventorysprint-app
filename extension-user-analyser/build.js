// Produces the upload zip. Run from this folder: `npm run build`.
//
// NOT wired into the root `npm run build` yet, deliberately. That script
// (scripts/build-extension-zips.js) has a hardcoded two-entry target list for
// extension/ and extension-create/, and writes into public/, which Vite then
// copies into dist/ where the admin "Download .zip" buttons point. Adding a
// third target would publish this test build to the app's download page before
// it has been through store review, so it stays manual until that is wanted.
//
// Zero dependencies: writes a STORE-method (uncompressed) zip by hand. The
// archive is a handful of small text files, so compression buys nothing worth
// a dependency, and Chrome and the Web Store both accept stored entries.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'inventorysprint-user-analyser-0.1.0.zip');

/**
 * Everything that ships. Tests, deps and the icon generator do not.
 *
 * ⚠️ This list is the SINGLE definition of "what ships", and
 * __tests__/noOwnerFallback.test.js imports it rather than keeping its own
 * copy. It had its own copy for one run, and the two promptly disagreed: the
 * lint read package-lock.json -- 50 npmjs.org URLs, none of which ship -- and
 * failed on every one. A lint that disagrees with the packager about what is
 * being shipped is checking the wrong thing in both directions: noise on files
 * that never reach a user, and silence on files that do.
 */
const EXCLUDE_DIRS = new Set(['node_modules', '__tests__', '.git', 'dist']);
const EXCLUDE_FILES = new Set(['build.js', 'package.json', 'package-lock.json', '.gitignore', 'README.md', 'icons/make-icons.js']);

function collect(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      collect(abs, out);
    } else {
      if (EXCLUDE_FILES.has(rel) || rel.endsWith('.zip')) continue;
      out.push(rel);
    }
  }
  return out;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Fixed DOS timestamp so the zip is byte-reproducible: the same sources always
// produce the same file, which makes "did anything change?" answerable with a
// checksum instead of a diff of a binary.
const DOS_TIME = 0x0000;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

function main() {
  const files = collect().sort();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const rel of files) {
    const data = fs.readFileSync(path.join(ROOT, rel));
    const name = Buffer.from(rel, 'utf8');
    const crc = crc32(data);

    const lf = Buffer.alloc(30);
    lf.writeUInt32LE(0x04034b50, 0);
    lf.writeUInt16LE(20, 4);           // version needed
    lf.writeUInt16LE(0, 6);            // flags
    lf.writeUInt16LE(0, 8);            // method 0 = stored
    lf.writeUInt16LE(DOS_TIME, 10);
    lf.writeUInt16LE(DOS_DATE, 12);
    lf.writeUInt32LE(crc, 14);
    lf.writeUInt32LE(data.length, 18);
    lf.writeUInt32LE(data.length, 22);
    lf.writeUInt16LE(name.length, 26);
    lf.writeUInt16LE(0, 28);
    locals.push(lf, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += 30 + name.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  fs.writeFileSync(OUT, Buffer.concat([...locals, cdBuf, eocd]));
  const size = fs.statSync(OUT).size;
  const sum = require('node:crypto').createHash('sha256').update(fs.readFileSync(OUT)).digest('hex').slice(0, 16);
  console.log(`${path.basename(OUT)}  ${files.length} files  ${size} bytes  sha256:${sum}`);
  for (const f of files) console.log('  ' + f);
  // Sanity: the four files Chrome cannot start without.
  for (const need of ['manifest.json', 'background.js', 'content.js', 'readPage.js']) {
    if (!files.includes(need)) { console.error(`MISSING ${need}`); process.exit(1); }
  }
  void zlib; // kept to document that compression was considered, not needed
}

// Run only when invoked directly, so the lint can require() this file for
// collect() without writing a zip as a side effect of running the tests.
if (require.main === module) main();

module.exports = { collect, ROOT, EXCLUDE_DIRS, EXCLUDE_FILES };
