import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const outdir = resolve("build");
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [resolve("src/index.js")],
  bundle: true,
  minify: false,
  format: "iife",
  target: ["es2020"],
  outfile: resolve(outdir, "index.js"),
  loader: { ".html": "text" },
});

copyFileSync(resolve("src/index.html"), resolve(outdir, "index.html"));
