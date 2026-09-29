import { applyD1Migrations, env } from "cloudflare:test";

// Each test worker gets its own isolated D1 storage; bring it up to schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
