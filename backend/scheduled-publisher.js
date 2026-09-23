import "dotenv/config";
import mongoose from "mongoose";

const MONGODB_URI=String(process.env.MONGODB_URI||"").trim();
const MEILI_URL=String(process.env.MEILI_URL||"").trim().replace(/\/$/,"");
const MEILI_KEY=String(process.env.MEILI_MASTER_KEY||"").trim();
const MEILI_INDEX=String(process.env.MEILI_INDEX||"awaaz_news").trim()||"awaaz_news";
const POLL_MS=Math.max(Number(process.env.SCHEDULED_PUBLISH_POLL_MS||15000),5000);

if(!MONGODB_URI)throw new Error("MONGODB_URI is required for scheduled publisher");

const newsSchema=new mongoose.Schema({
 title:String,slug:String,excerpt:String,content:String,category:String,location:String,image:mongoose.Schema.Types.Mixed,
 author:String,video:String,status:String,featured:Boolean,latest:Boolean,breaking:Boolean,publishedAt:Date,pushNotifiedAt:Date
},{collection:"news",timestamps:true});
const News=mongoose.models.ScheduledNews||mongoose.model("ScheduledNews",newsSchema);

async function meiliPublish(rows){
 if(!MEILI_URL||!MEILI_KEY||!rows.length)return;
 try{
  const docs=rows.map(n=>({_id:String(n._id),title:String(n.title||""),excerpt:String(n.excerpt||""),content:String(n.content||""),category:String(n.category||""),location:String(n.location||""),publishedAt:n.publishedAt||n.createdAt||null,slug:String(n.slug||"")}));
  await fetch(MEILI_URL+"/indexes/"+encodeURIComponent(MEILI_INDEX)+"/documents?primaryKey=_id",{
   method:"POST",headers:{"Authorization":"Bearer "+MEILI_KEY,"Content-Type":"application/json"},body:JSON.stringify(docs)
  });
 }catch(error){console.warn("Scheduled Meilisearch sync failed:",error?.message||error);}
}

async function publishDue(){
 const now=new Date();
 const rows=await News.find({status:"scheduled",publishedAt:{$lte:now}}).sort({publishedAt:1}).limit(100);
 if(!rows.length)return 0;
 const published=[];
 for(const row of rows){
  row.status="published";
  if(!row.publishedAt)row.publishedAt=now;
  await row.save();
  published.push(row.toObject());
 }
 await meiliPublish(published);
 console.log(`Scheduled publish complete: ${published.length} news item(s)`);
 return published.length;
}

async function main(){
 await mongoose.connect(MONGODB_URI,{serverSelectionTimeoutMS:10000});
 console.log(`Awaaz Rajasthan scheduled publisher started; polling every ${POLL_MS}ms`);
 let running=false;
 const tick=async()=>{if(running)return;running=true;try{await publishDue();}catch(error){console.error("Scheduled publisher cycle failed:",error);}finally{running=false;}};
 await tick();
 setInterval(tick,POLL_MS);
}
process.on("SIGTERM",async()=>{await mongoose.disconnect().catch(()=>{});process.exit(0);});
process.on("SIGINT",async()=>{await mongoose.disconnect().catch(()=>{});process.exit(0);});
main().catch(error=>{console.error("Scheduled publisher failed to start:",error);process.exit(1);});
