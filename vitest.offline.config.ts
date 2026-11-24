import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

/** Run the normal suite with real outbound fetches denied in-process. */
export default mergeConfig(baseConfig, defineConfig({
  test: {
    setupFiles: ["./src/__tests__/offline-network-guard.ts"],
    silent: true,
  },
}));
