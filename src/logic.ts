// Pure logic, no I/O: argument normalisation into REST request bodies, and
// response compaction. Unit-tested on its own.
//
// Argument contract matches Google's analytics-mcp (snake_case, protobuf
// style) so its hints and any prompts written against it keep working. The
// REST API wants camelCase, so keys are converted on the way out; camelCase
// input passes through unchanged, so both styles are accepted.

export function propertyName(value: string | number): string {
  const s = String(value).trim();
  const num = /^\d+$/.test(s) ? s : /^properties\/\d+$/.test(s) ? s.split("/")[1] : null;
  if (!num) {
    throw new Error(
      `Invalid property ID: ${value}. A valid property value is either a number ` +
      "or a string starting with 'properties/' and followed by a number.",
    );
  }
  return `properties/${num}`;
}

const snakeToCamel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Deep-convert object KEYS from snake_case to camelCase. Values are untouched,
 *  so field names ("eventName") and enums ("BEGINS_WITH") survive as given. */
export function camelKeys<T = unknown>(value: T): T {
  if (Array.isArray(value)) return value.map(camelKeys) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [snakeToCamel(k), camelKeys(v)]),
    ) as T;
  }
  return value;
}

export interface ReportArgs {
  date_ranges?: Record<string, unknown>[];
  dimensions?: string[];
  metrics?: string[];
  dimension_filter?: Record<string, unknown>;
  metric_filter?: Record<string, unknown>;
  order_bys?: Record<string, unknown>[];
  limit?: number;
  offset?: number;
  currency_code?: string;
  return_property_quota?: boolean;
  conversion_spec?: Record<string, unknown>;
}

export const MAX_LIMIT = 250_000;

/** Build a runReport / runRealtimeReport body from tool arguments. */
export function buildReportBody(args: ReportArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    dimensions: (args.dimensions ?? []).map(name => ({ name })),
    metrics: (args.metrics ?? []).map(name => ({ name })),
  };
  if (args.date_ranges?.length) body.dateRanges = camelKeys(args.date_ranges);
  if (args.dimension_filter) body.dimensionFilter = camelKeys(args.dimension_filter);
  if (args.metric_filter) body.metricFilter = camelKeys(args.metric_filter);
  if (args.order_bys?.length) body.orderBys = camelKeys(args.order_bys);
  if (args.limit) {
    if (args.limit < 1 || args.limit > MAX_LIMIT) throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
    body.limit = String(args.limit);
  }
  if (args.offset) body.offset = String(Math.max(0, args.offset));
  if (args.currency_code) body.currencyCode = args.currency_code;
  if (args.conversion_spec) body.conversionSpec = camelKeys(args.conversion_spec);
  if (args.return_property_quota) body.returnPropertyQuota = true;
  return body;
}

export interface FunnelArgs {
  funnel_steps: Record<string, any>[];
  date_ranges?: Record<string, unknown>[];
  funnel_breakdown?: { breakdown_dimension?: string };
  funnel_next_action?: { next_action_dimension?: string; limit?: number };
  segments?: Record<string, unknown>[];
  return_property_quota?: boolean;
}

/** Build a runFunnelReport body. A step is either {name, filter_expression}
 *  or the shorthand {name, event}. */
