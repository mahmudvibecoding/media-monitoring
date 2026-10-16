import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

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

// next-intl finds each request's language and texts in src/i18n/request.ts
export default createNextIntlPlugin()(nextConfig);
