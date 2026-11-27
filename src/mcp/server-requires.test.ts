import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import { createMcpServer } from "./server.js";
import { McpSession } from "./session.js";
import { call } from "./test-server.js";
import { FakeSimlockClient, sampleGrant } from "./test-support.js";

async function serverOver(
  client: FakeSimlockClient,
  farm?: { readonly origin: string; readonly requesterId: string },
) {
  const clock = new FakeClock();
  const session = new McpSession({
    clock,
    connect: async () => client,
    connectForRenew: async () => client,
    ...(farm === undefined ? {} : { farm }),
  });
  const server = createMcpServer(session, { clock });
  const mcpClient = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
  return {
    close: async () => {
      await Promise.all([mcpClient.close(), server.close(), session.close()]);
    },
    mcpClient,
  };
}

describe("MCP lease_simulator: the capabilities a lease requires", () => {
  it("sends requires as given locally, with an idempotency key in farm mode, none when not given, and lists it in the input schema", async () => {
    const sentBy = async (farm: boolean, args: Record<string, unknown>) => {
      const client = new FakeSimlockClient();
      client.requestLeaseImpl = () => Promise.resolve(sampleGrant());
      const { mcpClient, close } = await serverOver(
        client,
        farm ? { origin: "https://farm.example.com", requesterId: "agent-a" } : undefined,
      );
      try {
        const result = await call(mcpClient, "lease_simulator", {
          model: "iPhone 17 Pro",
          platform: "ios",
          ...args,
        });
        expect(result.isError).not.toBe(true);
        return client.calls.find(({ method }) => method === "requestLease")?.input;
      } finally {
        await close();
      }
    };

    expect(await sentBy(false, { requires: ["bank-network"] })).toMatchObject({
      requires: ["bank-network"],
    });
    expect(await sentBy(true, { requires: ["bank-network", "eu-west"] })).toMatchObject({
      idempotencyKey: expect.stringMatching(/\S/),
      requires: ["bank-network", "eu-west"],
    });
    expect(await sentBy(false, {})).not.toHaveProperty("requires");
    expect(await sentBy(true, {})).not.toHaveProperty("requires");

    const { mcpClient, close } = await serverOver(new FakeSimlockClient());
    try {
      const tools = await mcpClient.request({ method: "tools/list" }, ListToolsResultSchema);
      const leaseTool = tools.tools.find((tool) => tool.name === "lease_simulator");
      expect(Object.keys(leaseTool?.inputSchema.properties ?? {})).toContain("requires");
    } finally {
      await close();
    }
  });
});
