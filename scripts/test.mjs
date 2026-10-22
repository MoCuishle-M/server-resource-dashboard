import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
mkdirSync(".sites-runtime/tests", { recursive: true });
for (const name of ["domain", "repository", "bulk-import", "schedule", "resource-search", "settings", "audit-search", "lingshu", "resource-visibility", "request-draft"])
  await build({
    entryPoints: [`tests/${name}.test.ts`],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: `.sites-runtime/tests/${name}.test.mjs`,
  });
const result = spawnSync(
  process.execPath,
  [
    "--test",
    ".sites-runtime/tests/domain.test.mjs",
    ".sites-runtime/tests/repository.test.mjs",
    ".sites-runtime/tests/bulk-import.test.mjs",
    ".sites-runtime/tests/schedule.test.mjs",
    ".sites-runtime/tests/resource-search.test.mjs",
    ".sites-runtime/tests/settings.test.mjs",
    ".sites-runtime/tests/audit-search.test.mjs",
    ".sites-runtime/tests/lingshu.test.mjs",
    ".sites-runtime/tests/resource-visibility.test.mjs",
    ".sites-runtime/tests/request-draft.test.mjs",
  ],
  { stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
process.exit(result.status ?? 1);
