function shortCodeFromId(id){try{const hex=String(id||"").trim();if(!/^[a-fA-F0-9]{24}$/.test(hex))return "";let bin="";for(let i=0;i<24;i+=2)bin+=String.fromCharCode(parseInt(hex.slice(i,i+2),16));return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}catch{return "";}}
function idFromShortCode(code){try{const s=String(code||"").replace(/-/g,"+").replace(/_/g,"/");const bin=atob(s);if(bin.length!==12)return "";let hex="";for(let i=0;i<bin.length;i++)hex+=bin.charCodeAt(i).toString(16).padStart(2,"0");return /^[a-fA-F0-9]{24}$/.test(hex)?hex:"";}catch{return "";}}

export default async function handler(req,res){
  let slug=String(req.query?.slug||"").split("/")[0];
  const decoded=idFromShortCode(slug); if(decoded) slug=decoded;
  if(!slug)return res.status(400).send("Missing news slug");
  const origin="https://"+String(req.headers.host||"awaazrajasthan.vercel.app").replace(/\/$/,"");
  const apiBase=String(process.env.PUBLIC_API_URL||"https://awaazrajasthan.onrender.com").replace(/\/$/,"");
  const clean=(v)=>String(v??"").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
  const esc=(v)=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const imageFrom=(v)=>{if(typeof v==="string")return v.trim();if(Array.isArray(v)){for(const item of v){const x=imageFrom(item);if(x)return x;}return "";}if(v&&typeof v==="object"){for(const k of ["url","src","secure_url","publicUrl","image","original","large"]){if(v[k]){const x=imageFrom(v[k]);if(x)return x;}}}return "";};
  try{
    let api=await fetch(apiBase+"/api/news/"+encodeURIComponent(slug)+"/preview",{headers:{accept:"application/json"}});
    if(!api.ok) api=await fetch(apiBase+"/api/news/"+encodeURIComponent(slug),{headers:{accept:"application/json"}});
    if(!api.ok)return res.status(api.status).send("News not found");
    const payload=await api.json();const n=payload.news||payload.data||{};
    const title=clean(n.title)||"आवाज़ राजस्थान | Rajasthan News";
    const description=(clean(n.excerpt)||clean(n.content)||"राजस्थान की ताज़ा, स्थानीय और जरूरी खबरें।").slice(0,300);
    const raw=imageFrom(n.image);const image=raw?new URL(raw,origin).href:new URL("/og-default.svg",origin).href;
    const videoRaw=imageFrom(n.video || n.videoUrl || n.mediaVideo);const video=videoRaw?new URL(videoRaw,origin).href:"";
    const canonical=origin+"/s/"+encodeURIComponent(slug);
    const baseHtml=await (await fetch(origin+"/index.html",{cache:"no-store"})).text();
    const remove=/<meta[^>]+(?:name|property)=["'](?:description|og:[^"']+|twitter:[^"']+|article:[^"']+)["'][^>]*>/gi;
    let out=baseHtml.replace(remove,"").replace(/<title>[\s\S]*?<\/title>/i,"");
    const tags="<title>"+esc(title)+" | आवाज़ राजस्थान</title>"+"\n  <meta name=\"description\" content=\""+esc(description)+"\">"+"\n  <meta property=\"og:site_name\" content=\"आवाज़ राजस्थान\">"+"\n  <meta property=\"og:locale\" content=\"hi_IN\">"+"\n  <meta property=\"og:type\" content=\"article\">"+"\n  <meta property=\"og:title\" content=\""+esc(title)+"\">"+"\n  <meta property=\"og:description\" content=\""+esc(description)+"\">"+"\n  <meta property=\"og:url\" content=\""+esc(canonical)+"\">"+"\n  <meta property=\"og:image\" content=\""+esc(image)+"\">"+"\n  <meta property=\"og:image:alt\" content=\""+esc(title)+"\">"+(video?"\n  <meta property=\"og:video\" content=\""+esc(video)+"\">\n  <meta property=\"og:video:secure_url\" content=\""+esc(video)+"\">\n  <meta property=\"og:video:type\" content=\"video/mp4\">":"")+"\n  <meta name=\"twitter:card\" content=\"summary_large_image\">"+"\n  <meta name=\"twitter:title\" content=\""+esc(title)+"\">"+"\n  <meta name=\"twitter:description\" content=\""+esc(description)+"\">"+"\n  <meta name=\"twitter:image\" content=\""+esc(image)+"\">"+"\n  <meta name=\"twitter:image:alt\" content=\""+esc(title)+"\">"+"\n  <link rel=\"canonical\" href=\""+esc(canonical)+"\">";
    out=out.replace(/<head>/i,"<head>\n  "+tags);
    res.setHeader("Cache-Control","public, s-maxage=300, stale-while-revalidate=900");
    res.setHeader("Content-Type","text/html; charset=utf-8");
    return res.status(200).send(out);
  }catch(e){console.error("share preview error",e);return res.status(500).send("Share preview error");}
}
