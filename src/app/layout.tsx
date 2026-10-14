import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#0f1c2e",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
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
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-[#fbf9f5] text-[#1c1815] selection:bg-[#c5a059]/30">
        {children}
      </body>
    </html>
  );
}
