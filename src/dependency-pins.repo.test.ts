import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "@hono/node-server";

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

const declared = (
  JSON.parse(read("package.json")) as { readonly dependencies: Readonly<Record<string, string>> }
).dependencies[PACKAGE];

function override(yaml: string, key: string): string | undefined {
  const block = /^overrides:\n((?:[ \t]+.*\n)+)/m.exec(yaml)?.[1] ?? "";
  for (const line of block.split("\n")) {
    const found = /^\s+['"]?([^'":]+)['"]?:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (found?.[1] === key) return found[2];
  }
  return undefined;
}

// why: npm ignores pnpm overrides, so a user's install resolves package.json's version; a pnpm
// override that disagrees makes every test run an adapter version no user runs (issue 96).
describe(`${PACKAGE} pin`, () => {
  it("package.json, the pnpm override, the lockfile and node_modules all name the version package.json ships", () => {
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);

    const workspaceOverride = override(read("pnpm-workspace.yaml"), PACKAGE);
    if (workspaceOverride !== undefined) expect(workspaceOverride).toBe(declared);

    const lock = read("pnpm-lock.yaml");
    const lockOverride = override(lock, PACKAGE);
    if (lockOverride !== undefined) expect(lockOverride).toBe(declared);

    const importer =
      /^importers:\n\n {2}\.:\n {4}dependencies:\n((?: {6}.*\n)+)/m.exec(lock)?.[1] ?? "";
    const entry = new RegExp(
      `^ {6}'${PACKAGE}':\\n {8}specifier: (\\S+)\\n {8}version: ([^(\\s]+)`,
      "m",
    ).exec(importer);
    expect({ specifier: entry?.[1], version: entry?.[2] }).toEqual({
      specifier: declared,
      version: declared,
    });

    const installed = (
      JSON.parse(read(`node_modules/${PACKAGE}/package.json`)) as { readonly version: string }
    ).version;
    expect(installed).toBe(declared);
  });
});
