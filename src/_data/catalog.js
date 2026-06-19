import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The homepage is just a view of the catalog the asset build already emits, so
// index.json stays the single source of truth and the two artifacts can't
// drift. This reads across into dist/, which the Python build must populate
// first (`npm run build:assets`).
const indexPath = fileURLToPath(new URL("../../dist/index.json", import.meta.url));

export default function () {
  try {
    return JSON.parse(readFileSync(indexPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "dist/index.json not found — run `npm run build:assets` before building the site.",
      );
    }
    throw error;
  }
}
