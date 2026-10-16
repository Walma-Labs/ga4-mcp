# ga4-mcp — Google Analytics 4 MCP server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude, Cursor, Claude Code and any other MCP client access to Google Analytics 4: core, realtime, funnel and conversions reports, plus account and property information.

It is a TypeScript port of Google's own [analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp). It has the same nine tools, the same argument names and the same filter hints, so prompts written for one work on the other. What differs:

- **Service-account auth, no gcloud.** Point it at a key file, or pass the key inline. Nothing to log in to on the machine that runs the agent.
- **Streamable HTTP as well as stdio.** It can run centrally. This is how [Walma](https://walma.ai) serves it to whole organisations through its AI gateway.
- **Compact results.** Report rows come back as one object per row (`{ "country": "Sweden", "sessions": 120 }`) instead of parallel value arrays, so the model spends fewer tokens on the same data.
- **Three runtime dependencies.** It calls the REST API directly instead of using the gRPC client libraries and Google's agent framework.

Built and used by [Walma AI](https://walma.ai).

## Tools

| Tool | What it does |
|---|---|
| `get_account_summaries` | Accounts and properties the service account can read, with property IDs |
| `get_property_details` | Time zone, currency, industry and service level of a property |
| `list_google_ads_links` | Google Ads accounts linked to a property |
| `list_property_annotations` | Notes left on dates in GA4 (releases, campaigns, outages) |
| `get_custom_dimensions_and_metrics` | The property's custom definitions, with the `apiName` to report on |
| `run_report` | Data API report: any dimensions and metrics, filters, ordering, several date ranges, pagination |
| `run_realtime_report` | The last ~30 minutes |
| `run_funnel_report` | Funnel progression and abandonment, with breakdowns and next actions |
| `run_conversions_report` | Ad cost, ROAS and conversions with a chosen attribution model |

Everything is read-only (`analytics.readonly` scope). The server cannot change anything in Google Analytics.

## Setup

### 1. Create a service account and key

1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create a project.
2. Enable the **Google Analytics Data API** and the **Google Analytics Admin API**.
3. IAM & Admin → Service accounts → Create. No project roles are needed.
4. Keys → Add key → JSON. Save the file somewhere outside any repository, for example `~/.config/gcloud/ga4-service-account.json`.

### 2. Give the service account access in Google Analytics

In GA4, open **Admin → Property access management** (or Account access management to cover every property in the account). Add the service account's email address (`…@….iam.gserviceaccount.com`) with the **Viewer** role.

The server sees exactly the properties it was invited to.

### 3. Add it to your MCP client

**Claude Code:**

```sh
claude mcp add ga4 --scope user \
  -e GA4_SERVICE_ACCOUNT_FILE=~/.config/gcloud/ga4-service-account.json \
  -- npx -y github:Walma-Labs/ga4-mcp
```

**Claude Desktop, Cursor and others** (`mcpServers` in the client's config):

```json
{
  "mcpServers": {
    "ga4": {
      "command": "npx",
      "args": ["-y", "github:Walma-Labs/ga4-mcp"],
      "env": { "GA4_SERVICE_ACCOUNT_FILE": "/absolute/path/to/ga4-service-account.json" }
    }
  }
}
```

### Environment variables

| Variable | Meaning |
|---|---|
| `GA4_SERVICE_ACCOUNT_FILE` | Path to the service-account JSON key (`~` is expanded) |
| `GA4_SERVICE_ACCOUNT_JSON` | The key as inline JSON. Wins over the file when both are set |
| `PORT` | Port for the HTTP entrypoint (default `8080`) |

## Running over HTTP

```sh
npm install && npm run build
GA4_SERVICE_ACCOUNT_FILE=… npm run start:http
```

This starts a stateless streamable-HTTP endpoint on `POST /`, plus `GET /healthz`. **It has no authentication of its own.** Put it behind something that authenticates callers. In Walma's deployment, the gateway relay does that.

## Using it as a library

```ts
import { createGa4Server, createGa4Client } from "@walma-labs/ga4-mcp";

const client = createGa4Client();          // or createGa4Client(myRequestFn)
const server = createGa4Server(client);    // an McpServer; connect any transport
```

`createGa4Client` takes an optional request function, so you can supply your own authorisation or a test double.

## Development

```sh
npm install
npm test        # unit + MCP-wire tests against a mocked client, no network
npm run build
```

## License

Apache-2.0. Tool names, argument contracts and hint text derive from Google's [analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp); see `NOTICE`.
