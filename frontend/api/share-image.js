function idFromShortCode(code){try{const s=String(code||"").replace(/-/g,"+").replace(/_/g,"/");const bin=atob(s);if(bin.length!==12)return "";let hex="";for(let i=0;i<bin.length;i++)hex+=bin.charCodeAt(i).toString(16).padStart(2,"0");return /^[a-fA-F0-9]{24}$/.test(hex)?hex:"";}catch{return "";}}
function imageFrom(v){
  if(typeof v==="string")return v.trim();
  if(Array.isArray(v)){for(const item of v){const x=imageFrom(item);if(x)return x;}return "";}
  if(v&&typeof v==="object"){
    for(const k of ["url","src","secure_url","publicUrl","image","original","large","medium","thumbnail","poster","posterUrl","thumbnailUrl"]){if(v[k]){const x=imageFrom(v[k]);if(x)return x;}}
  }
  return "";
}
export default async function handler(req,res){
  const code=String(req.query?.code||req.query?.slug||"").split("/")[0];
  const decoded=idFromShortCode(code); const id=decoded||code;
  if(!id)return res.status(400).send("Missing news code");
  const apiBase=String(process.env.PUBLIC_API_URL||"https://awaazrajasthan.onrender.com").replace(/\/$/,"");
  try{
    let api=await fetch(apiBase+"/api/news/"+encodeURIComponent(id)+"/preview",{headers:{accept:"application/json"}});
    if(!api.ok)api=await fetch(apiBase+"/api/news/"+encodeURIComponent(id),{headers:{accept:"application/json"}});
    if(!api.ok)return res.status(api.status).end();
    const payload=await api.json(); const n=payload.news||payload.data||payload.article||{};
    const raw=imageFrom(n.image||n.images||n.photos||n.gallery||n.thumbnail||n.videoThumbnail||n.videoPoster||n.poster);
    if(!raw)return res.status(404).end();
    const media=raw.startsWith("/")?apiBase+raw:raw;
    const img=await fetch(media,{headers:{accept:"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"}});
    if(!img.ok)return res.status(img.status||404).end();
    res.setHeader("Content-Type",img.headers.get("content-type")||"image/jpeg");
    res.setHeader("Cache-Control","public, s-maxage=86400, stale-while-revalidate=604800");
    const len=img.headers.get("content-length"); if(len)res.setHeader("Content-Length",len);
    const body=Buffer.from(await img.arrayBuffer());\n    return res.status(200).send(body);
  }catch(e){console.error("share image error",e);return res.status(404).end();}
}
