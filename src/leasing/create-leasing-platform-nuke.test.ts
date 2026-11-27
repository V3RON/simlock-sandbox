import { describe, expect, it } from "vitest";
import { Nuke, type Platform } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { androidRequest, createHarness, flush, request } from "./test-create-leasing.js";

describe("createLeasing: a platform nuke", () => {
  async function heldOnBothPlatforms() {
    const androidMaxDevices = 1;
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      limits: {
        android: { maxDevices: androidMaxDevices, maxRunning: androidMaxDevices },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: androidMaxDevices + 2,
      },
      warmPoolEnabled: false,
    });
    const grants = {
      android: await harness.engine.request(androidRequest, { ownerId: "b", requesterId: "b" }),
      ios: await harness.engine.request(request, { ownerId: "a", requesterId: "a" }),
    };
    const nuke = (platform: Platform) =>
      new Nuke({ executor: harness.engine, registry: harness.registry }).run({
        deleteDevices: true,
        platform,
      });
    return { android, grants, harness, ios, nuke };
  }

  it("a platform nuke ends only that platform's leases, physical ones included, cancels every waiting request, and reports only its devices and leases", async () => {
    for (const [target, other] of [
      ["ios", "android"],
      ["android", "ios"],
    ] as const) {
      const { grants, harness, nuke } = await heldOnBothPlatforms();

      const report = await nuke(target);

      expect(report.releasedLeaseIds, target).toEqual([grants[target].lease.id]);
      expect(report.deletedDevices, target).toEqual([grants[target].device.id]);
      expect(
        harness.registry.snapshot.leases.map((lease) => lease.id),
        target,
      ).toEqual([grants[other].lease.id]);
      expect(
        harness.registry.snapshot.devices.find((device) => device.id === grants[other].device.id)
          ?.state,
        target,
      ).toBe("leased");
    }

    const { grants, harness, ios, nuke } = await heldOnBothPlatforms();
    const physical = await harness.registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: "UDID-P",
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
    });
    ios.setPhysicalPresence("UDID-P", true);
    const physicalGrant = await harness.engine.request(
      { model: "iPhone 15 Pro", physical: true, platform: "ios" },
      { ownerId: "p", requesterId: "p" },
    );
    const waiting = harness.engine
      .request(androidRequest, { ownerId: "w", requesterId: "w" })
      .catch((error: unknown) => error);
    await flush();
    expect(harness.engine.waitingRequests()).toMatchObject([{ requesterId: "w" }]);

    const report = await nuke("ios");

    expect([...report.releasedLeaseIds].sort()).toEqual(
      [grants.ios.lease.id, physicalGrant.lease.id].sort(),
    );
    expect(await waiting).toMatchObject({ name: "NukeCancelledError" });
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual([
      grants.android.lease.id,
    ]);
    expect(report.deletedDevices).not.toContain(physical.id);
    expect(
      harness.registry.snapshot.devices.find((device) => device.id === physical.id)?.state,
    ).toBe("ready");
  });

  it("a platform nuke with --delete-devices deletes only that platform's seeds and baselines, never an orphan, and without it deletes none", async () => {
    const sourceOf = (platform: Platform, kind: "baseline" | "seed", orphan = false) => ({
      id: `${platform}-${kind}${orphan ? "-orphan" : ""}`,
      kind,
      model: "Phone",
      osVersion: "1",
      ...(orphan ? { orphan: true as const } : {}),
    });
    const cases = [
      { deleteDevices: true, platform: "ios", removed: "ios-base" },
      { deleteDevices: true, platform: "android", removed: "android-base" },
      { deleteDevices: false, platform: "ios", removed: undefined },
    ] as const;

    for (const { deleteDevices, platform, removed } of cases) {
      const clock = new FakeClock(1_000);
      const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
      const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
      const harness = await createHarness({ driver: ios, drivers: [ios, android] });
      const drivers = { android, ios };
      for (const [name, driver] of Object.entries(drivers) as [Platform, FakeDriver][]) {
        driver.setSources([
          sourceOf(name, "seed"),
          sourceOf(name, "baseline"),
          sourceOf(name, "seed", true),
        ]);
        harness.state.database
          .prepare(
            "INSERT INTO baselines (name, version, platform, model, os_version, mode, saved_at, source_id) VALUES (?, 1, ?, 'Phone', '1', 'full', 'now', ?)",
          )
          .run(`${name}-base`, name, `${name}-baseline`);
      }
      const events: unknown[] = [];
      harness.bus.subscribe("baseline.removed", (event) => events.push(event.payload));

      const report = await new Nuke({ executor: harness.engine, registry: harness.registry }).run({
        deleteDevices,
        platform,
      });

      const kept = (name: Platform) =>
        drivers[name].listSources().then((all) => all.map((x) => x.id));
      const other = platform === "ios" ? "android" : "ios";
      expect(report.removedBaselines, platform).toEqual(removed === undefined ? [] : [removed]);
      expect(events, platform).toEqual(
        removed === undefined ? [] : [{ name: removed, reason: "nuke", version: 1 }],
      );
      expect(await kept(platform), platform).toEqual(
        deleteDevices
          ? [`${platform}-seed-orphan`]
          : [`${platform}-seed`, `${platform}-baseline`, `${platform}-seed-orphan`],
      );
      expect(await kept(other), platform).toEqual([
        `${other}-seed`,
        `${other}-baseline`,
        `${other}-seed-orphan`,
      ]);
    }
  });
});
