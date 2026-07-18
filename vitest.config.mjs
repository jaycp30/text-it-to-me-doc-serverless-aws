import { defineConfig } from "vitest/config";

// Backend regression tests only. These exercise the pure scheduling / token /
// email-template logic extracted out of the Lambda handlers, so they run in a
// plain Node environment with no AWS SDK calls and no network access.
export default defineConfig({
  test: {
    environment: "node",
    include: ["backend/tests/**/*.test.js"],
    // Keep test runs isolated from the frontend build and SAM artifacts.
    exclude: ["**/node_modules/**", "frontend/**", ".aws-sam/**", "dist/**"],
  },
});
