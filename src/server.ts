// The MCP server factory: nine read-only Google Analytics tools on
// @modelcontextprotocol/sdk, with the same names and argument contract as
// Google's analytics-mcp. One implementation, three consumers — the stdio bin
// (local use), the standalone HTTP entrypoint, and the Walma MCP chassis
// (which imports createGa4Server and mounts it on a path).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createGa4Client, type Ga4Client } from "./ga4.js";
import {
  DATE_RANGES_HINTS, DIMENSION_FILTER_HINTS, FUNNEL_STEPS_HINTS, METRIC_FILTER_HINTS,
  ORDER_BYS_HINTS, PROPERTY_ID_DOC,
} from "./hints.js";
import {
  buildFunnelBody, buildReportBody, compactFunnel, compactTable, customDefinitions,
  propertyName, MAX_LIMIT,
} from "./logic.js";

export const VERSION = "0.1.0";

export const INSTRUCTIONS =
  "Google Analytics 4 data via service account (read-only). Call " +
  "get_account_summaries first to find property IDs. Use run_report for " +
  "traffic, engagement and events; run_conversions_report for ad cost, ROAS " +
  "and attribution; run_realtime_report for the last 30 minutes. Standard " +
  "data is usually complete after 24-48 hours, so recent days may still rise.";

const propertyId = z.union([z.string(), z.number()]).describe(PROPERTY_ID_DOC);
const obj = z.record(z.string(), z.any());
const dateRanges = z.array(obj)
  .describe("Date ranges: [{start_date, end_date, name?}]. Dates are YYYY-MM-DD, 'today', 'yesterday' or 'NdaysAgo'.");
const limit = z.number().int().optional()
  .describe(`Max rows per response, 1-${MAX_LIMIT}. Paginate with offset.`);
const offset = z.number().int().optional().describe("Row count of the start row (first row is 0).");
const quota = z.boolean().optional().describe("Include the property's quota usage in the response.");
const filters = {
  dimension_filter: obj.optional()
    .describe("Data API FilterExpression on dimensions. Don't use it for metrics; use metric_filter."),
  metric_filter: obj.optional()
    .describe("Data API FilterExpression on metrics. Don't use it for dimensions; use dimension_filter."),
  order_bys: z.array(obj).optional()
    .describe("Data API OrderBy objects; every field named must be in dimensions/metrics."),
};

/** JSON tool result in the shape MCP clients expect. */
function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const SCHEMA_URL = "https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema";
const REALTIME_SCHEMA_URL = "https://developers.google.com/analytics/devguides/reporting/data/v1/realtime-api-schema";

const REPORT_DESCRIPTION = `Runs a Google Analytics Data API report (sessions, users, page views, events, revenue, and so on).

Rows come back flattened: one object per row keyed by dimension and metric name, metrics as numbers.

## dimensions
Standard dimensions (${SCHEMA_URL}#dimensions) available to every property, or the property's custom dimensions from get_custom_dimensions_and_metrics.

## metrics
Standard metrics (${SCHEMA_URL}#metrics) available to every property, or the property's custom metrics from get_custom_dimensions_and_metrics.

## date_ranges
${DATE_RANGES_HINTS}

## dimension_filter
${DIMENSION_FILTER_HINTS}

## metric_filter
${METRIC_FILTER_HINTS}

## order_bys
${ORDER_BYS_HINTS}`;

const REALTIME_DESCRIPTION = `Runs a Google Analytics Data API realtime report covering roughly the last 30 minutes (https://developers.google.com/analytics/devguides/reporting/data/v1/realtime-basics).

## dimensions
Realtime dimensions (${REALTIME_SCHEMA_URL}#dimensions), or user-scoped custom dimensions: from get_custom_dimensions_and_metrics, those whose apiName begins with "customUser:".

## metrics
Realtime metrics only (${REALTIME_SCHEMA_URL}#metrics). Realtime reports can't use custom metrics.

## dimension_filter
${DIMENSION_FILTER_HINTS}

## metric_filter
${METRIC_FILTER_HINTS}

## order_bys
${ORDER_BYS_HINTS}`;

const CONVERSION_DIMENSIONS = ["campaignName", "continent", "country", "defaultChannelGroup", "deviceCategory",
  "medium", "platform", "primaryChannelGroup", "source", "sourceMedium", "sourcePlatform", "subcontinent"];
const CONVERSION_METRICS = ["advertiserAdClicks", "advertiserAdCost",
  "advertiserAdCostPerAllConversionsByConversionDate", "advertiserAdCostPerAllConversionsByInteractionDate",
  "advertiserAdCostPerClick", "advertiserAdImpressions", "allConversionsByConversionDate",
  "allConversionsByInteractionDate", "returnOnAdSpendByConversionDate", "returnOnAdSpendByInteractionDate",
  "totalRevenueByConversionDate", "totalRevenueByInteractionDate"];

const CONVERSIONS_DESCRIPTION = `Runs a Google Analytics Data API conversions report.

USE THIS TOOL INSTEAD OF run_report WHEN:
- You need to report on conversions, ad performance, return on ad spend (ROAS) or attribution.
- You need conversion metrics such as advertiserAdCost, returnOnAdSpendByInteractionDate or allConversionsByConversionDate.
- You need a specific attribution model (DATA_DRIVEN or LAST_CLICK).
- The question is explicitly about conversions, ad clicks, ad costs, or campaigns related to conversions.

See https://developers.google.com/analytics/devguides/reporting/data/v1/conversions-api-basics.

## dimensions
Only these standard dimensions: ${CONVERSION_DIMENSIONS.join(", ")}.

## metrics
Only these standard metrics: ${CONVERSION_METRICS.join(", ")}.

## conversion_spec
Required. Pass an empty conversion_actions list for all conversion events:
{"conversion_actions": ["conversionActions/12345"], "attribution_model": "DATA_DRIVEN"}  (or [] / "LAST_CLICK")

## date_ranges
${DATE_RANGES_HINTS}

## dimension_filter
${DIMENSION_FILTER_HINTS}

## metric_filter
${METRIC_FILTER_HINTS}

## order_bys
${ORDER_BYS_HINTS}`;

