import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only stand-ins. The real values live in Cloudflare secrets.
        bindings: {
          STEAM_API_KEY: "test-steam-key",
          SESSION_SECRET: "test-session-secret-0123456789abcdef",
        },
      },
    }),
  ],
  test: {
    // Verbose: name every individual assertion group in the output rather than
    // a per-file summary, so CI logs say exactly what was checked.
    reporters: ["verbose"],
  },
});
