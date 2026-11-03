import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Praxis — Circuit workbench",
  description:
    "See your circuit, inspect its connections, and verify a repair with Praxis.",
  applicationName: "Praxis",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Praxis" },
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f6f5f0",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
