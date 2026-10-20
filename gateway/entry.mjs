// The Lambda entry point. It is `.mjs`, not `.ts`, on purpose: see README, "Why there is
// no build step". Keep this file to a single dynamic import — anything more and type
// stripping stops being the only transform involved in getting the handler running.
const { handler } = (await import("./bootstrap.ts")).createHandlerForLambda();
export { handler };
