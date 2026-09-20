import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import morgan from "morgan";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import webpush from "web-push";
import nodemailer from "nodemailer";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PDFDocument, rgb } from "pdf-lib";
import Razorpay from "razorpay";

const app=express();
const PORT=Number(process.env.PORT||5000);
const PROD=process.env.NODE_ENV==="production";
const FRONTEND_URL=String(process.env.FRONTEND_URL||"").trim().replace(/\/$/,"");
if(PROD&&!FRONTEND_URL) throw new Error("FRONTEND_URL is required in production");
const PUBLIC_API_URL=String(process.env.PUBLIC_API_URL||"https://awaazrajasthan.onrender.com").trim().replace(/\/$/,"");
const RAZORPAY_KEY_ID=String(process.env.RAZORPAY_KEY_ID||"").trim();
const RAZORPAY_KEY_SECRET=String(process.env.RAZORPAY_KEY_SECRET||"").trim();
const RAZORPAY_WEBHOOK_SECRET=String(process.env.RAZORPAY_WEBHOOK_SECRET||"").trim();
const RAZORPAY_ENABLED=Boolean(RAZORPAY_KEY_ID&&RAZORPAY_KEY_SECRET);
const razorpay=RAZORPAY_ENABLED?new Razorpay({key_id:RAZORPAY_KEY_ID,key_secret:RAZORPAY_KEY_SECRET}):null;
const cleanEnv=v=>String(v||"").trim().replace(/^(['"])(.*)\1$/,"$2").trim();
const B2_BUCKET_NAME=cleanEnv(process.env.B2_BUCKET_NAME);
const B2_ENDPOINT=cleanEnv(process.env.B2_ENDPOINT).replace(/\/$/,"");
const B2_REGION=cleanEnv(process.env.B2_REGION);
const B2_KEY_ID=cleanEnv(process.env.B2_KEY_ID);
const B2_APPLICATION_KEY=cleanEnv(process.env.B2_APPLICATION_KEY);
const B2_ENABLED=Boolean(B2_BUCKET_NAME&&B2_ENDPOINT&&B2_REGION&&B2_KEY_ID&&B2_APPLICATION_KEY);
const b2=B2_ENABLED?new S3Client({endpoint:B2_ENDPOINT,region:B2_REGION,forcePathStyle:true,credentials:{accessKeyId:B2_KEY_ID,secretAccessKey:B2_APPLICATION_KEY}}):null;
const JWT_SECRET=process.env.JWT_SECRET;
if(PROD&&!JWT_SECRET) throw new Error("JWT_SECRET is required in production");
const uploadDir=path.join(process.cwd(),"uploads");
const epaperDir=path.join(process.cwd(),"epapers");
fs.mkdirSync(uploadDir,{recursive:true});
fs.mkdirSync(epaperDir,{recursive:true});

app.disable("x-powered-by");
app.set("trust proxy",1);
app.use(helmet({crossOriginResourcePolicy:{policy:"cross-origin"},contentSecurityPolicy:false}));
app.use(compression());
app.use(cors({origin:(origin,cb)=>{const allowed=!origin||FRONTEND_URL.split(",").map(x=>x.trim()).includes(origin);cb(allowed?null:new Error("CORS origin denied"),allowed);},credentials:true,methods:["GET","POST","PATCH","DELETE","OPTIONS"]}));
app.post("/api/payments/razorpay/webhook",express.raw({type:"application/json",limit:"1mb"}),async(req,res)=>{try{if(!RAZORPAY_WEBHOOK_SECRET)return res.status(503).json({message:"Razorpay webhook is not configured"});const signature=String(req.headers["x-razorpay-signature"]||""),expected=crypto.createHmac("sha256",RAZORPAY_WEBHOOK_SECRET).update(req.body).digest("hex");if(!signature||signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return res.status(401).json({message:"Invalid webhook signature"});const event=JSON.parse(req.body.toString("utf8"));if(event.event==="payment.captured"||event.event==="order.paid"){const p=event.payload?.payment?.entity||{},o=event.payload?.order?.entity||{},orderId=String(p.order_id||o.id||""),paymentId=String(p.id||""),amount=Number(p.amount??o.amount),currency=String(p.currency||o.currency||"").toUpperCase();if(orderId){const b=await AdBooking.findOne({razorpayOrderId:orderId});if(b&&b.paymentStatus!=="paid"){const expectedAmount=Math.round(Number(b.amount)*100);if(!Number.isFinite(amount)||amount!==expectedAmount||currency!=="INR")return res.status(400).json({message:"Webhook payment amount or currency mismatch"});b.paymentStatus="paid";b.status="paid";if(paymentId)b.razorpayPaymentId=paymentId;b.razorpaySignature=signature;b.updatedAt=new Date();await b.save();}}}if(event.event==="payment.failed"){const p=event.payload?.payment?.entity||{},orderId=String(p.order_id||"");if(orderId)await AdBooking.updateOne({razorpayOrderId:orderId,paymentStatus:{$ne:"paid"}},{$set:{paymentStatus:"failed",updatedAt:new Date()}});}res.json({ok:true});}catch(e){console.error("RAZORPAY_WEBHOOK_ERROR",e);res.status(500).json({message:"Webhook processing failed"});}});
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:true,limit:"1mb"}));
app.use(cookieParser());
app.use(morgan(PROD?"combined":"dev"));
app.use("/api",rateLimit({windowMs:15*60*1000,limit:500,standardHeaders:"draft-8",legacyHeaders:false}));
app.use("/api/admin/login",rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:"draft-8",legacyHeaders:false}));
app.use("/api/admin/change-password",rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:"draft-8",legacyHeaders:false}));
const adImpressionLimiter=rateLimit({windowMs:15*60*1000,limit:120,standardHeaders:"draft-8",legacyHeaders:false});
const adClickLimiter=rateLimit({windowMs:15*60*1000,limit:60,standardHeaders:"draft-8",legacyHeaders:false});
const subscriptionLimiter=rateLimit({windowMs:60*60*1000,limit:10,standardHeaders:"draft-8",legacyHeaders:false});
// Durable media is served only through Backblaze B2; local uploads are temporary staging files.
app.get(/^\/api\/media\/(.+)$/,async(req,res,next)=>{
 try{
  if(!B2_ENABLED)return res.status(503).json({message:"B2 storage is not configured"});
  const raw=String(req.params[0]||"").replace(/^\/+/, "");
  let key;
  try{key=raw.split("/").map(decodeURIComponent).join("/");}catch{return res.status(400).json({message:"Invalid media key"});}
  if(!key||key.includes("..")||key.startsWith("/")||key.includes("\\0"))return res.status(400).json({message:"Invalid media key"});

  const head=await b2.send(new HeadObjectCommand({Bucket:B2_BUCKET_NAME,Key:key}));
  const size=Number(head.ContentLength||0);
  const contentType=String(head.ContentType||"application/octet-stream");
  const range=String(req.headers.range||"").trim();

  res.set("Accept-Ranges","bytes");
  res.set("Content-Type",contentType);
  res.set("Cache-Control","public, max-age=31536000, immutable");
  if(head.ETag)res.set("ETag",head.ETag);

  if(range && size>0){
   const match=/^bytes=(\\d*)-(\\d*)$/.exec(range);
   if(!match)return res.status(416).set("Content-Range",`bytes */${size}`).end();
   let start=match[1]?Number(match[1]):0;
   let end=match[2]?Number(match[2]):size-1;
   if(!match[1]&&match[2]){const suffix=Number(match[2]);if(!Number.isFinite(suffix)||suffix<=0)return res.status(416).set("Content-Range",`bytes */${size}`).end();start=Math.max(0,size-suffix);}
   if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||start>=size||end<start){return res.status(416).set("Content-Range",`bytes */${size}`).end();}
   end=Math.min(end,size-1);
   const length=end-start+1;
   const obj=await b2.send(new GetObjectCommand({Bucket:B2_BUCKET_NAME,Key:key,Range:`bytes=${start}-${end}`}));
   res.status(206);
   res.set("Content-Range",`bytes ${start}-${end}/${size}`);
   res.set("Content-Length",String(length));
   return obj.Body.pipe(res);
  }

  if(size>0)res.set("Content-Length",String(size));
  const obj=await b2.send(new GetObjectCommand({Bucket:B2_BUCKET_NAME,Key:key}));
  return obj.Body.pipe(res);
 }catch(e){
  const code=String(e?.$metadata?.httpStatusCode||e?.Code||e?.name||"");
  if(code==="NotFound"||code==="NoSuchKey"||code==="404")return res.status(404).json({message:"Media not found"});
  next(e);
 }
});
// E-paper PDFs are served from Backblaze B2 through /api/media.

