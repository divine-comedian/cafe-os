import { afterEach, describe, expect, it } from "vitest";
import { IDS } from "../src/fixtures.ts";
import { MockCafeApi } from "../src/mock-api.ts";
let api: MockCafeApi | undefined;
afterEach(async () => api?.stop());

describe("MockCafeApi", () => {
  it("filters reads, records creates, and enforces dependencies", async () => {
    api = new MockCafeApi();
    const base = await api.start();
    const headers = { authorization: `Bearer ${api.token}`, "content-type": "application/json" };
    const drafts = await fetch(`${base}/v1/purchases?provider_id=${IDS.cafeSierra}&status=draft`, { headers });
    expect((await drafts.json()).data).toHaveLength(1);
    const created = await fetch(`${base}/v1/providers`, { method: "POST", headers, body: JSON.stringify({ name: " Cooperativa Nube ", region: " OAXACA ", notes: " expo " }) });
    expect(await created.json()).toMatchObject({ data: { name: "Cooperativa Nube", region: "oaxaca" } });
    const deletion = await fetch(`${base}/v1/providers/${IDS.cafeSierra}`, { method: "DELETE", headers });
    expect(deletion.status).toBe(409);
    expect((await deletion.json()).error).toMatchObject({ code: "DEPENDENCY_CONFLICT", dependencies: { purchases: 2 } });
  });
});
