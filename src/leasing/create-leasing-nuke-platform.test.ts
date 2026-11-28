import { describe, expect, it } from "vitest";
import { Nuke } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { androidRequest, createHarness, request } from "./test-create-leasing.js";

describe("createLeasing: a platform nuke", () => {
  it("ends only that platform's leases and deletes only its devices, and reports only their ids", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      limits: {
        android: { maxDevices: 2, maxRunning: 2 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 4,
      },
    });
    const iosLease = await harness.engine.request(request, { ownerId: "i", requesterId: "i" });
    const androidLease = await harness.engine.request(androidRequest, {
      ownerId: "a",
      requesterId: "a",
    });

    const report = await new Nuke({ executor: harness.engine, registry: harness.registry }).run({
      deleteDevices: true,
      platform: "ios",
    });

    expect(report.releasedLeaseIds).toEqual([iosLease.lease.id]);
    expect(report.deletedDevices).toEqual([iosLease.device.id]);
    const state = (id: string) =>
      harness.registry.snapshot.devices.find((device) => device.id === id)?.state;
    expect(state(iosLease.device.id)).toBe("deleted");
    expect(state(androidLease.device.id)).toBe("leased");
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual([
      androidLease.lease.id,
    ]);
  });
});
