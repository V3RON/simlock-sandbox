import { describe, expect, it } from "vitest";
import { Nuke } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { androidRequest, createHarness, flush, request, seedReady } from "./test-create-leasing.js";
import {
  asking,
  createHarness as createPhysicalHarness,
  enrollIphone,
  physicalRequest,
} from "./test-physical-device-watcher.js";

type Platform = "android" | "ios";

async function bothPlatforms() {
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
  return { drivers: { android, ios }, harness };
}

describe("createLeasing: a platform nuke", () => {
  it("ends only that platform's leases and deletes only its devices, and reports only their ids, leaving out a device another path deleted", async () => {
    for (const platform of ["ios", "android"] as const satisfies readonly Platform[]) {
      const { drivers, harness } = await bothPlatforms();
      const leases = {
        ios: await harness.engine.request(request, { ownerId: "i", requesterId: "i" }),
        android: await harness.engine.request(androidRequest, { ownerId: "a", requesterId: "a" }),
      };
      const other = platform === "ios" ? "android" : "ios";
      const spare = await seedReady(
        harness,
        other === "ios" ? { ...request, physical: false } : { ...androidRequest, physical: false },
        "full",
        drivers[other],
      );
      harness.bus.subscribe("device.deleted", (event) => {
        if (event.payload.deviceId !== leases[platform].device.id) return;
        void harness.decisions.run(() => harness.registry.markDeviceMissing(spare.id, "elsewhere"));
      });

      const report = await new Nuke({ executor: harness.engine, registry: harness.registry }).run({
        deleteDevices: true,
        platform,
      });

      expect(report.releasedLeaseIds, platform).toEqual([leases[platform].lease.id]);
      const state = (id: string) =>
        harness.registry.snapshot.devices.find((device) => device.id === id)?.state;
      expect(state(spare.id), platform).toBe("deleted");
      expect(report.deletedDevices, platform).toEqual([leases[platform].device.id]);
      expect(state(leases[platform].device.id), platform).toBe("deleted");
      expect(state(leases[other].device.id), platform).toBe("leased");
      expect(
        harness.registry.snapshot.leases.map((lease) => lease.id),
        platform,
      ).toEqual([leases[other].lease.id]);
    }
  });

  it("ends an iOS physical lease and keeps the device enrolled, and leaves the Android lease", async () => {
    const harness = await createPhysicalHarness({ android: true });
    const phone = await enrollIphone(harness, "UDID-A");
    const physical = await harness.engine.request(physicalRequest, asking("p"));
    const android = await harness.engine.request(
      { ...androidRequest, osVersion: "14" },
      asking("a"),
    );

    const report = await new Nuke({ executor: harness.engine, registry: harness.registry }).run({
      deleteDevices: true,
      platform: "ios",
    });

    expect(report.releasedLeaseIds).toEqual([physical.lease.id]);
    expect(report.deletedDevices).toEqual([]);
    const state = (id: string) =>
      harness.registry.snapshot.devices.find((device) => device.id === id)?.state;
    expect(state(phone.id)).not.toBe("deleted");
    expect(state(phone.id)).not.toBe("leased");
    expect(state(android.device.id)).toBe("leased");
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual([android.lease.id]);
  });

  it("cancels a waiting Android request as killed", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 3,
      },
    });
    const held = await harness.engine.request(androidRequest, { ownerId: "a", requesterId: "a" });
    const iosLease = await harness.engine.request(request, { ownerId: "i", requesterId: "i" });
    const waiting = harness.engine.request(androidRequest, { ownerId: "w", requesterId: "w" });
    const outcome = waiting.then(
      () => "granted",
      (error: unknown) => (error as Error).name,
    );
    await flush();

    const report = await new Nuke({ executor: harness.engine, registry: harness.registry }).run({
      deleteDevices: true,
      platform: "ios",
    });

    await expect(outcome).resolves.toBe("NukeCancelledError");
    expect(report.releasedLeaseIds).toEqual([iosLease.lease.id]);
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual([held.lease.id]);
    expect(harness.bus.replay().filter((event) => event.event === "lease.rejected")).toMatchObject([
      { payload: { reason: "killed" } },
    ]);
  });
});
