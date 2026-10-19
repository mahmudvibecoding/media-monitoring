import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { API_URL } from "./src/lib/api-url";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false, // no "X-Powered-By: Next.js" header in answers
  // The activity is on the overview: its own address, with its step and page (?step=…&page=…), goes there
  async redirects() {
    return [{ source: "/activity", destination: "/", permanent: false }];
  },
  // The browser asks the site's own /api/...: Next passes it on to the API
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
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
