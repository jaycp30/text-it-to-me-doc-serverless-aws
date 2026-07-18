import { defineConfig } from "vitest/config";

// Pure-logic regression tests. Backend tests exercise the scheduling / token /
// email-template / error logic extracted out of the Lambda handlers; the
// frontend tests cover the pure error-mapping module (frontend/src/errors.js).
// All run in a plain Node environment with no AWS SDK calls and no network access.
export default defineConfig({
  test: {
    environment: "node",
    include: ["backend/tests/**/*.test.js", "frontend/src/**/*.test.js"],
    // Keep test runs isolated from build output and SAM artifacts.
    exclude: ["**/node_modules/**", ".aws-sam/**", "dist/**"],
  },
});
