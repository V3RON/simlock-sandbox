import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { emptyDeviceSet, setDevices, simctlInSet } from "./helpers/ios-device-set.js";

const execFileAsync = promisify(execFile);

async function simctlJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", ...args, "-j"]);
  return JSON.parse(stdout) as T;
}

// why: The driver's `destroy` goes on to `simctl delete` after a `simctl shutdown` that timed out (#50).
// That is only sound when CoreSimulator deletes a simulator whose shutdown was killed mid-way, which only a real simctl answers.
describe.skipIf(process.platform !== "darwin")(
  "iOS destroy after a killed simctl shutdown (real simctl)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "simctl delete removes a simulator whose simctl shutdown was killed before it finished",
      { timeout: 600_000 },
      async () => {
        const runtimes = await simctlJson<{
          runtimes: { identifier: string; isAvailable: boolean; platform?: string }[];
        }>(["list", "runtimes"]);
        const runtime = runtimes.runtimes.find(
          (candidate) => candidate.isAvailable && (candidate.platform ?? "iOS") === "iOS",
        );
        expect(runtime, "this lane needs an installed iOS runtime").toBeDefined();
        const types = await simctlJson<{ devicetypes: { identifier: string; name: string }[] }>([
          "list",
          "devicetypes",
        ]);
        const type = types.devicetypes.find((candidate) => candidate.name.startsWith("iPhone"));
        expect(type, "this lane needs an iPhone device type").toBeDefined();

        const home = await mkdtemp(join(tmpdir(), "simlock-e2e-destroy-"));
        const deviceSet = join(home, "set");
        await execFileAsync("mkdir", ["-p", deviceSet]);
        try {
          const { stdout } = await simctlInSet(deviceSet, [
            "create",
            "destroy-after-kill",
            type?.identifier ?? "",
            runtime?.identifier ?? "",
          ]);
          const udid = stdout.trim();
          await simctlInSet(deviceSet, ["boot", udid]);
          await simctlInSet(deviceSet, ["bootstatus", udid, "-b"]);

          const shutdown = spawn("xcrun", ["simctl", "--set", deviceSet, "shutdown", udid], {
            stdio: "ignore",
          });
          const killed = new Promise<void>((resolve) => shutdown.on("close", () => resolve()));
          shutdown.kill("SIGKILL");
          await killed;

          await simctlInSet(deviceSet, ["delete", udid]);
          expect(
            (await setDevices(deviceSet)).map((device) => device.udid),
            "simctl delete left the simulator behind",
          ).not.toContain(udid);
        } finally {
          await emptyDeviceSet(deviceSet);
          await rm(home, { force: true, recursive: true });
        }
      },
    );
  },
);
