import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(join(tmpdir(), "semantic-dom-sentinel-consumer-"));

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`, {
      cause: error,
    });
  }
}

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  return npmCli
    ? run(process.execPath, [npmCli, ...args], cwd)
    : run("npm", args, cwd);
}

try {
  runNpm(["run", "build"], projectRoot);

  const packOutput = runNpm(["pack", "--json", "--pack-destination", tempRoot], projectRoot);
  const [packed] = JSON.parse(packOutput);
  assert.ok(packed?.filename, "npm pack should produce a package archive");
  const archivePath = join(tempRoot, packed.filename);

  const consumerRoot = join(tempRoot, "consumer");
  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "semantic-dom-sentinel-consumer-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  runNpm(
    ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", "--no-save", archivePath],
    consumerRoot,
  );

  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       const entry = import.meta.resolve("semantic-dom-sentinel");
       assert.ok(entry.endsWith("/dist/index.js"), entry);
       const library = await import("semantic-dom-sentinel");
       assert.equal(typeof library.createSentinel, "function");`,
    ],
    consumerRoot,
  );
  console.log("PASS ESM package-root import");

  run(
    process.execPath,
    [
      "--conditions=browser",
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       const entry = import.meta.resolve("semantic-dom-sentinel");
       assert.ok(entry.endsWith("/dist/index.js"), entry);
       const library = await import("semantic-dom-sentinel");
       assert.equal(typeof library.createSentinel, "function");`,
    ],
    consumerRoot,
  );
  console.log("PASS browser export condition");

  run(
    process.execPath,
    [
      "--eval",
      `const assert = require("node:assert/strict");
       const entry = require.resolve("semantic-dom-sentinel");
       assert.deepEqual(entry.split(require("node:path").sep).slice(-2), ["dist", "index.cjs"]);
       const library = require("semantic-dom-sentinel");
       assert.equal(typeof library.createSentinel, "function");`,
    ],
    consumerRoot,
  );
  console.log("PASS CommonJS package-root require");

  const typeSmokePath = join(consumerRoot, "consumer.mts");
  await writeFile(
    typeSmokePath,
    [
      'import { createSentinel, type SentinelOptions } from "semantic-dom-sentinel";',
      "const factory: typeof createSentinel = createSentinel;",
      "declare const options: SentinelOptions;",
      "void factory;",
      "void options;",
      "",
    ].join("\n"),
  );
  run(
    process.execPath,
    [
      join(projectRoot, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      typeSmokePath,
    ],
    consumerRoot,
  );
  console.log("PASS TypeScript declarations");

  const iifePath = join(consumerRoot, "node_modules", "semantic-dom-sentinel", "dist", "index.global.js");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "dangerously",
    url: "http://localhost/",
  });
  try {
    const script = dom.window.document.createElement("script");
    script.textContent = await readFile(iifePath, "utf8");
    dom.window.document.body.append(script);
    assert.equal(typeof dom.window.SemanticDomSentinel?.createSentinel, "function");
  } finally {
    dom.window.close();
  }
  console.log("PASS classic browser IIFE global");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
