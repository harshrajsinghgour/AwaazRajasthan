// Clean article URL bridge.
// Keep the public /news/<slug-or-id> URL intact and let the article API
// resolve the slug itself. This avoids an extra API read that would also
// increment the article view counter before the real article load.
const PREFIX = "/news/";
const HASH_PREFIX = "#news-";
const originalReplaceState = window.history.replaceState.bind(window.history);
const originalPushState = window.history.pushState.bind(window.history);

function idFromPath(pathname = window.location.pathname) {
  if (!pathname.startsWith(PREFIX)) return "";
  const value = pathname.slice(PREFIX.length).split("/")[0];
  try { return value ? decodeURIComponent(value) : ""; } catch { return value; }
}

function pathForId(id) {
  return `${PREFIX}${encodeURIComponent(String(id))}`;
}

function bridgeUrl(original, state, title, url) {
  if (typeof url === "string" && url.startsWith(HASH_PREFIX)) {
    const id = url.slice(HASH_PREFIX.length);
    if (id) {
      try {
        original(state, title, pathForId(decodeURIComponent(id)));
      } catch {
        original(state, title, pathForId(id));
      }
      return true;
    }
  }
  return false;
}

window.history.replaceState = function articleAwareReplaceState(state, title, url) {
  if (!bridgeUrl(originalReplaceState, state, title, url)) originalReplaceState(state, title, url);
};

window.history.pushState = function articleAwarePushState(state, title, url) {
  if (!bridgeUrl(originalPushState, state, title, url)) originalPushState(state, title, url);
};

function bootstrapArticlePath() {
  const initialValue = idFromPath();
  if (!initialValue || window.location.hash) return;

  const cleanUrl = window.location.pathname + window.location.search;
  originalReplaceState(null, "", `${cleanUrl}${HASH_PREFIX}${encodeURIComponent(initialValue)}`);

  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    const mounted = document.querySelector(".article-modal");
    const stillOnArticle = window.location.pathname.startsWith(PREFIX);
    if (!stillOnArticle || mounted || attempts >= 40) {
      window.clearInterval(timer);
      if (stillOnArticle && window.location.hash.startsWith(HASH_PREFIX)) {
        originalReplaceState(null, "", cleanUrl);
      }
    }
  }, 100);
}

bootstrapArticlePath();

window.addEventListener("popstate", () => {
  const value = idFromPath();
  if (!value || window.location.hash) return;
  const cleanUrl = window.location.pathname + window.location.search;
  originalReplaceState(null, "", `${cleanUrl}${HASH_PREFIX}${encodeURIComponent(value)}`);
});
