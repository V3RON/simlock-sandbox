import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const EXACT = /^\d+\.\d+\.\d+$/;

interface Locked {
  readonly specifier: string;
  readonly version: string;
}

/** why: no YAML parser is a direct dependency; the lockfile's `importers:` block is a fixed four-level shape, read line by line. */
function lockedImporters(): Map<string, Map<string, Locked>> {
  const lines = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8").split(/\r?\n/);
  // why: the first YAML document holds only pnpm's own pin; the workspace's importers are in the last one.
  const start = lines.lastIndexOf("importers:");
  const importers = new Map<string, Map<string, Locked>>();
  let entries = new Map<string, Locked>();
  let name = "";
  let specifier = "";
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const importer = /^ {2}(\S.*):$/.exec(line);
    if (importer) {
      entries = new Map();
      importers.set(importer[1]!, entries);
      continue;
    }
    const dependency = /^ {6}(\S.*):$/.exec(line);
    if (dependency) name = dependency[1]!.replace(/^'(.*)'$/, "$1");
    const spec = /^ {8}specifier: (.*)$/.exec(line);
    if (spec) specifier = spec[1]!.replace(/^'(.*)'$/, "$1");
    const version = /^ {8}version: (.*)$/.exec(line);
    if (version) entries.set(name, { specifier, version: version[1]!.replace(/\(.*$/, "") });
  }
  return importers;
}

function declared(importer: string): Map<string, string> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, importer, "package.json"), "utf8"),
  ) as Partial<Record<(typeof SECTIONS)[number], Record<string, string>>>;
  return new Map(SECTIONS.flatMap((section) => Object.entries(manifest[section] ?? {})));
}

describe("pnpm-lock.yaml", () => {
  it("resolves every dependency of every workspace package from the specifier its package.json declares, and an exact pin to that version", () => {
    const importers = lockedImporters();
    expect([...importers.keys()].sort()).toEqual([".", "packages/e2e"]);

    const mismatches = [...importers].flatMap(([importer, locked]) =>
      [...declared(importer)].flatMap(([name, wanted]) => {
        const entry = locked.get(name);
        if (entry === undefined)
          return [`${importer} ${name}: package.json ${wanted}, not in the lockfile`];
        const pinMissed = EXACT.test(wanted) && entry.version !== wanted;
        return entry.specifier === wanted && !pinMissed
          ? []
          : [
              `${importer} ${name}: package.json ${wanted}, lockfile specifier ${entry.specifier} resolved ${entry.version}`,
            ];
      }),
    );

    expect(mismatches).toEqual([]);
  });
});
