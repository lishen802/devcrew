import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { DEVCREW_VERSION } from "../packages/core/src/index.js";

test("package metadata is ready for public npm publishing", async () => {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));

  assert.equal(pkg.name, "devcrew");
  assert.equal(pkg.version, DEVCREW_VERSION);
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.repository.type, "git");
  assert.equal(pkg.repository.url, "git+https://github.com/lishen802/devcrew.git");
  assert.equal(pkg.bugs.url, "https://github.com/lishen802/devcrew/issues");
  assert.equal(pkg.homepage, "https://github.com/lishen802/devcrew#readme");
  assert.equal(pkg.bin.devcrew, "./dist/packages/cli/src/index.js");
  assert.equal(pkg.scripts.prepack, "npm run build");
  assert.equal(pkg.scripts["smoke:codex-plugin"], "node scripts/smoke-codex-plugin.mjs");
  assert.equal(pkg.scripts.prepare, undefined);
  assert.ok(pkg.files.includes("dist/packages"));
  assert.ok(pkg.files.includes("plugins/devcrew-codex"));
  assert.ok(pkg.files.includes("scripts"));
});

test("npm publish workflow validates and publishes the public package", async () => {
  const workflow = await readFile(join(process.cwd(), ".github", "workflows", "npm-publish.yml"), "utf8");

  assert.match(workflow, /name: npm publish/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run validate/);
  assert.match(workflow, /npm pack --dry-run/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
});
