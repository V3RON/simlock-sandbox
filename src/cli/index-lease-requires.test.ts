import { describe, expect, it } from "vitest";
import { SimlockError } from "../contract/index.js";
import { FakeClock } from "../ports/index.js";
import { runCli } from "./index.js";
import { detachedGrant, fakeClient, outputCapture, realCliEnvironmentPorts } from "./test-index.js";
import { FakeFarm } from "./test-remote.js";

const FARM = {
  SIMLOCK_AGENT_ID: "agent-a",
  SIMLOCK_TOKEN: "slk_t",
  SIMLOCK_URL: "https://farm.example.com",
};

async function sentLocally(flags: readonly string[], refusal?: string) {
  let sent: Record<string, unknown> | undefined;
  const output = outputCapture();
  const exitCode = await runCli(
    ["lease", "--platform", "android", "--detach", ...flags],
    output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          requestLease: (input) => {
            sent = input as unknown as Record<string, unknown>;
            return refusal === undefined
              ? Promise.resolve(detachedGrant)
              : Promise.reject(new SimlockError("BAD_REQUEST", "protocol", refusal, {} as never));
          },
        }),
    }),
  );
  return { exitCode, sent, stderr: output.stderr, stdout: output.stdout };
}

describe("simlock lease: the capabilities a lease requires", () => {
  it("sends --requires as a list of names, locally and with --url, sends none without it, prints the daemon's refusal of an empty one, and lists the flag in --help", async () => {
    const accepted: readonly (readonly [string, readonly string[], readonly string[]])[] = [
      ["one name", ["--requires", "bank-network"], ["bank-network"]],
      ["two names", ["--requires", "bank-network,eu-west"], ["bank-network", "eu-west"]],
    ];
    for (const [name, flags, requires] of accepted) {
      const local = await sentLocally(flags);
      expect(local.exitCode, name).toBe(0);
      expect(local.sent, name).toMatchObject({ requires });
    }
    const plain = await sentLocally([]);
    expect(plain.exitCode).toBe(0);
    expect(plain.sent).not.toHaveProperty("requires");

    const farm = new FakeFarm({ "lease.request": () => detachedGrant });
    const output = outputCapture({ ...realCliEnvironmentPorts(), clock: new FakeClock(0) }, FARM);
    const farmCode = await runCli(
      ["lease", "--platform", "android", "--detach", "--requires", "bank-network,eu-west"],
      output.environmentWith({ webSocket: farm }),
    );
    expect(farmCode).toBe(0);
    expect(farm.requests.find(({ type }) => type === "lease.request")?.payload).toEqual(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/\S/),
        requires: ["bank-network", "eu-west"],
      }),
    );

    const refusal = "a capability name must be 1 to 64 characters";
    const empty = await sentLocally(["--requires", ""], refusal);
    expect(empty.sent).toMatchObject({ requires: [""] });
    expect(empty.exitCode).toBe(2);
    expect(empty.stderr).toContain(refusal);
    expect(empty.stderr).toContain("BAD_REQUEST");
    expect(empty.stderr).not.toContain("USAGE");

    const help = outputCapture();
    expect(await runCli(["lease", "--help"], help.environmentWith({}))).toBe(0);
    expect(help.stdout).toContain("[--requires <capability,...>]");
  });
});
