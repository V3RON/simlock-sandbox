import { describe, expect, it } from "vitest";
import { SimlockError } from "../contract/index.js";
import { FakeClock } from "../ports/index.js";
import { runCli } from "./index.js";
import { detachedGrant, fakeClient, outputCapture, realCliEnvironmentPorts } from "./test-index.js";
import { FakeFarm } from "./test-remote.js";

describe("simlock lease: the capabilities a lease requires", () => {
  it("sends --requires split on commas, adds the idempotency key with --url, prints the daemon's BAD_REQUEST for an empty one, and lists the flag in --help", async () => {
    const local = async (flags: readonly string[]) => {
      let sent: Record<string, unknown> | undefined;
      const exitCode = await runCli(
        ["lease", "--platform", "android", "--detach", ...flags],
        outputCapture().environmentWith({
          connectAdmin: async () =>
            fakeClient({
              requestLease: (input) => {
                sent = input as unknown as Record<string, unknown>;
                return Promise.resolve(detachedGrant);
              },
            }),
        }),
      );
      return { exitCode, sent };
    };

    const one = await local(["--requires", "bank-network"]);
    expect(one.exitCode).toBe(0);
    expect(one.sent).toMatchObject({ requires: ["bank-network"] });
    const two = await local(["--requires", "bank-network,eu-west"]);
    expect(two.sent).toMatchObject({ requires: ["bank-network", "eu-west"] });
    const none = await local([]);
    expect(none.sent).not.toHaveProperty("requires");

    const farm = new FakeFarm({ "lease.request": () => detachedGrant });
    const farmOutput = outputCapture(
      { ...realCliEnvironmentPorts(), clock: new FakeClock(0) },
      {
        SIMLOCK_AGENT_ID: "agent-a",
        SIMLOCK_TOKEN: "slk_t",
        SIMLOCK_URL: "https://farm.example.com",
      },
    );
    const farmExit = await runCli(
      ["lease", "--platform", "android", "--detach", "--requires", "bank-network,eu-west"],
      farmOutput.environmentWith({ webSocket: farm }),
    );
    expect(farmExit).toBe(0);
    const request = farm.requests.find(({ type }) => type === "lease.request");
    expect(request?.payload).toMatchObject({
      idempotencyKey: expect.stringMatching(/\S/),
      requires: ["bank-network", "eu-west"],
    });

    const refusal = "a capability name must match the name rules";
    let sent: Record<string, unknown> | undefined;
    const output = outputCapture();
    const refusedExit = await runCli(
      ["lease", "--platform", "android", "--detach", "--requires", ""],
      output.environmentWith({
        connectAdmin: async () =>
          fakeClient({
            requestLease: (input) => {
              sent = input as unknown as Record<string, unknown>;
              return Promise.reject(
                new SimlockError("BAD_REQUEST", "protocol", refusal, {} as never),
              );
            },
          }),
      }),
    );
    expect(sent).toMatchObject({ requires: [""] });
    expect(refusedExit).toBe(2);
    expect(output.stderr).toContain(refusal);
    expect(output.stderr).toContain("BAD_REQUEST");
    expect(output.stderr).not.toContain("USAGE");

    const help = outputCapture();
    expect(await runCli(["lease", "--help"], help.environmentWith({}))).toBe(0);
    expect(help.stdout).toContain("[--requires <capability,...>]");
  });
});
