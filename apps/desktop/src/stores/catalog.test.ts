import { err } from "@loadout/core";
import { scanItem, seededState } from "@loadout/core/testing";
import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import { mountView } from "../testing/mountView.ts";
import { useCatalogStore } from "./catalog.ts";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
/** Nothing on screen: these tests are about the store, which only needs the app's injected Library. */
const Bare = defineComponent({ render: () => null });

describe("the catalog store's scan", () => {
  it("reads the scan on every load: launch, Refresh, and the reload after a write", async () => {
    let scans = 0;
    const scanned = seededState().scanned;
    mountView(Bare, { library: { scan: async () => (scans++, ok({ items: scanned, missing: [] })) } });
    const catalog = useCatalogStore();
    await catalog.launch();
    await catalog.refresh();
    await catalog.reload();
    expect(scans).toBe(3);
    expect(catalog.unmanaged.map((i) => i.name)).toEqual(scanned.map((i) => i.name));
  });

  it("keeps only what is unmanaged, without the Python CLI's parked copies", async () => {
    const parked = scanItem({ name: "parked", state: { state: "unmanaged", origin: "parked-by-python-cli" }, loadable: false });
    const managed = { ...scanItem({ name: "mine" }), state: { state: "installed" as const, receipt: seededState().entries[0]!.receipt! } };
    mountView(Bare, { seed: { ...seededState(), scanned: [scanItem({ name: "loose" }), parked, managed] } });
    const catalog = useCatalogStore();
    await catalog.reload();
    expect(catalog.unmanaged.map((i) => i.name)).toEqual(["loose"]);
  });

  it("records a failed scan without failing the catalog, and forgets it once a scan succeeds", async () => {
    let failing = true;
    mountView(Bare, {
      library: { scan: async () => (failing ? err({ code: "RECEIPTS_INVALID", message: "receipts.json is not valid JSON" }) : ok({ items: [], missing: [] })) },
    });
    const catalog = useCatalogStore();
    await catalog.reload();
    expect(catalog.scanFailure).toBe("receipts.json is not valid JSON");
    expect(catalog.failure).toBeNull();
    expect(catalog.entries.length).toBeGreaterThan(0);
    failing = false;
    await catalog.reload();
    expect(catalog.scanFailure).toBeNull();
  });
});