export function buildFunnelBody(args: FunnelArgs): Record<string, unknown> {
  if (!args.funnel_steps?.length) throw new Error("funnel_steps must contain at least one step");
  const steps = args.funnel_steps.map((step, i) => {
    if (!step || typeof step !== "object") throw new Error(`Step ${i + 1} must be an object`);
    const name = step.name ?? `Step ${i + 1}`;
    const expr = step.filter_expression ?? step.filterExpression;
    if (expr) return { name, filterExpression: camelKeys(expr) };
    if (step.event) return { name, filterExpression: { funnelEventFilter: { eventName: step.event } } };
    throw new Error(`Step ${i + 1} must contain either 'filter_expression' or 'event'`);
  });
  const body: Record<string, unknown> = { funnel: { steps } };
  if (args.date_ranges?.length) body.dateRanges = camelKeys(args.date_ranges);
  if (args.funnel_breakdown?.breakdown_dimension) {
    body.funnelBreakdown = { breakdownDimension: { name: args.funnel_breakdown.breakdown_dimension } };
  }
  if (args.funnel_next_action?.next_action_dimension) {
    const next: Record<string, unknown> = {
      nextActionDimension: { name: args.funnel_next_action.next_action_dimension },
    };
    if (args.funnel_next_action.limit) next.limit = String(args.funnel_next_action.limit);
    body.funnelNextAction = next;
  }
  if (args.segments?.length) body.segments = camelKeys(args.segments);
  if (args.return_property_quota) body.returnPropertyQuota = true;
  return body;
}

const NUMERIC = new Set(["TYPE_INTEGER", "TYPE_FLOAT", "TYPE_SECONDS", "TYPE_MILLISECONDS",
  "TYPE_MINUTES", "TYPE_HOURS", "TYPE_STANDARD", "TYPE_CURRENCY", "TYPE_FEET", "TYPE_MILES",
  "TYPE_METERS", "TYPE_KILOMETERS"]);

/**
 * Flatten a Data API report (rows of parallel value arrays) into one object
 * per row keyed by header name, with numeric metrics as numbers. A report
 * over several date ranges carries a `dateRange` dimension, which survives
 * as an ordinary key. Far fewer tokens than the raw shape, same information.
 */
export function compactTable(resp: any): Record<string, unknown> {
  const dims: string[] = (resp?.dimensionHeaders ?? []).map((h: any) => h.name);
  // The funnel endpoint repeats its metric headers (each name twice) while rows
  // carry one value per distinct metric, so keep only first occurrences.
  const mets: { name: string; type?: string }[] = (resp?.metricHeaders ?? [])
    .filter((h: any, i: number, all: any[]) => all.findIndex(o => o.name === h.name) === i)
    .map((h: any) => ({ name: h.name, type: h.type }));
  const toRow = (r: any) => {
    const row: Record<string, unknown> = {};
    dims.forEach((d, i) => { row[d] = r.dimensionValues?.[i]?.value ?? null; });
    mets.forEach((m, i) => {
      const v = r.metricValues?.[i]?.value;
      row[m.name] = v != null && (!m.type || NUMERIC.has(m.type)) && v !== "" && !isNaN(Number(v)) ? Number(v) : v ?? null;
    });
    return row;
  };
  const out: Record<string, unknown> = {
    rowCount: resp?.rowCount ?? (resp?.rows ?? []).length,
    dimensions: dims,
    metrics: mets.map(m => m.name),
    rows: (resp?.rows ?? []).map(toRow),
  };
  for (const k of ["totals", "maximums", "minimums"] as const) {
    if (resp?.[k]?.length) out[k] = resp[k].map(toRow);
  }
  if (resp?.metadata && Object.keys(resp.metadata).length) out.metadata = resp.metadata;
  if (resp?.propertyQuota) out.propertyQuota = resp.propertyQuota;
  return out;
}

export function compactFunnel(resp: any): Record<string, unknown> {
  const out: Record<string, unknown> = {
    funnelTable: compactTable(resp?.funnelTable),
    funnelVisualization: compactTable(resp?.funnelVisualization),
  };
  if (resp?.propertyQuota) out.propertyQuota = resp.propertyQuota;
  return out;
}

/** Keep only the property's custom definitions from a metadata response. */
export function customDefinitions(meta: any): { custom_dimensions: any[]; custom_metrics: any[] } {
  return {
    custom_dimensions: (meta?.dimensions ?? []).filter((d: any) => d.customDefinition),
    custom_metrics: (meta?.metrics ?? []).filter((m: any) => m.customDefinition),
  };
}
