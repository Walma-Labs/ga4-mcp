// Server tests: drive the real MCP wire (in-memory transport) against a mocked
// GA4 client — proves tool registration, zod schemas, request-body shape sent
// to Google, and response mapping, all without network or credentials.

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGa4Server } from "../src/server.js";
import { createGa4Client, type Ga4Client, type RequestFn } from "../src/ga4.js";

const REPORT = {
  dimensionHeaders: [{ name: "sessionSourceMedium" }],
  metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }],
  rows: [{ dimensionValues: [{ value: "google / organic" }], metricValues: [{ value: "42" }] }],
  rowCount: 1,
};

function fixture() {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec = (name: string, result: unknown) => async (...args: unknown[]) => {
    calls.push([name, ...args]);
    return result;
  };
  const client: Ga4Client = {
    listAccountSummaries: rec("listAccountSummaries", [{
      account: "accounts/1", displayName: "Walma",
      propertySummaries: [{ property: "properties/475852940", displayName: "Hemsida", propertyType: "PROPERTY_TYPE_ORDINARY" }],
    }]) as any,
    getProperty: rec("getProperty", { name: "properties/475852940", timeZone: "Europe/Stockholm" }),
    listGoogleAdsLinks: rec("listGoogleAdsLinks", []) as any,
    listAnnotations: rec("listAnnotations", [{ title: "Launch" }]) as any,
    getMetadata: rec("getMetadata", { dimensions: [{ apiName: "customEvent:plan", customDefinition: true }], metrics: [] }),
    runReport: rec("runReport", REPORT),
    runRealtimeReport: rec("runRealtimeReport", REPORT),
    runFunnelReport: rec("runFunnelReport", { funnelTable: REPORT, funnelVisualization: {} }),
    runConversionsReport: rec("runConversionsReport", REPORT),
  };
  return { client, calls };
}

async function connect(ga4: Ga4Client) {
  const server = createGa4Server(ga4);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), mcp.connect(clientT)]);
  return mcp;
}

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("ga4 MCP server", () => {
  it("registers Google's nine tools under the same names", async () => {
    const mcp = await connect(fixture().client);
    const { tools } = await mcp.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      "get_account_summaries", "get_custom_dimensions_and_metrics", "get_property_details",
      "list_google_ads_links", "list_property_annotations", "run_conversions_report",
      "run_funnel_report", "run_realtime_report", "run_report",
    ]);
    const report = tools.find(t => t.name === "run_report")!;
    expect(report.inputSchema.required).toEqual(
      expect.arrayContaining(["property_id", "date_ranges", "dimensions", "metrics"]),
    );
    expect(report.description).toContain("BEGINS_WITH");
  });

  it("summarises accounts and properties", async () => {
    const mcp = await connect(fixture().client);
    const out = parse(await mcp.callTool({ name: "get_account_summaries", arguments: {} }));
    expect(out[0].properties[0]).toMatchObject({ property: "properties/475852940", displayName: "Hemsida" });
  });

  it("run_report sends a REST body and returns flattened rows", async () => {
    const { client, calls } = fixture();
    const mcp = await connect(client);
    const out = parse(await mcp.callTool({
      name: "run_report",
      arguments: {
        property_id: 475852940,
        date_ranges: [{ start_date: "7daysAgo", end_date: "yesterday" }],
        dimensions: ["sessionSourceMedium"],
        metrics: ["sessions"],
        dimension_filter: { filter: { field_name: "sessionMedium", string_filter: { match_type: "EXACT", value: "organic" } } },
      },
    }));
    expect(calls[0]).toEqual(["runReport", "properties/475852940", {
      dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "sessionSourceMedium" }],
      metrics: [{ name: "sessions" }],
      dimensionFilter: { filter: { fieldName: "sessionMedium", stringFilter: { matchType: "EXACT", value: "organic" } } },
    }]);
    expect(out.rows).toEqual([{ sessionSourceMedium: "google / organic", sessions: 42 }]);
  });

  it("routes conversions and funnels to their own endpoints", async () => {
    const { client, calls } = fixture();
    const mcp = await connect(client);
    await mcp.callTool({
      name: "run_conversions_report",
      arguments: {
        property_id: "properties/1", date_ranges: [{ start_date: "28daysAgo", end_date: "yesterday" }],
        dimensions: ["campaignName"], metrics: ["advertiserAdCost"],
        conversion_spec: { conversion_actions: [], attribution_model: "DATA_DRIVEN" },
      },
    });
    const funnel = parse(await mcp.callTool({
      name: "run_funnel_report",
      arguments: { property_id: 1, funnel_steps: [{ name: "Visit", event: "session_start" }] },
    }));
    expect(calls.map(c => c[0])).toEqual(["runConversionsReport", "runFunnelReport"]);
    expect((calls[0]![2] as any).conversionSpec).toEqual({ conversionActions: [], attributionModel: "DATA_DRIVEN" });
    expect(funnel.funnelTable.rows).toHaveLength(1);
  });

  it("reports a bad property ID as a tool error, not a crash", async () => {
    const mcp = await connect(fixture().client);
    const r: any = await mcp.callTool({ name: "get_property_details", arguments: { property_id: "G-XYZ" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Invalid property ID/);
  });
});

describe("createGa4Client", () => {
  it("hits the right API versions and follows pagination", async () => {
    const seen: string[] = [];
    const request: RequestFn = async ({ url }) => {
      seen.push(url);
      if (url.includes("accountSummaries") && !url.includes("pageToken")) {
        return { data: { accountSummaries: [{ account: "accounts/1" }], nextPageToken: "p2" } };
      }
      if (url.includes("accountSummaries")) return { data: { accountSummaries: [{ account: "accounts/2" }] } };
      return { data: {} };
    };
    const c = createGa4Client(request);
    expect((await c.listAccountSummaries()).map(a => a.account)).toEqual(["accounts/1", "accounts/2"]);
    await c.runReport("properties/1", {});
    await c.runFunnelReport("properties/1", {});
    await c.runConversionsReport("properties/1", {});
    await c.listAnnotations("properties/1");
    expect(seen.slice(2)).toEqual([
      "https://analyticsdata.googleapis.com/v1beta/properties/1:runReport",
      "https://analyticsdata.googleapis.com/v1alpha/properties/1:runFunnelReport",
      "https://analyticsdata.googleapis.com/v1alpha/properties/1:runReport",
      "https://analyticsadmin.googleapis.com/v1alpha/properties/1/reportingDataAnnotations",
    ]);
    expect(seen[1]).toContain("pageToken=p2");
  });
});
