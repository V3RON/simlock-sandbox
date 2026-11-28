import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { LeaseGrant } from "../client/index.js";
import type { SimlockAdminClient } from "../simlock-client/client.js";
import { runCli } from "./index.js";
import type { CliEnvironment } from "./types.js";
import { FakeClock } from "../ports/index.js";
import { fakeClient, outputCapture, settle } from "./test-index.js";

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
    environment: { SIMULATOR_UDID: "dev_1" },
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

const ANDROID_SPEC = { physical: false, platform: "android", model: "Pixel 8", osVersion: "35" };

interface Case {
  readonly name: string;
  readonly args?: readonly string[];
  readonly device?: Partial<LeaseGrant["device"]>;
  readonly catalog?: (clock: FakeClock) => Promise<ReturnType<typeof iosCatalog>>;
  /** why: the default run holds the lease until a signal, which these cases send once the hint had its time. */
  readonly held?: true;
  /** why: the connection drops while the hint's catalog read is out, which a detached lease holds nothing for. */
  readonly dropsDuringHint?: true;
  readonly line?: readonly string[];
  readonly catalogCalls?: number;
}

const ALL = (): Promise<ReturnType<typeof iosCatalog>> => Promise.resolve(iosCatalog(CATEGORIES));
const answersAfter =
  (delayMs: number) =>
  (clock: FakeClock): Promise<ReturnType<typeof iosCatalog>> =>
    new Promise((resolve) => {
      clock.setTimer(delayMs, () => resolve(iosCatalog(CATEGORIES)));
    });
const lineOf = (names: readonly string[]) =>
  `slim: ${names.join(", ")} off; use --except <name> or --mode full`;

const CASES: readonly Case[] = [
  { name: "all 16, no except", line: [lineOf(CATEGORIES)], catalogCalls: 1 },
  {
    name: "except siri names the other 15",
    device: { except: ["siri"] },
    line: [lineOf(CATEGORIES.filter((name) => name !== "siri"))],
  },
  { name: "except covers the list", device: { except: CATEGORIES.slice(0, 16) } },
  { name: "slimCategories []", catalog: () => Promise.resolve(iosCatalog([])) },
  { name: "slimCategories absent", catalog: () => Promise.resolve(iosCatalog(undefined)) },
  { name: "no iOS entry", catalog: () => Promise.resolve({ platforms: [] }) },
  { name: "full", device: { mode: "full" }, catalogCalls: 0 },
  {
    name: "Android",
    device: { spec: ANDROID_SPEC, mode: undefined } as Partial<LeaseGrant["device"]>,
    catalogCalls: 0,
  },
  { name: "physical", device: { physical: true, mode: undefined }, catalogCalls: 0 },
  { name: "catalog.get rejects", catalog: () => Promise.reject(new Error("daemon went away")) },
  { name: "catalog.get unanswered", catalog: () => new Promise(() => {}) },
  {
    name: "catalog.get answers inside the 2 s bound",
    catalog: answersAfter(1_500),
    line: [lineOf(CATEGORIES)],
  },
  { name: "catalog.get answers after the 2 s bound", catalog: answersAfter(2_500) },
  { name: "held (no --detach)", held: true, line: [lineOf(CATEGORIES)] },
  { name: "held, catalog.get unanswered", held: true, catalog: () => new Promise(() => {}) },
  { name: "--detach", args: ["--detach"], line: [lineOf(CATEGORIES)] },
  {
    name: "--detach, the connection drops during the catalog read",
    args: ["--detach"],
    dropsDuringHint: true,
    catalog: answersAfter(1_000),
    line: [lineOf(CATEGORIES)],
  },
  { name: "--export-env", args: ["--export-env", "--detach"], line: [lineOf(CATEGORIES)] },
];

interface Ran {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly catalogCalls: number;
}

async function runCase(testCase: Case): Promise<Ran> {
  const where = `case ${testCase.name}`;
  const output = outputCapture();
  const clock = new FakeClock(0);
  let catalogCalls = 0;
  const grant = grantOf(testCase.device ?? {});
  const lostHandlers: ((error: { code: string; message: string }) => void)[] = [];
  const client = fakeClient({
    requestLease: () => Promise.resolve(grant),
    onConnectionLost: ((handler: (typeof lostHandlers)[number]) => {
      lostHandlers.push(handler);
      return () => {};
    }) as SimlockAdminClient["onConnectionLost"],
    getCatalog: () => {
      catalogCalls += 1;
      if (testCase.dropsDuringHint === true) {
        for (const handler of lostHandlers)
          handler({ code: "DAEMON_CONNECTION_LOST", message: "gone" });
      }
      return (testCase.catalog ?? ALL)(clock);
    },
  });
  let code: number | undefined;
  const signals = new EventEmitter();
  const running = runCli(
    [
      "lease",
      "--platform",
      "ios",
      "--mode",
      "slim",
      ...(testCase.held === true ? [] : ["--detach"]),
      ...(testCase.args ?? []),
    ],
    output.environmentWith({
      clock,
      connectAdmin: async () => client,
      signals: signals as unknown as CliEnvironment["signals"],
    }),
  ).then((exit) => (code = exit));
  // why: the command module loads lazily, so the fake clock starts only once the grant is out.
  await vi.waitFor(() => expect(output.stdout, `${where}: no grant written`).not.toBe(""));
  for (let tick = 0; tick < 10 && code === undefined; tick += 1) {
    await settle();
    clock.advance(500);
    if (testCase.held === true && tick === 6) signals.emit("SIGINT");
  }
  expect(code, `${where}: the command had not finished by 5 s on the fake clock`).toBeDefined();
  await running;
  return { code: code as number, stderr: output.stderr, stdout: output.stdout, catalogCalls };
}

function slimNotices(ran: Ran, where: string): string[] {
  return ran.stderr
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return String((JSON.parse(line) as { notice?: unknown }).notice);
      } catch {
        throw new Error(`${where}: ${ran.stderr}`);
      }
    })
    .filter((notice) => notice.startsWith("slim:"));
}

describe("simlock lease: the slim hint line", () => {
  it("a slim iOS lease writes one stderr notice naming the categories off, in catalog order, and never changes the grant or the exit code", async () => {
    for (const testCase of CASES) {
      const where = `case ${testCase.name}`;
      const ran = await runCase(testCase);
      expect(slimNotices(ran, where), where).toEqual(testCase.line ?? []);
      expect(ran.code, where).toBe(0);
      expect(ran.stderr, `${where}: a detached lease reports no lost connection`).not.toContain(
        "DAEMON_CONNECTION_LOST",
      );
      expect(ran.catalogCalls, where).toBe(testCase.catalogCalls ?? 1);
      if (testCase.args?.includes("--export-env") === true) {
        expect(ran.stdout, where).toMatch(/^export /m);
        expect(ran.stdout, where).not.toContain("slim:");
      } else {
        expect(JSON.parse(ran.stdout), where).toMatchObject({ lease: { id: "lse_1" } });
      }
    }
  });
});
