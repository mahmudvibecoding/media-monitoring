import { defineConfig } from "@hey-api/openapi-ts";

// "pnpm api" writes src/api/, the typed client, from the API's description (../openapi.json, which "uv run api
// openapi" writes). Run it again whenever the API changes; src/api/ isn't edited by hand.
export default defineConfig({
  input: "../openapi.json",
  output: "src/api",
  plugins: [
    // Where requests go is set in src/lib/api-client.ts
    { name: "@hey-api/client-fetch", runtimeConfigPath: "./src/lib/api-client" },
    "@hey-api/typescript",
    "@hey-api/sdk",
    "@tanstack/react-query",
  ],
});
