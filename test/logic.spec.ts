import { describe, it, expect } from "vitest";
import {
  buildFunnelBody, buildReportBody, camelKeys, compactTable, customDefinitions, propertyName,
} from "../src/logic.js";

describe("propertyName", () => {
  it("accepts numbers, digit strings and resource names", () => {
    expect(propertyName(123)).toBe("properties/123");
    expect(propertyName(" 456 ")).toBe("properties/456");
    expect(propertyName("properties/789")).toBe("properties/789");
  });
  it("rejects anything else", () => {
    expect(() => propertyName("G-ABC123")).toThrow(/Invalid property ID/);
    expect(() => propertyName("properties/abc")).toThrow();
    expect(() => propertyName("accounts/1")).toThrow();
  });
});

describe("camelKeys", () => {
  it("converts keys deeply but never values", () => {
    expect(camelKeys({
      and_group: { expressions: [{ filter: { field_name: "event_name", string_filter: { match_type: "BEGINS_WITH" } } }] },
    })).toEqual({
      andGroup: { expressions: [{ filter: { fieldName: "event_name", stringFilter: { matchType: "BEGINS_WITH" } } }] },
    });
  });
  it("leaves camelCase input unchanged", () => {
    const v = { notExpression: { filter: { fieldName: "x", int64Value: "10" } } };
    expect(camelKeys(v)).toEqual(v);
  });
});

describe("buildReportBody", () => {
  it("maps the argument contract to the REST body", () => {
    expect(buildReportBody({
      date_ranges: [{ start_date: "30daysAgo", end_date: "yesterday" }],
      dimensions: ["country"],
      metrics: ["sessions"],
      order_bys: [{ metric: { metric_name: "sessions" }, desc: true }],
      limit: 10,
      offset: 20,
      currency_code: "SEK",
      return_property_quota: true,
    })).toEqual({
      dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "country" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: "10",
      offset: "20",
      currencyCode: "SEK",
      returnPropertyQuota: true,
    });
  });
  it("omits what was not asked for", () => {
    expect(buildReportBody({ dimensions: [], metrics: ["activeUsers"] }))
      .toEqual({ dimensions: [], metrics: [{ name: "activeUsers" }] });
  });
  it("rejects an out-of-range limit", () => {
    expect(() => buildReportBody({ metrics: ["sessions"], limit: 300_000 })).toThrow(/limit/);
  });
  it("carries a conversion spec", () => {
    expect(buildReportBody({ metrics: ["advertiserAdCost"], conversion_spec: { conversion_actions: [], attribution_model: "LAST_CLICK" } }).conversionSpec)
      .toEqual({ conversionActions: [], attributionModel: "LAST_CLICK" });
  });
});

describe("buildFunnelBody", () => {
  it("expands the event shorthand and converts full expressions", () => {
    const body = buildFunnelBody({
      funnel_steps: [
        { name: "Start", event: "session_start" },
        { name: "Lead", filter_expression: { funnel_event_filter: { event_name: "generate_lead" } } },
      ],
      date_ranges: [{ start_date: "28daysAgo", end_date: "yesterday" }],
      funnel_breakdown: { breakdown_dimension: "deviceCategory" },
      funnel_next_action: { next_action_dimension: "eventName", limit: 5 },
    });
    expect(body).toEqual({
      funnel: {
        steps: [
          { name: "Start", filterExpression: { funnelEventFilter: { eventName: "session_start" } } },
          { name: "Lead", filterExpression: { funnelEventFilter: { eventName: "generate_lead" } } },
        ],
      },
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      funnelBreakdown: { breakdownDimension: { name: "deviceCategory" } },
      funnelNextAction: { nextActionDimension: { name: "eventName" }, limit: "5" },
    });
  });
  it("names unnamed steps and rejects empty or malformed ones", () => {
    expect((buildFunnelBody({ funnel_steps: [{ event: "a" }] }).funnel as any).steps[0].name).toBe("Step 1");
    expect(() => buildFunnelBody({ funnel_steps: [] })).toThrow(/at least one/);
    expect(() => buildFunnelBody({ funnel_steps: [{ name: "x" }] })).toThrow(/Step 1/);
  });
});

describe("compactTable", () => {
  const resp = {
    dimensionHeaders: [{ name: "country" }],
    metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }, { name: "bounceRate", type: "TYPE_FLOAT" }],
    rows: [
      { dimensionValues: [{ value: "Sweden" }], metricValues: [{ value: "120" }, { value: "0.41" }] },
      { dimensionValues: [{ value: "Norway" }], metricValues: [{ value: "8" }, { value: "0.5" }] },
    ],
    totals: [{ dimensionValues: [{ value: "RESERVED_TOTAL" }], metricValues: [{ value: "128" }, { value: "0.42" }] }],
    rowCount: 2,
    metadata: { currencyCode: "SEK", timeZone: "Europe/Stockholm" },
  };
  it("flattens rows into objects with numeric metrics", () => {
    const out = compactTable(resp);
    expect(out.rows).toEqual([
      { country: "Sweden", sessions: 120, bounceRate: 0.41 },
      { country: "Norway", sessions: 8, bounceRate: 0.5 },
    ]);
    expect(out.rowCount).toBe(2);
    expect(out.totals).toEqual([{ country: "RESERVED_TOTAL", sessions: 128, bounceRate: 0.42 }]);
    expect(out.metadata).toEqual(resp.metadata);
  });
  it("collapses the funnel endpoint's duplicated metric headers", () => {
    const out = compactTable({
      dimensionHeaders: [{ name: "funnelStepName" }],
      metricHeaders: [{ name: "activeUsers", type: "TYPE_INTEGER" }, { name: "activeUsers", type: "TYPE_INTEGER" }],
      rows: [{ dimensionValues: [{ value: "1. Visit" }], metricValues: [{ value: "805" }] }],
    });
    expect(out.metrics).toEqual(["activeUsers"]);
    expect(out.rows).toEqual([{ funnelStepName: "1. Visit", activeUsers: 805 }]);
  });
  it("survives an empty report", () => {
    expect(compactTable({})).toEqual({ rowCount: 0, dimensions: [], metrics: [], rows: [] });
  });
});

describe("customDefinitions", () => {
  it("keeps only custom definitions", () => {
    expect(customDefinitions({
      dimensions: [{ apiName: "country" }, { apiName: "customEvent:plan", customDefinition: true }],
      metrics: [{ apiName: "sessions" }],
    })).toEqual({ custom_dimensions: [{ apiName: "customEvent:plan", customDefinition: true }], custom_metrics: [] });
  });
});