const NEWS_CATEGORIES=["राजस्थान","जयपुर","जोधपुर","उदयपुर","कोटा","अजमेर","भीलवाड़ा","सभी जिले","अपराध","राजनीति","खेल","शिक्षा","नौकरी","देश","दुनिया","मनोरंजन","बिजनेस"];
const NEWS_DISTRICTS=["सभी जिले","अजमेर","अलवर","बालोतरा","बांसवाड़ा","बारां","बाड़मेर","ब्यावर","भरतपुर","भीलवाड़ा","बीकानेर","बूंदी","चित्तौड़गढ़","चूरू","दौसा","डीग","धौलपुर","डीडवाना-कुचामन","डूंगरपुर","हनुमानगढ़","जयपुर","जैसलमेर","जालौर","झालावाड़","झुंझुनूं","जोधपुर","करौली","खैरथल-तिजारा","कोटा","कोटपूतली-बहरोड़","नागौर","पाली","फलोदी","प्रतापगढ़","राजसमंद","सलूम्बर","सवाई माधोपुर","सीकर","सिरोही","श्रीगंगानगर","टोंक","उदयपुर"];
const ADMIN_PERMISSIONS=["news:read","news:write","news:delete","media:write"];
const cleanAssignmentList=value=>Array.isArray(value)?[...new Set(value.map(v=>String(v).trim()).filter(Boolean))]:[];
const adminCanPost=(admin,category,location)=>{
 if(admin?.role==="owner")return true;
 const cats=cleanAssignmentList(admin?.allowedCategories), districts=cleanAssignmentList(admin?.allowedDistricts);
 return (!cats.length||cats.includes(String(category||""))) && (!districts.length||districts.includes(String(location||"")));
};
const AD_POSITIONS=["home_top","home_inline","sidebar","article_top","article_bottom","mobile","desktop"];
const AD_DEVICES=["all","mobile","desktop"];
const AD_BOOKING_RATES={home_top:1200,home_inline:900,sidebar:700,article_top:900,article_bottom:700,mobile:800,desktop:1000};
const DEFAULT_AD_PRICE_META={home_top:{label:"Home Top",description:"होम पेज के सबसे ऊपर"},home_inline:{label:"Home Middle",description:"होम न्यूज के बीच"},sidebar:{label:"Sidebar",description:"Desktop side panel"},article_top:{label:"Article Top",description:"खबर के ऊपर"},article_bottom:{label:"Article Bottom",description:"खबर के नीचे"},mobile:{label:"Mobile",description:"Mobile-specific placement"},desktop:{label:"Desktop",description:"Desktop-specific placement"}};
const AD_BOOKING_POSITION_LABELS={home_top:"Home Top",home_inline:"Home Middle",sidebar:"Sidebar",article_top:"Article Top",article_bottom:"Article Bottom",mobile:"Mobile",desktop:"Desktop"};
const AD_BOOKING_STATUSES=["pending","payment_submitted","paid","under_review","approved","active","paused","rejected","expired"];
const AD_PAYMENT_UPI_ID=String(process.env.AD_PAYMENT_UPI_ID||"").trim();
const AD_PAYMENT_LINK=String(process.env.AD_PAYMENT_LINK||"").trim();
const adPriceSchema=new mongoose.Schema({position:{type:String,unique:true,index:true},label:{type:String,required:true,maxlength:80},description:{type:String,default:"",maxlength:200},ratePerDay:{type:Number,required:true,min:0,max:10000000},imageRatePerDay:{type:Number,min:0,max:10000000,default:null},videoRatePerDay:{type:Number,min:0,max:10000000,default:null},active:{type:Boolean,default:true,index:true}},{timestamps:true});
const categorySchema=new mongoose.Schema({name:{type:String,required:true,unique:true,trim:true,maxlength:60},icon:{type:String,default:"📰",maxlength:8},active:{type:Boolean,default:true,index:true},sortOrder:{type:Number,default:0}},{timestamps:true});
const epaperSchema=new mongoose.Schema({title:{type:String,trim:true,maxlength:150,default:"आज का ई-पेपर"},issueDate:{type:Date,required:true,index:true},pdf:{type:String,required:true},status:{type:String,enum:["draft","published"],default:"published",index:true}},{timestamps:true});
const newsSchema=new mongoose.Schema({title:{type:String,required:true,trim:true,maxlength:220},slug:{type:String,unique:true,sparse:true,index:true},excerpt:{type:String,trim:true,maxlength:600,default:""},content:{type:String,default:""},category:{type:String,default:"राजस्थान",index:true},location:{type:String,default:"राजस्थान",index:true},image:{type:String,default:""},author:{type:String,default:"आवाज़ राजस्थान"},video:{type:String,default:""},status:{type:String,enum:["draft","published","archived"],default:"draft",index:true},featured:{type:Boolean,default:false,index:true},latest:{type:Boolean,default:true,index:true},breaking:{type:Boolean,default:false,index:true},views:{type:Number,default:0},publishedAt:{type:Date,default:null,index:true}},{timestamps:true});
newsSchema.index({title:"text",excerpt:"text",content:"text",category:"text",location:"text"});
const adSchema=new mongoose.Schema({title:{type:String,required:true,trim:true,maxlength:150},image:{type:String,default:""},video:{type:String,default:""},link:{type:String,default:""},position:{type:String,enum:AD_POSITIONS,default:"home_top",index:true},device:{type:String,enum:AD_DEVICES,default:"all",index:true},status:{type:String,enum:["active","paused"],default:"active",index:true},startDate:{type:Date,default:null},endDate:{type:Date,default:null},impressions:{type:Number,default:0},clicks:{type:Number,default:0},createdBy:{type:mongoose.Schema.Types.ObjectId,ref:"Admin"}},{timestamps:true});
const adminSchema=new mongoose.Schema({name:{type:String,trim:true,maxlength:100,default:"Admin"},email:{type:String,required:true,unique:true,lowercase:true,trim:true,index:true},passwordHash:{type:String,required:true},role:{type:String,enum:["owner","admin","editor"],default:"editor",index:true},permissions:{type:[String],default:[]},allowedCategories:{type:[String],default:[]},allowedDistricts:{type:[String],default:[]},active:{type:Boolean,default:true},sessionVersion:{type:Number,default:0},lastLoginAt:{type:Date,default:null}},{timestamps:true});
const adBookingSchema=new mongoose.Schema({bookingId:{type:String,unique:true,index:true},businessName:{type:String,required:true,trim:true,maxlength:150},contactName:{type:String,required:true,trim:true,maxlength:100},mobile:{type:String,required:true,trim:true,maxlength:20,index:true},email:{type:String,required:true,lowercase:true,trim:true,maxlength:180},website:{type:String,default:"",trim:true,maxlength:500},title:{type:String,required:true,trim:true,maxlength:150},position:{type:String,enum:AD_POSITIONS,required:true,index:true},device:{type:String,enum:AD_DEVICES,default:"all"},startDate:{type:Date,required:true},endDate:{type:Date,required:true},days:{type:Number,required:true,min:1,max:365},ratePerDay:{type:Number,required:true,min:0},imageRatePerDay:{type:Number,min:0},videoRatePerDay:{type:Number,min:0},mediaType:{type:String,enum:["image","video","both"],default:"image"},amount:{type:Number,required:true,min:0},image:{type:String,default:""},video:{type:String,default:""},link:{type:String,default:""},message:{type:String,default:"",maxlength:1000},paymentMethod:{type:String,enum:["upi","manual"],default:"upi"},paymentTxnId:{type:String,default:"",trim:true,maxlength:100},razorpayOrderId:{type:String,default:"",index:true},razorpayPaymentId:{type:String,default:"",index:true},razorpaySignature:{type:String,default:""},paymentStatus:{type:String,enum:["pending","submitted","paid","failed","refunded"],default:"pending",index:true},status:{type:String,enum:AD_BOOKING_STATUSES,default:"pending",index:true},adminNote:{type:String,default:"",maxlength:1000},adId:{type:mongoose.Schema.Types.ObjectId,ref:"Ad",default:null}},{timestamps:true});
const adminOtpSchema=new mongoose.Schema({adminId:{type:mongoose.Schema.Types.ObjectId,ref:"Admin",required:true,index:true},otpHash:{type:String,required:true},expiresAt:{type:Date,required:true,index:true},attempts:{type:Number,default:0},used:{type:Boolean,default:false}},{timestamps:true});
const subscriberSchema=new mongoose.Schema({endpoint:{type:String,required:true,unique:true},subscription:{type:mongoose.Schema.Types.Mixed,required:true},active:{type:Boolean,default:true}},{timestamps:true});
const News=mongoose.model("News",newsSchema),Ad=mongoose.model("Ad",adSchema),AdBooking=mongoose.model("AdBooking",adBookingSchema),Admin=mongoose.model("Admin",adminSchema),Subscriber=mongoose.model("Subscriber",subscriberSchema),Epaper=mongoose.model("Epaper",epaperSchema),Category=mongoose.model("Category",categorySchema),AdPrice=mongoose.model("AdPrice",adPriceSchema),AdminOtp=mongoose.model("AdminOtp",adminOtpSchema);
const upload=multer({storage:multer.diskStorage({destination:(_r,_f,cb)=>cb(null,uploadDir),filename:(_r,f,cb)=>cb(null,`${crypto.randomBytes(12).toString("hex")}${path.extname(f.originalname).toLowerCase()}`)}),limits:{fileSize:Number(process.env.MAX_UPLOAD_MB||8)*1024*1024},fileFilter:(_r,f,cb)=>cb(/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|ogg)|application\/pdf)$/.test(f.mimetype)?null:new Error("केवल JPG, PNG, WEBP, GIF, MP4, WEBM, OGG या PDF फ़ाइल स्वीकार है।"),true)});
const RESEND_API_KEY=String(process.env.RESEND_API_KEY||"").trim();
const RESEND_FROM=String(process.env.RESEND_FROM||"").trim();
const mailTransporter=process.env.SMTP_HOST?nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE||"false")==="true",auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined}):null;
async function sendAdminOtpEmail(to,name,otp){
 const subject="Awaaz Rajasthan Admin Password OTP";
 const text="Hello "+(name||"Admin")+", your OTP to reset the Awaaz Rajasthan admin password is "+otp+". It expires in 10 minutes. If you did not request this, ignore this email.";
 if(RESEND_API_KEY&&RESEND_FROM){
  const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:RESEND_FROM,to:[to],subject,text})});
  if(!response.ok){const body=await response.text().catch(()=>"" );throw new Error("Resend email failed: "+response.status+" "+body.slice(0,300));}
  return;
 }
 if(mailTransporter&&process.env.SMTP_FROM){
  await mailTransporter.sendMail({from:process.env.SMTP_FROM,to,subject,text});
  return;
 }
 throw new Error("Email service is not configured on Render"); 
}
const sign=a=>jwt.sign({sub:String(a._id),role:a.role,email:a.email,sv:a.sessionVersion||0},JWT_SECRET||"development-secret",{expiresIn:"8h"});
async function verifyAdminPassword(admin,password){
 if(!admin||typeof password!=="string"||!password)return false;
 const stored=String(admin.passwordHash||"");
 try{
  if(/^\$2[aby]\$\d{2}\$/.test(stored)) return await bcrypt.compare(password,stored);
 }catch{}
 // Migrate legacy plaintext passwords created by older admin builds.
 if(stored&&stored===password){
  admin.passwordHash=await bcrypt.hash(password,12);
  await admin.save();
  return true;
 }
 return false;
}
const safe=a=>{const o=a.toObject?a.toObject():{...a};delete o.passwordHash;return o;};
const activeAd=(a,n=new Date())=>a.status==="active"&&(!a.startDate||a.startDate<=n)&&(!a.endDate||a.endDate>=n);
const slugify=v=>String(v).toLowerCase().trim().replace(/[^a-z0-9\u0900-\u097f]+/gi,"-").replace(/^-+|-+$/g,"").slice(0,150)||crypto.randomUUID();
const permissions=(name)=>(req,res,next)=>req.admin?.role==="owner"||req.admin?.permissions?.includes(name)?next():res.status(403).json({message:"Permission denied"});
const ownerOnly=(req,res,next)=>req.admin?.role==="owner"?next():res.status(403).json({message:"केवल owner यह कार्रवाई कर सकता है।"});
const isHttpUrl=v=>{try{const u=new URL(String(v));return u.protocol==="http:"||u.protocol==="https:";}catch{return false;}};
const isValidEmail=v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
const normalizeDate=v=>{if(v===undefined||v===null||v==="")return null;const d=new Date(v);return Number.isNaN(d.getTime())?null:d;};
const validateAdDates=(start,end)=>{const s=normalizeDate(start),e=normalizeDate(end);if((start!==undefined&&start!==null&&start!==""&&!s)||(end!==undefined&&end!==null&&end!==""&&!e))return {error:"Invalid ad schedule date"};if(s&&e&&s>e)return {error:"Ad start date must be before or equal to end date"};return {start:s,end:e};};
const boundedText=(value,max)=>String(value??"").trim().slice(0,max);
const b2ObjectKey=(folder,file)=>`${folder}/${crypto.randomUUID()}-${path.basename(file.filename)}`;
async function storeUploadedFile(file,folder){
 if(!file) throw new Error("File required");
 if(!B2_ENABLED) throw new Error("B2 durable storage is not configured");
 const key=b2ObjectKey(folder,file);
 try{
  await b2.send(new PutObjectCommand({Bucket:B2_BUCKET_NAME,Key:key,Body:fs.createReadStream(file.path),ContentType:file.mimetype,CacheControl:"public, max-age=31536000, immutable"}));
 }catch(error){
  console.error("B2 upload failed:",error?.name||error?.Code||error?.message||error);
  throw new Error("Media could not be stored in Backblaze B2");
 }finally{
  try{fs.unlinkSync(file.path)}catch{}
 }
 const relative="/api/media/"+key.split("/").map(encodeURIComponent).join("/");
 return {key,url:PUBLIC_API_URL+relative,relativeUrl:relative,storage:"b2"};
}
async function getB2SignedUrl(key){
 if(!B2_ENABLED) return null;
 return getSignedUrl(b2,new GetObjectCommand({Bucket:B2_BUCKET_NAME,Key:key}),{expiresIn:3600});
}
async function verifyB2Storage(){
 if(!B2_ENABLED) return {enabled:false,ok:false,reason:"B2 environment variables are incomplete"};
 try{
  await b2.send(new HeadBucketCommand({Bucket:B2_BUCKET_NAME}));
  return {enabled:true,ok:true};
 }catch(error){
  return {enabled:true,ok:false,reason:String(error?.Code||error?.name||error?.message||"B2 connection failed").slice(0,180)};
 }
}

