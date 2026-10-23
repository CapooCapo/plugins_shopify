import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: __dirname,
  define: {
    "process.env": {},
    process: { env: {} },
  },
  resolve: {
    alias: [
      { find: "@shopify/shopify-app-react-router/server", replacement: resolve(__dirname, "server-mock.ts") },
      { find: "../shopify.server", replacement: resolve(__dirname, "server-mock.ts") },
      { find: "../db.server", replacement: resolve(__dirname, "server-mock.ts") },
      { find: "node:crypto", replacement: resolve(__dirname, "server-mock.ts") },
      { find: "../utils/csv.server", replacement: resolve(__dirname, "server-mock.ts") },
      { find: "../utils/request-body.server", replacement: resolve(__dirname, "server-mock.ts") },
      { find: "../utils/shopify-graphql.server", replacement: resolve(__dirname, "server-mock.ts") },
    ],
  },
  server: { host: "127.0.0.1", port: 4179, strictPort: true, fs: { allow: ["../.."] } },
});
