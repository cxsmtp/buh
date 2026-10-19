import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { THEME_COLOR } from "@/lib/design/tokens";
import { LOOK_PRESETS } from "@/lib/design/themes";
import "./globals.css";

/*
 * The shop's two typefaces, served from this site (no font requests to other hosts): Cormorant
 * Garamond, an elegant serif for headings and the shop's name, and Inter for everything else.
 * Both under the SIL Open Font License (src/app/fonts/).
 */
const display = localFont({
  src: [
    { path: "./fonts/cormorant-garamond-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/cormorant-garamond-latin-500-italic.woff2", weight: "500", style: "italic" },
    { path: "./fonts/cormorant-garamond-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-display",
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
});
const ui = localFont({
  src: "./fonts/inter-latin-wght-normal.woff2",
  weight: "100 900",
  variable: "--font-ui",
  display: "swap",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "Arial", "sans-serif"],
});

export const viewport: Viewport = {
  // The phone's status bar: the ink in a light look, the page's own dark in a dark one (the device
  // decides which applies). This page is the same for every visitor, so the colours are Ivory &
  // Gold's; the other looks' are near enough for a status bar.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR },
    { media: "(prefers-color-scheme: dark)", color: LOOK_PRESETS["ivory-gold"].dark.colors.ivory },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  // The page reaches under a phone's notch and home bar; the header, tab bar and sheets pad
  // themselves by the safe-area insets (globals.css), like an app.
  viewportFit: "cover",
  // The on-screen keyboard shrinks the page instead of covering it, so a sheet's footer button
  // stays above the keyboard (Chrome on Android; iPhones do this by themselves).
  interactiveWidget: "resizes-content",
};

export const metadata: Metadata = {
  title: "Beautiful UAE Home • Handprinted & Machine Printed Block Bed Linens",
  description:
    "Artisanal hand-block and machine-printed luxury bed sheet collections tailored for UAE deep mattresses. Fast delivery across Dubai, Abu Dhabi, Sharjah & all Emirates with Cash on Delivery & Direct Bank Transfer.",
  keywords: [
    "UAE bed sheets",
    "block printed linens",
    "handprinted bedding Dubai",
    "Egyptian cotton bed sheets UAE",
    "Abu Dhabi luxury bedding",
    "cash on delivery bedding UAE",
    "express delivery UAE",
  ],
  authors: [{ name: "Beautiful UAE Home Trading LLC" }],
  icons: {
    icon: "/favicon.ico",
    apple: "/icons/apple-touch-icon.png",
  },
  // Added to an iPhone's home screen, the shop opens full screen like an app (its name and icon
  // come from the web app manifest, src/app/manifest.ts).
  appleWebApp: { capable: true, statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`h-full antialiased ${display.variable} ${ui.variable}`} suppressHydrationWarning>
      <head>
        {/* The chosen look (Settings → Look), from the server before anything paints: src/app/look.css. */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/look.css" />
      </head>
      <body className="min-h-full flex flex-col bg-ivory text-ink selection:bg-gold/30">
        {children}
      </body>
    </html>
  );
}