async function auth(req,res,next){try{const token=req.cookies.awaaz_admin||String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");if(!token)return res.status(401).json({message:"Authentication required"});const p=jwt.verify(token,JWT_SECRET||"development-secret"),a=await Admin.findById(p.sub);if(!a||!a.active||Number(p.sv||0)!==Number(a.sessionVersion||0))return res.status(401).json({message:"Session expired"});req.admin=a;next();}catch{res.status(401).json({message:"Invalid or expired session"});}}
function setCookie(res,t){const secure=process.env.COOKIE_SECURE!=="false";res.cookie("awaaz_admin",t,{httpOnly:true,secure,sameSite:secure?"none":"lax",maxAge:8*60*60*1000,path:"/"});}
function clearCookie(res){const secure=process.env.COOKIE_SECURE!=="false";res.clearCookie("awaaz_admin",{httpOnly:true,secure,sameSite:secure?"none":"lax",path:"/"});}
app.get("/",(_r,res)=>res.json({ok:true,service:"awaaz-rajasthan-api",message:"Awaaz Rajasthan API is live"}));
app.get("/api/health",(_r,res)=>res.json({ok:true,service:"awaaz-rajasthan-api",time:new Date().toISOString()}));
app.get("/api/notifications/public-key",(_r,res)=>{const key=String(process.env.VAPID_PUBLIC_KEY||"").trim();res.json({publicKey:key});});
app.get("/api/news",async(req,res,next)=>{try{const limit=Math.min(Math.max(Number(req.query.limit)||30,1),100),page=Math.min(Math.max(Number(req.query.page)||1,1),1000),f={status:"published"};const category=boundedText(req.query.category,80),location=boundedText(req.query.location,80),q=boundedText(req.query.q,200);if(category&&category!=="होम")f.category=category;if(location)f.location=location;if(q)f.$text={$search:q};if(req.query.featured==="true")f.featured=true;const [items,total]=await Promise.all([News.find(f).sort({featured:-1,publishedAt:-1,createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),News.countDocuments(f)]);res.json({news:items,data:items,pagination:{page,limit,total,pages:Math.ceil(total/limit)}});}catch(e){next(e);}});
app.get("/api/news/:id",async(req,res,next)=>{try{const key=boundedText(req.params.id,180);const item=mongoose.isValidObjectId(key)?await News.findOneAndUpdate({_id:key,status:"published"},{$inc:{views:1}},{new:true}).lean():await News.findOneAndUpdate({slug:key,status:"published"},{$inc:{views:1}},{new:true}).lean();if(!item)return res.status(404).json({message:"News not found"});res.json({news:item,data:item});}catch(e){next(e);}});
app.get("/api/categories",async(_r,res,next)=>{try{const rows=await Category.find({active:true}).sort({sortOrder:1,name:1}).lean();res.json({categories:rows.map(x=>x.name),items:rows});}catch(e){next(e);}});
async function getAdPrices(){
 const rows=await AdPrice.find({active:true}).sort({position:1}).lean();
 const mapRow=x=>{
  const base=Number(x.ratePerDay||AD_BOOKING_RATES[x.position]||0);
  const imageRate=Number.isFinite(Number(x.imageRatePerDay))?Number(x.imageRatePerDay):base;
  const videoRate=Number.isFinite(Number(x.videoRatePerDay))?Number(x.videoRatePerDay):Math.max(base,Math.round(base*1.5));
  return {...x,ratePerDay:rate,imageRatePerDay:imageRate,videoRatePerDay:videoRate};
 };
 if(rows.length)return rows.map(mapRow);
 return AD_POSITIONS.map(position=>{
  const base=Number(AD_BOOKING_RATES[position]||0);
  return {position,label:DEFAULT_AD_PRICE_META[position]?.label||position,description:DEFAULT_AD_PRICE_META[position]?.description||"",ratePerDay:base,imageRatePerDay:base,videoRatePerDay:Math.max(base,Math.round(base*1.5)),active:true};
 });
}
app.get("/api/ad-bookings/options",async(_req,res,next)=>{try{const rows=await getAdPrices();res.json({positions:rows,payment:{upiId:AD_PAYMENT_UPI_ID,paymentLink:AD_PAYMENT_LINK}})}catch(e){next(e)}});

const bookingUploadLimiter=rateLimit({windowMs:60*60*1000,limit:12,standardHeaders:"draft-8",legacyHeaders:false});
app.post("/api/ad-bookings/upload",bookingUploadLimiter,upload.single("file"),async(req,res,next)=>{try{if(!req.file)return res.status(400).json({message:"File required"});if(!req.file.mimetype.startsWith("image/")&&!req.file.mimetype.startsWith("video/"))return res.status(400).json({message:"केवल image या video upload करें"});const folder=req.file.mimetype.startsWith("video/")?"ad-bookings/videos":"ad-bookings/images";const stored=await storeUploadedFile(req.file,folder);res.status(201).json({url:stored.url,relativeUrl:stored.relativeUrl,storage:stored.storage});}catch(e){next(e)}});
app.post("/api/ad-bookings/:bookingId/create-order",bookingUploadLimiter,async(req,res,next)=>{try{if(!razorpay)return res.status(503).json({message:"Razorpay payment is not configured"});const bookingId=boundedText(req.params.bookingId,80),b=await AdBooking.findOne({bookingId});if(!b)return res.status(404).json({message:"Booking नहीं मिली"});if(b.paymentStatus==="paid")return res.json({paid:true,booking:{bookingId:b.bookingId,amount:b.amount,status:b.status,paymentStatus:b.paymentStatus}});const order=await razorpay.orders.create({amount:Math.round(Number(b.amount)*100),currency:"INR",receipt:b.bookingId,notes:{bookingId:b.bookingId,businessName:b.businessName,position:b.position}});b.razorpayOrderId=order.id;b.paymentMethod="upi";b.paymentStatus="pending";await b.save();res.json({keyId:RAZORPAY_KEY_ID,orderId:order.id,amount:order.amount,currency:order.currency,bookingId:b.bookingId});}catch(e){next(e)}});
app.post("/api/ad-bookings",bookingUploadLimiter,async(req,res,next)=>{try{const b=req.body||{},businessName=boundedText(b.businessName,150),contactName=boundedText(b.contactName,100),mobile=boundedText(b.mobile,20),email=String(b.email||"").toLowerCase().trim(),title=boundedText(b.title,150),position=String(b.position||""),device=AD_DEVICES.includes(String(b.device))?String(b.device):"all",start=normalizeDate(b.startDate),end=normalizeDate(b.endDate),image=boundedText(b.image,1000),video=boundedText(b.video,1000),link=String(b.link||"").trim();if(!businessName||!contactName||!mobile||!isValidEmail(email)||!title||!AD_POSITIONS.includes(position)||!start||!end||start>end)return res.status(400).json({message:"Booking details सही भरें"});if(link&&!isHttpUrl(link))return res.status(400).json({message:"Invalid ad link"});if(!image&&!video)return res.status(400).json({message:"Ad की photo या video में से कम-से-कम एक upload करें"});const days=Math.max(1,Math.ceil((new Date(end).setHours(23,59,59,999)-new Date(start).setHours(0,0,0,0))/86400000));const prices=await getAdPrices();const price=prices.find(x=>x.position===position);if(!price)return res.status(400).json({message:"इस ad position की pricing उपलब्ध नहीं है"});const imageRatePerDay=Number(price.imageRatePerDay||price.ratePerDay||0),videoRatePerDay=Number(price.videoRatePerDay||0),requestedMediaType=["image","video"].includes(String(b.mediaType))?String(b.mediaType):image&&video?"both":video?"video":"image";if(requestedMediaType==="image"&&!image)return res.status(400).json({message:"Photo ad के लिए photo upload करें"});if(requestedMediaType==="video"&&!video)return res.status(400).json({message:"Video ad के लिए video upload करें"});if(requestedMediaType==="both"&&(!image||!video))return res.status(400).json({message:"Photo + Video दोनों के लिए दोनों files upload करें"});const mediaType=requestedMediaType,ratePerDay=mediaType==="video"?videoRatePerDay:mediaType==="both"?imageRatePerDay+videoRatePerDay:imageRatePerDay,amount=days*ratePerDay;const bookingId=`AR-AD-${new Date().toISOString().slice(0,10).replace(/-/g,"")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;const booking=await AdBooking.create({bookingId,businessName,contactName,mobile,email,website:boundedText(b.website,500),title,position,device,startDate:start,endDate:end,days,ratePerDay,imageRatePerDay,videoRatePerDay,mediaType,amount,image,video,link,message:boundedText(b.message,1000),paymentMethod:"upi"});res.status(201).json({booking:{bookingId:booking.bookingId,amount:booking.amount,days:booking.days,ratePerDay:booking.ratePerDay,imageRatePerDay:booking.imageRatePerDay,videoRatePerDay:booking.videoRatePerDay,mediaType:booking.mediaType,status:booking.status,paymentStatus:booking.paymentStatus},payment:{upiId:AD_PAYMENT_UPI_ID,paymentLink:AD_PAYMENT_LINK}});}catch(e){next(e)}});
app.get("/api/ad-bookings/:bookingId",async(req,res,next)=>{try{const b=await AdBooking.findOne({bookingId:boundedText(req.params.bookingId,80)}).select("bookingId title position device startDate endDate days ratePerDay amount paymentStatus status createdAt updatedAt").lean();if(!b)return res.status(404).json({message:"Booking नहीं मिली"});res.json({booking:b});}catch(e){next(e)}});
app.post("/api/ad-bookings/:bookingId/payment",bookingUploadLimiter,async(req,res,next)=>{try{const txn=boundedText(req.body?.paymentTxnId,100);if(!txn)return res.status(400).json({message:"Payment transaction ID जरूरी है"});const b=await AdBooking.findOneAndUpdate({bookingId:boundedText(req.params.bookingId,80)},{paymentTxnId:txn,paymentStatus:"submitted",status:"under_review",updatedAt:new Date()},{new:true}).select("bookingId amount paymentStatus status");if(!b)return res.status(404).json({message:"Booking नहीं मिली"});res.json({booking:b})}catch(e){next(e)}});
app.post("/api/ad-bookings/:bookingId/verify-payment",bookingUploadLimiter,async(req,res,next)=>{try{if(!RAZORPAY_KEY_SECRET||!razorpay)return res.status(503).json({message:"Razorpay is not configured"});const bookingId=boundedText(req.params.bookingId,80),b=await AdBooking.findOne({bookingId});if(!b)return res.status(404).json({message:"Booking नहीं मिली"});if(b.paymentStatus==="paid")return res.json({ok:true,booking:{bookingId:b.bookingId,amount:b.amount,paymentStatus:b.paymentStatus,status:b.status}});const paymentId=boundedText(req.body?.razorpay_payment_id,100),orderId=boundedText(req.body?.razorpay_order_id,100),signature=boundedText(req.body?.razorpay_signature,200);if(!paymentId||!orderId||!signature||orderId!==b.razorpayOrderId)return res.status(400).json({message:"Invalid Razorpay payment details"});const expected=crypto.createHmac("sha256",RAZORPAY_KEY_SECRET).update(orderId+"|"+paymentId).digest("hex");if(signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return res.status(400).json({message:"Payment signature verification failed"});const [order,payment]=await Promise.all([razorpay.orders.fetch(orderId),razorpay.payments.fetch(paymentId)]);const expectedAmount=Math.round(Number(b.amount)*100);if(!order||String(order.id)!==orderId||Number(order.amount)!==expectedAmount||String(order.currency)!=="INR")return res.status(400).json({message:"Razorpay order amount mismatch"});if(!payment||String(payment.order_id)!==orderId||Number(payment.amount)!==expectedAmount||String(payment.currency)!=="INR"||String(payment.status)!=="captured")return res.status(400).json({message:"Razorpay payment is not captured or amount mismatch"});b.razorpayPaymentId=paymentId;b.razorpaySignature=signature;b.paymentTxnId=paymentId;b.paymentStatus="paid";b.status="paid";await b.save();res.json({ok:true,booking:{bookingId:b.bookingId,amount:b.amount,paymentStatus:b.paymentStatus,status:b.status}});}catch(e){next(e)}});
app.get("/api/ads",async(req,res,next)=>{try{const device=AD_DEVICES.includes(String(req.query.device))?String(req.query.device):"all",position=AD_POSITIONS.includes(String(req.query.position))?String(req.query.position):"home_top";const rows=await Ad.find({position,status:"active",$or:[{device:"all"},{device}]}).sort({createdAt:-1}).limit(20).lean();res.json({ads:rows.filter(activeAd),data:rows.filter(activeAd)});}catch(e){next(e);}});
app.post("/api/ads/:id/impression",adImpressionLimiter,async(req,res,next)=>{try{if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:"Invalid ad id"});const ad=await Ad.findById(req.params.id).select("status startDate endDate").lean();if(!ad||!activeAd(ad))return res.status(404).json({message:"Ad not active"});await Ad.updateOne({_id:req.params.id},{$inc:{impressions:1}});res.status(204).end();}catch(e){next(e);}});
app.post("/api/ads/:id/click",adClickLimiter,async(req,res,next)=>{try{if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:"Invalid ad id"});const ad=await Ad.findById(req.params.id).select("status startDate endDate").lean();if(!ad||!activeAd(ad))return res.status(404).json({message:"Ad not active"});await Ad.updateOne({_id:req.params.id},{$inc:{clicks:1}});res.status(204).end();}catch(e){next(e);}});
app.post("/api/notifications/subscribe",subscriptionLimiter,async(req,res,next)=>{try{const body=req.body||{},endpoint=String(body.endpoint||"").trim();if(!endpoint||endpoint.length>2048||!isHttpUrl(endpoint))return res.status(400).json({message:"Invalid subscription endpoint"});if(!body.keys||typeof body.keys!=="object"||Array.isArray(body.keys))return res.status(400).json({message:"Push subscription keys are required"});const p256dh=String(body.keys.p256dh||"").trim(),authKey=String(body.keys.auth||"").trim();if(!p256dh||p256dh.length>512||!authKey||authKey.length>512)return res.status(400).json({message:"Invalid push subscription keys"});if(body.expirationTime!==undefined&&body.expirationTime!==null&&(!Number.isFinite(Number(body.expirationTime))||Number(body.expirationTime)<0))return res.status(400).json({message:"Invalid subscription expiration"});await Subscriber.findOneAndUpdate({endpoint},{subscription:{...body,endpoint,keys:{p256dh,auth:authKey}},active:true},{upsert:true,new:true,setDefaultsOnInsert:true});res.status(201).json({ok:true});}catch(e){next(e);}});
app.post("/api/admin/login",async(req,res,next)=>{try{const email=String(req.body.email||"").toLowerCase().trim(),password=String(req.body.password||"");if(!isValidEmail(email)||!password)return res.status(401).json({message:"ईमेल या पासवर्ड गलत है।"});const a=await Admin.findOne({email});if(!a||!a.active||!(await verifyAdminPassword(a,password))){console.warn("ADMIN_LOGIN_FAILED",JSON.stringify({email,exists:!!a,active:a?.active===true,hashPresent:!!a?.passwordHash,hashType:a?.passwordHash?String(a.passwordHash).slice(0,4):null}));return res.status(401).json({message:"ईमेल या पासवर्ड गलत है।"});}a.lastLoginAt=new Date();await a.save();setCookie(res,sign(a));res.json({admin:safe(a),token:sign(a)});}catch(e){next(e);}});
app.post("/api/admin/logout",(_r,res)=>{clearCookie(res);res.json({ok:true});});
app.get("/api/admin/me",auth,(req,res)=>res.json({admin:safe(req.admin)}));
const issueAdminOtp=async(target)=>{
 const otp=String(crypto.randomInt(100000,1000000));
 await sendAdminOtpEmail(target.email,target.name,otp);
 await AdminOtp.updateMany({adminId:target._id,used:false},{$set:{used:true}});
 await AdminOtp.create({adminId:target._id,otpHash:await bcrypt.hash(otp,10),expiresAt:new Date(Date.now()+10*60*1000)});
};
const resetAdminWithOtp=async(target,otp,nextPassword)=>{
 const record=await AdminOtp.findOne({adminId:target._id,used:false,expiresAt:{$gt:new Date()}}).sort({createdAt:-1});
 if(!record)return {status:400,message:"OTP expired or not requested"};
 if(record.attempts>=5)return {status:429,message:"Too many OTP attempts"};
 if(!(await bcrypt.compare(otp,record.otpHash))){record.attempts+=1;await record.save();return {status:401,message:"Incorrect OTP"};}
 target.passwordHash=await bcrypt.hash(nextPassword,12);
 target.sessionVersion+=1;
 await target.save();
 record.used=true;await record.save();await AdminOtp.deleteMany({adminId:target._id});
 return {ok:true};
};
app.post("/api/admin/password/request-otp",rateLimit({windowMs:15*60*1000,limit:5,standardHeaders:"draft-8",legacyHeaders:false}),async(req,res,next)=>{
 try{
  const email=String(req.body?.email||"").toLowerCase().trim();
  if(!isValidEmail(email))return res.status(400).json({message:"Valid email required"});
  const target=await Admin.findOne({email,active:true});
  if(target) await issueAdminOtp(target);
  res.json({ok:true,message:"अगर यह registered admin email है, OTP भेज दिया गया है।"});
 }catch(e){next(e);}
});
app.post("/api/admin/password/reset-otp",rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:"draft-8",legacyHeaders:false}),async(req,res,next)=>{
 try{
  const email=String(req.body?.email||"").toLowerCase().trim(),otp=String(req.body?.otp||"").trim(),nextPassword=String(req.body?.newPassword||"");
  if(!isValidEmail(email)||!/^[0-9]{6}$/.test(otp))return res.status(400).json({message:"Valid email और 6 digit OTP required"});
  if(nextPassword.length<10)return res.status(400).json({message:"New password must be at least 10 characters"});
  const target=await Admin.findOne({email,active:true});
  if(!target)return res.status(400).json({message:"OTP expired or invalid"});
  const result=await resetAdminWithOtp(target,otp,nextPassword);
  if(result.ok)return res.json({ok:true,message:"Password successfully changed. अब नए password से login करें।"});
  return res.status(result.status).json({message:result.message});
 }catch(e){next(e);}
});
app.post("/api/admin/admin-password/request-otp",auth,ownerOnly,async(req,res,next)=>{
 try{
  const target=await Admin.findById(req.body?.adminId);
  if(!target||target.role==="owner")return res.status(404).json({message:"Admin not found"});
  await issueAdminOtp(target);
  res.json({ok:true,message:"OTP sent to registered admin email"});
 }catch(e){next(e);}
});
app.post("/api/admin/admin-password/reset-otp",auth,ownerOnly,async(req,res,next)=>{
 try{
  const adminId=String(req.body?.adminId||""),otp=String(req.body?.otp||"").trim(),nextPassword=String(req.body?.newPassword||"");
  if(!/^\d{6}$/.test(otp))return res.status(400).json({message:"Invalid OTP"});
  if(nextPassword.length<10)return res.status(400).json({message:"New password must be at least 10 characters"});
  const target=await Admin.findById(adminId);
  if(!target||target.role==="owner")return res.status(404).json({message:"Admin not found"});
  const result=await resetAdminWithOtp(target,otp,nextPassword);
  if(result.ok)return res.json({ok:true});
  return res.status(result.status).json({message:result.message});
 }catch(e){next(e);}
});
app.post("/api/admin/change-password",auth,async(req,res,next)=>{try{const current=String(req.body.currentPassword||""),nextPassword=String(req.body.newPassword||"");if(nextPassword.length<10)return res.status(400).json({message:"New password must be at least 10 characters"});if(!(await bcrypt.compare(current,req.admin.passwordHash)))return res.status(401).json({message:"Current password is incorrect"});req.admin.passwordHash=await bcrypt.hash(nextPassword,12);req.admin.sessionVersion+=1;await req.admin.save();setCookie(res,sign(req.admin));res.json({ok:true});}catch(e){next(e);}});
app.post("/api/admin/logout-all",auth,async(req,res)=>{req.admin.sessionVersion+=1;await req.admin.save();clearCookie(res);res.json({ok:true});});
app.get("/api/admin/dashboard",auth,async(req,res,next)=>{try{const [news,published,drafts,ads,views,ast]=await Promise.all([News.countDocuments(),News.countDocuments({status:"published"}),News.countDocuments({status:"draft"}),Ad.countDocuments(),News.aggregate([{$group:{_id:null,total:{$sum:"$views"}}}]),Ad.aggregate([{$group:{_id:null,impressions:{$sum:"$impressions"},clicks:{$sum:"$clicks"}}}])]);res.json({stats:{news,published,drafts,ads,views:views[0]?.total||0,impressions:ast[0]?.impressions||0,clicks:ast[0]?.clicks||0}});}catch(e){next(e);}});
app.post("/api/admin/notifications/send",auth,ownerOnly,async(req,res,next)=>{try{const title=boundedText(req.body?.title,120),body=boundedText(req.body?.body,300),url=String(req.body?.url||"/").trim()||"/";if(!title||!body)return res.status(400).json({message:"Title and message are required"});if(!VAPID_PUBLIC_KEY||!VAPID_PRIVATE_KEY||!VAPID_SUBJECT)return res.status(503).json({message:"Push notification service is not configured"});webpush.setVapidDetails(VAPID_SUBJECT,VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY);const subscribers=await Subscriber.find({active:true}).select("subscription _id").lean();let sent=0,removed=0,failed=0;const payload=JSON.stringify({title,body,url,tag:"awaaz-manual-"+Date.now(),renotify:true});for(const row of subscribers){try{await webpush.sendNotification(row.subscription,payload);sent++;}catch(error){if(error?.statusCode===404||error?.statusCode===410){await Subscriber.updateOne({_id:row._id},{$set:{active:false}});removed++;}else{failed++;console.error("Manual push failed:",error?.statusCode||error?.message||error);}}}res.json({ok:true,sent,removed,failed,total:subscribers.length});}catch(e){next(e);}});
app.get("/api/admin/notifications/status",auth,ownerOnly,async(_req,res,next)=>{try{const [active,total,latest]=await Promise.all([Subscriber.countDocuments({active:true}),Subscriber.countDocuments(),Subscriber.findOne({}).sort({createdAt:-1}).select("createdAt active").lean()]);res.json({stats:{active,total,latestSubscribedAt:latest?.createdAt||null,latestActive:latest?.active===true}});}catch(e){next(e);}});
app.post("/api/admin/notifications/cleanup",auth,ownerOnly,async(_req,res,next)=>{try{const result=await Subscriber.deleteMany({active:false});res.json({ok:true,removed:Number(result.deletedCount||0)});}catch(e){next(e);}});
app.get("/api/admin/news",auth,permissions("news:read"),async(req,res,next)=>{try{const items=await News.find({}).sort({createdAt:-1}).limit(200).lean();res.json({news:items,data:items});}catch(e){next(e);}});
app.post("/api/admin/news",auth,permissions("news:write"),async(req,res,next)=>{try{const b=req.body||{},title=String(b.title||"").trim(),category=String(b.category||"राजस्थान"),location=String(b.location||"राजस्थान");if(!title)return res.status(400).json({message:"Title required"});if(!NEWS_CATEGORIES.includes(category)&&!await Category.exists({name:category,active:true}))return res.status(400).json({message:"Invalid news category"});if(!NEWS_DISTRICTS.includes(location))return res.status(400).json({message:"Invalid news district"});if(!adminCanPost(req.admin,category,location))return res.status(403).json({message:"इस admin को इस category/district में खबर publish करने की अनुमति नहीं है।"});let slug=slugify(b.slug||title);if(await News.exists({slug}))slug+=`-${Date.now().toString(36)}`;const item=await News.create({...b,title,slug,category,location:boundedText(location,80),author:boundedText(b.author||req.admin.name||"आवाज़ राजस्थान",100),publishedAt:b.status==="published"?(b.publishedAt||new Date()):null});res.status(201).json({news:item});}catch(e){next(e);}});
app.patch("/api/admin/news/:id",auth,permissions("news:write"),async(req,res,next)=>{try{const allowed=["title","slug","excerpt","content","category","location","image","video","author","status","featured","latest","breaking","publishedAt"],u={};allowed.forEach(k=>{if(req.body?.[k]!==undefined)u[k]=req.body[k]});if(u.title!==undefined){u.title=String(u.title).trim();if(!u.title)return res.status(400).json({message:"Title required"});}if(u.category!==undefined&&!NEWS_CATEGORIES.includes(String(u.category))&&!await Category.exists({name:String(u.category),active:true}))return res.status(400).json({message:"Invalid news category"});if(u.location!==undefined&&!NEWS_DISTRICTS.includes(String(u.location)))return res.status(400).json({message:"Invalid news district"});if(u.location!==undefined)u.location=boundedText(u.location,80);if(u.author!==undefined)u.author=boundedText(u.author,100);const current=await News.findById(req.params.id).select("category location").lean();if(!current)return res.status(404).json({message:"News not found"});if(!adminCanPost(req.admin,u.category||current.category,u.location||current.location))return res.status(403).json({message:"इस admin को इस category/district में खबर edit/publish करने की अनुमति नहीं है।"});if(u.status!==undefined&&!['draft','published','archived'].includes(String(u.status)))return res.status(400).json({message:"Invalid news status"});if(u.status==="published"&&!u.publishedAt)u.publishedAt=new Date();if(u.slug!==undefined){u.slug=slugify(u.slug);const clash=await News.findOne({slug:u.slug,_id:{$ne:req.params.id}}).select("_id").lean();if(clash)u.slug=`${u.slug}-${Date.now().toString(36)}`;}const item=await News.findByIdAndUpdate(req.params.id,u,{new:true,runValidators:true});if(!item)return res.status(404).json({message:"News not found"});res.json({news:item});}catch(e){next(e);}});
app.delete("/api/admin/news/:id",auth,permissions("news:delete"),async(req,res,next)=>{try{const item=await News.findById(req.params.id).select("category location").lean();if(!item)return res.status(404).json({message:"News not found"});if(!adminCanPost(req.admin,item.category,item.location))return res.status(403).json({message:"इस admin को इस category/district में खबर delete करने की अनुमति नहीं है।"});const deleted=await News.findByIdAndDelete(req.params.id);if(!deleted)return res.status(404).json({message:"News not found"});res.json({ok:true});}catch(e){next(e);}});
app.get("/api/epapers",async(req,res,next)=>{try{const f={status:"published"};const raw=String(req.query?.date||"").trim();if(raw){if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(raw))return res.status(400).json({message:"Invalid date"});const start=new Date(raw+"T00:00:00.000Z"),end=new Date(start.getTime()+86400000);f.issueDate={$gte:start,$lt:end};}const items=await Epaper.find(f).sort({issueDate:-1,createdAt:-1}).lean();res.json({epapers:items,data:items})}catch(e){next(e)}});
app.get("/api/epapers/:id/download",async(req,res,next)=>{try{const item=await Epaper.findOne({_id:req.params.id,status:"published"}).lean();if(!item)return res.status(404).json({message:"ई-पेपर नहीं मिला।"});const pdf=String(item.pdf||"");if(pdf.startsWith("/api/media/")){if(!B2_ENABLED)return res.status(503).json({message:"B2 storage is not configured"});const key=decodeURIComponent(pdf.replace(/^\/api\/media\//,"")).split("/").map(decodeURIComponent).join("/");if(!key||key.includes("..")||key.startsWith("/")||key.includes("\\0"))return res.status(400).json({message:"Invalid media key"});const obj=await b2.send(new GetObjectCommand({Bucket:B2_BUCKET_NAME,Key:key}));res.set("Content-Type","application/pdf");res.set("Content-Disposition",`attachment; filename="awaaz-rajasthan-${new Date(item.issueDate).toISOString().slice(0,10)}.pdf"`);if(obj.ContentLength)res.set("Content-Length",String(obj.ContentLength));return obj.Body.pipe(res)}if(/^https?:\/\//i.test(pdf))return res.redirect(pdf);const filePath=path.join(process.cwd(),pdf.replace(/^\/+/, "").replace(/^epapers[\\/]/,"epapers/"));return res.status(404).json({message:"ई-पेपर B2 media URL उपलब्ध नहीं है।"})}catch(e){next(e)}});
app.get("/api/epaper/latest",async(_req,res,next)=>{try{const item=await Epaper.findOne({status:"published"}).sort({issueDate:-1,createdAt:-1}).lean();if(!item)return res.status(404).json({message:"ई-पेपर उपलब्ध नहीं है।"});const pdf=String(item.pdf||"");if(!pdf)return res.status(404).json({message:"ई-पेपर PDF उपलब्ध नहीं है।"});if(/^https?:\/\//i.test(pdf))return res.redirect(pdf);if(pdf.startsWith("/api/media/"))return res.redirect(pdf);const filePath=path.join(process.cwd(),pdf.replace(/^\/+/, "").replace(/^epapers[\\/]/,"epapers/"));return res.status(404).json({message:"ई-पेपर B2 media URL उपलब्ध नहीं है।"})}catch(e){next(e)}});
app.get("/api/admin/epapers",auth,ownerOnly,async(_r,res,next)=>{try{const items=await Epaper.find({}).sort({issueDate:-1,createdAt:-1}).lean();res.json({epapers:items,data:items})}catch(e){next(e)}});
async function watermarkEpaper(filePath){try{const bytes=fs.readFileSync(filePath),pdf=await PDFDocument.load(bytes);let logoBytes=null;const logoUrl=String(process.env.FRONTEND_URL||"").replace(/\/$/,"")+"/awaazrajasthan-logo.png";if(logoUrl.startsWith("http")){try{const r=await fetch(logoUrl);if(r.ok)logoBytes=Buffer.from(await r.arrayBuffer())}catch{}}const logo=logoBytes?await pdf.embedPng(logoBytes):null;for(const page of pdf.getPages()){const {width,height}=page.getSize();if(logo){const size=Math.min(width,height)*.28;page.drawImage(logo,{x:(width-size)/2,y:(height-size)/2,width:size,height:size,opacity:.07})}else page.drawText("आवाज़ राजस्थान",{x:width*.27,y:height*.48,size:28,color:rgb(.45,.45,.45),opacity:.08})}fs.writeFileSync(filePath,await pdf.save())}catch(e){console.error("E-paper watermark skipped:",e.message)}}
app.post("/api/admin/epapers/upload",auth,ownerOnly,upload.single("file"),async(req,res,next)=>{
 try{
  if(!req.file||req.file.mimetype!=="application/pdf")return res.status(400).json({message:"केवल PDF ई-पेपर स्वीकार है।"});
  await watermarkEpaper(req.file.path);
  const stored=await storeUploadedFile(req.file,"epapers");
  return res.status(201).json({pdf:stored.relativeUrl,url:stored.url,filename:req.file.originalname,storage:"b2"});
 }catch(e){next(e)}
});
app.post("/api/admin/epapers",auth,ownerOnly,async(req,res,next)=>{try{const b=req.body||{},title=String(b.title||"आज का ई-पेपर").trim(),issueDate=new Date(b.issueDate||"");if(!Number.isFinite(issueDate.getTime()))return res.status(400).json({message:"Valid issue date required"});if(!b.pdf)return res.status(400).json({message:"PDF required"});const item=await Epaper.create({title,issueDate,pdf:String(b.pdf),status:b.status==="draft"?"draft":"published"});res.status(201).json({epaper:item})}catch(e){next(e)}});
app.patch("/api/admin/epapers/:id",auth,ownerOnly,async(req,res,next)=>{try{const u={};if(req.body?.title!==undefined)u.title=String(req.body.title).trim();if(req.body?.pdf!==undefined)u.pdf=String(req.body.pdf);if(req.body?.status!==undefined){if(!["draft","published"].includes(String(req.body.status)))return res.status(400).json({message:"Invalid status"});u.status=String(req.body.status)}if(req.body?.issueDate!==undefined){const d=new Date(req.body.issueDate);if(!Number.isFinite(d.getTime()))return res.status(400).json({message:"Invalid issue date"});u.issueDate=d}const item=await Epaper.findByIdAndUpdate(req.params.id,u,{new:true,runValidators:true});if(!item)return res.status(404).json({message:"E-paper not found"});res.json({epaper:item})}catch(e){next(e)}});
app.delete("/api/admin/epapers/:id",auth,ownerOnly,async(req,res,next)=>{try{const item=await Epaper.findByIdAndDelete(req.params.id);if(!item)return res.status(404).json({message:"E-paper not found"});res.json({ok:true})}catch(e){next(e)}});
app.get("/api/admin/categories",auth,ownerOnly,async(_r,res,next)=>{try{const items=await Category.find({}).sort({sortOrder:1,name:1}).lean();res.json({categories:items,data:items})}catch(e){next(e)}});
app.post("/api/admin/categories",auth,ownerOnly,async(req,res,next)=>{try{const name=String(req.body?.name||"").trim();const icon=String(req.body?.icon||"📰").trim().slice(0,8);if(!name)return res.status(400).json({message:"Category name required"});if(name==="होम"||name==="सभी जिले")return res.status(400).json({message:"यह system category है"});if(await Category.exists({name}))return res.status(409).json({message:"Category already exists"});const item=await Category.create({name,icon,sortOrder:Number(req.body?.sortOrder)||0});res.status(201).json({category:item})}catch(e){next(e)}});
app.patch("/api/admin/categories/:id",auth,ownerOnly,async(req,res,next)=>{try{const item=await Category.findById(req.params.id);if(!item)return res.status(404).json({message:"Category not found"});if(req.body?.name!==undefined){const name=String(req.body.name).trim();if(!name||name==="होम"||name==="सभी जिले")return res.status(400).json({message:"Invalid category name"});const clash=await Category.findOne({name,_id:{$ne:item._id}});if(clash)return res.status(409).json({message:"Category already exists"});item.name=name}if(req.body?.icon!==undefined)item.icon=String(req.body.icon).trim().slice(0,8);if(req.body?.active!==undefined)item.active=Boolean(req.body.active);if(req.body?.sortOrder!==undefined)item.sortOrder=Number(req.body.sortOrder)||0;await item.save();res.json({category:item})}catch(e){next(e)}});
app.delete("/api/admin/categories/:id",auth,ownerOnly,async(req,res,next)=>{try{const item=await Category.findByIdAndDelete(req.params.id);if(!item)return res.status(404).json({message:"Category not found"});res.json({ok:true})}catch(e){next(e)}});
app.get("/api/admin/ad-prices",auth,ownerOnly,async(_req,res,next)=>{try{const rows=await AdPrice.find({}).sort({position:1}).lean();const by=new Map(rows.map(x=>[x.position,x]));const data=AD_POSITIONS.map(position=>by.get(position)||{position,label:DEFAULT_AD_PRICE_META[position]?.label||position,description:DEFAULT_AD_PRICE_META[position]?.description||"",ratePerDay:Number(AD_BOOKING_RATES[position]||0),active:true});res.json({prices:data});}catch(e){next(e)}});
app.put("/api/admin/ad-prices",auth,ownerOnly,async(req,res,next)=>{try{const items=Array.isArray(req.body?.prices)?req.body.prices:[];if(!items.length)return res.status(400).json({message:"Pricing list required"});for(const item of items){const position=String(item.position||"");const rate=Number(item.ratePerDay),imageRate=Number(item.imageRatePerDay),videoRate=Number(item.videoRatePerDay);if(!AD_POSITIONS.includes(position)||!Number.isFinite(rate)||rate<0||rate>10000000||!Number.isFinite(imageRate)||imageRate<0||imageRate>10000000||!Number.isFinite(videoRate)||videoRate<0||videoRate>10000000)return res.status(400).json({message:"Invalid ad pricing"});await AdPrice.findOneAndUpdate({position},{position,label:boundedText(item.label||DEFAULT_AD_PRICE_META[position]?.label||position,80),description:boundedText(item.description||DEFAULT_AD_PRICE_META[position]?.description||"",200),ratePerDay:imageRate,imageRatePerDay:imageRate,videoRatePerDay:videoRate,active:item.active!==false},{upsert:true,new:true,setDefaultsOnInsert:true});}res.json({ok:true,prices:await AdPrice.find({}).sort({position:1}).lean()});}catch(e){next(e)}});
app.get("/api/admin/ad-bookings",auth,ownerOnly,async(req,res,next)=>{try{const status=String(req.query?.status||"").trim();const f=status&&AD_BOOKING_STATUSES.includes(status)?{status}:{};const bookings=await AdBooking.find(f).sort({createdAt:-1}).limit(500).lean();res.json({bookings,data:bookings});}catch(e){next(e)}});
app.patch("/api/admin/ad-bookings/:id",auth,ownerOnly,async(req,res,next)=>{try{const b=await AdBooking.findById(req.params.id);if(!b)return res.status(404).json({message:"Ad booking not found"});const nextStatus=req.body?.status?String(req.body.status):b.status;if(!AD_BOOKING_STATUSES.includes(nextStatus))return res.status(400).json({message:"Invalid booking status"});if(["approved","active"].includes(nextStatus)&&b.paymentStatus!=="paid")return res.status(400).json({message:"पहले payment को Paid करें"});if(req.body?.paymentStatus!==undefined&&!["pending","submitted","paid","failed","refunded"].includes(String(req.body.paymentStatus)))return res.status(400).json({message:"Invalid payment status"});if(req.body?.adminNote!==undefined)b.adminNote=boundedText(req.body.adminNote,1000);if(req.body?.paymentStatus!==undefined)b.paymentStatus=String(req.body.paymentStatus);b.status=nextStatus;if(nextStatus==="paid"&&b.paymentStatus!=="paid")b.paymentStatus="paid";if(["approved","active"].includes(nextStatus)){const conflict=await AdBooking.findOne({_id:{$ne:b._id},position:b.position,device:{$in:[b.device,"all"]},status:{$in:["approved","active"]},startDate:{$lte:b.endDate},endDate:{$gte:b.startDate}}).select("_id bookingId").lean();if(conflict)return res.status(409).json({message:"इस position और date range में दूसरा approved/live ad मौजूद है"});const adData={title:b.title,image:b.image,video:b.video,link:b.link,position:b.position,device:b.device,status:"active",startDate:b.startDate,endDate:b.endDate,createdBy:req.admin._id};if(b.adId){await Ad.findByIdAndUpdate(b.adId,adData,{runValidators:true});}else{const ad=await Ad.create(adData);b.adId=ad._id;}b.status="active";}b.updatedAt=new Date();await b.save();res.json({booking:b});}catch(e){next(e)}});
app.delete("/api/admin/ad-bookings/:id",auth,ownerOnly,async(req,res,next)=>{try{const b=await AdBooking.findByIdAndDelete(req.params.id);if(!b)return res.status(404).json({message:"Ad booking not found"});if(b.adId)await Ad.findByIdAndDelete(b.adId);res.json({ok:true})}catch(e){next(e)}});
app.get("/api/admin/ads",auth,ownerOnly,async(_r,res,next)=>{try{const ads=await Ad.find({}).sort({createdAt:-1}).lean();res.json({ads,data:ads});}catch(e){next(e);}});
app.post("/api/admin/ads",auth,ownerOnly,async(req,res,next)=>{try{const b=req.body||{},title=String(b.title||"").trim();if(!title)return res.status(400).json({message:"Ad title required"});if(b.position!==undefined&&!AD_POSITIONS.includes(String(b.position)))return res.status(400).json({message:"Invalid ad position"});if(b.device!==undefined&&!AD_DEVICES.includes(String(b.device)))return res.status(400).json({message:"Invalid ad device"});if(b.link&&!isHttpUrl(b.link))return res.status(400).json({message:"Invalid ad link"});const schedule=validateAdDates(b.startDate,b.endDate);if(schedule.error)return res.status(400).json({message:schedule.error});const ad=await Ad.create({...b,title,position:b.position||"home_top",device:b.device||"all",startDate:schedule.start,endDate:schedule.end,createdBy:req.admin._id});res.status(201).json({ad});}catch(e){next(e);}});
app.patch("/api/admin/ads/:id",auth,ownerOnly,async(req,res,next)=>{try{const allowed=["title","image","video","link","position","device","status","startDate","endDate"],u={};allowed.forEach(k=>{if(req.body?.[k]!==undefined)u[k]=req.body[k]});if(u.title!==undefined){u.title=String(u.title).trim();if(!u.title)return res.status(400).json({message:"Ad title required"});}if(u.position!==undefined&&!AD_POSITIONS.includes(String(u.position)))return res.status(400).json({message:"Invalid ad position"});if(u.device!==undefined&&!AD_DEVICES.includes(String(u.device)))return res.status(400).json({message:"Invalid ad device"});if(u.status!==undefined&&!['active','paused'].includes(String(u.status)))return res.status(400).json({message:"Invalid ad status"});if(u.link&&!isHttpUrl(u.link))return res.status(400).json({message:"Invalid ad link"});const existing=await Ad.findById(req.params.id).select("startDate endDate").lean();if(!existing)return res.status(404).json({message:"Ad not found"});const schedule=validateAdDates(u.startDate!==undefined?u.startDate:existing.startDate,u.endDate!==undefined?u.endDate:existing.endDate);if(schedule.error)return res.status(400).json({message:schedule.error});u.startDate=schedule.start;u.endDate=schedule.end;const ad=await Ad.findByIdAndUpdate(req.params.id,u,{new:true,runValidators:true});res.json({ad});}catch(e){next(e);}});
app.delete("/api/admin/ads/:id",auth,ownerOnly,async(req,res,next)=>{try{const ad=await Ad.findByIdAndDelete(req.params.id);if(!ad)return res.status(404).json({message:"Ad not found"});res.json({ok:true});}catch(e){next(e);}});
app.get("/api/admin/admins",auth,ownerOnly,async(_r,res,next)=>{try{const admins=await Admin.find({}).sort({createdAt:-1}).lean();res.json({admins:admins.map(safe),data:admins.map(safe)});}catch(e){next(e);}});
app.post("/api/admin/admins",auth,ownerOnly,async(req,res,next)=>{try{const b=req.body||{},email=String(b.email||"").toLowerCase().trim(),password=String(b.password||"");if(!isValidEmail(email))return res.status(400).json({message:"Valid email required"});if(password.length<10)return res.status(400).json({message:"Password must be at least 10 characters"});if(await Admin.exists({email}))return res.status(409).json({message:"Admin already exists"});const selectedPermissions=Array.isArray(b.permissions)?b.permissions.map(String).filter(p=>ADMIN_PERMISSIONS.includes(p)):[];const allowedCategories=cleanAssignmentList(b.allowedCategories).filter(x=>NEWS_CATEGORIES.includes(x));const allowedDistricts=cleanAssignmentList(b.allowedDistricts).filter(x=>NEWS_DISTRICTS.includes(x));const a=await Admin.create({name:b.name,email,passwordHash:await bcrypt.hash(password,12),role:b.role==="admin"?"admin":"editor",permissions:selectedPermissions,allowedCategories,allowedDistricts});res.status(201).json({admin:safe(a)});}catch(e){next(e);}});
app.patch("/api/admin/admins/:id",auth,ownerOnly,async(req,res,next)=>{try{const target=await Admin.findById(req.params.id);if(!target)return res.status(404).json({message:"Admin not found"});const self=String(target._id)===String(req.admin._id);if(target.role==="owner")return res.status(400).json({message:self?"Primary owner account is protected":"Owner account cannot be modified"});const u={};let invalidateSessions=false;if(req.body?.permissions!==undefined){if(!Array.isArray(req.body.permissions)||req.body.permissions.some(p=>!ADMIN_PERMISSIONS.includes(String(p))))return res.status(400).json({message:"Invalid permission"});u.permissions=req.body.permissions.map(String);invalidateSessions=true;}if(req.body?.allowedCategories!==undefined){const v=cleanAssignmentList(req.body.allowedCategories);if(v.some(x=>!NEWS_CATEGORIES.includes(x)))return res.status(400).json({message:"Invalid category assignment"});u.allowedCategories=v;invalidateSessions=true;}if(req.body?.allowedDistricts!==undefined){const v=cleanAssignmentList(req.body.allowedDistricts);if(v.some(x=>!NEWS_DISTRICTS.includes(x)))return res.status(400).json({message:"Invalid district assignment"});u.allowedDistricts=v;invalidateSessions=true;}["name","active"].forEach(k=>{if(req.body?.[k]!==undefined){u[k]=req.body[k];if(k==="active")invalidateSessions=true;}});if(req.body?.email!==undefined){const email=String(req.body.email||"").toLowerCase().trim();if(!isValidEmail(email))return res.status(400).json({message:"Valid email required"});const clash=await Admin.findOne({email,_id:{$ne:req.params.id}}).select("_id").lean();if(clash)return res.status(409).json({message:"Email is already in use"});u.email=email;invalidateSessions=true;}if(req.body?.role!==undefined){if(req.body.role==="owner")return res.status(400).json({message:"Owner role is reserved"});if(!["admin","editor"].includes(req.body.role))return res.status(400).json({message:"Invalid admin role"});if(target.role==="owner")return res.status(400).json({message:"Owner account cannot be demoted"});u.role=req.body.role;invalidateSessions=true;}if(req.body?.password){if(String(req.body.password).length<10)return res.status(400).json({message:"Password must be at least 10 characters"});u.passwordHash=await bcrypt.hash(String(req.body.password),12);invalidateSessions=true;}if(invalidateSessions)u.$inc={sessionVersion:1};const a=await Admin.findByIdAndUpdate(req.params.id,u,{new:true,runValidators:true});res.json({admin:safe(a)});}catch(e){next(e);}});
app.delete("/api/admin/admins/:id",auth,ownerOnly,async(req,res,next)=>{try{if(String(req.admin._id)===String(req.params.id))return res.status(400).json({message:"You cannot delete your own owner account"});const target=await Admin.findById(req.params.id).select("role").lean();if(!target)return res.status(404).json({message:"Admin not found"});if(target.role==="owner")return res.status(400).json({message:"Owner account cannot be deleted"});await Admin.deleteOne({_id:req.params.id});res.json({ok:true});}catch(e){next(e);}});
app.post("/api/admin/upload",auth,permissions("media:write"),upload.single("file"),async(req,res,next)=>{
 try{
  if(!req.file)return res.status(400).json({message:"File required"});
  const folder=req.file.mimetype==="application/pdf"?"epapers":req.file.mimetype.startsWith("video/")?"videos":"images";
  const stored=await storeUploadedFile(req.file,folder);
  res.status(201).json({url:stored.url,relativeUrl:stored.relativeUrl,filename:req.file.filename,mimetype:req.file.mimetype,size:req.file.size,storage:stored.storage});
 }catch(e){next(e)}
});
app.get("/api/admin/ads/analytics",auth,ownerOnly,async(_r,res,next)=>{try{const ads=await Ad.find({}).select("title position device status startDate endDate impressions clicks createdAt").sort({createdAt:-1}).lean();res.json({analytics:ads.map(a=>({...a,ctr:a.impressions?Number(((a.clicks/a.impressions)*100).toFixed(2)):0}))});}catch(e){next(e);}});
app.use((err,_req,res,_next)=>{console.error(err);res.status(err.status||500).json({message:PROD?"Server error":String(err.message||err)});});
const DEFAULT_CATEGORY_ROWS=[["राजस्थान","🏜️",1],["जयपुर","🏛️",2],["जोधपुर","🏰",3],["उदयपुर","🌊",4],["कोटा","🎓",5],["अजमेर","🕌",6],["भीलवाड़ा","🏭",7],["अपराध","🚨",8],["राजनीति","🏛️",9],["शिक्षा","📚",10],["नौकरी","💼",11],["खेल","🏆",12],["देश","🇮🇳",13],["दुनिया","🌍",14],["मनोरंजन","🎬",15],["बिजनेस","📈",16]];
async function bootstrap(){if(!process.env.MONGODB_URI){if(PROD)throw new Error("MONGODB_URI is required in production");return;}if(PROD&&!B2_ENABLED)throw new Error("B2 durable media storage is required in production");await mongoose.connect(process.env.MONGODB_URI);await Promise.all(DEFAULT_CATEGORY_ROWS.map(([name,icon,sortOrder])=>Category.updateOne({name},{$setOnInsert:{name,icon,sortOrder,active:true}},{upsert:true})));const email=String(process.env.OWNER_EMAIL||"harshrajsinghgour1@gmail.com").toLowerCase().trim(),password=String(process.env.OWNER_PASSWORD||"");if(email&&password){const hash=await bcrypt.hash(password,12);await Admin.updateOne({email},{$setOnInsert:{name:"harshraj singh gour",email,passwordHash:hash,role:"owner",permissions:["news:read","news:write","news:delete","media:write"],active:true,sessionVersion:0}},{upsert:true});}const b2Status=await verifyB2Storage();if(PROD&&!b2Status.ok)throw new Error(`B2 storage verification failed: ${b2Status.reason}`);app.listen(PORT,async()=>{ console.log(`Awaaz Rajasthan API listening on ${PORT}`); console.log(`B2 storage: ${b2Status.ok?"READY":b2Status.reason}`); if(process.env.ENABLE_PUSH_WORKER!=="false" && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT){ const worker=spawn(process.execPath,[path.join(process.cwd(),"backend","push-worker.js")],{stdio:"inherit",env:process.env}); worker.on("exit",(code,signal)=>console.log(`Push worker exited: code=${code??""} signal=${signal??""}`)); worker.on("error",error=>console.error("Push worker process error:",error)); } else console.log("Push worker not started: VAPID configuration is not complete or ENABLE_PUSH_WORKER=false"); });}
bootstrap().catch(e=>{console.error(e);process.exit(1);});
