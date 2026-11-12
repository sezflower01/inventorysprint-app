// Zips extension/ and extension-create/ into public/*.zip so the admin
// "Download .zip" buttons (see src/config/moduleCategories.ts downloadUrl)
// always ship whatever is currently in those source folders. Runs as part of
// `npm run build`, before `vite build` copies public/ into dist/. The output
// files are gitignored (public/*.zip) -- they're build artifacts, regenerated
// fresh on every build, never committed.
import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { ZipArchive } from "archiver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function zipDir(srcDir, outFile, ignore) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outFile);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    if (ignore && ignore.length > 0) {
      // glob() rather than directory(), because archiver only applies `ignore`
      // to a glob source. directory(src, false, { ignore }) silently archives
      // everything -- which would have put node_modules/ (jsdom, ~5 MB) and
      // the test fixtures into a public download.
      archive.glob("**/*", { cwd: srcDir, dot: true, ignore });
    } else {
      archive.directory(srcDir, false);
    }
    archive.finalize();
  });
}

async function main() {
  const targets = [
    {
      src: path.join(root, "extension"),
      out: path.join(root, "public", "inventorysprint-extension.zip"),
    },
    {
      src: path.join(root, "extension-create"),
      out: path.join(root, "public", "inventorysprint-create-listing-extension.zip"),
    },
    {
      // User Analyser 0.1.0. Added 2026-11-12 so it has a download card beside
      // the other two.
      //
      // Unlike those two, this source folder contains things that must NOT
      // ship: __tests__/ (with jsdom fixtures), node_modules/ (jsdom itself,
      // ~5 MB), package.json, build.js and icons/make-icons.js. zipDir() takes
      // a whole directory, so the exclusions live in `ignore` below rather
      // than in the extension's own build.js -- which still exists and is
      // still the reference list.
      //
      // ⚠️ The two lists must agree. extension-user-analyser/build.js owns the
      // canonical set and its own lint imports it; this entry is the second
      // copy, and a file added to one and not the other either leaks into the
      // public zip or vanishes from it.
      src: path.join(root, "extension-user-analyser"),
      out: path.join(root, "public", "inventorysprint-user-analyser-extension.zip"),
      ignore: [
        "__tests__/**",
        "node_modules/**",
        "package.json",
        "package-lock.json",
        "build.js",
        "README.md",
        ".gitignore",
        "icons/make-icons.js",
        "*.zip",
      ],
    },
  ];

  await mkdir(path.join(root, "public"), { recursive: true });

  for (const { src, out, ignore } of targets) {
    await zipDir(src, out, ignore);
    console.log(`Built ${path.relative(root, out)} from ${path.relative(root, src)}/`);
  }
}

main().catch((err) => {
  console.error("Failed to build extension zips:", err);
  process.exit(1);
});
