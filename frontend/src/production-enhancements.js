import { useEffect } from "react";

const LIVE_TV_URL = import.meta.env.VITE_LIVE_TV_URL || "";

function scrollToElement(selector) {
  document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function syncMobileNavigation() {
  const nav = document.querySelector(".mobile-bottom-nav");
  if (!nav) return;
  const buttons = [...nav.querySelectorAll("button")];
  if (buttons.length < 5) return;

  const setLabel = (button, label, aria) => {
    const span = button.querySelector("span");
    if (span && span.textContent !== label) span.textContent = label;
    if (button.getAttribute("aria-label") !== aria) button.setAttribute("aria-label", aria);
  };

  setLabel(buttons[1], "खबरें", "ताज़ा खबरें खोलें");
  setLabel(buttons[2], "जिले", "जिलेवार खबरें खोलें");
  setLabel(buttons[3], "लाइव", "लाइव न्यूज़ खोलें");
  setLabel(buttons[4], "और", "और विकल्प खोलें");

  if (!buttons[1].dataset.productionBound) {
    buttons[1].dataset.productionBound = "1";
    buttons[1].addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      scrollToElement(".latest-section");
    });
  }
  if (!buttons[2].dataset.productionBound) {
    buttons[2].dataset.productionBound = "1";
    buttons[2].addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      scrollToElement(".district-section");
    });
  }
  if (!buttons[3].dataset.productionBound) {
    buttons[3].dataset.productionBound = "1";
    buttons[3].addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      scrollToElement(".live-hub");
    });
  }
}

function renderLiveHub() {
  const main = document.querySelector("main#main-content");
  if (!main) return;

  const tickerButtons = [...document.querySelectorAll(".ticker-track button")].slice(0, 6);
  let hub = main.querySelector(".live-hub");
  if (!hub) {
    hub = document.createElement("section");
    hub.className = "live-hub";
    const district = main.querySelector(".district-section");
    if (district) main.insertBefore(hub, district);
    else main.appendChild(hub);
  }

  const key = `${LIVE_TV_URL}|${tickerButtons.map((node) => node.textContent).join("|")}`;
  if (hub.dataset.key === key) return;
  hub.dataset.key = key;
  hub.replaceChildren();

  const header = document.createElement("div");
  header.className = "live-hub-head";
  const headingWrap = document.createElement("div");
  const label = document.createElement("span");
  label.className = "section-label";
  label.textContent = "LIVE DESK";
  const heading = document.createElement("h2");
  heading.textContent = "लाइव न्यूज़";
  const description = document.createElement("p");
  description.textContent = "ब्रेकिंग अपडेट्स और लाइव कवरेज एक ही जगह।";
  headingWrap.append(label, heading, description);
  const status = document.createElement("span");
  status.className = "live-status";
  const statusDot = document.createElement("i");
  status.append(statusDot, document.createTextNode(" LIVE"));
  header.append(headingWrap, status);
  hub.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "live-hub-grid";

  if (LIVE_TV_URL) {
    const tv = document.createElement("a");
    tv.className = "live-tv-card";
    tv.href = LIVE_TV_URL;
    tv.target = "_blank";
    tv.rel = "noopener noreferrer";
    const art = document.createElement("div");
    art.className = "live-tv-art";
    art.textContent = "▶";
    const copy = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = "आवाज़ राजस्थान LIVE TV";
    const meta = document.createElement("small");
    meta.textContent = "लाइव कवरेज देखें";
    copy.append(title, meta);
    tv.append(art, copy);
    grid.appendChild(tv);
  }

  tickerButtons.forEach((source, index) => {
    const card = document.createElement("button");
    card.className = "live-news-card";
    card.type = "button";
    const live = document.createElement("span");
    live.className = "live-dot";
    live.textContent = "LIVE";
    const title = document.createElement("strong");
    title.textContent = source.textContent || "ताज़ा अपडेट";
    const meta = document.createElement("small");
    meta.textContent = `ब्रेकिंग अपडेट ${index + 1}`;
    card.append(live, title, meta);
    card.addEventListener("click", () => source.click());
    grid.appendChild(card);
  });

  if (!grid.children.length) {
    const empty = document.createElement("div");
    empty.className = "live-empty";
    empty.textContent = "अभी कोई लाइव अपडेट उपलब्ध नहीं है।";
    grid.appendChild(empty);
  }

  hub.appendChild(grid);
}

function enhance() {
  syncMobileNavigation();
  renderLiveHub();
}

export default function ProductionEnhancements() {
  useEffect(() => {
    let frame = 0;
    const scheduleEnhance = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        enhance();
      });
    };

    enhance();
    const observer = new MutationObserver(scheduleEnhance);

    // Only watch structural changes. Attribute/text mutations are deliberately
    // ignored so this enhancement layer can never create its own observer loop.
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
