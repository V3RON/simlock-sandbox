import { describe, expect, it } from "vitest";
import { Nuke } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { androidRequest, createHarness, request } from "./test-create-leasing.js";

describe("createLeasing: a platform nuke", () => {
  it("a platform nuke ends only that platform's leases and reports only its devices and leases", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 2,
      },
      warmPoolEnabled: false,
    });
    const iosGrant = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    const androidGrant = await harness.engine.request(androidRequest, {
      ownerId: "b",
      requesterId: "b",
    });

    const report = await new Nuke({ executor: harness.engine, registry: harness.registry }).run({
      deleteDevices: true,
      platform: "ios",
    });

    expect(report.releasedLeaseIds).toEqual([iosGrant.lease.id]);
    expect(report.deletedDevices).toEqual([iosGrant.device.id]);
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual([
      androidGrant.lease.id,
    ]);
    expect(
      harness.registry.snapshot.devices.find((device) => device.id === androidGrant.device.id)
        ?.state,
    ).toBe("leased");
  });
});
