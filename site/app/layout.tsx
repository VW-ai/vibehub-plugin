import type { Metadata, Viewport } from "next";
import "./globals.css";

const publicUrl = process.env.NEXT_PUBLIC_SITE_URL;

export const metadata: Metadata = {
  title: "VibeHub — The Git-native development cycle",
  description:
    "VibeHub turns a development request into a Git-native Ticket cycle your coding agent can plan, execute, prove, and close.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  ...(publicUrl
    ? {
        metadataBase: new URL(publicUrl),
        openGraph: {
          title: "VibeHub — The Git-native development cycle",
          description:
            "Keep the whole development cycle in one Git-native Ticket.",
          images: [{ url: "/og.png", width: 1728, height: 918 }],
          type: "website",
        },
        twitter: {
          card: "summary_large_image" as const,
          images: ["/og.png"],
        },
      }
    : {}),
};

export const viewport: Viewport = {
  themeColor: "#e8eae8",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
