import React, { Component } from "react";
import ReactDOM from "react-dom/client";
import App from "./AppProduction";
import "./index.css";
import "./production-polish.css";
import "./app-production.css";
import "./final-production-polish.css";
import "./production-completion.css";
import "./premium-editorial.css";

class FrontendErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Awaaz Rajasthan frontend runtime error:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, background: "#f4f5f7", fontFamily: "system-ui,sans-serif" }}>
          <section style={{ width: "min(92vw,460px)", textAlign: "center", background: "#fff", borderRadius: 20, padding: "30px 22px", boxShadow: "0 16px 45px rgba(7,17,31,.12)" }}>
            <img src="/awaazrajasthan-logo.png" alt="आवाज़ राजस्थान" style={{ width: "min(58vw,220px)", maxWidth: "100%", margin: "0 auto 18px" }} />
            <h1 style={{ margin: "0 0 8px", color: "#07111f", fontSize: 24 }}>आवाज़ राजस्थान</h1>
            <p style={{ margin: "0 0 12px", color: "#687282", lineHeight: 1.6 }}>वेबसाइट लोड करते समय एक तकनीकी समस्या आई।</p><details style={{ textAlign: "left", margin: "0 auto 18px", maxWidth: 420 }}><summary style={{ cursor: "pointer", color: "#d71920", fontWeight: 800 }}>तकनीकी विवरण</summary><pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11, color: "#4d5865", background: "#f4f5f7", borderRadius: 10, padding: 10 }}>{String(this.state.error?.message || this.state.error || "Unknown error")}</pre></details>
            <button type="button" onClick={() => window.location.reload()} style={{ border: 0, borderRadius: 10, background: "#d71920", color: "#fff", padding: "12px 22px", fontWeight: 800, cursor: "pointer" }}>फिर कोशिश करें</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then(registration => {
      registration.update().catch(() => {});
    }).catch(error => console.warn("Service worker registration skipped:", error));
  }, { once: true });
}

registerServiceWorker();

const root = document.getElementById("root");
if (!root) throw new Error("Awaaz Rajasthan root element is missing.");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <FrontendErrorBoundary>
      <App />
    </FrontendErrorBoundary>
  </React.StrictMode>
);
