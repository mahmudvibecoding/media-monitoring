import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false, // no "X-Powered-By: Next.js" header in answers
  turbopack: {
    rules: {
      // Tailwind's styles, built by Turbopack itself
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
