import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function simctl(set: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "--set", set, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function deviceState(set: string, udid: string): Promise<string | undefined> {
  const listed = JSON.parse(await simctl(set, "list", "devices", "-j")) as {
    devices: Record<string, { udid: string; state: string }[]>;
  };
  return Object.values(listed.devices)
    .flat()
    .find((d) => d.udid === udid)?.state;
}

describe("simctl delete after a shutdown that timed out (#98)", () => {
  it("removes a simulator whose simctl shutdown was killed before it finished", async () => {
    const set = await mkdtemp(join(tmpdir(), "simlock-delete-after-shutdown-"));
    try {
      const runtimes = JSON.parse(await simctl(set, "list", "runtimes", "-j")) as {
        runtimes: { identifier: string; isAvailable: boolean; name: string }[];
      };
      const runtime = runtimes.runtimes.find((r) => r.isAvailable && r.name.startsWith("iOS"));
      expect(runtime, "this lane needs an installed iOS runtime").toBeDefined();
      const udid = await simctl(
        set,
        "create",
        "simlock-98",
        "iPhone 15",
        runtime?.identifier ?? "",
      );
      await simctl(set, "boot", udid);
      await simctl(set, "bootstatus", udid, "-b");

      const shutdown = spawn("xcrun", ["simctl", "--set", set, "shutdown", udid], {
        stdio: "ignore",
      });
      let closed = false;
      const closedP = new Promise<void>((resolve) =>
        shutdown.once("close", () => {
          closed = true;
          resolve();
        }),
      );
      // why: killing in the same tick as spawn() can stop simctl before CoreSimulator hears of the shutdown; wait until the device has left "Booted" so the kill lands mid-shutdown.
      const deadline = Date.now() + 15_000;
      let state = await deviceState(set, udid);
      while (state === "Booted") {
        expect(Date.now(), "the device never began shutting down").toBeLessThan(deadline);
        await new Promise((resolve) => setTimeout(resolve, 20));
        state = await deviceState(set, udid);
      }
      expect(state, "the shutdown finished before it could be killed mid-way").toBe(
        "Shutting Down",
      );
      expect(closed, "simctl shutdown exited before the kill").toBe(false);
      shutdown.kill("SIGKILL");
      await closedP;

      await simctl(set, "delete", udid);
      const listed = JSON.parse(await simctl(set, "list", "devices", "-j")) as {
        devices: Record<string, { udid: string }[]>;
      };
      expect(
        Object.values(listed.devices)
          .flat()
          .map((d) => d.udid),
      ).not.toContain(udid);
    } finally {
      await rm(set, { recursive: true, force: true });
    }
  }, 300_000);
});
