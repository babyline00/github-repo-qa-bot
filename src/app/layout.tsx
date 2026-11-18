import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GitHub Repo Q&A Bot",
  description:
    "Drop a public GitHub repo URL, ingest the top 50 smallest files (unauthenticated contents API, 60 req/hr), AST-chunk TS/JS, regex-chunk other langs, hybrid retrieval (BM25 + vector + RRF), streaming chat with [^c1] citations grounded in retrieved chunks. Per-file sidebar filter. \"Where is X used?\" lookup via whole-word regex match.",
  keywords: [
    "RAG",
    "GitHub",
    "code QA",
    "AST chunking",
    "tree-sitter",
    "BM25",
    "vector search",
    "Next.js",
  ],
  authors: [{ name: "GitHub Repo Q&A Bot" }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
