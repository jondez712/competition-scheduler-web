import path from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Before test files are imported (describe.skipIf is evaluated at collect time).
const envMode = process.env.NODE_ENV ?? "test";
for (const [key, value] of Object.entries(loadEnv(envMode, process.cwd(), ""))) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

export default defineConfig(({ mode }) => {
  // Same files Next.js uses (.env, .env.local, …) so benchmark:ai sees OPENAI_API_KEY.
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
      setupFiles: ["./vitest.setup.ts"],
      env: {
        ...env,
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
