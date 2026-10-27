// The local dev entry point. It is `.mjs` so Node can load it without type stripping.
// Lambda does NOT use this file — the CDK stack points NodejsFunction at bootstrap.ts
// directly, and esbuild bundles it. This shim is only used by scripts/dev-server.ts.
const { handler } = (await import("./bootstrap.ts")).createHandlerForLambda();
export { handler };
