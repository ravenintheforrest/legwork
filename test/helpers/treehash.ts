// The hard rule made checkable: a content hash of the four live artifact trees.
// Any test that writes into data/, briefs/, memos/, or site/ changes one of these
// digests, and `npm run test:sealed` fails.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT, SEALED_TREES } from "./env.js";

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full));
  }
}

/** sha256 over every file path and its bytes. "absent" when the tree does not exist. */
export function hashTree(path: string): string {
  if (!existsSync(path)) return "absent";
  if (statSync(path).isFile()) return createHash("sha256").update(readFileSync(path)).digest("hex");
  const files: string[] = [];
  walk(path, path, files);
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    digest.update(file).update("\0");
    digest.update(createHash("sha256").update(readFileSync(join(path, file))).digest("hex")).update("\n");
  }
  return `${files.length} files ${digest.digest("hex")}`;
}

export function hashSealedTrees(root = REPO_ROOT): Record<string, string> {
  return Object.fromEntries(SEALED_TREES.map((tree) => [tree, hashTree(join(root, tree))]));
}

export function diffHashes(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(before)) {
    if (before[key] !== after[key]) changed.push(`${key}: ${before[key]} -> ${after[key]}`);
  }
  return changed;
}
