// Google Analytics client: service-account auth + the REST calls the tools
// need. Deliberately NOT the @google-analytics/* gRPC packages — nine
// endpoints don't justify them, and a thin client keeps the request function
// injectable for tests and for the Walma MCP chassis.
//
// Auth (either works; JSON wins when both are set):
//   GA4_SERVICE_ACCOUNT_JSON  — the key as inline JSON (Key Vault / chassis path)
//   GA4_SERVICE_ACCOUNT_FILE  — path to the key file (local / CLI path)
//
// Scope is read-only by design: the server cannot change anything in
// Google Analytics.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { JWT } from "google-auth-library";

export const SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"];

const DATA_BETA = "https://analyticsdata.googleapis.com/v1beta";
const DATA_ALPHA = "https://analyticsdata.googleapis.com/v1alpha";
const ADMIN_BETA = "https://analyticsadmin.googleapis.com/v1beta";
const ADMIN_ALPHA = "https://analyticsadmin.googleapis.com/v1alpha";

/** Minimal authorized-request signature — what tests and the chassis inject. */
export type RequestFn = (opts: {
  url: string;
  method: "GET" | "POST";
  data?: unknown;
}) => Promise<{ data: any }>;

/** Every method takes a property resource name ("properties/123"). */
export interface Ga4Client {
  listAccountSummaries(): Promise<any[]>;
  getProperty(property: string): Promise<any>;
  listGoogleAdsLinks(property: string): Promise<any[]>;
  listAnnotations(property: string): Promise<any[]>;
  getMetadata(property: string): Promise<any>;
  runReport(property: string, body: Record<string, unknown>): Promise<any>;
  runRealtimeReport(property: string, body: Record<string, unknown>): Promise<any>;
  runFunnelReport(property: string, body: Record<string, unknown>): Promise<any>;
  /** Data API v1alpha runReport — the only version that accepts conversionSpec. */
  runConversionsReport(property: string, body: Record<string, unknown>): Promise<any>;
}

function loadCredentials(): { client_email: string; private_key: string } {
  const inline = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch {
      throw new Error("GA4_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
  }
  let file = process.env.GA4_SERVICE_ACCOUNT_FILE;
  if (!file) {
    throw new Error("GA4_SERVICE_ACCOUNT_FILE is not set (or set GA4_SERVICE_ACCOUNT_JSON)");
  }
  if (file.startsWith("~")) file = file.replace(/^~/, homedir());
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Service account key not found: ${file}`);
  }
  return JSON.parse(raw);
}

/** Lazily constructed so importing the package never demands credentials. */
export function createDefaultRequestFn(): RequestFn {
  let jwt: JWT | null = null;
  return async (opts) => {
    if (!jwt) {
      const creds = loadCredentials();
      jwt = new JWT({ email: creds.client_email, key: creds.private_key, scopes: SCOPES });
    }
    return jwt.request({ url: opts.url, method: opts.method, data: opts.data });
  };
}

export function createGa4Client(request: RequestFn = createDefaultRequestFn()): Ga4Client {
  const get = (url: string) => request({ url, method: "GET" }).then(r => r.data);
  const post = (url: string, data: unknown) => request({ url, method: "POST", data }).then(r => r.data);

  /** Follow nextPageToken until exhausted, concatenating `key`. */
  const listAll = async (url: string, key: string): Promise<any[]> => {
    const out: any[] = [];
    let token: string | undefined;
    do {
      const sep = url.includes("?") ? "&" : "?";
      const page = await get(token ? `${url}${sep}pageToken=${encodeURIComponent(token)}` : url);
      out.push(...(page?.[key] ?? []));
      token = page?.nextPageToken || undefined;
    } while (token);
    return out;
  };

  return {
    listAccountSummaries: () => listAll(`${ADMIN_BETA}/accountSummaries?pageSize=200`, "accountSummaries"),
    getProperty: (p) => get(`${ADMIN_BETA}/${p}`),
    listGoogleAdsLinks: (p) => listAll(`${ADMIN_BETA}/${p}/googleAdsLinks`, "googleAdsLinks"),
    listAnnotations: (p) => listAll(`${ADMIN_ALPHA}/${p}/reportingDataAnnotations`, "reportingDataAnnotations"),
    getMetadata: (p) => get(`${DATA_BETA}/${p}/metadata`),
    runReport: (p, body) => post(`${DATA_BETA}/${p}:runReport`, body),
    runRealtimeReport: (p, body) => post(`${DATA_BETA}/${p}:runRealtimeReport`, body),
    runFunnelReport: (p, body) => post(`${DATA_ALPHA}/${p}:runFunnelReport`, body),
    runConversionsReport: (p, body) => post(`${DATA_ALPHA}/${p}:runReport`, body),
  };
}
