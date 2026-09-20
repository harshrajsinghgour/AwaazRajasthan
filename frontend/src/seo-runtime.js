// Runtime SEO for the existing article renderer.
// Keeps the current UI intact while synchronising article metadata with
// shareable /news/<id-or-slug> URLs.
(function setupRuntimeSeo() {
  const ORIGIN = window.location.origin;
  const DEFAULT_TITLE = "आवाज़ राजस्थान | Rajasthan News";
  const DEFAULT_DESCRIPTION = "आवाज़ राजस्थान — राजस्थान की ताज़ा, स्थानीय और भरोसेमंद खबरें।";
  const SCRIPT_ID = "awaaz-article-jsonld";
  const DEFAULT_IMAGE = `${ORIGIN}/og-default.svg`;

  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const escapeText = value => clean(value).slice(0, 500);

  function setMeta(key, value, property = false) {
    if (!value) return;
    const attr = property ? "property" : "name";
    let el = document.head.querySelector(`meta[${attr}="${key}"]`);
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute(attr, key);
      document.head.appendChild(el);
    }
    el.setAttribute("content", value);
  }

  function removeMeta(key, property = false) {
    const attr = property ? "property" : "name";
    document.head.querySelector(`meta[${attr}="${key}"]`)?.remove();
  }

  function setCanonical(href) {
    let el = document.head.querySelector('link[rel="canonical"]');
    if (!el) {
      el = document.createElement("link");
      el.rel = "canonical";
      document.head.appendChild(el);
    }
    el.href = href;
  }

  function removeArticleData() {
    document.getElementById(SCRIPT_ID)?.remove();
    document.title = DEFAULT_TITLE;
    setMeta("description", DEFAULT_DESCRIPTION);
    setMeta("og:title", DEFAULT_TITLE, true);
    setMeta("og:description", DEFAULT_DESCRIPTION, true);
    setMeta("og:type", "website", true);
    setMeta("og:url", `${ORIGIN}/`, true);
    setMeta("og:image", DEFAULT_IMAGE, true);
    setMeta("twitter:title", DEFAULT_TITLE);
    setMeta("twitter:description", DEFAULT_DESCRIPTION);
    setMeta("twitter:image", DEFAULT_IMAGE);
    setCanonical(`${ORIGIN}/`);
    removeMeta("article:section", true);
    removeMeta("article:published_time", true);
    removeMeta("article:modified_time", true);
    removeMeta("article:author", true);
  }

  function build() {
    const modal = document.querySelector(".article-modal");
    if (!modal) {
      removeArticleData();
      return;
    }

    const title = clean(modal.querySelector("h1")?.textContent);
    if (!title) return;

    const description = escapeText(
      modal.querySelector(".article-lead")?.textContent ||
      modal.querySelector(".article-body p")?.textContent ||
      DEFAULT_DESCRIPTION
    );

    const rawImage = modal.querySelector(".article-cover")?.getAttribute("src");
    let image = DEFAULT_IMAGE;
    try { if (rawImage) image = new URL(rawImage, ORIGIN).href; } catch { /* keep default */ }

    const canonical = `${ORIGIN}${window.location.pathname || "/"}`;
    const byline = clean(modal.querySelector(".article-byline span")?.textContent) || "आवाज़ राजस्थान";
    const category = clean(modal.querySelector(".news-kicker")?.textContent).split("•")[0].trim();
    const time = modal.querySelector("time[datetime]");
    const datePublished = time?.getAttribute("datetime") || "";
    const articleBody = clean(modal.querySelector(".article-body")?.textContent);
    const wordCount = articleBody ? articleBody.split(/\s+/u).filter(Boolean).length : 0;

    document.title = `${title} | आवाज़ राजस्थान`;
    setMeta("description", description);
    setMeta("og:title", title, true);
    setMeta("og:description", description, true);
    setMeta("og:type", "article", true);
    setMeta("og:url", canonical, true);
    setMeta("og:image", image, true);
    setMeta("og:image:alt", title, true);
    setMeta("twitter:title", title);
    setMeta("twitter:description", description);
    setMeta("twitter:image", image);
    setMeta("twitter:image:alt", title);
    setMeta("article:section", category, true);
    setMeta("article:published_time", datePublished, true);
    setMeta("article:author", byline, true);
    setCanonical(canonical);

    let script = document.getElementById(SCRIPT_ID);
    if (!script) {
      script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.type = "application/ld+json";
      document.head.appendChild(script);
    }

    const article = {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      headline: title,
      description,
      inLanguage: "hi-IN",
      isAccessibleForFree: true,
      mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
      author: { "@type": "Person", name: byline },
      publisher: {
        "@type": "NewsMediaOrganization",
        name: "आवाज़ राजस्थान",
        url: ORIGIN,
        logo: { "@type": "ImageObject", url: `${ORIGIN}/awaazrajasthan-logo.png` }
      },
      image: [image]
    };

    if (category) article.articleSection = category;
    if (datePublished) article.datePublished = datePublished;
    if (wordCount) article.wordCount = wordCount;

    // A visible publication time is the most reliable runtime signal available
    // in the current renderer. Do not fabricate a modification timestamp.
    const modified = modal.querySelector("time[data-modified][datetime]")?.getAttribute("datetime");
    if (modified) {
      article.dateModified = modified;
      setMeta("article:modified_time", modified, true);
    } else {
      removeMeta("article:modified_time", true);
    }

    script.textContent = JSON.stringify(article);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      build();
    });
  }

  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "datetime", "data-modified"]
  });
  window.addEventListener("popstate", schedule);
  window.addEventListener("hashchange", schedule);
  schedule();
})();
