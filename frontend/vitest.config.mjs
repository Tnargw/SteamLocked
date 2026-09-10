import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    reporters: ["verbose"],
    include: ["test/**/*.test.js"],
  },
});