const FUNNEL_DESCRIPTION = `Runs a Google Analytics Data API funnel report (https://developers.google.com/analytics/devguides/reporting/data/v1/funnels).

Returns funnel_table (progression through the steps) and funnel_visualization, both flattened to one object per row.

## funnel_steps
Each step is {name, filter_expression} or the shorthand {name, event}.
${FUNNEL_STEPS_HINTS}

## funnel_breakdown
Segment the funnel by a dimension: {"breakdown_dimension": "deviceCategory"}. Common: deviceCategory, country, operatingSystem, browser.

## funnel_next_action
What users do after completing or dropping off: {"next_action_dimension": "eventName", "limit": 5}. Common: eventName, pagePath.

## segments
Data API Segment objects (https://developers.google.com/analytics/devguides/reporting/data/v1/funnels#segments).

## date_ranges
${DATE_RANGES_HINTS}`;

export function createGa4Server(client: Ga4Client = createGa4Client()): McpServer {
  const server = new McpServer(
    { name: "ga4", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool("get_account_summaries", {
    description: "List the Google Analytics accounts and properties the service account can read, with property IDs.",
    inputSchema: {},
  }, async () => {
    const summaries = await client.listAccountSummaries();
    return jsonResult(summaries.map((a: any) => ({
      account: a.account,
      displayName: a.displayName,
      properties: (a.propertySummaries ?? []).map((p: any) => ({
        property: p.property,
        displayName: p.displayName,
        propertyType: p.propertyType,
        parent: p.parent,
      })),
    })));
  });

  server.registerTool("get_property_details", {
    description: "Return details about a property: time zone, currency, industry, service level, create time.",
    inputSchema: { property_id: propertyId },
  }, async (args) => jsonResult(await client.getProperty(propertyName(args.property_id))));

  server.registerTool("list_google_ads_links", {
    description: "List the Google Ads accounts linked to a property.",
    inputSchema: { property_id: propertyId },
  }, async (args) => jsonResult(await client.listGoogleAdsLinks(propertyName(args.property_id))));

  server.registerTool("list_property_annotations", {
    description:
      "List a property's annotations: notes left in GA4 on specific dates or periods, typically for " +
      "releases, campaign launches or changes, and traffic jumps or drops with an external cause.",
    inputSchema: { property_id: propertyId },
  }, async (args) => jsonResult(await client.listAnnotations(propertyName(args.property_id))));

  server.registerTool("get_custom_dimensions_and_metrics", {
    description: "Return the property's custom dimensions and metrics, with the apiName to use in reports.",
    inputSchema: { property_id: propertyId },
  }, async (args) => {
    const property = propertyName(args.property_id);
    return jsonResult(customDefinitions(await client.getMetadata(property)));
  });

  server.registerTool("run_report", {
    description: REPORT_DESCRIPTION,
    inputSchema: {
      property_id: propertyId,
      date_ranges: dateRanges,
      dimensions: z.array(z.string()),
      metrics: z.array(z.string()),
      ...filters,
      limit,
      offset,
      currency_code: z.string().optional().describe("ISO 4217, e.g. SEK. Defaults to the property's currency."),
      return_property_quota: quota,
    },
  }, async (args) => {
    const resp = await client.runReport(propertyName(args.property_id), buildReportBody(args));
    return jsonResult(compactTable(resp));
  });

  server.registerTool("run_realtime_report", {
    description: REALTIME_DESCRIPTION,
    inputSchema: {
      property_id: propertyId,
      dimensions: z.array(z.string()),
      metrics: z.array(z.string()),
      ...filters,
      limit,
      offset,
      return_property_quota: quota,
    },
  }, async (args) => {
    const resp = await client.runRealtimeReport(propertyName(args.property_id), buildReportBody(args));
    return jsonResult(compactTable(resp));
  });

  server.registerTool("run_funnel_report", {
    description: FUNNEL_DESCRIPTION,
    inputSchema: {
      property_id: propertyId,
      funnel_steps: z.array(obj),
      date_ranges: dateRanges.optional(),
      funnel_breakdown: z.object({ breakdown_dimension: z.string() }).optional(),
      funnel_next_action: z.object({ next_action_dimension: z.string(), limit: z.number().int().optional() }).optional(),
      segments: z.array(obj).optional(),
      return_property_quota: quota,
    },
  }, async (args) => {
    const resp = await client.runFunnelReport(propertyName(args.property_id), buildFunnelBody(args));
    return jsonResult(compactFunnel(resp));
  });

  server.registerTool("run_conversions_report", {
    description: CONVERSIONS_DESCRIPTION,
    inputSchema: {
      property_id: propertyId,
      date_ranges: dateRanges,
      dimensions: z.array(z.string()),
      metrics: z.array(z.string()),
      conversion_spec: obj.describe("{conversion_actions: string[], attribution_model: 'DATA_DRIVEN' | 'LAST_CLICK'}"),
      ...filters,
      limit,
      offset,
      currency_code: z.string().optional(),
      return_property_quota: quota,
    },
  }, async (args) => {
    const resp = await client.runConversionsReport(propertyName(args.property_id), buildReportBody(args));
    return jsonResult(compactTable(resp));
  });

  return server;
}
