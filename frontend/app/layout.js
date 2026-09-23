import "../src/index.css";
import "../src/production-polish.css";
import "../src/app-production.css";
import "../src/final-production-polish.css";
import "../src/production-completion.css";
import "../src/premium-editorial.css";
import "../src/elite-editorial.css";
import "../src/elite-editorial-v3.css";
import "../src/elite-editorial-v4.css";
import "../src/elite-editorial-v5.css";
import "../src/elite-editorial-v6.css";
import "../src/premium-editorial-v7.css";

export const metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://awaazrajasthan.vercel.app"),
  title: { default: "आवाज़ राजस्थान — राजस्थान की अपनी खबर", template: "%s | आवाज़ राजस्थान" },
  description: "राजस्थान की ताज़ा, स्थानीय, राष्ट्रीय और विश्व खबरें।",
  applicationName: "आवाज़ राजस्थान",
  alternates: { canonical: "/" },
  openGraph: { type: "website", siteName: "आवाज़ राजस्थान", locale: "hi_IN", title: "आवाज़ राजस्थान", description: "राजस्थान की ताज़ा खबरें" },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true }
};

export default function RootLayout({ children }) {
  return <html lang="hi"><body>{children}</body></html>;
}
