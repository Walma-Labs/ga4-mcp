// Public package surface: the factory (what the Walma MCP chassis imports),
// the thin GA4 client pieces, and the pure logic for anyone who wants it.

export { createGa4Server, INSTRUCTIONS, VERSION } from "./server.js";
export { createGa4Client, createDefaultRequestFn, SCOPES, type Ga4Client, type RequestFn } from "./ga4.js";
export * as logic from "./logic.js";
