import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Armara Vision",
  description:
    "Institutional analytics and monitoring for tokenized equities — premium/discount, liquidity depth, flows, and issuer structure.",
};

const NAV = [
  { href: "/", label: "OVERVIEW" },
  { href: "/assets", label: "SCREENER" },
  { href: "/news", label: "NEWS" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-mono antialiased min-h-screen">
        <header className="border-b border-terminal-border bg-terminal-panel">
          <div className="mx-auto flex max-w-7xl items-center gap-8 px-4 py-3">
            <Link href="/" className="text-terminal-amber tracking-widest text-sm font-bold">
              ARMARA VISION
            </Link>
            <nav className="flex gap-5 text-xs text-terminal-muted">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="hover:text-terminal-text tracking-wider">
                  {n.label}
                </Link>
              ))}
            </nav>
            <span className="ml-auto text-[10px] text-terminal-muted uppercase tracking-wider">
              Tokenized equities terminal
            </span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
