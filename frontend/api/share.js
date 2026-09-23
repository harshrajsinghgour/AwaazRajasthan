function shortCodeFromId(id){try{const hex=String(id||"").trim();if(!/^[a-fA-F0-9]{24}$/.test(hex))return "";let bin="";for(let i=0;i<24;i+=2)bin+=String.fromCharCode(parseInt(hex.slice(i,i+2),16));return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}catch{return "";}}
function idFromShortCode(code){try{const s=String(code||"").replace(/-/g,"+").replace(/_/g,"/");const bin=atob(s);if(bin.length!==12)return "";let hex="";for(let i=0;i<bin.length;i++)hex+=bin.charCodeAt(i).toString(16).padStart(2,"0");return /^[a-fA-F0-9]{24}$/.test(hex)?hex:"";}catch{return "";}}

export default async function handler(req,res){
  const sharePath=String(req.query?.slug||"").split("/")[0];
  let slug=sharePath; const decoded=idFromShortCode(slug); if(decoded) slug=decoded;
  if(!slug)return res.status(400).send("Missing news slug");

  const origin="https://"+String(req.headers.host||"awaazrajasthan.vercel.app").replace(/\/$/,"");
  const apiBase=String(process.env.PUBLIC_API_URL||"https://awaazrajasthan.onrender.com").replace(/\/$/,"");

  const clean=(v)=>String(v??"").replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ").replace(/\s+/g," ").trim();
  const esc=(v)=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const imageFrom=(v)=>{
    if(typeof v==="string")return v.trim();
    if(Array.isArray(v)){for(const item of v){const x=imageFrom(item);if(x)return x;}return "";}
    if(v&&typeof v==="object"){
      for(const k of ["url","src","secure_url","publicUrl","image","original","large","medium","thumbnail","poster","posterUrl","thumbnailUrl"]){
        if(v[k]){const x=imageFrom(v[k]);if(x)return x;}
      }
    }
    return "";
  };
  const firstMediaImage=(n)=>{
    const candidates=[
      n?.image,n?.images,n?.photos,n?.gallery,n?.mediaImages,n?.thumbnail,n?.thumbnailUrl,
      n?.videoThumbnail,n?.videoPoster,n?.videoPosterUrl,n?.poster,n?.posterUrl,
      n?.video?.thumbnail,n?.video?.poster
    ];
    for(const candidate of candidates){const x=imageFrom(candidate);if(x)return x;}
    return "";
  };
  const firstVideo=(n)=>imageFrom(n?.video||n?.videoUrl||n?.mediaVideo||n?.media?.video||n?.media?.videoUrl);

  try{
    let api=await fetch(apiBase+"/api/news/"+encodeURIComponent(slug)+"/preview",{headers:{accept:"application/json"}});
    if(!api.ok) api=await fetch(apiBase+"/api/news/"+encodeURIComponent(slug),{headers:{accept:"application/json"}});
    if(!api.ok)return res.status(api.status).send("News not found");

    const payload=await api.json();
    const n=payload.news||payload.data||payload.article||{};
    const title=clean(n.title)||"आवाज़ राजस्थान | Rajasthan News";

    const rawDescription=clean(n.excerpt)||clean(n.summary)||clean(n.description)||clean(n.content);
    const description=(rawDescription||"राजस्थान की ताज़ा, स्थानीय और जरूरी खबरें।").slice(0,320);
    const rawImage=firstMediaImage(n);
    const image=rawImage?origin+"/api/share-image?code="+encodeURIComponent(sharePath):new URL("/og-default.svg",origin).href;
    const video=firstVideo(n);
    const canonical=origin+"/news/"+encodeURIComponent(sharePath);

    const baseResponse=await fetch(origin+"/index.html",{cache:"no-store"});
    const baseHtml=await baseResponse.text();

    const remove=/<meta[^>]+(?:name|property)=[\"'](?:description|og:[^\"']+|twitter:[^\"']+|article:[^\"']+)[\"'][^>]*>/gi;
    let out=baseHtml.replace(remove,"").replace(/<title>[\s\S]*?<\/title>/i,"");

    const tags=[
      "<title>"+esc(title)+" | आवाज़ राजस्थान</title>",
      "<meta name=\"description\" content=\""+esc(description)+"\">",
      "<meta property=\"og:site_name\" content=\"आवाज़ राजस्थान\">",
      "<meta property=\"og:locale\" content=\"hi_IN\">",
      "<meta property=\"og:type\" content=\"article\">",
      "<meta property=\"og:title\" content=\""+esc(title)+"\">",
      "<meta property=\"og:description\" content=\""+esc(description)+"\">",
      "<meta property=\"og:url\" content=\""+esc(canonical)+"\">",
      "<meta property=\"og:image\" content=\""+esc(image)+"\">",
      "<meta property=\"og:image:secure_url\" content=\""+esc(image)+"\">\n      <meta property=\"og:image:width\" content=\"1200\">\n      <meta property=\"og:image:height\" content=\"630\">",
      "<meta property=\"og:image:alt\" content=\""+esc(title)+"\">",
      "",
      "<meta name=\"twitter:card\" content=\"summary_large_image\">",
      "<meta name=\"twitter:title\" content=\""+esc(title)+"\">",
      "<meta name=\"twitter:description\" content=\""+esc(description)+"\">",
      "<meta name=\"twitter:image\" content=\""+esc(image)+"\">",
      "<meta name=\"twitter:image:alt\" content=\""+esc(title)+"\">",
      "<link rel=\"canonical\" href=\""+esc(canonical)+"\">"
    ];

    const publishedAt=n?.publishedAt||n?.createdAt||new Date().toISOString();
    const modifiedAt=n?.updatedAt||publishedAt;
    const articleSchema={
      "@context":"https://schema.org",
      "@type":"NewsArticle",
      "headline":title.slice(0,220),
      "description":description,
      "datePublished":new Date(publishedAt).toISOString(),
      "dateModified":new Date(modifiedAt).toISOString(),
      "mainEntityOfPage":{"@type":"WebPage","@id":canonical},
      "author":{"@type":"Organization","name":clean(n.author)||"आवाज़ राजस्थान"},
      "publisher":{"@type":"Organization","name":"आवाज़ राजस्थान","logo":{"@type":"ImageObject","url":origin+"/awaazrajasthan-logo.png"}},
      "image":[image]
    };
    tags.push("<script type=\"application/ld+json\">"+JSON.stringify(articleSchema).replace(/</g,"\\u003c")+"</script>");
    tags.push("<meta property=\"article:section\" content=\""+esc(n.category||"राजस्थान")+"\">");
    const visibleText=clean(n.content||n.excerpt||"").slice(0,12000);
    const noscript="<noscript><article><h1>"+esc(title)+"</h1><p>"+esc(description)+"</p><div>"+esc(visibleText)+"</div></article></noscript>";
    if(video){
      tags.push("<meta property=\"og:video\" content=\""+esc(new URL(video,origin).href)+"\">");
      tags.push("<meta property=\"og:video:secure_url\" content=\""+esc(new URL(video,origin).href)+"\">");
      tags.push("<meta property=\"og:video:type\" content=\"video/mp4\">");
      tags.push("<meta property=\"og:video:width\" content=\"1280\">");
      tags.push("<meta property=\"og:video:height\" content=\"720\">");
    }

    out=out.replace(/<head>/i,"<head>\n  "+tags.join("\n  "));
    out=out.replace(/<\/body>/i,noscript+"</body>");

    res.setHeader("Cache-Control","public, s-maxage=300, stale-while-revalidate=900");
    res.setHeader("Content-Type","text/html; charset=utf-8");
    return res.status(200).send(out);
  }catch(e){
    console.error("share preview error",e);
    return res.status(500).send("Share preview error");
  }
}
