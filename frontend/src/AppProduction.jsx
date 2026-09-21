// Production build stabilization
import React, { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = import.meta.env.DEV
  ? (import.meta.env.VITE_API_URL || import.meta.env.VITE_BACKEND_URL || "http://localhost:5000").replace(/\/$/, "")
  : "";
const E_PAPER_URL = import.meta.env.VITE_E_PAPER_URL || "/epaper";
const BUILD_VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || "";

const DEFAULT_CATEGORIES = ["होम", "भारत", "विश्व", "राजस्थान", "जयपुर", "जोधपुर", "उदयपुर", "कोटा", "अजमेर", "भीलवाड़ा", "सभी जिले", "अपराध", "राजनीति", "शिक्षा", "नौकरी", "खेल", "मनोरंजन", "बिजनेस"];
const DEFAULT_HOME_BUTTONS = [{label:"ताज़ा खबरें",icon:"🕒",action:"latest"},{label:"ब्रेकिंग न्यूज़",icon:"🔴",action:"breaking"},{label:"ट्रेंडिंग",icon:"🔥",action:"trending"},{label:"वीडियो",icon:"▶️",action:"video"},{label:"फोटो",icon:"📷",action:"photo"}];
const DISTRICTS = ["अजमेर", "अलवर", "बालोतरा", "बांसवाड़ा", "बारां", "बाड़मेर", "ब्यावर", "भरतपुर", "भीलवाड़ा", "बीकानेर", "बूंदी", "चित्तौड़गढ़", "चूरू", "दौसा", "डीग", "धौलपुर", "डीडवाना-कुचामन", "डूंगरपुर", "हनुमानगढ़", "जयपुर", "जैसलमेर", "जालौर", "झालावाड़", "झुंझुनूं", "जोधपुर", "करौली", "खैरथल-तिजारा", "कोटा", "कोटपूतली-बहरोड़", "नागौर", "पाली", "फलोदी", "प्रतापगढ़", "राजसमंद", "सलूम्बर", "सवाई माधोपुर", "सीकर", "सिरोही", "श्रीगंगानगर", "टोंक", "उदयपुर"];

const FALLBACK = [
  { id: "f0", category: "भारत", title: "भारत की मुख्य खबरें और राष्ट्रीय अपडेट्स", excerpt: "देशभर से प्रमुख और महत्वपूर्ण राष्ट्रीय खबरें।", image: "/news-placeholder.svg", time: "अभी", location: "भारत" },
  { id: "f00", category: "विश्व", title: "विश्व की मुख्य खबरें और अंतरराष्ट्रीय अपडेट्स", excerpt: "दुनिया भर से महत्वपूर्ण अंतरराष्ट्रीय खबरें।", image: "/news-placeholder.svg", time: "अभी", location: "विश्व" },
  { id: "f1", category: "राजस्थान", title: "राजस्थान की बड़ी खबरें और दिनभर के महत्वपूर्ण अपडेट्स", excerpt: "प्रदेश के अलग-अलग जिलों से सामने आई प्रमुख खबरें और जनहित से जुड़ी जानकारी एक जगह।", image: "/news-placeholder.svg", time: "अभी", location: "राजस्थान" },
  { id: "f2", category: "जयपुर", title: "जयपुर से जुड़ी महत्वपूर्ण खबर और शहर के नए अपडेट", excerpt: "शहर की नागरिक सुविधाओं और प्रमुख गतिविधियों से जुड़े ताजा अपडेट।", image: "/news-placeholder.svg", time: "10 मिनट पहले", location: "जयपुर" },
  { id: "f3", category: "खेल", title: "खेल जगत की प्रमुख खबरें और आज के अहम अपडेट", excerpt: "प्रतियोगिताओं और खेल जगत से जुड़ी महत्वपूर्ण जानकारी।", image: "/news-placeholder.svg", time: "25 मिनट पहले", location: "राजस्थान" },
  { id: "f4", category: "देश", title: "देशभर की प्रमुख खबरें और जरूरी राष्ट्रीय अपडेट", excerpt: "देश के अलग-अलग हिस्सों से दिन की महत्वपूर्ण खबरें।", image: "/news-placeholder.svg", time: "40 मिनट पहले", location: "भारत" },
  { id: "f5", category: "अपराध", title: "पुलिस और प्रशासन से जुड़े महत्वपूर्ण अपडेट", excerpt: "स्थानीय घटनाओं और आधिकारिक अपडेट का संक्षिप्त विवरण।", image: "/news-placeholder.svg", time: "1 घंटा पहले", location: "राजस्थान" }
];

const CATEGORY_ICONS = { भारत: "🇮🇳", विश्व: "🌍", राजस्थान: "🏜️", जयपुर: "🏛️", जोधपुर: "🏰", उदयपुर: "🌊", कोटा: "🎓", अजमेर: "🕌", भीलवाड़ा: "🏭", बीकानेर: "🐪", अलवर: "🌳", अपराध: "🚨", राजनीति: "🏛️", शिक्षा: "📚", नौकरी: "💼", खेल: "🏆", देश: "🇮🇳", दुनिया: "🌍", मनोरंजन: "🎬", बिजनेस: "📈" };

function normalizeSavedItem(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || item._id || "").trim();
  if (!id) return null;
  return {
    ...item,
    id,
    image: mediaUrl(item.image || item.imageUrl || item.thumbnail || ""),
    video: mediaUrl(item.video || item.videoUrl || item.mediaVideo || "")
  };
}
function normalize(item, index = 0) {
  const fallback = FALLBACK[index % FALLBACK.length];
  return {
    id: String(item?._id || item?.id || `api-${index}`), category: item?.category || "राजस्थान", title: item?.title || "ताज़ा खबर",
    excerpt: item?.excerpt || item?.summary || item?.description || "", content: item?.content || item?.body || item?.article || "",
    image: mediaUrl(item?.image || item?.imageUrl || item?.thumbnail || fallback.image), video: mediaUrl(item?.video || item?.videoUrl || item?.mediaVideo || ""),
    time: item?.publishedAt || item?.createdAt ? formatDate(item.publishedAt || item.createdAt) : item?.time || "अभी",
    location: item?.location || item?.city || "राजस्थान", author: item?.author || item?.reporter || "आवाज़ राजस्थान",
    featured: Boolean(item?.featured), latest: item?.latest !== false, breaking: Boolean(item?.breaking), views: Number(item?.views || 0), slug: item?.slug || ""
  };
}
function formatDate(value) { try { const d = new Date(value); if (Number.isNaN(d.getTime())) return "अभी"; return d.toLocaleString("hi-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return "अभी"; } }
function mediaUrl(src) {
  if (typeof src !== "string" || !src.trim()) return "";
  const value = src.trim();
  if (/^(data:|blob:)/i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return value;
  try { return new URL(value, `${API_BASE || window.location.origin}/`).href; } catch { return value; }
}
function safeImage(src) { return mediaUrl(src) || "/news-placeholder.svg"; }
function readStorage(key, fallback = null) { try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function readStorageJson(key, fallback = []) { try { const raw = readStorage(key, ""); if (!raw) return fallback; const value = JSON.parse(raw); return Array.isArray(value) ? value : fallback; } catch { return fallback; } }
function writeStorage(key, value) { try { window.localStorage.setItem(key, value); } catch {} }
function icon(name) {
  const paths = {
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>, search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
    bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>, bookmark: <path d="M6 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18l-6-3-6 3z" />,
    share: <><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.3 10.8 7.4-4.5M8.3 13.2l7.4 4.5" /></>, arrow: <><path d="M5 12h13M13 6l6 6-6 6" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>, home: <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
    moon: <path d="M20.5 15.3A8.5 8.5 0 0 1 8.7 3.5 8.5 8.5 0 1 0 20.5 15.3Z" />, sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    location: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>, clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    refresh: <><path d="M20 11a8.1 8.1 0 0 0-14.9-3L3 11" /><path d="M3 5v6h6" /><path d="M4 13a8.1 8.1 0 0 0 14.9 3L21 13" /><path d="M21 19v-6h-6" /></>
  };
  return <svg className="wa-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}
function Brand() { return <div className="brand" aria-label="आवाज़ राजस्थान"><img className="brand-logo-image" src="/awaazrajasthan-logo.png" alt="आवाज़ राजस्थान" /><div><strong>आवाज़ राजस्थान</strong><small>राजस्थान की अपनी खबर</small></div></div>; }
function safeAdUrl(value) { if (typeof value !== "string" || !value.trim()) return "#"; try { const url = new URL(value, window.location.origin); if (url.protocol !== "http:" && url.protocol !== "https:") return "#"; return url.href; } catch { return "#"; } }function AdSlot({ position = "home_top", className = "" }) {
  const [ad, setAd] = useState(null); const counted = useRef(false);
useEffect(() => { if (!API_BASE) return; let cancelled = false; fetch(`${API_BASE}/api/ads?position=${encodeURIComponent(position)}&device=${window.innerWidth < 768 ? "mobile" : "desktop"}`, { headers: { Accept: "application/json" } }).then(r => r.ok ? r.json() : Promise.reject()).then(data => { const list = Array.isArray(data) ? data : (data.ads || data.data || []); if (!cancelled && list[0]) setAd(list[0]); }).catch(() => {}); return () => { cancelled = true; }; }, [position]);
  useEffect(() => { const id = ad?._id || ad?.id; if (!API_BASE || !id || counted.current) return; counted.current = true; fetch(`${API_BASE}/api/ads/${id}/impression`, { method: "POST" }).catch(() => {}); }, [ad]);
  if (!ad) return <div className={`ad-slot ${className}`}><span>विज्ञापन</span></div>;
  const image = mediaUrl(ad.image || ad.imageUrl || ad.banner); const video = mediaUrl(ad.video || ad.videoUrl || ""); const href = safeAdUrl(ad.link);
  return <a className={`ad-slot ad-live ${className}`} href={href} target="_blank" rel="noreferrer" onClick={() => fetch(`${API_BASE}/api/ads/${ad._id || ad.id}/click`, { method: "POST" }).catch(() => {})}>{video ? <video src={video} poster={image || undefined} controls muted playsInline preload="metadata" aria-label={ad.title || "विज्ञापन वीडियो"} /> : image ? <img src={image} alt={ad.title || "विज्ञापन"} /> : <span>{ad.title || "विज्ञापन"}</span>}</a>;
}
function NewsImage({ item, className = "" }) { const [src, setSrc] = useState(safeImage(item.image)); return <img className={className} src={src} alt={item.title} loading="lazy" decoding="async" onError={() => setSrc("/news-placeholder.svg")} />; }
function Skeletons() { return <div className="skeleton-list">{[1, 2, 3, 4].map(i => <div className="skeleton-card" key={i}><div className="sk-image" /><div className="sk-copy"><i /><i /><i /></div></div>)}</div>; }

function EpaperPage() {
  const [allItems,setAllItems]=useState([]);
  const [items,setItems]=useState([]);
  const [date,setDate]=useState("");
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [calendarOpen,setCalendarOpen]=useState(false);
  const [calendarMonth,setCalendarMonth]=useState(()=>{const d=new Date();return new Date(d.getFullYear(),d.getMonth(),1)});

  function todayKey(){
    const d=new Date();
    return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  }
  function issueKey(value){
    const d=new Date(value);
    if(Number.isNaN(d.getTime())) return "";
    return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  }
  function dateLabel(value){
    const d=new Date(value+"T00:00:00");
    return Number.isNaN(d.getTime())?value:d.toLocaleDateString("hi-IN",{day:"numeric",month:"long",year:"numeric"});
  }
  function monthLabel(d){
    return d.toLocaleDateString("hi-IN",{month:"long",year:"numeric"});
  }
  function openEdition(selectedDate){
    const edition=allItems.find(x=>issueKey(x?.issueDate)===selectedDate);
    if(!edition){setDate(selectedDate);setItems([]);setCalendarOpen(false);return;}
    setDate(selectedDate);
    setItems(allItems.filter(x=>issueKey(x?.issueDate)===selectedDate));
    setCalendarOpen(false);
    const url=mediaUrl(edition.pdf);
    if(url) window.open(url,"_blank","noopener,noreferrer");
  }
  async function getJson(url){
    const response=await fetch(url,{headers:{Accept:"application/json"}});
    const type=response.headers.get("content-type")||"";
    if(!response.ok) throw new Error("ई-पेपर सर्वर से लोड नहीं हो पाया।");
    if(!type.includes("application/json")) throw new Error("ई-पेपर सर्वर ने सही डेटा नहीं भेजा। कृपया थोड़ी देर बाद फिर कोशिश करें।");
    return response.json();
  }

  useEffect(()=>{
    let cancelled=false;
    setLoading(true);
    getJson(API_BASE+"/api/epapers")
      .then(d=>{
        if(cancelled)return;
        const list=Array.isArray(d?.epapers)?d.epapers:[];
        const today=todayKey();
        setAllItems(list);
        setDate(today);
        setItems(list.filter(x=>issueKey(x?.issueDate)===today));
        setCalendarMonth(new Date(Number(today.slice(0,4)),Number(today.slice(5,7))-1,1));
      })
      .catch(e=>{if(!cancelled)setError(e.message||"ई-पेपर लोड नहीं हो पाया।")})
      .finally(()=>{if(!cancelled)setLoading(false)});
    return()=>{cancelled=true};
  },[]);

  const availableDates=[...new Set(allItems.map(x=>issueKey(x?.issueDate)).filter(Boolean))].sort((a,b)=>b.localeCompare(a));
  const availableSet=new Set(availableDates);
  const today=todayKey();
  const selectedToday=date===today;
  const calendarYear=calendarMonth.getFullYear();
  const calendarMonthIndex=calendarMonth.getMonth();
  const firstDay=new Date(calendarYear,calendarMonthIndex,1).getDay();
  const daysInMonth=new Date(calendarYear,calendarMonthIndex+1,0).getDate();
  const calendarCells=Array.from({length:firstDay+daysInMonth},(_,i)=>i<firstDay?null:i-firstDay+1);
  const hindiDays=["रवि","सोम","मंगल","बुध","गुरु","शुक्र","शनि"];

  function chooseCalendarDay(day){
    const key=calendarYear+"-"+String(calendarMonthIndex+1).padStart(2,"0")+"-"+String(day).padStart(2,"0");
    if(availableSet.has(key)) openEdition(key);
  }
  function openToday(){
    if(availableSet.has(today)) openEdition(today);
    else {setDate(today);setItems([]);}
  }

  return <div className="epaper-page">
    <header className="epaper-head">
      <a href="/" className="epaper-brand"><img src="/awaazrajasthan-logo.png" alt="आवाज़ राजस्थान"/><span><b>आवाज़ राजस्थान</b><small>ई-पेपर</small></span></a>
      <a href="/" className="epaper-home">← होम</a>
    </header>

    <main className="epaper-main container">
      <div className="epaper-title">
        <span>📰 DAILY EDITION</span>
        <h1>{selectedToday?"आज का ई-पेपर":"आवाज़ राजस्थान ई-पेपर"}</h1>
        <p>तारीख चुनें और उस दिन का प्रकाशित ई-पेपर सीधे पढ़ें या डाउनलोड करें।</p>
      </div>

      <div className="epaper-date-panel">
        <div className="epaper-date-panel-head">
          <div className="epaper-date-icon">▦</div>
          <div><span>ई-पेपर की तारीख</span><strong>कैलेंडर से तारीख चुनें</strong></div>
          <button type="button" className="epaper-today-btn" onClick={openToday}>▣ &nbsp;आज का ई-पेपर</button>
        </div>

        <button type="button" className="epaper-calendar-trigger" onClick={()=>setCalendarOpen(true)} aria-label="ई-पेपर की तारीख चुनें">
          <span className="calendar-trigger-icon">▣</span>
          <span className="calendar-trigger-date">{date?dateLabel(date):"तारीख चुनें"}</span>
          <span className="calendar-trigger-arrow">⌄</span>
        </button>

        

        {calendarOpen&&<div className="epaper-calendar-overlay" role="dialog" aria-modal="true" aria-label="ई-पेपर कैलेंडर">
          <div className="epaper-calendar">
            <div className="epaper-calendar-top">
              <button type="button" onClick={()=>setCalendarMonth(new Date(calendarYear,calendarMonthIndex-1,1))} aria-label="पिछला महीना">‹</button>
              <strong>{monthLabel(calendarMonth)}</strong>
              <button type="button" onClick={()=>setCalendarMonth(new Date(calendarYear,calendarMonthIndex+1,1))} aria-label="अगला महीना">›</button>
            </div>
            <div className="epaper-weekdays">{hindiDays.map((d,i)=><span key={d} className={i===0||i===6?"weekend":""}>{d}</span>)}</div>
            <div className="epaper-days">{calendarCells.map((day,i)=>{
              if(!day)return <span className="epaper-day empty" key={"e"+i}/>;
              const key=calendarYear+"-"+String(calendarMonthIndex+1).padStart(2,"0")+"-"+String(day).padStart(2,"0");
              const active=availableSet.has(key), isSelected=key===date, isToday=key===today;
              return <button type="button" key={key} disabled={!active} className={"epaper-day "+(active?"available ":"unavailable ")+(isSelected?"selected ":"")+(isToday?"today":"")} onClick={()=>chooseCalendarDay(day)}>{day}</button>;
            })}</div>
            <div className="epaper-calendar-note">ⓘ केवल प्रकाशित ई-पेपर वाली तारीखें चुनी जा सकती हैं।</div>
            <button type="button" className="epaper-calendar-close" onClick={()=>setCalendarOpen(false)}>बंद करें</button>
          </div>
        </div>}
      </div>

      {loading?<div className="epaper-state">ई-पेपर लोड हो रहा है…</div>
      :error?<div className="epaper-state">{error}</div>
      :items.length===0?<div className="epaper-state"><strong>{selectedToday?"आज का ई-पेपर अभी उपलब्ध नहीं है।":"इस तारीख का ई-पेपर उपलब्ध नहीं है।"}</strong><br/><small>कैलेंडर से किसी सक्रिय तारीख को चुनें।</small></div>
      :<div className="epaper-grid">{items.map(x=>{
        const url=mediaUrl(x.pdf);
        const downloadUrl=API_BASE+"/api/epapers/"+x._id+"/download";
        const issue=issueKey(x.issueDate);
        return <article className="epaper-card" key={x._id}>
          <div className="epaper-preview">
            <img className="epaper-watermark" src="/awaazrajasthan-logo.png" alt="" aria-hidden="true"/>
            <div className="epaper-preview-icon">📰</div>
            <strong>{x.title||"आज का ई-पेपर"}</strong>
            <span>{dateLabel(issue)}</span>
          </div>
          <div className="epaper-card-actions">
            <a href={url} target="_blank" rel="noreferrer">📖 पढ़ें</a>
            <a href={downloadUrl} rel="noreferrer">⬇️ डाउनलोड करें</a>
          </div>
        </article>
      })}</div>}
    </main>
  </div>;
}

export default function AppProduction() {
  if(window.location.pathname==="/epaper") return <EpaperPage />;
  const [news, setNews] = useState(FALLBACK), [loading, setLoading] = useState(false), [category, setCategory] = useState("होम"), [feedType, setFeedType] = useState("latest"), [homeButtons, setHomeButtons] = useState(DEFAULT_HOME_BUTTONS), [district, setDistrict] = useState(""), [query, setQuery] = useState(""), [searchOpen, setSearchOpen] = useState(false), [menuOpen, setMenuOpen] = useState(false);
  const [saved, setSaved] = useState(() => {
    try {
      const bookmarks = readStorageJson("awaaz-bookmarks", []).map(x => String(x)).filter(Boolean);
      const items = readStorageJson("awaaz-saved-news", []).map(normalizeSavedItem).filter(Boolean);
      return [...new Set([...bookmarks, ...items.map(x => String(x.id))])];
    } catch { return []; }
  }), [categories, setCategories] = useState(DEFAULT_CATEGORIES), [savedItems, setSavedItems] = useState(() => readStorageJson("awaaz-saved-news", []).map(normalizeSavedItem).filter(Boolean)), [savedOnly, setSavedOnly] = useState(false), [districtMenuOpen, setDistrictMenuOpen] = useState(false), [article, setArticle] = useState(null), [notifyOpen, setNotifyOpen] = useState(false), [notifyState, setNotifyState] = useState("idle"), [toast, setToast] = useState("");
  const [dark, setDark] = useState(() => readStorage("awaaz-theme", "") === "dark"), [showTop, setShowTop] = useState(false), [installPrompt, setInstallPrompt] = useState(null);
  useEffect(() => {
    const section = new URLSearchParams(window.location.search).get("section");
    if (!section) return;
    if (section === "saved") {
      setSavedOnly(true);
      setCategory("होम");
      setDistrict("");
      setSearchOpen(false);
    } else if (section === "search") {
      setSearchOpen(true);
    } else if (section === "latest") {
      setSavedOnly(false);
      setCategory("होम");
      setDistrict("");
      window.setTimeout(() => document.getElementById("main-content")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/home-buttons`, { headers: { Accept: "application/json" } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => { const rows = Array.isArray(data?.buttons) ? data.buttons.filter(x => x && x.active !== false) : []; if (!cancelled && rows.length) setHomeButtons(rows); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/categories`, { headers: { Accept: "application/json" } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        const names = Array.isArray(data?.categories) ? data.categories.filter(Boolean) : [];
        if (!cancelled && names.length) {
          const ordered = names.filter(x => !["होम","सभी जिले","देश","दुनिया"].includes(x));
          const desired = ["भारत","विश्व","राजस्थान"];
          const rest = ordered.filter(x => !desired.includes(x));
          const bhilwaraIndex = rest.indexOf("भीलवाड़ा");
          const insertAt = bhilwaraIndex >= 0 ? bhilwaraIndex + 1 : rest.length;
          rest.splice(insertAt, 0, "सभी जिले");
          setCategories(["होम", ...desired, ...rest]);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const [vapidPublicKey, setVapidPublicKey] = useState(BUILD_VAPID_PUBLIC_KEY);
  useEffect(() => {
    if (vapidPublicKey || !API_BASE) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/notifications/public-key`, { headers: { Accept: "application/json" } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => { if (!cancelled && data?.publicKey) setVapidPublicKey(String(data.publicKey).trim()); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [vapidPublicKey]);

  useEffect(() => { document.documentElement.lang = "hi"; document.documentElement.dataset.theme = dark ? "dark" : "light"; writeStorage("awaaz-theme", dark ? "dark" : "light"); }, [dark]);
  useEffect(() => { const onScroll = () => setShowTop(window.scrollY > 650); const onInstall = e => { e.preventDefault(); setInstallPrompt(e); }; window.addEventListener("scroll", onScroll, { passive: true }); window.addEventListener("beforeinstallprompt", onInstall); return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("beforeinstallprompt", onInstall); }; }, []);
  useEffect(() => {
    if (!API_BASE) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 8000);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: "100" });
      if (category !== "होम") params.set("category", category);
      if (district) params.set("location", district);
      if (query.trim()) params.set("q", query.trim());
      fetch(`${API_BASE}/api/news?${params.toString()}`, { headers: { Accept: "application/json" }, signal: controller.signal })
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(data => {
          const list = Array.isArray(data) ? data : (data.news || data.data || data.articles || []);
          if (!cancelled) setNews(Array.isArray(list) ? list.map(normalize) : []);
        })
        .catch(() => {})
        .finally(() => { if (!cancelled) setLoading(false); });
    }, query.trim() ? 350 : 0);
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(timeoutId); controller.abort(); };
  }, [category, district, query]);
  useEffect(() => { writeStorage("awaaz-bookmarks", JSON.stringify(saved)); writeStorage("awaaz-saved-news", JSON.stringify(savedItems)); }, [saved, savedItems]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 2400); return () => clearTimeout(t); }, [toast]);
  useEffect(() => {
    const hashMatch = window.location.hash.match(/^#news-(.+)$/);
    const pathMatch = window.location.pathname.match(/^\/news\/([^/]+)\/?$/);
    if (!hashMatch && !pathMatch) return;
    let id = (hashMatch || pathMatch)[1];
    try { id = decodeURIComponent(id); } catch {}
    const found = news.find(n => String(n.id) === id || String(n.slug || "") === id);
    if (found) {
      openArticle(found, false);
      return;
    }
    if (!API_BASE || !id || String(id).startsWith("f")) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/news/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        if (cancelled) return;
        const item = data?.news || data?.data || data?.article || data;
        if (item?.title) openArticle(normalize(item, 0), false);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [news]);

  const breaking = useMemo(() => news.filter(n => n.breaking).slice(0, 8).length ? news.filter(n => n.breaking).slice(0, 8) : news.slice(0, 6), [news]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (savedOnly) return savedItems.filter(n => !q || [n.title,n.excerpt,n.category,n.location,n.author].join(" ").toLowerCase().includes(q));
    return news.filter(n => {
      const categoryMatch = category === "होम" || n.category === category || n.location === category;
      const districtMatch = !district || n.location === district || n.category === district || `${n.title} ${n.excerpt}`.includes(district);
      const textMatch = !q || [n.title,n.excerpt,n.category,n.location,n.author].join(" ").toLowerCase().includes(q);
      const feedMatch = feedType === "latest" ? n.latest !== false : feedType === "breaking" ? Boolean(n.breaking) : feedType === "video" ? Boolean(n.video) : feedType === "photo" ? Boolean(n.image) : true;
      return categoryMatch && districtMatch && textMatch && feedMatch;
    });
  }, [news, savedItems, category, district, query, savedOnly, feedType]);
  const featured = filtered.find(n => n.featured) || filtered[0] || null, secondary = filtered.filter(n => n.id !== featured?.id).slice(0, 3), latest = filtered.filter(n => n.id !== featured?.id && n.latest !== false), trending = [...news].sort((a, b) => b.views - a.views).slice(0, 5);

  function selectCategory(value) { if (value === "सभी जिले") { setDistrictMenuOpen(true); setCategory("होम"); setDistrict(""); setSavedOnly(false); setMenuOpen(true); setSearchOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); return; } setDistrictMenuOpen(false); setCategory(value); setDistrict(""); setSavedOnly(false); setMenuOpen(false); setSearchOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); }
  function toggleSave(id) { const key = String(id); const exists = saved.includes(key); if (exists) { const nextSaved = saved.filter(x => String(x) !== key); const nextItems = savedItems.filter(x => String(x.id || x._id) !== key); setSaved(nextSaved); setSavedItems(nextItems); writeStorage("awaaz-bookmarks", JSON.stringify(nextSaved)); writeStorage("awaaz-saved-news", JSON.stringify(nextItems)); setToast("खबर सेव से हटाई गई"); } else { const item = news.find(n => String(n.id || n._id) === key) || (article && String(article.id || article._id) === key ? article : null); if (!item) return; const nextSaved = [key, ...saved.filter(x => String(x) !== key)]; const nextItems = [item, ...savedItems.filter(x => String(x.id || x._id) !== key)]; setSaved(nextSaved); setSavedItems(nextItems); writeStorage("awaaz-bookmarks", JSON.stringify(nextSaved)); writeStorage("awaaz-saved-news", JSON.stringify(nextItems)); setToast("खबर सेव हो गई"); } }
  async function share(item) { const slugOrId = encodeURIComponent(item.slug || item.id), url = `${window.location.origin}/news/${slugOrId}`; try { if (navigator.share) await navigator.share({ title: item.title, text: item.excerpt, url }); else { await navigator.clipboard.writeText(url); setToast("लिंक कॉपी हो गया"); } } catch {} }
  async function openArticle(item, updateHash = true) { setArticle(item); setMenuOpen(false); if (updateHash) window.history.replaceState(null, "", `#news-${encodeURIComponent(item.id)}`); window.scrollTo({ top: 0, behavior: "smooth" }); document.title = `${item.title} | आवाज़ राजस्थान`; setMeta("description", item.excerpt || "राजस्थान की ताज़ा खबरें — आवाज़ राजस्थान"); setMeta("og:title", item.title, true); setMeta("og:description", item.excerpt || "राजस्थान की ताज़ा खबरें", true); if (!API_BASE || String(item.id).startsWith("f")) return; try { const r = await fetch(`${API_BASE}/api/news/${encodeURIComponent(item.id)}`, { headers: { Accept: "application/json" } }); if (!r.ok) return; const data = await r.json(), n = data.news || data.data || data.article || data; setArticle(prev => prev ? { ...prev, ...normalize(n, 0) } : prev); } catch {} }
  function closeArticle() { setArticle(null); const target = window.location.pathname.startsWith("/news/") ? "/" : (window.location.pathname + window.location.search); window.history.replaceState(null, "", target); document.title = "आवाज़ राजस्थान | Rajasthan News"; setMeta("description", "आवाज़ राजस्थान — राजस्थान की ताज़ा, स्थानीय और भरोसेमंद खबरें।"); }

  async function enableNotifications() {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) { setNotifyState("error"); setToast("इस डिवाइस पर पुश नोटिफिकेशन उपलब्ध नहीं है"); return; }
    if (!vapidPublicKey) { setNotifyState("error"); setToast("नोटिफिकेशन सेवा अभी कॉन्फ़िगर नहीं है"); return; }
    if (!API_BASE) { setNotifyState("error"); setToast("नोटिफिकेशन सर्वर अभी कॉन्फ़िगर नहीं है"); return; }
    setNotifyState("loading");
    try {
      if (Notification.permission === "denied") { setNotifyState("error"); setToast("Chrome में इस वेबसाइट के Notifications Block हैं। Site settings में जाकर Notifications → Allow करें, फिर पेज Reload करें।"); return; }
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") throw new Error("permission");
      const reg = await navigator.serviceWorker.register("/sw.js");
      let subscription = await reg.pushManager.getSubscription();
      if (!subscription) {
        const pad = "=".repeat((4 - vapidPublicKey.length % 4) % 4);
        const base64 = (vapidPublicKey + pad).replace(/-/g, "+").replace(/_/g, "/");
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      }
      const response = await fetch(`${API_BASE}/api/notifications/subscribe`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(subscription) });
      if (!response.ok) throw new Error("subscribe-api");
      setNotifyState("enabled"); setToast("ब्रेकिंग न्यूज़ नोटिफिकेशन चालू हो गए");
    } catch (error) {
      setNotifyState("error");
      setToast(error?.message === "subscribe-api" ? "नोटिफिकेशन सर्वर से कनेक्शन नहीं हो पाया" : error?.message === "permission" ? "नोटिफिकेशन की अनुमति नहीं मिली। Chrome में Notifications → Allow करें।" : "नोटिफिकेशन चालू नहीं हो पाए। फिर से कोशिश करें।");
    }
  }
  async function installApp() { if (!installPrompt) return; try { await installPrompt.prompt(); await installPrompt.userChoice; } catch {} finally { setInstallPrompt(null); } }
  function setMeta(name, content, property = false) { if (!content) return; const attr = property ? "property" : "name"; let el = document.head.querySelector(`meta[${attr}="${name}"]`); if (!el) { el = document.createElement("meta"); el.setAttribute(attr, name); document.head.appendChild(el); } el.setAttribute("content", content); }

  return <div className="awaaz-app">
    <a className="skip-link" href="#main-content">मुख्य सामग्री पर जाएँ</a>
    <header className="site-header"><div className="header-top container"><button className="icon-btn menu-btn" onClick={() => setMenuOpen(true)} aria-label="मेनू खोलें">{icon("menu")}</button><Brand /><div className="header-actions"><button className="icon-btn" onClick={() => setSearchOpen(v => !v)} aria-label="खोजें">{icon("search")}</button><button className="icon-btn notification-btn" onClick={() => setNotifyOpen(true)} aria-label="नोटिफिकेशन">{icon("bell")}</button><button className="icon-btn theme-btn" onClick={() => setDark(v => !v)} aria-label="थीम बदलें">{icon(dark ? "sun" : "moon")}</button></div></div>
      <nav className="category-nav" aria-label="मुख्य श्रेणियाँ"><div className="container category-scroll">{categories.map(c => <button key={c} className={category === c && !district ? "active" : ""} onClick={() => selectCategory(c)}>{c === "होम" ? icon("home") : CATEGORY_ICONS[c] || "•"}<span>{c}</span></button>)}</div></nav>
    </header>
    {searchOpen && <section className="search-panel container"><div className="search-box"><span>{icon("search")}</span><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="खबर, शहर, जिला या विषय खोजें..." /><button onClick={() => { setQuery(""); setSearchOpen(false); }}>×</button></div><div className="search-hints"><span>लोकप्रिय:</span>{["जयपुर", "राजस्थान", "अपराध", "खेल", "सरकार"].map(x => <button key={x} onClick={() => { setQuery(x); setSearchOpen(true); }}>{x}</button>)}</div></section>}
    <div className="breaking-bar"><div className="container breaking-inner"><b>🔴 ब्रेकिंग</b><div className="ticker-track">{breaking.map((n, i) => <button key={`${n.id}-${i}`} onClick={() => openArticle(n)}>{n.title}</button>)}</div></div></div>
    <main id="main-content" className="container main-content"><AdSlot position="home_top" className="top-ad" /><section className="welcome-row"><div><p className="eyebrow">RAJASTHAN • TODAY</p><h1>{district ? `${district} की खबरें` : category === "होम" ? "राजस्थान की ताज़ा खबरें" : `${category} की खबरें`}</h1><p>तेज़, स्थानीय और जरूरी खबरें — एक ही जगह।</p></div><button className="refresh-btn" onClick={() => window.location.reload()}>{icon("refresh")} ताज़ा करें</button></section>
      <section className="quick-tools" aria-label="त्वरित सुविधाएँ"><button onClick={() => { setSavedOnly(v => !v); setCategory("होम"); setDistrict(""); }} className={savedOnly ? "selected" : ""}>{icon("bookmark")} <span>मेरी सेव खबरें</span></button><a href={E_PAPER_URL}><span>📰</span><span>ई-पेपर</span></a><button onClick={() => setNotifyOpen(true)}>🔔 <span>नोटिफिकेशन</span></button>{installPrompt && <button onClick={installApp}>📲 <span>ऐप इंस्टॉल करें</span></button>}</section><section className="news-type-nav" aria-label="न्यूज़ सेक्शन">{homeButtons.map((button,i)=><button key={button._id||button.action||i} className={feedType===button.action?"active":""} onClick={()=>{setFeedType(button.action||"latest");if(button.action==="category"&&button.category){setCategory(button.category);setDistrict("");setSavedOnly(false);}}}>{button.icon||"📰"} <span>{button.label}</span></button>)}</section>
      {loading ? <Skeletons /> : featured ? <><section className="hero-grid"><article className="hero-card" onClick={() => openArticle(featured)}><div className="hero-image-wrap"><NewsImage item={featured} className="hero-image" />{featured.breaking && <span className="breaking-pill">ब्रेकिंग</span>}</div><div className="hero-copy"><span className="news-kicker">{featured.category} • {featured.location}</span><h2>{featured.title}</h2><p>{featured.excerpt}</p><div className="card-meta"><span>{icon("clock")} {featured.time}</span><button onClick={e => { e.stopPropagation(); toggleSave(featured.id); }} className={saved.includes(String(featured.id)) ? "saved" : ""} aria-label={saved.includes(String(featured.id)) ? "सेव की गई खबर" : "खबर सेव करें"} aria-pressed={saved.includes(String(featured.id))} title={saved.includes(String(featured.id)) ? "सेव की गई" : "खबर सेव करें"}>{icon("bookmark")}</button><button onClick={e => { e.stopPropagation(); share(featured); }}>{icon("share")}</button></div></div></article><div className="secondary-grid">{secondary.map(item => <article className="compact-card" key={item.id} onClick={() => openArticle(item)}><NewsImage item={item} /><div><span className="news-kicker">{item.category}</span><h3>{item.title}</h3><div className="compact-card-footer"><small>{item.time}</small><button aria-label="खबर शेयर करें" title="खबर शेयर करें" onClick={e => { e.stopPropagation(); share(item); }}>{icon("share")}</button></div></div></article>)}</div></section>
        <AdSlot position="home_inline" className="mid-ad" /><div className="content-layout"><section className="latest-section"><div className="section-heading"><div><span className="section-label">LATEST</span><h2>ताज़ा खबरें</h2></div><span className="count">{filtered.length} खबरें</span></div>{latest.length ? <div className="news-list">{latest.map(item => <article className="news-row" key={item.id} onClick={() => openArticle(item)}><NewsImage item={item} /><div className="news-row-copy"><div className="row-top"><span>{item.category}</span><small>{item.location}</small></div><h3>{item.title}</h3>{item.excerpt && <p>{item.excerpt}</p>}<div className="row-bottom"><small>{item.time}</small><div><button onClick={e => { e.stopPropagation(); toggleSave(item.id); }} className={saved.includes(String(item.id)) ? "saved" : ""} aria-label={saved.includes(String(item.id)) ? "सेव की गई खबर" : "खबर सेव करें"} aria-pressed={saved.includes(String(item.id))} title={saved.includes(String(item.id)) ? "सेव की गई" : "खबर सेव करें"}>{icon("bookmark")}</button><button onClick={e => { e.stopPropagation(); share(item); }}>{icon("share")}</button></div></div></div></article>)}</div> : <div className="empty-state"><strong>{savedOnly ? "अभी कोई खबर सेव नहीं है" : "इस फिल्टर में कोई खबर नहीं मिली"}</strong>{savedOnly ? <small>खबर के 🔖 बुकमार्क बटन पर टैप करके उसे यहाँ सेव करें।</small> : null}<button onClick={() => { setQuery(""); setDistrict(""); setSavedOnly(false); setCategory("होम"); }}>सभी खबरें देखें</button></div>}</section>
          <aside className="sidebar"><AdSlot position="sidebar" className="side-ad" /><div className="side-card"><div className="side-title"><h3>🔥 ट्रेंडिंग</h3></div>{trending.map((item, i) => <button className="trend-item" key={item.id} onClick={() => openArticle(item)}><b>{String(i + 1).padStart(2, "0")}</b><span>{item.title}</span></button>)}</div><div className="side-card"><div className="side-title"><h3>📍 जिला चुनें</h3></div><div className="district-select"><select value={district} onChange={e => { setDistrict(e.target.value); setCategory("होम"); window.scrollTo({ top: 0, behavior: "smooth" }); }}><option value="">सभी जिले</option>{DISTRICTS.map(d => <option key={d}>{d}</option>)}</select></div></div></aside></div>
        <section className="district-section"><div className="section-heading"><div><span className="section-label">RAJASTHAN</span><h2>जिलेवार खबरें</h2></div></div><div className="district-grid">{DISTRICTS.map(d => <button key={d} onClick={() => { setDistrict(d); setCategory("होम"); window.scrollTo({ top: 0, behavior: "smooth" }); }} className={district === d ? "active" : ""}>{d}</button>)}</div></section></> : <div className="empty-state"><strong>खबरें उपलब्ध नहीं हैं</strong><button onClick={() => window.location.reload()}>फिर कोशिश करें</button></div>}
    </main>
    <footer className="site-footer"><div className="container footer-grid"><div><Brand /><p>आवाज़ राजस्थान — राजस्थान की ताज़ा, स्थानीय और जरूरी खबरों का डिजिटल न्यूज़ प्लेटफॉर्म।</p></div><div><h4>खबरें</h4><button onClick={() => selectCategory("राजस्थान")}>राजस्थान</button><button onClick={() => selectCategory("अपराध")}>अपराध</button><button onClick={() => selectCategory("राजनीति")}>राजनीति</button><button onClick={() => selectCategory("खेल")}>खेल</button></div><div><h4>जरूरी लिंक</h4><a href="/legal.html#about">About Us / हमारे बारे में</a><a href="/legal.html#contact">Contact Us / संपर्क करें</a><a href="/legal.html#privacy">Privacy Policy</a><a href="/legal.html#terms">Terms & Conditions</a><a href="/legal.html#disclaimer">Disclaimer</a><a href="/legal.html#grievance">Grievance / शिकायत</a><a href="/legal.html#editorial">Editorial Policy / संपादकीय नीति</a><a href="/legal.html#copyright">Copyright</a><a href={E_PAPER_URL}>ई-पेपर</a><a href="/ad-booking.html">विज्ञापन बुक करें</a><a href="/admin">एडमिन</a><a href="/robots.txt">Robots</a></div></div><div className="footer-bottom container">© {new Date().getFullYear()} आवाज़ राजस्थान • सभी अधिकार सुरक्षित</div></footer>
    <nav className="mobile-bottom-nav" aria-label="मोबाइल नेविगेशन"><button className={category === "होम" && !savedOnly ? "active" : ""} onClick={() => selectCategory("होम")}>{icon("home")}<span>होम</span></button><button onClick={() => setSearchOpen(true)}>{icon("search")}<span>खोजें</span></button><button className={savedOnly ? "active" : ""} onClick={() => { setSavedOnly(true); setCategory("होम"); setDistrict(""); }}>{icon("bookmark")}<span>सेव</span></button><button onClick={() => setNotifyOpen(true)}>{icon("bell")}<span>अलर्ट</span></button><button onClick={() => setMenuOpen(true)}>{icon("menu")}<span>मेनू</span></button></nav>
    {menuOpen && <div className="overlay" onClick={() => setMenuOpen(false)}><aside className="drawer" onClick={e => e.stopPropagation()}><div className="drawer-head"><Brand /><button className="icon-btn" onClick={() => setMenuOpen(false)}>{icon("close")}</button></div><div className="drawer-links"><h4>श्रेणियां</h4>{categories.slice(1).map(c => c === "सभी जिले" ? <React.Fragment key={c}><button className={districtMenuOpen ? "district-menu-trigger active" : "district-menu-trigger"} onClick={() => { setDistrictMenuOpen(v => !v); setCategory("होम"); setDistrict(""); }}>{"📍"} {c}<span className="district-chevron">{districtMenuOpen ? "⌃" : "⌄"}</span></button>{districtMenuOpen && <div className="drawer-districts"><p>राजस्थान के सभी जिले</p>{DISTRICTS.map(d => <button key={d} onClick={() => { setDistrict(d); setCategory("होम"); setSavedOnly(false); setDistrictMenuOpen(false); setMenuOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); }}>📍 {d}</button>)}</div>}</React.Fragment> : <button key={c} onClick={() => selectCategory(c)}>{CATEGORY_ICONS[c] || "•"} {c}</button>)}<h4>आपके लिए</h4><button onClick={() => { setSavedOnly(true); setCategory("होम"); setMenuOpen(false); }}>🔖 सेव खबरें</button><a href={E_PAPER_URL}>📰 ई-पेपर</a><a href="/ad-booking.html">📢 विज्ञापन बुक करें</a><a href="/legal.html#about">ℹ️ हमारे बारे में</a><a href="/legal.html#contact">📞 संपर्क करें</a><a href="/legal.html#privacy">🔒 Privacy Policy</a><a href="/legal.html#terms">📄 Terms & Conditions</a><a href="/legal.html#disclaimer">⚖️ Disclaimer</a><a href="/legal.html#grievance">🇮🇳 Grievance / शिकायत</a><a href="/legal.html#editorial">📰 संपादकीय नीति</a><a href="/legal.html#copyright">© Copyright</a><a href="/admin">⚙️ एडमिन</a></div></aside></div>}
    {notifyOpen && <div className="modal-backdrop" onClick={() => setNotifyOpen(false)}><div className="notify-modal" onClick={e => e.stopPropagation()}><button className="modal-close" onClick={() => setNotifyOpen(false)}>{icon("close")}</button><div className="notify-icon">🔔</div><h2>ब्रेकिंग न्यूज़ अलर्ट</h2><p>राजस्थान की बड़ी और जरूरी खबरें सीधे आपके डिवाइस पर पाएं।</p>{notifyState === "enabled" ? <div className="success-box">✓ नोटिफिकेशन चालू हैं</div> : <button className="primary-btn" disabled={notifyState === "loading"} onClick={enableNotifications}>{notifyState === "loading" ? "चालू हो रहा है..." : "नोटिफिकेशन चालू करें"}</button>}<small>आप किसी भी समय ब्राउज़र की सेटिंग से अनुमति बदल सकते हैं।</small></div></div>}
    {article && <div className="article-backdrop" onClick={closeArticle}><article className="article-modal" onClick={e => e.stopPropagation()}><div className="article-toolbar"><button onClick={closeArticle}>{icon("arrow")} वापस</button><div><button onClick={() => toggleSave(article.id)} className={saved.includes(String(article.id)) ? "saved" : ""} aria-label={saved.includes(String(article.id)) ? "सेव की गई खबर" : "खबर सेव करें"} aria-pressed={saved.includes(String(article.id))} title={saved.includes(String(article.id)) ? "सेव की गई" : "खबर सेव करें"}>{icon("bookmark")}</button><button onClick={() => share(article)}>{icon("share")}</button></div></div><NewsImage item={article} className="article-cover" />{article.video && <div className="article-video"><video src={article.video} controls playsInline preload="metadata" poster={safeImage(article.image)} /></div>}<div className="article-content"><span className="news-kicker">{article.category} • {article.location}</span><h1>{article.title}</h1><div className="article-byline"><span>{article.author}</span><span>{article.time}</span></div><AdSlot position="article_top" className="article-ad" />{article.excerpt && <p className="article-lead">{article.excerpt}</p>}<div className="article-body">{article.content ? article.content.split(/\r?\n+/).filter(Boolean).map((p, i) => <p key={i}>{p.replace(/<[^>]+>/g, "")}</p>) : <p>इस खबर का विस्तृत विवरण जल्द अपडेट किया जाएगा।</p>}</div><AdSlot position="article_bottom" className="article-ad" /><div className="related"><h3>यह खबरें भी पढ़ें</h3>{news.filter(n => n.id !== article.id && (n.category === article.category || n.location === article.location)).slice(0, 4).map(n => <button key={n.id} onClick={() => openArticle(n)}><NewsImage item={n} /><span>{n.title}</span></button>)}</div></div></article></div>}
    {showTop && <button className="to-top" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>↑</button>}{toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}