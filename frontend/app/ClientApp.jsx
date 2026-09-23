"use client";

import App from "../src/AppProduction";

export default function ClientApp({ initialNews = [] }) {
  return <App initialNews={initialNews} />;
}
