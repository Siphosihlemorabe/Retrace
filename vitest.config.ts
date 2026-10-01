import { defineConfig } from 'vitest/config';

// Node's own .env loader rather than dotenv: one less dependency, and the same
// mechanism the npm scripts use via --env-file-if-exists.
try {
  process.loadEnvFile();
} catch {
  // No .env — database tests skip, or fail under REQUIRE_DB=1.
}

export default defineConfig({
  test: {
    globalSetup: ['./src/db/test-setup.ts'],
  },
});
