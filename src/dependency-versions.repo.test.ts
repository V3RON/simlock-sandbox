import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

function loadedVersion(name: string, fromDir: string): string {
  let dir = dirname(createRequire(join(fromDir, "package.json")).resolve(name));
  while (dirname(dir) !== dir) {
    const path = join(dir, "package.json");
    if (existsSync(path) && readPackageJson(path).name === name)
      return readPackageJson(path).version;
    dir = dirname(dir);
  }
  throw new Error(`no package.json for ${name} above ${fromDir}`);
}

const rootManifest = readPackageJson(join(REPO_ROOT, "package.json"));
const mcpSdkDir = realpathSync(join(REPO_ROOT, "node_modules", "@modelcontextprotocol", "sdk"));

// why: a pnpm override in pnpm-workspace.yaml applies to this checkout only; an npm install of
// simlock gets the version package.json declares, so the tests must load that one.
describe("@hono/node-server", () => {
  it("the copies simlock and the MCP SDK load are both the version package.json declares", () => {
    const declared = rootManifest.dependencies["@hono/node-server"];
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    expect({
      simlock: loadedVersion("@hono/node-server", REPO_ROOT),
      mcpSdk: loadedVersion("@hono/node-server", mcpSdkDir),
    }).toEqual({ simlock: declared, mcpSdk: declared });
  });
});
