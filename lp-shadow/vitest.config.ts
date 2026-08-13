import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Two suites (loop, service) truncate the same scratch database; parallel
    // test files race each other's beforeAll. The whole suite runs in seconds,
    // so serial file execution costs nothing and removes the race entirely.
    fileParallelism: false,
  },
});
