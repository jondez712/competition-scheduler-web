import { loadEnv } from "vite";

const mode = process.env.NODE_ENV ?? "test";
const fileEnv = loadEnv(mode, process.cwd(), "");

for (const [key, value] of Object.entries(fileEnv)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}
