import { describe, expect, it } from "vitest";
import { Nuke } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { androidRequest, createHarness, flush, request, seedReady } from "./test-create-leasing.js";

type Platform = "android" | "ios";

async function bothPlatforms(options: Parameters<typeof createHarness>[0] = {}) {
  const clock = new FakeClock(1_000);
  const ios = new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    knownModels: [request.model],
    platform: "ios",
  });
  const android = new FakeDriver({
    availableOsVersions: ["36"],
    clock,
    knownModels: [androidRequest.model],
    platform: "android",
  });
  const harness = await createHarness({
    ...options,
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

/** why: one lease and one saved baseline per platform, a seed and an orphan beside each, then a nuke of one platform; answers what the nuke reported and what is left. */
async function nukeSeedsAndBaselines(platform: Platform, deleteDevices: boolean) {
  const { drivers, harness } = await bothPlatforms();
  const asks = { android: androidRequest, ios: request };
  for (const each of ["ios", "android"] as const) {
    const lease = await harness.engine.request(asks[each], { ownerId: each, requesterId: each });
    await harness.engine.core.baselines.save({
      leaseId: lease.lease.id,
      name: `${each}-checkout`,
      requesterId: each,
    });
    drivers[each].setSources([
      ...(await drivers[each].listSources()),
      { id: `${each}-seed`, kind: "seed", model: "m", osVersion: "1" },
      { id: `${each}-orphan`, kind: "seed", model: "m", orphan: true, osVersion: "1" },
    ]);
  }

  const report = await harness.engine.nuke(deleteDevices, platform);

  const left = async (each: Platform) =>
    (await drivers[each].listSources()).map((source) => source.id).sort();
  return {
    baselines: (await harness.engine.core.baselines.list()).map((entry) => entry.name).sort(),
    removed: report.removedBaselines,
    removedEvents: harness.bus.replay().filter((event) => event.event === "baseline.removed")
      .length,
    sources: { android: await left("android"), ios: await left("ios") },
  };
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
      const idle = await seedReady(
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
      expect(state(idle.id), platform).toBe("ready");
      expect(
        harness.registry.snapshot.leases.map((lease) => lease.id),
        platform,
      ).toEqual([leases[other].lease.id]);
    }
  });

  it("ends an iOS physical lease and keeps the device enrolled, and leaves the Android lease", async () => {
    const { drivers, harness } = await bothPlatforms();
    const phone = await harness.registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: "UDID-A",
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
    });
    drivers.ios.setPhysicalPresence("UDID-A", true);
    const physical = await harness.engine.request(
      { model: "iPhone 15 Pro", physical: true, platform: "ios" },
      { ownerId: "p", requesterId: "p" },
    );
    const android = await harness.engine.request(androidRequest, {
      ownerId: "a",
      requesterId: "a",
    });

    const report = await new Nuke({ executor: harness.engine, registry: harness.registry }).run({
      deleteDevices: true,
      platform: "ios",
    });

    expect(report.releasedLeaseIds).toEqual([physical.lease.id]);
    expect(report.deletedDevices).toEqual([]);
    const state = (id: string) =>
      harness.registry.snapshot.devices.find((device) => device.id === id)?.state;
    expect(state(phone.id)).toBe("ready");
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

  it("with --delete-devices deletes only that platform's seeds and baselines, keeps every orphan, and deletes nothing without it", async () => {
    const outcomes: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const platform of ["ios", "android"] as const satisfies readonly Platform[]) {
      const other = platform === "ios" ? "android" : "ios";
      for (const deleteDevices of [true, false]) {
        const label = `${platform} ${deleteDevices ? "with" : "without"} --delete-devices`;
        outcomes[label] = await nukeSeedsAndBaselines(platform, deleteDevices);
        expected[label] = deleteDevices
          ? {
              baselines: [`${other}-checkout`],
              removed: [`${platform}-checkout`],
              removedEvents: 1,
              sources: {
                [other]: ["fake-source-1", `${other}-orphan`, `${other}-seed`].sort(),
                [platform]: [`${platform}-orphan`],
              },
            }
          : {
              baselines: ["android-checkout", "ios-checkout"],
              removed: [],
              removedEvents: 0,
              sources: {
                android: ["android-orphan", "android-seed", "fake-source-1"].sort(),
                ios: ["fake-source-1", "ios-orphan", "ios-seed"].sort(),
              },
            };
      }
    }

    expect(outcomes).toEqual(expected);
  });

  it("forgets only that platform's learned kinds, an iOS baseline kind included, and every kind without a platform", async () => {
    for (const platform of [undefined, "ios", "android"] as const) {
      const { harness } = await bothPlatforms({
        startPool: true,
        warmPool: { baselineLearnAfter: 1 },
      });
      harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
      const learn = async (asked: Parameters<typeof harness.engine.request>[0], who: string) => {
        const grant = await harness.engine.request(asked, { ownerId: who, requesterId: who });
        await harness.engine.release(grant.lease.id, "explicit");
        await flush();
      };
      await learn(request, "plain");
      await learn(androidRequest, "android");
      const saver = await harness.engine.request(request, {
        ownerId: "saver",
        requesterId: "saver",
      });
      await harness.engine.core.baselines.save({
        leaseId: saver.lease.id,
        name: "checkout",
        requesterId: "saver",
      });
      await learn({ baseline: "checkout", platform: "ios" }, "based");
      await harness.engine.core.passWarmPool();
      const learned = () =>
        harness.engine
          .figures()
          .targets.filter((target) => target.origin === "learned")
          .map(
            (target) =>
              `${target.platform}:${target.baseline === undefined ? "plain" : "baseline"}`,
          )
          .sort();
      expect(learned()).toEqual(["android:plain", "ios:baseline", "ios:plain"]);

      await harness.engine.nuke(false, platform);
      await harness.engine.core.passWarmPool();

      expect(learned(), String(platform)).toEqual(
        platform === undefined
          ? []
          : platform === "ios"
            ? ["android:plain"]
            : ["ios:baseline", "ios:plain"],
      );
    }
  });
});
