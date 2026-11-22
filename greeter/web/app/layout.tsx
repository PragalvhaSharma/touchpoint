import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Greeter", template: "%s · Hack Western 13" },
  description: "Knows who is in front of the camera and says hello.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        {/* @openuidev/react-lang mounts its "OpenUI Inspect" panel in dev and pops it open on any stream error,
            right over the booth. This flag is the one its auto-mount checks; it has to be set before any bundle runs. */}
        <script dangerouslySetInnerHTML={{ __html: 'globalThis[Symbol.for("openui.devtools.autoMount")]=true;' }} />
      </head>
      <body className="h-full">{children}</body>
    </html>
  );
}
