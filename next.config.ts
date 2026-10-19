import type { NextConfig } from "next";
import path from "path";
import { BILL_CSP, contentSecurityPolicy } from "./src/lib/csp";
import { DOCUMENT_CSP } from "./src/lib/server/documentHeaders";
import pkg from "./package.json";

// Shown in the admin hub as BUH-xx.xx.xx, so "which build is this?" has one answer.
const appVersion = `BUH-${pkg.version.split(".").map((n) => n.padStart(2, "0")).join(".")}`;

const nextConfig: NextConfig = {
  output: "standalone",
  // Loaded at runtime from node_modules (native SQLite driver; mailer with dynamic requires).
  serverExternalPackages: ["better-sqlite3", "nodemailer", "imapflow", "mailparser", "stripe"],
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
          // Checkout uses the browser's location to fill the address, and Stripe's frame (only) may
          // use the Payment Request API for Apple Pay and Google Pay; nothing else is needed.
          { key: "Permissions-Policy", value: 'camera=(), microphone=(), geolocation=(self), payment=(self "https://js.stripe.com" "https://pay.google.com"), usb=()' },
          // Only meaningful over HTTPS; browsers ignore it on plain http. No `preload`:
          // that is a one-way commitment the site owner should opt into deliberately.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
        ],
      },
      {
        // The service worker: always checked with the server (so a new release is found), allowed
        // to control the whole site, and itself limited to this site.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'; frame-ancestors 'none'" },
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
      {
        // A bill's photo opened on its own: sandboxed, the image and nothing else (after the API's
        // policy above, so this one is sent; the route sets the same).
        source: "/api/admin/expenses/:id/bills/:bill",
        headers: [{ key: "Content-Security-Policy", value: BILL_CSP }],
      },
      {
        // An order's printable receipt or tax invoice (the hub's, and the customer's private one):
        // its own inline style, no scripts at all (src/lib/server/documentHeaders.ts).
        source: "/api/admin/orders/:id/invoice",
        headers: [{ key: "Content-Security-Policy", value: DOCUMENT_CSP }],
      },
      {
        source: "/invoice/:token",
        headers: [
          { key: "Content-Security-Policy", value: DOCUMENT_CSP },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store" },
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
