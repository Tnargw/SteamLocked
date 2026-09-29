import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run against a real local D1 instance with the same migrations that
// ship to production, so schema mistakes fail here rather than on deploy.
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only stand-ins. The real values live in Cloudflare secrets.
        bindings: {
          STEAM_API_KEY: "test-steam-key",
          SESSION_SECRET: "test-session-secret-0123456789abcdef",
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    // Verbose: name every individual assertion group in the output rather than
    // a per-file summary, so CI logs say exactly what was checked.
    reporters: ["verbose"],
    setupFiles: ["./test/setup.js"],
  },
});
