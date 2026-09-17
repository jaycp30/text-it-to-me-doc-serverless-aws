import { defineConfig } from "vitest/config";

// Pure-logic regression tests. Backend tests exercise the scheduling / token /
// email-template / error logic extracted out of the Lambda handlers; the
// frontend tests cover the pure error-mapping module (frontend/src/errors.js).
// All run in a plain Node environment with no AWS SDK calls and no network access.
//
// The `rx-session-token` auth layer needs no alias here: Lambda resolves the bare
// specifier from /opt/nodejs/node_modules, and the repo resolves it through the
// file: dependency in package.json. A bundler alias would not have worked anyway,
// since it cannot intercept require() from a CommonJS module.
export default defineConfig({
  test: {
    environment: "node",
    include: ["backend/tests/**/*.test.js", "frontend/src/**/*.test.js"],
    // Keep test runs isolated from build output and SAM artifacts.
    exclude: ["**/node_modules/**", ".aws-sam/**", "dist/**"],
  },
});
