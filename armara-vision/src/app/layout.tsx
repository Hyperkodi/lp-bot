import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Armara Vision",
  description:
    "Institutional analytics and monitoring for tokenized equities — premium/discount, liquidity depth, flows, and issuer structure.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-mono antialiased min-h-screen">{children}</body>
    </html>
  );
}
