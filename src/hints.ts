// Argument hints embedded in the tool descriptions. Ported from Google's
// analytics-mcp (reporting/metadata.py, Apache-2.0) — the examples are what
// make the model produce valid FilterExpressions on the first try, so they
// are kept close to the original. Keys are snake_case to match the argument
// contract; the server converts them for the REST API.

const j = (v: unknown) => JSON.stringify(v);

const JAN = { start_date: "2025-01-01", end_date: "2025-01-31", name: "Jan2025" };
const FEB = { start_date: "2025-02-01", end_date: "2025-02-28", name: "Feb2025" };

export const DATE_RANGES_HINTS = `Example date_ranges arguments:
  1. A single date range: [ ${j(JAN)} ]
  2. A relative date range using 'yesterday' and 'today': [ ${j({ start_date: "yesterday", end_date: "today", name: "YesterdayAndToday" })} ]
  3. A relative date range using 'NdaysAgo': [ ${j({ start_date: "30daysAgo", end_date: "yesterday", name: "Previous30Days" })} ]
  4. Multiple date ranges (adds a 'dateRange' column to every row): [ ${j(JAN)}, ${j(FEB)} ]`;

const FILTER_NOTES = `
Notes:
  The API applies dimension_filter and metric_filter independently, so some
  combinations are impossible in one request, e.g.
  ((eventName = "page_view" AND eventCount > 100) OR (eventName = "join_group" AND eventCount < 50)).
  For conditions shaped ((D1 AND M1) OR (D2 AND M2)) either:
  a) run one report filtering on the supported subset (eventName in
     ["page_view","join_group"]) with eventCount included, and apply the metric
     conditions to the rows yourself; or
  b) run one report per (dimension condition, metric condition) pair.
  Prefer (a) — fewer reports — unless it would use excessive quota
  (https://developers.google.com/analytics/blog/2023/data-api-quota-management).`;

const EVENT_COUNT_GT_10 = {
  filter: { field_name: "eventCount", numeric_filter: { operation: "GREATER_THAN", value: { int64_value: "10" } } },
};
const REVENUE_BETWEEN = {
  filter: {
    field_name: "purchaseRevenue",
    between_filter: { from_value: { double_value: 10 }, to_value: { double_value: 25 } },
  },
};

export const METRIC_FILTER_HINTS = `Example metric_filter arguments:
  1. A simple filter: ${j(EVENT_COUNT_GT_10)}
  2. A NOT filter: ${j({ not_expression: EVENT_COUNT_GT_10 })}
  3. An empty value filter: ${j({ filter: { field_name: "purchaseRevenue", empty_filter: {} } })}
  4. An AND group filter: ${j({ and_group: { expressions: [EVENT_COUNT_GT_10, REVENUE_BETWEEN] } })}
  5. An OR group filter: ${j({ or_group: { expressions: [EVENT_COUNT_GT_10, REVENUE_BETWEEN] } })}
${FILTER_NOTES}`;

const BEGINS_WITH = {
  filter: { field_name: "eventName", string_filter: { match_type: "BEGINS_WITH", value: "add" } },
};
const SOURCE_MEDIUM = {
  filter: { field_name: "sourceMedium", string_filter: { match_type: "EXACT", value: "google / cpc" } },
};
const EVENT_LIST = {
  filter: {
    field_name: "eventName",
    in_list_filter: { case_sensitive: true, values: ["first_visit", "purchase", "add_to_cart"] },
  },
};

export const DIMENSION_FILTER_HINTS = `Example dimension_filter arguments:
  1. A simple filter: ${j(BEGINS_WITH)}
  2. A NOT filter: ${j({ not_expression: BEGINS_WITH })}
  3. An empty value filter: ${j({ filter: { field_name: "source", empty_filter: {} } })}
  4. An AND group filter: ${j({ and_group: { expressions: [SOURCE_MEDIUM, EVENT_LIST] } })}
  5. An OR group filter: ${j({ or_group: { expressions: [SOURCE_MEDIUM, EVENT_LIST] } })}
${FILTER_NOTES}`;

