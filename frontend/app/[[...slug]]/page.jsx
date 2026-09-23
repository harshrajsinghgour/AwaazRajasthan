import ClientApp from "../ClientApp";

const BACKEND = String(process.env.BACKEND_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || "https://awaazrajasthan.onrender.com").replace(/\/$/, "");
const SITE = String(process.env.NEXT_PUBLIC_SITE_URL || "https://awaazrajasthan.vercel.app").replace(/\/$/, "");

async function getArticle(slug) {
  if (!slug) return null;
  const key = decodeURIComponent(String(slug));
  try {
    const response = await fetch(`${BACKEND}/api/news/${encodeURIComponent(key)}/preview`, { next: { revalidate: 30, tags: ["news", `news:${key}`] } });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.news || data?.data || null;
  } catch { return null; }
}

export async function generateMetadata({ params }) {
  const resolved = await params;
  const parts = Array.isArray(resolved?.slug) ? resolved.slug : [];
  if (parts[0] !== "news" || !parts[1]) return {};
  const article = await getArticle(parts.slice(1).join("/"));
  if (!article) return {};
  const title = String(article.title || "आवाज़ राजस्थान");
  const description = String(article.excerpt || article.content || "राजस्थान की ताज़ा खबरें").replace(/<[^>]*>/g, "").slice(0, 160);
  const image = Array.isArray(article.image) ? article.image[0] : article.image;
  const url = `${SITE}/news/${encodeURIComponent(article.slug || parts[1])}`;
  return {
    title, description,
    alternates: { canonical: url },
    openGraph: { type: "article", url, title, description, siteName: "आवाज़ राजस्थान", locale: "hi_IN", publishedTime: article.publishedAt || article.createdAt || undefined, modifiedTime: article.updatedAt || undefined, images: image ? [{ url: image, width: 1200, height: 675, alt: title }] : undefined },
    twitter: { card: "summary_large_image", title, description, images: image ? [image] : undefined },
    robots: { index: true, follow: true, googleBot: { index: true, follow: true } }
  };
}

export default async function Page({ params }) {
  const resolved = await params;
  const parts = Array.isArray(resolved?.slug) ? resolved.slug : [];
  const isArticle = parts[0] === "news" && parts[1];
  const article = isArticle ? await getArticle(parts.slice(1).join("/")) : null;
  const jsonLd = article ? {
    "@context": "https://schema.org", "@type": "NewsArticle", headline: article.title, description: article.excerpt || "",
    datePublished: article.publishedAt || article.createdAt, dateModified: article.updatedAt || article.publishedAt || article.createdAt,
    author: { "@type": "Organization", name: article.author || "आवाज़ राजस्थान" },
    publisher: { "@type": "Organization", name: "आवाज़ राजस्थान", url: SITE },
    mainEntityOfPage: { "@type": "WebPage", "@id": `${SITE}/news/${encodeURIComponent(article.slug || parts[1])}` },
    image: Array.isArray(article.image) ? article.image : article.image ? [article.image] : []
  } : null;
  return <>{jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />}<ClientApp /></>;
}
