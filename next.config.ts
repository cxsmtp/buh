import type { NextConfig } from "next";
import path from "path";
import { contentSecurityPolicy } from "./src/lib/csp";
import pkg from "./package.json";

// Shown in the admin hub as BUH-xx.xx.xx, so "which build is this?" has one answer.
const appVersion = `BUH-${pkg.version.split(".").map((n) => n.padStart(2, "0")).join(".")}`;

const nextConfig: NextConfig = {
  output: "standalone",
  // Loaded at runtime from node_modules (native SQLite driver; mailer with dynamic requires).
  serverExternalPackages: ["better-sqlite3", "nodemailer", "imapflow", "mailparser"],
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
  // Settings → Versions shows the changelog of the running build.
  outputFileTracingIncludes: { "/api/admin/versions": ["./CHANGELOG.md"] },
  images: {
    unoptimized: true,
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // Checkout uses the browser's location to fill the address; nothing else is needed.
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=(), usb=()" },
          // Only meaningful over HTTPS; browsers ignore it on plain http. No `preload`:
          // that is a one-way commitment the site owner should opt into deliberately.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
        ],
      },
      {
        // API answers are per-request and may carry personal data: never cache them.
        // (Uploaded images, content-addressed and public, set their own long cache.)
        source: "/api/((?!images/).*)",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
        ],
      },
    ];
  },
  turbopack: {
    root: path.resolve("."),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