const BY_EVENT_NAME = { dimension: { dimension_name: "eventName", order_type: "ALPHANUMERIC" }, desc: false };
const BY_AUDIENCE = { dimension: { dimension_name: "audienceId", order_type: "NUMERIC" }, desc: false };
const BY_EVENT_COUNT_DESC = { metric: { metric_name: "eventCount" }, desc: true };

export const ORDER_BYS_HINTS = `Example order_bys arguments:
  1. Ascending 'eventName': [ ${j(BY_EVENT_NAME)} ]
  2. Descending 'campaignName', ignoring case: [ ${j({ dimension: { dimension_name: "campaignName", order_type: "CASE_INSENSITIVE_ALPHANUMERIC" }, desc: true })} ]
  3. Ascending 'audienceId' (numeric): [ ${j(BY_AUDIENCE)} ]
  4. Descending 'eventCount': [ ${j(BY_EVENT_COUNT_DESC)} ]
  5. Ascending 'eventCount': [ ${j({ metric: { metric_name: "eventCount" }, desc: false })} ]
  6. Dimension and metric combined: [ ${j(BY_EVENT_NAME)}, ${j(BY_EVENT_COUNT_DESC)} ]
  7. Several dimensions and metrics: [ ${j(BY_EVENT_NAME)}, ${j(BY_AUDIENCE)}, ${j(BY_EVENT_COUNT_DESC)} ]
The dimensions and metrics in order_bys must also be in the request's dimensions and metrics.`;

const ev = (event_name: string) => ({ funnel_event_filter: { event_name } });
const STEP_FIRST_OPEN = { name: "First open/visit", filter_expression: { or_group: { expressions: [ev("first_open"), ev("first_visit")] } } };
const STEP_ORGANIC = {
  name: "Organic visitors",
  filter_expression: {
    funnel_field_filter: {
      field_name: "firstUserMedium",
      string_filter: { match_type: "CONTAINS", case_sensitive: false, value: "organic" },
    },
  },
};
const STEP_SESSION = { name: "Session start", filter_expression: ev("session_start") };
const STEP_PAGE_VIEW = { name: "Screen/Page view", filter_expression: { or_group: { expressions: [ev("screen_view"), ev("page_view")] } } };
const STEP_PURCHASE = { name: "Purchase", filter_expression: { or_group: { expressions: [ev("purchase"), ev("in_app_purchase")] } } };

export const FUNNEL_STEPS_HINTS = `Example funnel_steps configurations:
  1. Shorthand event step: ${j({ name: "Session start", event: "session_start" })}
  2. Several events with OR: ${j(STEP_FIRST_OPEN)}
  3. Field filter for organic traffic: ${j(STEP_ORGANIC)}
  4. Event with a parameter filter (value > 50): ${j({
    name: "Add to cart (value > 50)",
    filter_expression: {
      funnel_event_filter: {
        event_name: "add_to_cart",
        funnel_parameter_filter_expression: {
          funnel_parameter_filter: {
            event_parameter_name: "value",
            numeric_filter: { operation: "GREATER_THAN", value: { double_value: 50 } },
          },
        },
      },
    },
  })}
  5. AND condition (page view on a path): ${j({
    name: "Home page view",
    filter_expression: {
      and_group: {
        expressions: [ev("page_view"), { funnel_field_filter: { field_name: "pageLocation", string_filter: { match_type: "CONTAINS", value: "/" } } }],
      },
    },
  })}

A typical e-commerce funnel: [ ${[STEP_FIRST_OPEN, STEP_ORGANIC, STEP_SESSION, STEP_PAGE_VIEW, STEP_PURCHASE].map(j).join(", ")} ]`;

export const PROPERTY_ID_DOC =
  "The Google Analytics property ID: a number, or 'properties/' followed by a number. " +
  "Use get_account_summaries to find it.";
