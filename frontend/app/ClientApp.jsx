"use client";

import App from "../src/AppProduction";

export default function ClientApp({ initialNews = [], initialArticle = null }) {
  return <App initialNews={initialNews} initialArticle={initialArticle} />;
}
