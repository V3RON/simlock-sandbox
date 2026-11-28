import { describe, expect, it } from "vitest";
import type { LeaseGrant } from "../client/index.js";
import { runCli } from "./index.js";
import { fakeClient, outputCapture } from "./test-index.js";

const CATEGORIES = [
  "widgets",
  "siri",
  "search",
  "icloud",
  "store",
  "pim",
  "web",
  "family",
  "health",
  "photos",
  "apps",
  "messaging",
  "connectivity",
  "telemetry",
  "mdm",
  "other",
];

function iosCatalog(slimCategories: readonly string[] | undefined) {
  return {
    platforms: [
      {
        platform: "ios" as const,
        defaultRuntime: "26.5",
        modelAliases: {},
        classDefaults: {},
        modelClasses: {},
        modelRuntimes: { "iPhone 17 Pro": ["26.5"] },
        models: ["iPhone 17 Pro"],
        runtimes: ["26.5"],
        ...(slimCategories === undefined ? {} : { slimCategories: [...slimCategories] }),
      },
    ],
  };
}

function grantOf(device: Partial<LeaseGrant["device"]>): LeaseGrant {
  return {
    environment: {},
    device: {
      physical: false,
      id: "dev_1",
      driverDeviceId: "dev_1",
      spec: { physical: false, platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      mode: "slim",
      ...device,
    } as LeaseGrant["device"],
    lease: {
      id: "lse_1",
      deviceId: "dev_1",
      requesterId: "test-requester",
      ownerId: "test-requester",
      grantedAt: 0,
      lastRenewedAt: 0,
      idChosenByRequester: false,
      ttlMs: 60_000,
      ttlDeadline: 60_000,
    },
    timing: {
      estimatedProvisionMs: 0,
      estimatedBootMs: 0,
      estimatedReclaimMs: 0,
      estimatedReadyMs: 0,
    },
  };
}

describe("simlock lease: the slim hint line", () => {
  it("a slim iOS lease writes one stderr notice naming the categories off, in catalog order", async () => {
    const output = outputCapture();
    const client = fakeClient({
      requestLease: () => Promise.resolve(grantOf({})),
      getCatalog: () => Promise.resolve(iosCatalog(CATEGORIES)),
    });
    const code = await runCli(
      ["lease", "--platform", "ios", "--mode", "slim", "--detach"],
      output.environmentWith({ connectAdmin: async () => client }),
    );
    expect(code).toBe(0);
    const notices = output.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => String(line.notice).startsWith("slim:"));
    expect(notices).toEqual([
      {
        notice: `slim: ${CATEGORIES.join(", ")} off; use --except <name> or --mode full`,
      },
    ]);
  });
});
