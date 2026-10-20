/**
 * The bundled web client.
 *
 * `index.html`, `app.js` and `style.css` are read from disk *once*, at module load, and
 * held as strings. Serving them from memory rather than from `/var/task` per request keeps
 * the demo path off the filesystem, and the whole set is ~20 KB, which is nothing next to
 * an execution environment that already costs 512 MB.
 *
 * The client is a single hand-written file with no build step, matching the rest of the
 * repository: the browser loads the same source a human reads.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ClientAsset {
  readonly files: Readonly<Record<string, { readonly body: string; readonly type: string }>>;
}

const TYPES: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
};

/** Load `client/*` from a directory. Throws at deploy time if a file is missing, not at request time. */
export function loadClient(directory: string): ClientAsset {
  const files: Record<string, { body: string; type: string }> = {};
  for (const [name, type] of Object.entries(TYPES)) {
    files[name] = { body: readFileSync(join(directory, name), "utf8"), type };
  }
  return { files };
}

/** Load `client/*` from this module's own directory — how the Lambda asset is laid out. */
export function loadBundledClient(): ClientAsset {
  return loadClient(join(dirname(fileURLToPath(import.meta.url)), "client"));
}

export function serveClient(asset: ClientAsset, name: string): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  const file = asset.files[name];
  if (!file) return { statusCode: 404, headers: { "content-type": "application/json" }, body: '{"error":{"code":"not_found"}}' };
  return {
    statusCode: 200,
    headers: {
      "content-type": file.type,
      // The client is not cache-busted by filename, so keep the window short.
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
    body: file.body,
  };
}
