import { describe, expect, it } from "vitest";
import type { CatalogGetOutput, LeaseGrant } from "../client/index.js";
import { leaseSimulatorOutputSchema } from "./contracts.js";
import { FakeSimlockClient, sampleGrant } from "./test-support.js";
import { call, connectedServer, text, waitFor } from "./test-server.js";

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

const catalogOf = (slimCategories: readonly string[]): CatalogGetOutput => ({
  platforms: [
    {
      platform: "ios",
      defaultRuntime: "26.5",
      modelAliases: {},
      classDefaults: {},
      modelClasses: {},
      modelRuntimes: { "iPhone 17 Pro": ["26.5"] },
      models: ["iPhone 17 Pro"],
      runtimes: ["26.5"],
      slimCategories: [...slimCategories],
    },
  ],
});

const hintOf = (names: readonly string[]) =>
  `slim: ${names.join(", ")} off; pass except: ["<name>"] or mode: "full"`;

interface Case {
  readonly name: string;
  readonly args?: Record<string, unknown>;
  readonly device?: Partial<LeaseGrant["device"]>;
  readonly catalog?: () => Promise<CatalogGetOutput>;
  readonly hint?: string;
  readonly catalogCalls?: number;
}

const ALL = (): Promise<CatalogGetOutput> => Promise.resolve(catalogOf(CATEGORIES));

const CASES: readonly Case[] = [
  { name: "all 16", hint: hintOf(CATEGORIES) },
  {
    name: "except store",
    args: { except: ["store"] },
    device: { except: ["store"] },
    hint: hintOf(CATEGORIES.filter((name) => name !== "store")),
  },
  { name: "full", device: { mode: "full" }, catalogCalls: 0 },
  {
    name: "Android",
    device: {
      mode: "full",
      spec: { model: "Pixel 8", osVersion: "35", physical: false, platform: "android" },
    } as Partial<LeaseGrant["device"]>,
    catalogCalls: 0,
  },
  { name: "catalog read rejects", catalog: () => Promise.reject(new Error("gone")) },
  { name: "catalog read unanswered", catalog: () => new Promise(() => {}) },
];

describe("MCP lease_simulator: the slim hint", () => {
  it("a slim iOS lease answers the grant plus a hint naming the categories off, in structuredContent and in the text, and the rest equals the grant", async () => {
    for (const testCase of CASES) {
      const where = `case ${testCase.name}`;
      const client = new FakeSimlockClient();
      const grant: LeaseGrant = {
        ...sampleGrant(),
        device: { ...sampleGrant().device, mode: "slim", ...testCase.device },
      };
      let catalogCalls = 0;
      client.requestLeaseImpl = () => Promise.resolve(grant);
      client.getCatalogImpl = () => {
        catalogCalls += 1;
        return (testCase.catalog ?? ALL)();
      };
      const { clock, mcpClient, close } = await connectedServer(client);
      try {
        let result: Awaited<ReturnType<typeof call>> | undefined;
        const pending = call(mcpClient, "lease_simulator", {
          model: "iPhone 17 Pro",
          platform: "ios",
          mode: "slim",
          ...testCase.args,
        }).then((answer) => (result = answer));
        if (testCase.name === "catalog read unanswered") {
          await waitFor(() => catalogCalls > 0);
          await new Promise((resolve) => setTimeout(resolve, 0));
          clock.advance(2_001);
        }
        await pending;
        expect(result?.isError, where).not.toBe(true);
        const structured = result?.structuredContent as Record<string, unknown>;
        const { hint, ...rest } = structured;
        expect(hint, where).toBe(testCase.hint);
        expect(rest, where).toEqual(JSON.parse(JSON.stringify(grant)));
        expect(JSON.parse(text(result!)), where).toEqual(structured);
        expect(leaseSimulatorOutputSchema.parse(structured), where).toEqual(structured);
        expect(catalogCalls, where).toBe(testCase.catalogCalls ?? 1);
      } finally {
        await close();
      }
    }
  });
});
