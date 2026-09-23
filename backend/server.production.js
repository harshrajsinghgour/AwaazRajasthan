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
import sharp from "sharp";
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
app.use(cors({origin:(origin,cb)=>{const configured=FRONTEND_URL.split(",").map(x=>x.trim()).filter(Boolean);const vercelPreview=/^https:\/\/awaazrajasthan(?:-[a-z0-9-]+)?\.vercel\.app$/i.test(String(origin||""));const allowed=!origin||configured.includes(origin)||vercelPreview;cb(allowed?null:new Error("CORS origin denied"),allowed);},credentials:true,methods:["GET","POST","PUT","PATCH","DELETE","OPTIONS"]}));
app.post("/api/payments/razorpay/webhook",express.raw({type:"application/json",limit:"1mb"}),async(req,res)=>{try{if(!RAZORPAY_WEBHOOK_SECRET)return res.status(503).json({message:"Razorpay webhook is not configured"});const signature=String(req.headers["x-razorpay-signature"]||""),expected=crypto.createHmac("sha256",RAZORPAY_WEBHOOK_SECRET).update(req.body).digest("hex");if(!signature||signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return res.status(401).json({message:"Invalid webhook signature"});const event=JSON.parse(req.body.toString("utf8"));if(event.event==="payment.captured"||event.event==="order.paid"){const p=event.payload?.payment?.entity||{},o=event.payload?.order?.entity||{},orderId=String(p.order_id||o.id||""),paymentId=String(p.id||""),amount=Number(p.amount??o.amount),currency=String(p.currency||o.currency||"").toUpperCase();if(orderId){const b=await AdBooking.findOne({razorpayOrderId:orderId});if(b&&b.paymentStatus!=="paid"){const expectedAmount=Math.round(Number(b.amount)*100);if(!Number.isFinite(amount)||amount!==expectedAmount||currency!=="INR")return res.status(400).json({message:"Webhook payment amount or currency mismatch"});b.paymentStatus="paid";b.status="paid";if(paymentId)b.razorpayPaymentId=paymentId;b.razorpaySignature=signature;b.updatedAt=new Date();await b.save();}}}if(event.event==="payment.failed"){const p=event.payload?.payment?.entity||{},orderId=String(p.order_id||"");if(orderId)await AdBooking.updateOne({razorpayOrderId:orderId,paymentStatus:{$ne:"paid"}},{$set:{paymentStatus:"failed",updatedAt:new Date()}});}res.json({ok:true});}catch(e){console.error("RAZORPAY_WEBHOOK_ERROR",e);res.status(500).json({message:"Webhook processing failed"});}});
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:true,limit:"1mb"}));
app.use(cookieParser());
app.use(morgan(PROD?"combined":"dev"));
app.use("/api",rateLimit({windowMs:10*60*1000,limit:10000,standardHeaders:"draft-8",legacyHeaders:false,skip:req=>req.path==="/admin/login"}));
app.use("/api/admin/change-password",rateLimit({windowMs:10*60*1000,limit:1000,standardHeaders:"draft-8",legacyHeaders:false}));
const adImpressionLimiter=rateLimit({windowMs:10*60*1000,limit:12000,standardHeaders:"draft-8",legacyHeaders:false});
const adClickLimiter=rateLimit({windowMs:10*60*1000,limit:6000,standardHeaders:"draft-8",legacyHeaders:false});
const subscriptionLimiter=rateLimit({windowMs:10*60*1000,limit:1000,standardHeaders:"draft-8",legacyHeaders:false});
// Durable media is served only through Backblaze B2; local uploads are temporary staging files.
app.get(/^\/api\/media\/(.+)$/,async(req,res,next)=>{
 try{
  if(!B2_ENABLED)return res.status(503).json({message:"B2 storage is not configured"});
  const raw=String(req.params[0]||"").replace(/^\/+/, "");
  let key;
  try{key=raw.split("/").map(decodeURIComponent).join("/");}catch{return res.status(400).json({message:"Invalid media key"});}
  if(!key||key.includes("..")||key.startsWith("/")||key.includes("\0"))return res.status(400).json({message:"Invalid media key"});

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

const NEWS_CATEGORIES=["भारत","विश्व","राजस्थान","जयपुर","जोधपुर","उदयपुर","कोटा","अजमेर","भीलवाड़ा","सभी जिले","अपराध","राजनीति","खेल","शिक्षा","नौकरी","मनोरंजन","बिजनेस"];
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
const adPriceSchema=new mongoose.Schema({position:{type:String,unique:true,index:true},label:{type:String,required:true,maxlength:80},description:{type:String,default:"",maxlength:200},ratePerDay:{type:Number,required:true,min:0,max:10000000},imageRatePerDay:{type:Number,min:0,max:10000000,default:null},videoRatePerDay:{type:Number,min:0,max:10000000,default:null},active:{type:Boolean,default:true,index:true}},{timestamps:true});
const categorySchema=new mongoose.Schema({name:{type:String,required:true,unique:true,trim:true,maxlength:60},icon:{type:String,default:"📰",maxlength:8},active:{type:Boolean,default:true,index:true},sortOrder:{type:Number,default:0}},{timestamps:true});
const legalSettingsSchema=new mongoose.Schema({key:{type:String,unique:true,default:"default"},aboutText:{type:String,default:"",trim:true,maxlength:5000},contactEmail:{type:String,default:"",trim:true,maxlength:180},contactPhone:{type:String,default:"",trim:true,maxlength:40},contactAddress:{type:String,default:"",trim:true,maxlength:500},privacyText:{type:String,default:"",trim:true,maxlength:8000},termsText:{type:String,default:"",trim:true,maxlength:8000},disclaimerText:{type:String,default:"",trim:true,maxlength:8000},editorialPolicyText:{type:String,default:"",trim:true,maxlength:8000},copyrightText:{type:String,default:"",trim:true,maxlength:500},grievanceOfficerName:{type:String,default:"",trim:true,maxlength:120},grievanceOfficerEmail:{type:String,default:"",trim:true,maxlength:180},grievanceAddress:{type:String,default:"",trim:true,maxlength:500},privacyEmail:{type:String,default:"",trim:true,maxlength:180},updatedBy:{type:mongoose.Schema.Types.ObjectId,ref:"Admin",default:null}},{timestamps:true});
const grievanceSchema=new mongoose.Schema({ticketId:{type:String,unique:true,index:true},name:{type:String,required:true,trim:true,maxlength:120},email:{type:String,required:true,trim:true,maxlength:180},mobile:{type:String,default:"",trim:true,maxlength:20},subject:{type:String,required:true,trim:true,maxlength:200},message:{type:String,required:true,trim:true,maxlength:5000},status:{type:String,enum:["received","under_review","resolved","rejected"],default:"received",index:true},adminNote:{type:String,default:"",trim:true,maxlength:2000},createdAt:{type:Date,default:Date.now},updatedAt:{type:Date,default:Date.now}});
const homeNavButtonSchema=new mongoose.Schema({label:{type:String,required:true,trim:true,maxlength:40},icon:{type:String,default:"📰",trim:true,maxlength:8},action:{type:String,enum:["latest","breaking","trending","video","photo","category"],default:"latest",index:true},category:{type:String,default:"",trim:true,maxlength:60},sortOrder:{type:Number,default:0,index:true},active:{type:Boolean,default:true,index:true}},{timestamps:true});
const epaperSchema=new mongoose.Schema({title:{type:String,trim:true,maxlength:150,default:"आज का ई-पेपर"},issueDate:{type:Date,required:true,index:true},pdf:{type:String,required:true},status:{type:String,enum:["draft","published"],default:"published",index:true}},{timestamps:true});
const newsSchema=new mongoose.Schema({title:{type:String,required:true,trim:true,maxlength:220},slug:{type:String,unique:true,sparse:true,index:true},shareCode:{type:String,unique:true,sparse:true,index:true,trim:true,maxlength:12},excerpt:{type:String,trim:true,maxlength:600,default:""},content:{type:String,default:""},category:{type:String,default:"राजस्थान",index:true},location:{type:String,default:"राजस्थान",index:true},image:{type:mongoose.Schema.Types.Mixed,default:""},author:{type:String,default:"आवाज़ राजस्थान"},video:{type:String,default:""},status:{type:String,enum:["draft","published","archived"],default:"draft",index:true},featured:{type:Boolean,default:false,index:true},latest:{type:Boolean,default:true,index:true},breaking:{type:Boolean,default:false,index:true},views:{type:Number,default:0},publishedAt:{type:Date,default:null,index:true},pushNotifiedAt:{type:Date,default:null,index:true}},{timestamps:true});
newsSchema.index({title:"text",excerpt:"text",content:"text",category:"text",location:"text"});
const SHARE_ALPHABET="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function makeShareCode(){let out="";const bytes=crypto.randomBytes(6);for(let i=0;i<6;i++)out+=SHARE_ALPHABET[bytes[i]%SHARE_ALPHABET.length];return out;}
newsSchema.pre("validate",async function(next){try{if(!this.shareCode){for(let i=0;i<8;i++){const code=makeShareCode();const exists=await mongoose.models.News?.exists({shareCode:code,_id:{$ne:this._id}});if(!exists){this.shareCode=code;break;}}}next();}catch(e){next(e);}});
newsSchema.index({status:1,featured:-1,publishedAt:-1,createdAt:-1});
newsSchema.index({status:1,category:1,publishedAt:-1,createdAt:-1});
newsSchema.index({status:1,location:1,publishedAt:-1,createdAt:-1});
const adSchema=new mongoose.Schema({title:{type:String,required:true,trim:true,maxlength:150},image:{type:String,default:""},video:{type:String,default:""},link:{type:String,default:""},position:{type:String,enum:AD_POSITIONS,default:"home_top",index:true},device:{type:String,enum:AD_DEVICES,default:"all",index:true},status:{type:String,enum:["active","paused"],default:"active",index:true},startDate:{type:Date,default:null},endDate:{type:Date,default:null},impressions:{type:Number,default:0},clicks:{type:Number,default:0},createdBy:{type:mongoose.Schema.Types.ObjectId,ref:"Admin"}},{timestamps:true});
adSchema.index({position:1,status:1,device:1,createdAt:-1});
adSchema.index({status:1,startDate:1,endDate:1});
const adminSchema=new mongoose.Schema({name:{type:String,trim:true,maxlength:100,default:"Admin"},post:{type:String,trim:true,maxlength:100,default:""},avatar:{type:String,default:"",maxlength:600},email:{type:String,required:true,unique:true,lowercase:true,trim:true,index:true},passwordHash:{type:String,required:true},role:{type:String,enum:["owner","admin"],default:"admin",index:true},ownerType:{type:String,enum:["primary","secondary"],default:null,index:true},permissions:{type:[String],default:[]},allowedCategories:{type:[String],default:[]},allowedDistricts:{type:[String],default:[]},active:{type:Boolean,default:true},sessionVersion:{type:Number,default:0},lastLoginAt:{type:Date,default:null}},{timestamps:true});
const adBookingSchema=new mongoose.Schema({bookingId:{type:String,unique:true,index:true},businessName:{type:String,required:true,trim:true,maxlength:150},contactName:{type:String,required:true,trim:true,maxlength:100},mobile:{type:String,required:true,trim:true,maxlength:20,index:true},email:{type:String,required:true,lowercase:true,trim:true,maxlength:180},website:{type:String,default:"",trim:true,maxlength:500},title:{type:String,required:true,trim:true,maxlength:150},position:{type:String,enum:AD_POSITIONS,required:true,index:true},device:{type:String,enum:AD_DEVICES,default:"all"},startDate:{type:Date,default:null},endDate:{type:Date,default:null},days:{type:Number,required:true,min:1,max:365},ratePerDay:{type:Number,required:true,min:0},imageRatePerDay:{type:Number,min:0},videoRatePerDay:{type:Number,min:0},mediaType:{type:String,enum:["image","video","both"],default:"image"},amount:{type:Number,required:true,min:0},image:{type:String,default:""},video:{type:String,default:""},link:{type:String,default:""},message:{type:String,default:"",maxlength:1000},paymentMethod:{type:String,enum:["upi","manual"],default:"upi"},paymentTxnId:{type:String,default:"",trim:true,maxlength:100},razorpayOrderId:{type:String,default:"",index:true},razorpayPaymentId:{type:String,default:"",index:true},razorpaySignature:{type:String,default:""},paymentStatus:{type:String,enum:["pending","submitted","paid","failed","refunded"],default:"pending",index:true},status:{type:String,enum:AD_BOOKING_STATUSES,default:"pending",index:true},adminNote:{type:String,default:"",maxlength:1000},adId:{type:mongoose.Schema.Types.ObjectId,ref:"Ad",default:null}},{timestamps:true});
adBookingSchema.index({status:1,createdAt:-1});
adBookingSchema.index({position:1,device:1,status:1,startDate:1,endDate:1});
const adminOtpSchema=new mongoose.Schema({adminId:{type:mongoose.Schema.Types.ObjectId,ref:"Admin",required:true,index:true},otpHash:{type:String,required:true},expiresAt:{type:Date,required:true,index:true},attempts:{type:Number,default:0},used:{type:Boolean,default:false}},{timestamps:true});
adminOtpSchema.index({adminId:1,used:1,expiresAt:1,createdAt:-1});
const subscriberSchema=new mongoose.Schema({endpoint:{type:String,required:true,unique:true},subscription:{type:mongoose.Schema.Types.Mixed,required:true},district:{type:String,default:"",trim:true,maxlength:80,index:true},category:{type:String,default:"",trim:true,maxlength:80,index:true},active:{type:Boolean,default:true},lastSuccessAt:{type:Date,default:null},lastFailureAt:{type:Date,default:null}},{timestamps:true});
const News=mongoose.model("News",newsSchema),Ad=mongoose.model("Ad",adSchema),AdBooking=mongoose.model("AdBooking",adBookingSchema),Admin=mongoose.model("Admin",adminSchema),Subscriber=mongoose.model("Subscriber",subscriberSchema),Epaper=mongoose.model("Epaper",epaperSchema),Category=mongoose.model("Category",categorySchema),HomeNavButton=mongoose.model("HomeNavButton",homeNavButtonSchema),LegalSettings=mongoose.model("LegalSettings",legalSettingsSchema),Grievance=mongoose.model("Grievance",grievanceSchema),AdPrice=mongoose.model("AdPrice",adPriceSchema),AdminOtp=mongoose.model("AdminOtp",adminOtpSchema);
const upload=multer({storage:multer.diskStorage({destination:(_r,_f,cb)=>cb(null,uploadDir),filename:(_r,f,cb)=>cb(null,`${crypto.randomBytes(12).toString("hex")}${path.extname(f.originalname).toLowerCase()}`)}),limits:{fileSize:Number(process.env.MAX_UPLOAD_MB||8)*1024*1024,files:1,fields:20,fieldSize:64*1024,fieldNestingDepth:3,fieldArrayIndexLimit:100},fileFilter:(_r,f,cb)=>cb(/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|ogg)|application\/pdf)$/.test(f.mimetype)?null:new Error("केवल JPG, PNG, WEBP, GIF, MP4, WEBM, OGG या PDF फ़ाइल स्वीकार है।"),true)});
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
const ADMIN_SESSION_TTL="30d";
const ADMIN_COOKIE_MAX_AGE=30*24*60*60*1000;
const DUMMY_ADMIN_PASSWORD_HASH="$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
const sign=a=>jwt.sign({sub:String(a._id),role:a.role,email:a.email,sv:a.sessionVersion||0},JWT_SECRET||"development-secret",{expiresIn:ADMIN_SESSION_TTL});
async function verifyAdminPassword(admin,password){
 if(typeof password!=="string"||!password)return false;
 const stored=String(admin?.passwordHash||DUMMY_ADMIN_PASSWORD_HASH).trim();
 if(!stored)return false;
 // All Owner/Admin accounts use the same password verification path.
 // Accept bcrypt hashes from every admin record and transparently migrate only legacy plaintext records.
 if(/^\$2[aby]\$\d{2}\$/.test(stored)){
  try{return await bcrypt.compare(password,stored);}catch{return false;}
 }
 if(stored===password){
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
const isHttpsUrl=v=>{try{const u=new URL(String(v));return u.protocol==="https:";}catch{return false;}};
const isValidEmail=v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
const normalizeDate=v=>{if(v===undefined||v===null||v==="")return null;const d=new Date(v);return Number.isNaN(d.getTime())?null:d;};
const validateAdDates=(start,end)=>{const s=normalizeDate(start),e=normalizeDate(end);if((start!==undefined&&start!==null&&start!==""&&!s)||(end!==undefined&&end!==null&&end!==""&&!e))return {error:"Invalid ad schedule date"};if(s&&e&&s>e)return {error:"Ad start date must be before or equal to end date"};return {start:s,end:e};};
const boundedText=(value,max)=>String(value??"").trim().slice(0,max);
const publicCache=(res,seconds=15,stale=60)=>res.set("Cache-Control",`public, max-age=${seconds}, stale-while-revalidate=${stale}`);
const sseClients=new Set();
function broadcastNewsEvent(type,payload={}){
  const message=`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for(const client of sseClients){try{client.res.write(message);}catch{sseClients.delete(client);}}
}
const REDIS_URL=String(process.env.UPSTASH_REDIS_REST_URL||"").trim().replace(/\/$/,"");
const REDIS_TOKEN=String(process.env.UPSTASH_REDIS_REST_TOKEN||"").trim();
const REDIS_ENABLED=Boolean(REDIS_URL&&REDIS_TOKEN);
async function redisCommand(command){
  if(!REDIS_ENABLED)return null;
  try{
    const r=await fetch(REDIS_URL,{method:"POST",headers:{"Authorization":`Bearer ${REDIS_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify(command)});
    if(!r.ok)return null;
    const data=await r.json();
    return data?.result ?? null;
  }catch{return null;}
}
async function redisGetJson(key){
  const raw=await redisCommand(["GET",key]);
  if(!raw)return null;
  try{return JSON.parse(raw);}catch{return null;}
}
async function redisSetJson(key,value,ttl=15){
  await redisCommand(["SET",key,JSON.stringify(value),"EX",String(ttl)]);
}
const MEILI_URL=String(process.env.MEILI_URL||"").trim().replace(/\/$/,"");
const MEILI_KEY=String(process.env.MEILI_MASTER_KEY||"").trim();
const MEILI_INDEX=String(process.env.MEILI_INDEX||"awaaz_news").trim()||"awaaz_news";
const MEILI_ENABLED=Boolean(MEILI_URL&&MEILI_KEY);
async function meiliRequest(path,options={}){
  if(!MEILI_ENABLED)return null;
  try{
    const r=await fetch(MEILI_URL+path,{...options,headers:{"Authorization":`Bearer ${MEILI_KEY}`,"Content-Type":"application/json",...(options.headers||{})}});
    if(!r.ok)return null;
    return await r.json();
  }catch{return null;}
}
function meiliDoc(n){
  return {_id:String(n._id),title:String(n.title||""),excerpt:String(n.excerpt||""),content:String(n.content||""),category:String(n.category||""),location:String(n.location||""),publishedAt:n.publishedAt||n.createdAt||null,slug:String(n.slug||"")};
}
async function meiliIndexDocuments(rows){
  if(!MEILI_ENABLED||!rows?.length)return false;
  const r=await meiliRequest(`/indexes/${encodeURIComponent(MEILI_INDEX)}/documents?primaryKey=_id`,{method:"POST",body:JSON.stringify(rows.map(meiliDoc))});
  return Boolean(r?.taskUid);
}
async function ensureMeiliIndex(){
  if(!MEILI_ENABLED)return false;
  try{
    await meiliRequest("/indexes",{method:"POST",body:JSON.stringify({uid:MEILI_INDEX,primaryKey:"_id"})});
    await meiliRequest(`/indexes/${encodeURIComponent(MEILI_INDEX)}/settings`,{method:"PATCH",body:JSON.stringify({
      searchableAttributes:["title","excerpt","content","category","location"],
      filterableAttributes:["category","location","publishedAt"],
      sortableAttributes:["publishedAt"],
      displayedAttributes:["_id","title","excerpt","content","category","location","publishedAt","slug"]
    })});
    return true;
  }catch(e){console.warn("Meilisearch setup skipped:",e?.message||e);return false;}
}

const b2ObjectKey=(folder,file)=>`${folder}/${crypto.randomUUID()}-${path.basename(file.filename)}`;
async function putB2WithRetry(key,body,contentType){
 let lastError=null;
 for(let attempt=1;attempt<=5;attempt+=1){
  try{
   await b2.send(new PutObjectCommand({Bucket:B2_BUCKET_NAME,Key:key,Body:body,ContentType:contentType,CacheControl:"public, max-age=31536000, immutable"}));
   return;
  }catch(error){
   lastError=error;
   const code=String(error?.name||error?.Code||"");
   console.error("B2 upload attempt "+attempt+" failed:",code||error?.message||error);
   if(attempt<5)await new Promise(resolve=>setTimeout(resolve,1000*Math.pow(2,attempt-1)));
  }
 }
 throw lastError||new Error("B2 upload failed");
}
function mediaRelative(key){return "/api/media/"+key.split("/").map(encodeURIComponent).join("/");}
async function storeUploadedFile(file,folder){
 if(!file) throw new Error("File required");
 if(!B2_ENABLED) throw new Error("B2 durable media storage is not configured");
 try{
  const body=await fs.promises.readFile(file.path);
  const isOptimizableImage=/^image\\/(jpeg|png|webp)$/i.test(String(file.mimetype||""));
  const variants={};
  if(isOptimizableImage){
   const image=sharp(body,{failOn:"none"});
   for(const width of [480,960,1440]){
    const key=`${folder}/optimized/${crypto.randomUUID()}-w${width}.webp`;
    const out=await image.clone().resize({width,withoutEnlargement:true}).webp({quality:78}).toBuffer();
    await putB2WithRetry(key,out,"image/webp");
    variants[`w${width}`]=mediaRelative(key);
   }
   try{
    const key=`${folder}/optimized/${crypto.randomUUID()}-w1440.avif`;
    const out=await image.clone().resize({width:1440,withoutEnlargement:true}).avif({quality:55}).toBuffer();
    await putB2WithRetry(key,out,"image/avif");
    variants.avif=mediaRelative(key);
   }catch(error){console.warn("AVIF optimization skipped:",error?.message||error);}
   const primaryKey=Object.keys(variants).includes("w1440")?variants.w1440:variants.w960;
   return {key:primaryKey,url:primaryKey,publicUrl:PUBLIC_API_URL+primaryKey,relativeUrl:primaryKey,variants,storage:"b2",optimized:true};
  }
  const key=b2ObjectKey(folder,file);
  await putB2WithRetry(key,body,file.mimetype);
  const relative=mediaRelative(key);
  return {key,url:relative,publicUrl:PUBLIC_API_URL+relative,relativeUrl:relative,storage:"b2",optimized:false};
 }catch(error){
  console.error("B2 upload failed:",error?.name||error?.Code||error?.message||error);
  throw new Error("Media could not be stored in Backblaze B2. Please retry the upload.");
 }finally{
  try{await fs.promises.unlink(file.path)}catch{}
 }
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

async function auth(req,res,next){
 try{
  const cookieToken=req.cookies["__Host-awaaz_admin"]||req.cookies.awaaz_admin||"";
  const bearer=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  const token=bearer||cookieToken;
  if(!token)return res.status(401).json({message:"Authentication required"});
  const p=jwt.verify(token,JWT_SECRET||"development-secret");
  const a=await Admin.findById(p.sub);
  if(!a||!a.active||Number(p.sv||0)!==Number(a.sessionVersion||0))return res.status(401).json({message:"Session expired"});
  req.admin=a;
  const issuedAt=Number(p.iat||0)*1000;
  if(issuedAt&&Date.now()-issuedAt>7*24*60*60*1000)setCookie(res,sign(a));
  next();
 }catch(error){
  res.status(401).json({message:error?.name==="TokenExpiredError"?"Session expired":"Invalid or expired session"});
 }
}
async function optionalAuth(req,_res,next){
 try{
  const cookieToken=req.cookies["__Host-awaaz_admin"]||req.cookies.awaaz_admin||"";
  const bearer=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  const token=cookieToken||bearer;
  if(token){
   const p=jwt.verify(token,JWT_SECRET||"development-secret"),a=await Admin.findById(p.sub);
   if(a&&a.active&&Number(p.sv||0)===Number(a.sessionVersion||0))req.admin=a;
  }
 }catch{}
 next();
}
function setCookie(res,t){
 const secure=process.env.COOKIE_SECURE!=="false";
 res.cookie("__Host-awaaz_admin",t,{httpOnly:true,secure,sameSite:secure?"none":"lax",maxAge:ADMIN_COOKIE_MAX_AGE,path:"/"});
}
function clearCookie(res){
 const secure=process.env.COOKIE_SECURE!=="false";
 const opts={httpOnly:true,secure,sameSite:secure?"none":"lax",path:"/"};
 res.clearCookie("__Host-awaaz_admin",opts);
 res.clearCookie("awaaz_admin",opts);
}
app.get("/",(_r,res)=>res.json({ok:true,service:"awaaz-rajasthan-api",message:"Awaaz Rajasthan API is live"}));
app.get("/api/health",(_r,res)=>{const database=mongoose.connection.readyState===1?"connected":"disconnected";const ok=database==="connected";res.status(ok?200:503).json({ok,database,service:"awaaz-rajasthan-api",time:new Date().toISOString()});});
app.get("/api/notifications/public-key",(_r,res)=>{const key=String(process.env.VAPID_PUBLIC_KEY||"").trim();res.json({publicKey:key});});
app.get("/api/news/stream",(req,res)=>{
  res.status(200);res.set({"Content-Type":"text/event-stream","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});res.flushHeaders?.();
  const client={res};sseClients.add(client);res.write(`event: ready\ndata: ${JSON.stringify({ok:true,time:new Date().toISOString()})}\n\n`);
  const heartbeat=setInterval(()=>{try{res.write(": heartbeat\\n\\n");}catch{}},25000);
  req.on("close",()=>{clearInterval(heartbeat);sseClients.delete(client);});
});
app.get("/api/sitemap.xml",async(_req,res,next)=>{try{const rows=await News.find({status:"published"}).select("slug updatedAt publishedAt createdAt").sort({publishedAt:-1,updatedAt:-1}).limit(5000).lean();const esc=v=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");const base=String(process.env.PUBLIC_FRONTEND_URL||process.env.FRONTEND_URL||"https://awaazrajasthan.vercel.app").split(",")[0].trim().replace(/\/$/,"");const urls=[`<url><loc>${esc(base)}/</loc></url>`];for(const x of rows){const id=x.slug||"";if(!id)continue;const d=x.updatedAt||x.publishedAt||x.createdAt;if(d)urls.push(`<url><loc>${esc(base)}/news/${encodeURIComponent(id)}</loc><lastmod>${new Date(d).toISOString()}</lastmod></url>`);else urls.push(`<url><loc>${esc(base)}/news/${encodeURIComponent(id)}</loc></url>`);}publicCache(res,300,900);res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`);}catch(e){next(e);}});
app.get("/api/sitemap-news.xml",async(_req,res,next)=>{try{
 const rows=await News.find({status:"published",publishedAt:{$ne:null}}).select("slug title publishedAt updatedAt category").sort({publishedAt:-1}).limit(1000).lean();
 const esc=v=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
 const base=String(process.env.PUBLIC_FRONTEND_URL||process.env.FRONTEND_URL||"https://awaazrajasthan.vercel.app").split(",")[0].trim().replace(/\/$/,"");
 const items=rows.filter(x=>x.slug&&x.publishedAt).map(x=>`<url><loc>${esc(base)}/news/${encodeURIComponent(x.slug)}</loc><news:news><news:publication><news:name>आवाज़ राजस्थान</news:name><news:language>hi</news:language></news:publication><news:publication_date>${new Date(x.publishedAt).toISOString()}</news:publication_date><news:title>${esc(x.title)}</news:title></news:news></url>`).join("");
 publicCache(res,300,900);res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${items}</urlset>`);
 }catch(e){next(e);}});
app.get("/api/rss.xml",async(_req,res,next)=>{try{
 const rows=await News.find({status:"published"}).select("slug title excerpt content publishedAt updatedAt category").sort({publishedAt:-1,createdAt:-1}).limit(50).lean();
 const esc=v=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
 const base=String(process.env.PUBLIC_FRONTEND_URL||process.env.FRONTEND_URL||"https://awaazrajasthan.vercel.app").split(",")[0].trim().replace(/\/$/,"");
 const items=rows.map(x=>{const link=x.slug?`${base}/news/${encodeURIComponent(x.slug)}`:base;const d=x.publishedAt||x.updatedAt||new Date();const desc=String(x.excerpt||x.content||"").replace(/<[^>]*>/g,"").slice(0,500);return `<item><title>${esc(x.title)}</title><link>${esc(link)}</link><guid isPermaLink="true">${esc(link)}</guid><pubDate>${new Date(d).toUTCString()}</pubDate><category>${esc(x.category||"राजस्थान")}</category><description>${esc(desc)}</description></item>`;}).join("");
 publicCache(res,60,300);res.type("application/rss+xml").send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>आवाज़ राजस्थान</title><link>${esc(base)}</link><description>राजस्थान की ताज़ा खबरें</description><language>hi-IN</language>${items}</channel></rss>`);
 }catch(e){next(e);}});
app.get("/api/news",async(req,res,next)=>{try{
 const limit=Math.min(Math.max(Number(req.query.limit)||30,1),100),page=Math.min(Math.max(Number(req.query.page)||1,1),1000);
 const category=boundedText(req.query.category,80),location=boundedText(req.query.location,80),q=boundedText(req.query.q,200);
 const cacheKey=`awaaz:news:${req.originalUrl}`;const cached=await redisGetJson(cacheKey);
 if(cached){res.set("X-Awaaz-Cache","HIT");res.set("Cache-Control","public, max-age=10, stale-while-revalidate=300, stale-if-error=86400");return res.json(cached);}
 let items,total;
 if(q&&MEILI_ENABLED){
   const filters=[];if(category&&category!=="होम")filters.push(`category = "${category.replace(/"/g,'\\\"')}"`);if(location)filters.push(`location = "${location.replace(/"/g,'\\\"')}"`);
   const result=await meiliRequest(`/indexes/${encodeURIComponent(MEILI_INDEX)}/search`,{method:"POST",body:JSON.stringify({q,limit,offset:(page-1)*limit,filter:filters.length?filters.join(" AND "):undefined,sort:["publishedAt:desc"]})});
   if(result){
     items=Array.isArray(result.hits)?result.hits.map(x=>({_id:x._id,title:x.title,excerpt:x.excerpt,content:x.content,category:x.category,location:x.location,publishedAt:x.publishedAt,slug:x.slug})):[];total=Number(result.estimatedTotalHits??result.totalHits??items.length);
   }
 }
 if(!Array.isArray(items)){
   const f={status:"published"};if(category&&category!=="होम")f.category=category;if(location)f.location=location;if(q)f.$text={$search:q};
   [items,total]=await Promise.all([News.find(f).sort({featured:-1,publishedAt:-1,createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),News.countDocuments(f)]);
 }
 const payload={news:items,data:items,pagination:{page,limit,total,pages:Math.ceil(total/limit)}};await redisSetJson(cacheKey,payload,15);
 res.set("X-Awaaz-Cache",REDIS_ENABLED?"MISS":"DISABLED");res.set("Cache-Control","public, max-age=10, stale-while-revalidate=300, stale-if-error=86400");res.set("CDN-Cache-Control","public, s-maxage=30, stale-while-revalidate=3600, stale-if-error=86400");res.set("Vercel-CDN-Cache-Control","public, s-maxage=30, stale-while-revalidate=3600, stale-if-error=86400");res.set("Vercel-Cache-Tag","news");res.json(payload);
 }catch(e){next(e);}});
app.get("/api/news/:id/preview",async(req,res,next)=>{try{const key=boundedText(req.params.id,180);const item=mongoose.isValidObjectId(key)?await News.findOne({_id:key,status:"published"}).lean():await News.findOne({$or:[{slug:key},{shareCode:key}],status:"published"}).lean();if(!item)return res.status(404).json({message:"News not found"});res.set("Cache-Control","public, max-age=60, s-maxage=300, stale-while-revalidate=900");res.json({news:item,data:item});}catch(e){next(e);}});
app.get("/api/news/:id",async(req,res,next)=>{try{const key=boundedText(req.params.id,180);const query=mongoose.isValidObjectId(key)?{_id:key,status:"published"}:{ $or:[{slug:key},{shareCode:key}],status:"published"};const item=await News.findOneAndUpdate(query,{$inc:{views:1}},{new:true}).lean();if(!item)return res.status(404).json({message:"News not found"});res.json({news:item,data:item});}catch(e){next(e);}});
app.get("/api/categories",async(_r,res,next)=>{try{const rows=await Category.find({active:true}).sort({sortOrder:1,name:1}).lean();
  const fallbackRows=NEWS_CATEGORIES.map((name,index)=>({name,icon:"📰",active:true,sortOrder:index}));
  const items=rows.length?rows:fallbackRows;
  publicCache(res,rows.length?300:60,rows.length?900:120);
  res.json({categories:items.map(x=>x.name),items});}catch(e){next(e);}});
app.get("/api/home-buttons",async(_r,res,next)=>{try{const rows=await HomeNavButton.find({active:true}).sort({sortOrder:1,_id:1}).lean();publicCache(res,300,900);res.json({buttons:rows});}catch(e){next(e);}});
app.get("/api/legal-settings",async(_r,res,next)=>{try{const x=await LegalSettings.findOne({key:"default"}).lean();publicCache(res,300,900);res.json({settings:x||{grievanceOfficerName:"",grievanceOfficerEmail:"",grievanceAddress:"",privacyEmail:""}});}catch(e){next(e);}});
app.post("/api/grievances",async(req,res,next)=>{try{const name=boundedText(req.body?.name,120),email=String(req.body?.email||"").trim().toLowerCase(),mobile=boundedText(req.body?.mobile,20),subject=boundedText(req.body?.subject,200),message=boundedText(req.body?.message,5000);if(!name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!subject||!message)return res.status(400).json({message:"नाम, सही ईमेल, विषय और शिकायत संदेश आवश्यक हैं।"});const ticketId="AR-GR-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();const g=await Grievance.create({ticketId,name,email,mobile,subject,message});res.status(201).json({ok:true,ticketId:g.ticketId,message:"शिकायत दर्ज हो गई है।"});}catch(e){next(e);}});
async function getAdPrices(){
 const rows=await AdPrice.find({active:true}).sort({position:1}).lean();
 const mapRow=x=>{
  const base=Number(x.ratePerDay||AD_BOOKING_RATES[x.position]||0);
  const imageRate=Number.isFinite(Number(x.imageRatePerDay))?Number(x.imageRatePerDay):base;
  const videoRate=Number.isFinite(Number(x.videoRatePerDay))?Number(x.videoRatePerDay):Math.max(base,Math.round(base*1.5));
  return {...x,ratePerDay:base,imageRatePerDay:imageRate,videoRatePerDay:videoRate};
 };
 if(rows.length)return rows.map(mapRow);
 return AD_POSITIONS.map(position=>{
  const base=Number(AD_BOOKING_RATES[position]||0);
  return {position,label:DEFAULT_AD_PRICE_META[position]?.label||position,description:DEFAULT_AD_PRICE_META[position]?.description||"",ratePerDay:base,imageRatePerDay:base,videoRatePerDay:Math.max(base,Math.round(base*1.5)),active:true};
 });
}
app.get("/api/ad-bookings/options",async(_req,res,next)=>{try{const rows=await getAdPrices();res.json({positions:rows,payment:{provider:"razorpay",checkout:true,upiQr:false}})}catch(e){next(e)}});

const bookingUploadLimiter=rateLimit({windowMs:10*60*1000,limit:1200,standardHeaders:"draft-8",legacyHeaders:false});
app.post("/api/ad-bookings/upload",bookingUploadLimiter,upload.single("file"),async(req,res,next)=>{try{if(!req.file)return res.status(400).json({message:"File required"});if(!req.file.mimetype.startsWith("image/")&&!req.file.mimetype.startsWith("video/"))return res.status(400).json({message:"केवल image या video upload करें"});const folder=req.file.mimetype.startsWith("video/")?"ad-bookings/videos":"ad-bookings/images";const stored=await storeUploadedFile(req.file,folder);res.status(201).json({url:stored.url,relativeUrl:stored.relativeUrl,storage:stored.storage});}catch(e){next(e)}});
app.post("/api/ad-bookings/:bookingId/create-order",bookingUploadLimiter,async(req,res,next)=>{try{if(!razorpay)return res.status(503).json({message:"Razorpay payment is not configured"});const bookingId=boundedText(req.params.bookingId,80),b=await AdBooking.findOne({bookingId});if(!b)return res.status(404).json({message:"Booking नहीं मिली"});if(b.paymentStatus==="paid")return res.json({paid:true,booking:{bookingId:b.bookingId,amount:b.amount,status:b.status,paymentStatus:b.paymentStatus}});const order=await razorpay.orders.create({amount:Math.round(Number(b.amount)*100),currency:"INR",receipt:b.bookingId,notes:{bookingId:b.bookingId,businessName:b.businessName,position:b.position}});b.razorpayOrderId=order.id;b.paymentMethod="upi";b.paymentStatus="pending";await b.save();res.json({keyId:RAZORPAY_KEY_ID,orderId:order.id,amount:order.amount,currency:order.currency,bookingId:b.bookingId});}catch(e){next(e)}});
app.post("/api/ad-bookings",bookingUploadLimiter,async(req,res,next)=>{try{const b=req.body||{},businessName=boundedText(b.businessName,150),contactName=boundedText(b.contactName,100),mobile=boundedText(b.mobile,20),email=String(b.email||"").toLowerCase().trim(),title=boundedText(b.title,150),position=String(b.position||""),device=AD_DEVICES.includes(String(b.device))?String(b.device):"all",requestedDays=Math.floor(Number(b.days||1)),image=boundedText(b.image,1000),video=boundedText(b.video,1000),link=String(b.link||"").trim();if(!businessName||!contactName||!mobile||!isValidEmail(email)||!title||!AD_POSITIONS.includes(position)||!Number.isInteger(requestedDays)||requestedDays<1||requestedDays>365)return res.status(400).json({message:"Booking details सही भरें"});if(link&&!isHttpUrl(link))return res.status(400).json({message:"Invalid ad link"});if(!image&&!video)return res.status(400).json({message:"Ad की photo या video में से कम-से-कम एक upload करें"});const days=requestedDays;const prices=await getAdPrices();const price=prices.find(x=>x.position===position);if(!price)return res.status(400).json({message:"इस ad position की pricing उपलब्ध नहीं है"});const imageRatePerDay=Number(price.imageRatePerDay||price.ratePerDay||0),videoRatePerDay=Number(price.videoRatePerDay||0),requestedMediaType=["image","video"].includes(String(b.mediaType))?String(b.mediaType):image&&video?"both":video?"video":"image";if(requestedMediaType==="image"&&!image)return res.status(400).json({message:"Photo ad के लिए photo upload करें"});if(requestedMediaType==="video"&&!video)return res.status(400).json({message:"Video ad के लिए video upload करें"});if(requestedMediaType==="both"&&(!image||!video))return res.status(400).json({message:"Photo + Video दोनों के लिए दोनों files upload करें"});const mediaType=requestedMediaType,ratePerDay=mediaType==="video"?videoRatePerDay:mediaType==="both"?imageRatePerDay+videoRatePerDay:imageRatePerDay,amount=days*ratePerDay;const bookingId=`AR-AD-${new Date().toISOString().slice(0,10).replace(/-/g,"")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;const booking=await AdBooking.create({bookingId,businessName,contactName,mobile,email,website:boundedText(b.website,500),title,position,device,startDate:null,endDate:null,days,ratePerDay,imageRatePerDay,videoRatePerDay,mediaType,amount,image,video,link,message:boundedText(b.message,1000),paymentMethod:"upi"});res.status(201).json({booking:{bookingId:booking.bookingId,amount:booking.amount,days:booking.days,ratePerDay:booking.ratePerDay,imageRatePerDay:booking.imageRatePerDay,videoRatePerDay:booking.videoRatePerDay,mediaType:booking.mediaType,status:booking.status,paymentStatus:booking.paymentStatus},payment:{provider:"razorpay",upiQr:false}});}catch(e){next(e)}});
app.get("/api/ad-bookings/:bookingId",async(req,res,next)=>{try{const b=await AdBooking.findOne({bookingId:boundedText(req.params.bookingId,80)}).select("bookingId title position device startDate endDate days ratePerDay amount paymentStatus status createdAt updatedAt").lean();if(!b)return res.status(404).json({message:"Booking नहीं मिली"});res.json({booking:b});}catch(e){next(e)}});
app.post("/api/ad-bookings/:bookingId/payment",bookingUploadLimiter,async(req,res,next)=>{try{const txn=boundedText(req.body?.paymentTxnId,100);if(!txn)return res.status(400).json({message:"Payment transaction ID जरूरी है"});const bookingId=boundedText(req.params.bookingId,80),b=await AdBooking.findOne({bookingId});if(!b)return res.status(404).json({message:"Booking नहीं मिली"});if(b.paymentStatus==="paid")return res.status(409).json({message:"इस booking का payment पहले ही Paid है",booking:{bookingId:b.bookingId,amount:b.amount,paymentStatus:b.paymentStatus,status:b.status}});if(["active","approved"].includes(String(b.status)))return res.status(409).json({message:"यह booking पहले ही approved/live है"});b.paymentTxnId=txn;b.paymentStatus="submitted";b.status="under_review";b.updatedAt=new Date();await b.save();res.json({booking:{bookingId:b.bookingId,amount:b.amount,paymentStatus:b.paymentStatus,status:b.status}})}catch(e){next(e)}});
app.post("/api/ad-bookings/:bookingId/verify-payment",bookingUploadLimiter,async(req,res,next)=>{try{if(!RAZORPAY_KEY_SECRET||!razorpay)return res.status(503).json({message:"Razorpay is not configured"});const bookingId=boundedText(req.params.bookingId,80),b=await AdBooking.findOne({bookingId});if(!b)return res.status(404).json({message:"Booking नहीं मिली"});if(b.paymentStatus==="paid")return res.json({ok:true,booking:{bookingId:b.bookingId,amount:b.amount,paymentStatus:b.paymentStatus,status:b.status}});const paymentId=boundedText(req.body?.razorpay_payment_id,100),orderId=boundedText(req.body?.razorpay_order_id,100),signature=boundedText(req.body?.razorpay_signature,200);if(!paymentId||!orderId||!signature||orderId!==b.razorpayOrderId)return res.status(400).json({message:"Invalid Razorpay payment details"});const expected=crypto.createHmac("sha256",RAZORPAY_KEY_SECRET).update(orderId+"|"+paymentId).digest("hex");if(signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return res.status(400).json({message:"Payment signature verification failed"});const [order,payment]=await Promise.all([razorpay.orders.fetch(orderId),razorpay.payments.fetch(paymentId)]);const expectedAmount=Math.round(Number(b.amount)*100);if(!order||String(order.id)!==orderId||Number(order.amount)!==expectedAmount||String(order.currency)!=="INR")return res.status(400).json({message:"Razorpay order amount mismatch"});if(!payment||String(payment.order_id)!==orderId||Number(payment.amount)!==expectedAmount||String(payment.currency)!=="INR"||String(payment.status)!=="captured")return res.status(400).json({message:"Razorpay payment is not captured or amount mismatch"});b.razorpayPaymentId=paymentId;b.razorpaySignature=signature;b.paymentTxnId=paymentId;b.paymentStatus="paid";b.status="paid";await b.save();res.json({ok:true,booking:{bookingId:b.bookingId,amount:b.amount,paymentStatus:b.paymentStatus,status:b.status}});}catch(e){next(e)}});
app.get("/api/ads",async(req,res,next)=>{try{const device=AD_DEVICES.includes(String(req.query.device))?String(req.query.device):"all",position=AD_POSITIONS.includes(String(req.query.position))?String(req.query.position):"home_top";const rows=await Ad.find({position,status:"active",$or:[{device:"all"},{device}]}).sort({createdAt:-1}).limit(20).lean();publicCache(res,30,120);res.json({ads:rows.filter(activeAd),data:rows.filter(activeAd)});}catch(e){next(e);}});
app.post("/api/ads/:id/impression",adImpressionLimiter,async(req,res,next)=>{try{if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:"Invalid ad id"});const ad=await Ad.findById(req.params.id).select("status startDate endDate").lean();if(!ad||!activeAd(ad))return res.status(404).json({message:"Ad not active"});await Ad.updateOne({_id:req.params.id},{$inc:{impressions:1}});res.status(204).end();}catch(e){next(e);}});
app.post("/api/ads/:id/click",adClickLimiter,async(req,res,next)=>{try{if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:"Invalid ad id"});const ad=await Ad.findById(req.params.id).select("status startDate endDate").lean();if(!ad||!activeAd(ad))return res.status(404).json({message:"Ad not active"});await Ad.updateOne({_id:req.params.id},{$inc:{clicks:1}});res.status(204).end();}catch(e){next(e);}});
async function deliverPushToActiveSubscribers({title,body,url="/",tagPrefix="awaaz-news"}){const VAPID_PUBLIC_KEY=cleanEnv(process.env.VAPID_PUBLIC_KEY),VAPID_PRIVATE_KEY=cleanEnv(process.env.VAPID_PRIVATE_KEY),VAPID_SUBJECT=cleanEnv(process.env.VAPID_SUBJECT);if(!VAPID_PUBLIC_KEY||!VAPID_PRIVATE_KEY||!VAPID_SUBJECT)return {configured:false,sent:0,removed:0,failed:0,total:0};webpush.setVapidDetails(VAPID_SUBJECT,VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY);const subscribers=await Subscriber.find({active:true}).select("subscription _id").lean();let sent=0,removed=0,failed=0;const payload=JSON.stringify({title:boundedText(title,120),body:boundedText(body,300),url,tag:`${tagPrefix}-${Date.now()}`,renotify:true});for(const row of subscribers){try{await webpush.sendNotification(row.subscription,payload);sent++;await Subscriber.updateOne({_id:row._id},{$set:{lastSuccessAt:new Date()}});}catch(error){if(error?.statusCode===404||error?.statusCode===410){await Subscriber.updateOne({_id:row._id},{$set:{active:false,lastFailureAt:new Date()}});removed++;}else{await Subscriber.updateOne({_id:row._id},{$set:{lastFailureAt:new Date()}});failed++;console.error("Push delivery failed:",error?.statusCode||error?.message||error);}}}return {configured:true,sent,removed,failed,total:subscribers.length};}
app.post("/api/notifications/subscribe",subscriptionLimiter,async(req,res,next)=>{try{const body=req.body||{},endpoint=String(body.endpoint||"").trim();if(!endpoint||endpoint.length>2048||!isHttpsUrl(endpoint))return res.status(400).json({message:"Invalid subscription endpoint"});if(!body.keys||typeof body.keys!=="object"||Array.isArray(body.keys))return res.status(400).json({message:"Push subscription keys are required"});const p256dh=String(body.keys.p256dh||"").trim(),authKey=String(body.keys.auth||"").trim();if(!p256dh||p256dh.length>512||!authKey||authKey.length>512)return res.status(400).json({message:"Invalid push subscription keys"});if(body.expirationTime!==undefined&&body.expirationTime!==null&&(!Number.isFinite(Number(body.expirationTime))||Number(body.expirationTime)<0))return res.status(400).json({message:"Invalid subscription expiration"});const district=boundedText(body?.district,80),category=boundedText(body?.category,80);await Subscriber.findOneAndUpdate({endpoint},{subscription:{...body,endpoint,keys:{p256dh,auth:authKey},district,category},district,category,active:true},{upsert:true,new:true,setDefaultsOnInsert:true});res.status(201).json({ok:true});}catch(e){next(e);}});
const adminLoginIpLimiter=rateLimit({windowMs:10*60*1000,limit:120,standardHeaders:"draft-8",legacyHeaders:false,skipSuccessfulRequests:true});
const adminLoginEmailLimiter=rateLimit({windowMs:10*60*1000,limit:60,standardHeaders:"draft-8",legacyHeaders:false,skipSuccessfulRequests:true,keyGenerator:req=>String(req.body?.email||"").toLowerCase().trim()||req.ip||"login"});
app.post("/api/admin/search/reindex",auth,ownerOnly,async(_req,res,next)=>{try{
    if(!MEILI_ENABLED)return res.status(503).json({message:"Meilisearch is not configured"});
    const rows=await News.find({status:"published"}).select("_id title excerpt content category location publishedAt createdAt slug").lean();
    let queued=0;for(let i=0;i<rows.length;i+=500){if(await meiliIndexDocuments(rows.slice(i,i+500)))queued++;}
    res.json({ok:true,index:MEILI_INDEX,documents:rows.length,batches:queued});
  }catch(e){next(e);}});
app.post("/api/admin/login",adminLoginIpLimiter,adminLoginEmailLimiter,async(req,res,next)=>{
 try{
  const email=String(req.body?.email||"").toLowerCase().trim(),password=String(req.body?.password||"");
  if(!isValidEmail(email)||!password)return res.status(401).json({message:"ईमेल या पासवर्ड गलत है।"});
  const admin=await Admin.findOne({email});
  const passwordOk=await verifyAdminPassword(admin,password);
  if(!admin||!admin.active||!passwordOk){
   console.warn("ADMIN_LOGIN_FAILED",JSON.stringify({email,exists:!!admin,active:admin?.active===true,hashPresent:!!admin?.passwordHash,hashType:admin?.passwordHash?String(admin.passwordHash).slice(0,4):null}));
   return res.status(401).json({message:"ईमेल या पासवर्ड गलत है।"});
  }
  admin.lastLoginAt=new Date();
  await admin.save();
  setCookie(res,sign(admin));
  res.set("Cache-Control","no-store");
  res.json({ok:true,admin:safe(admin),token:sign(admin)});
 }catch(e){next(e);}
});
app.post("/api/admin/logout",optionalAuth,async(req,res,next)=>{try{if(req.admin){req.admin.sessionVersion=Number(req.admin.sessionVersion||0)+1;await req.admin.save();}clearCookie(res);res.json({ok:true});}catch(e){next(e);}});
app.get("/api/admin/me",auth,(req,res)=>{res.set("Cache-Control","no-store");res.json({admin:safe(req.admin)});});
app.get("/api/admin/profile",auth,(req,res)=>{res.set("Cache-Control","no-store");res.json({admin:safe(req.admin)});});
app.patch("/api/admin/profile",auth,async(req,res,next)=>{
 try{
  const keys=Object.keys(req.body||{}),allowed=new Set(["email","password","avatar"]);
  if(keys.some(k=>!allowed.has(k)))return res.status(400).json({message:"Profile में केवल email, password और profile photo बदली जा सकती है।"});
  const u={};let invalidate=false;
  if(req.body?.email!==undefined){
   const email=String(req.body.email||"").toLowerCase().trim();
   if(!isValidEmail(email))return res.status(400).json({message:"Valid email required"});
   const clash=await Admin.findOne({email,_id:{$ne:req.admin._id}}).select("_id").lean();
   if(clash)return res.status(409).json({message:"Email is already in use"});
   u.email=email;invalidate=true;
  }
  if(req.body?.avatar!==undefined){
   const avatar=String(req.body.avatar||"").trim().slice(0,600);
   if(avatar&&!isHttpUrl(avatar))return res.status(400).json({message:"Invalid profile photo URL"});
   u.avatar=avatar;
  }
  if(req.body?.password!==undefined&&String(req.body.password||"")){
   const password=String(req.body.password);
   if(password.length<10)return res.status(400).json({message:"Password must be at least 10 characters"});
   u.passwordHash=await bcrypt.hash(password,12);invalidate=true;
  }
  if(invalidate)u.$inc={sessionVersion:1};
  const admin=await Admin.findByIdAndUpdate(req.admin._id,u,{new:true,runValidators:true});
  if(!admin)return res.status(404).json({message:"Admin profile not found"});
  setCookie(res,sign(admin));
  res.set("Cache-Control","no-store");
  res.json({ok:true,admin:safe(admin),token:sign(admin),reauthRequired:false});
 }catch(e){next(e)}
});
app.post("/api/admin/profile/upload",auth,upload.single("file"),async(req,res,next)=>{
 try{
  if(!req.file)return res.status(400).json({message:"File required"});
  if(!/^image\/(jpeg|png|webp|gif)$/.test(req.file.mimetype))return res.status(400).json({message:"केवल JPG, PNG, WEBP या GIF photo स्वीकार है"});
  const stored=await storeUploadedFile(req.file,"admin-profiles");
  res.status(201).json({url:stored.url,relativeUrl:stored.relativeUrl,storage:stored.storage});
 }catch(e){next(e)}
});
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
app.post("/api/admin/password/request-otp",rateLimit({windowMs:10*60*1000,limit:50,standardHeaders:"draft-8",legacyHeaders:false}),async(req,res,next)=>{
 try{
  const email=String(req.body?.email||"").toLowerCase().trim();
  if(!isValidEmail(email))return res.status(400).json({message:"Valid email required"});
  const target=await Admin.findOne({email,active:true});
  if(target) await issueAdminOtp(target);
  res.json({ok:true,message:"अगर यह registered admin email है, OTP भेज दिया गया है।"});
 }catch(e){next(e);}
});
app.post("/api/admin/password/reset-otp",rateLimit({windowMs:10*60*1000,limit:100,standardHeaders:"draft-8",legacyHeaders:false}),async(req,res,next)=>{
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
  if(!target||target.ownerType==="primary")return res.status(404).json({message:"Admin not found"});
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
  if(!target||target.ownerType==="primary")return res.status(404).json({message:"Admin not found"});
  const result=await resetAdminWithOtp(target,otp,nextPassword);
  if(result.ok)return res.json({ok:true});
  return res.status(result.status).json({message:result.message});
 }catch(e){next(e);}
});
app.post("/api/admin/change-password",auth,async(req,res,next)=>{try{const current=String(req.body.currentPassword||""),nextPassword=String(req.body.newPassword||"");if(nextPassword.length<10)return res.status(400).json({message:"New password must be at least 10 characters"});if(!(await bcrypt.compare(current,req.admin.passwordHash)))return res.status(401).json({message:"Current password is incorrect"});req.admin.passwordHash=await bcrypt.hash(nextPassword,12);req.admin.sessionVersion+=1;await req.admin.save();const token=sign(req.admin);setCookie(res,token);res.json({ok:true,token});}catch(e){next(e);}});
app.post("/api/admin/logout-all",auth,async(req,res)=>{req.admin.sessionVersion+=1;await req.admin.save();clearCookie(res);res.json({ok:true});});
app.get("/api/admin/dashboard",auth,ownerOnly,async(req,res,next)=>{try{const owner=req.admin.role==="owner",newsAccess=owner||req.admin.permissions?.some(p=>["news:read","news:write","news:delete"].includes(p));const stats={};if(newsAccess){const [news,published,drafts,views]=await Promise.all([News.countDocuments(),News.countDocuments({status:"published"}),News.countDocuments({status:"draft"}),News.aggregate([{$group:{_id:null,total:{$sum:"$views"}}}])]);stats.news=news;stats.published=published;stats.drafts=drafts;stats.views=views[0]?.total||0;}if(owner){const [ads,ast]=await Promise.all([Ad.countDocuments(),Ad.aggregate([{$group:{_id:null,impressions:{$sum:"$impressions"},clicks:{$sum:"$clicks"}}}])]);stats.ads=ads;stats.impressions=ast[0]?.impressions||0;stats.clicks=ast[0]?.clicks||0;}res.json({stats});}catch(e){next(e);}});
app.post("/api/admin/notifications/send",auth,ownerOnly,async(req,res,next)=>{try{const title=boundedText(req.body?.title,120),body=boundedText(req.body?.body,300),rawUrl=String(req.body?.url||"/").trim()||"/";if(!title||!body)return res.status(400).json({message:"Title and message are required"});if(!rawUrl.startsWith("/")||rawUrl.startsWith("//")||/[\\r\\n]/.test(rawUrl))return res.status(400).json({message:"Notification URL must be a same-origin path"});const result=await deliverPushToActiveSubscribers({title,body,url:rawUrl,tagPrefix:"awaaz-manual"});if(!result.configured)return res.status(503).json({message:"Push notification service is not configured"});res.json({ok:true,...result});}catch(e){next(e);}});
app.get("/api/admin/notifications/status",auth,ownerOnly,async(_req,res,next)=>{try{const [active,total,latest]=await Promise.all([Subscriber.countDocuments({active:true}),Subscriber.countDocuments(),Subscriber.findOne({}).sort({createdAt:-1}).select("createdAt active").lean()]);res.json({stats:{active,total,latestSubscribedAt:latest?.createdAt||null,latestActive:latest?.active===true}});}catch(e){next(e);}});
app.post("/api/admin/notifications/cleanup",auth,ownerOnly,async(_req,res,next)=>{try{const result=await Subscriber.deleteMany({active:false});res.json({ok:true,removed:Number(result.deletedCount||0)});}catch(e){next(e);}});
app.get("/api/admin/news",auth,permissions("news:read"),async(req,res,next)=>{try{const items=await News.find({}).sort({createdAt:-1}).limit(200).lean();res.json({news:items,data:items});}catch(e){next(e);}});
app.post("/api/admin/news",auth,permissions("news:write"),async(req,res,next)=>{try{const b=req.body||{},title=String(b.title||"").trim(),category=String(b.category||"राजस्थान"),location=String(b.location||"राजस्थान");if(!title)return res.status(400).json({message:"Title required"});if(!NEWS_CATEGORIES.includes(category)&&!await Category.exists({name:category,active:true}))return res.status(400).json({message:"Invalid news category"});if(!NEWS_DISTRICTS.includes(location))return res.status(400).json({message:"Invalid news district"});if(!adminCanPost(req.admin,category,location))return res.status(403).json({message:"इस admin को इस category/district में खबर publish करने की अनुमति नहीं है।"});let slug=slugify(b.slug||title);if(await News.exists({slug}))slug+=`-${Date.now().toString(36)}`;const status=String(b.status||"published")==="draft"?"draft":"published";const item=await News.create({...b,title,slug,category,location:boundedText(location,80),author:boundedText(b.author||req.admin.name||"आवाज़ राजस्थान",100),status,publishedAt:status==="published"?(b.publishedAt||new Date()):null,pushNotifiedAt:null});if(item.status==="published"){meiliIndexDocuments([item]).catch(e=>console.warn("Meilisearch index failed:",e?.message||e));broadcastNewsEvent("news-updated",{id:String(item._id),slug:item.slug,action:"created"});}res.status(201).json({news:item,push:item.status==="published"&&item.breaking===true?{queued:true}:null});}catch(e){next(e);}});
app.patch("/api/admin/news/:id",auth,permissions("news:write"),async(req,res,next)=>{try{const allowed=["title","slug","excerpt","content","category","location","image","video","author","status","featured","latest","breaking","publishedAt"],u={};allowed.forEach(k=>{if(req.body?.[k]!==undefined)u[k]=req.body[k]});if(u.title!==undefined){u.title=String(u.title).trim();if(!u.title)return res.status(400).json({message:"Title required"});}if(u.category!==undefined&&!NEWS_CATEGORIES.includes(String(u.category))&&!await Category.exists({name:String(u.category),active:true}))return res.status(400).json({message:"Invalid news category"});if(u.location!==undefined&&!NEWS_DISTRICTS.includes(String(u.location)))return res.status(400).json({message:"Invalid news district"});if(u.location!==undefined)u.location=boundedText(u.location,80);if(u.author!==undefined)u.author=boundedText(u.author,100);const current=await News.findById(req.params.id).select("category location status breaking pushNotifiedAt title excerpt slug").lean();if(!current)return res.status(404).json({message:"News not found"});if(!adminCanPost(req.admin,u.category||current.category,u.location||current.location))return res.status(403).json({message:"इस admin को इस category/district में खबर edit/publish करने की अनुमति नहीं है।"});if(u.status!==undefined&&!['draft','published','archived'].includes(String(u.status)))return res.status(400).json({message:"Invalid news status"});if(u.status==="published"&&!u.publishedAt)u.publishedAt=new Date();if(u.slug!==undefined){u.slug=slugify(u.slug);const clash=await News.findOne({slug:u.slug,_id:{$ne:req.params.id}}).select("_id").lean();if(clash)u.slug=`${u.slug}-${Date.now().toString(36)}`;}const shouldNotify=!current.pushNotifiedAt&&String(u.status??current.status)==="published"&&(u.breaking!==undefined?Boolean(u.breaking):Boolean(current.breaking));const item=await News.findByIdAndUpdate(req.params.id,u,{new:true,runValidators:true});if(!item)return res.status(404).json({message:"News not found"});meiliIndexDocuments([item]).catch(e=>console.warn("Meilisearch index failed:",e?.message||e));broadcastNewsEvent("news-updated",{id:String(item._id),slug:item.slug,action:"updated"});res.json({news:item,push:shouldNotify?{queued:true}:null});}catch(e){next(e);}});
app.delete("/api/admin/news/:id",auth,permissions("news:delete"),async(req,res,next)=>{try{const item=await News.findById(req.params.id).select("category location").lean();if(!item)return res.status(404).json({message:"News not found"});if(!adminCanPost(req.admin,item.category,item.location))return res.status(403).json({message:"इस admin को इस category/district में खबर delete करने की अनुमति नहीं है।"});const deleted=await News.findByIdAndDelete(req.params.id);if(!deleted)return res.status(404).json({message:"News not found"});if(MEILI_ENABLED){meiliRequest(`/indexes/${encodeURIComponent(MEILI_INDEX)}/documents/delete/${encodeURIComponent(String(deleted._id))}`,{method:"DELETE"}).catch(()=>{});}broadcastNewsEvent("news-updated",{id:String(deleted._id),action:"deleted"});res.json({ok:true});}catch(e){next(e);}});
app.get("/api/epapers",async(req,res,next)=>{try{const f={status:"published"};const raw=String(req.query?.date||"").trim();if(raw){if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(raw))return res.status(400).json({message:"Invalid date"});const start=new Date(raw+"T00:00:00.000Z"),end=new Date(start.getTime()+86400000);f.issueDate={$gte:start,$lt:end};}const items=await Epaper.find(f).sort({issueDate:-1,createdAt:-1}).lean();publicCache(res,300,900);res.json({epapers:items,data:items})}catch(e){next(e)}});
app.get("/api/epapers/:id/download",async(req,res,next)=>{try{const item=await Epaper.findOne({_id:req.params.id,status:"published"}).lean();if(!item)return res.status(404).json({message:"ई-पेपर नहीं मिला।"});const pdf=String(item.pdf||"");if(pdf.startsWith("/api/media/")){if(!B2_ENABLED)return res.status(503).json({message:"B2 storage is not configured"});const key=decodeURIComponent(pdf.replace(/^\/api\/media\//,"")).split("/").map(decodeURIComponent).join("/");if(!key||key.includes("..")||key.startsWith("/")||key.includes("\0"))return res.status(400).json({message:"Invalid media key"});const obj=await b2.send(new GetObjectCommand({Bucket:B2_BUCKET_NAME,Key:key}));res.set("Content-Type","application/pdf");res.set("Content-Disposition",`attachment; filename="awaaz-rajasthan-${new Date(item.issueDate).toISOString().slice(0,10)}.pdf"`);if(obj.ContentLength)res.set("Content-Length",String(obj.ContentLength));return obj.Body.pipe(res)}if(/^https?:\/\//i.test(pdf))return res.redirect(pdf);const filePath=path.join(process.cwd(),pdf.replace(/^\/+/, "").replace(/^epapers[\\/]/,"epapers/"));return res.status(404).json({message:"ई-पेपर B2 media URL उपलब्ध नहीं है।"})}catch(e){next(e)}});
app.get("/api/epaper/latest",async(_req,res,next)=>{try{const item=await Epaper.findOne({status:"published"}).sort({issueDate:-1,createdAt:-1}).lean();if(!item)return res.status(404).json({message:"ई-पेपर उपलब्ध नहीं है।"});const pdf=String(item.pdf||"");if(!pdf)return res.status(404).json({message:"ई-पेपर PDF उपलब्ध नहीं है।"});if(/^https?:\/\//i.test(pdf))return res.redirect(pdf);if(pdf.startsWith("/api/media/"))return res.redirect(pdf);const filePath=path.join(process.cwd(),pdf.replace(/^\/+/, "").replace(/^epapers[\\/]/,"epapers/"));return res.status(404).json({message:"ई-पेपर B2 media URL उपलब्ध नहीं है।"})}catch(e){next(e)}});
app.get("/api/admin/epapers",auth,ownerOnly,async(_r,res,next)=>{try{const items=await Epaper.find({}).sort({issueDate:-1,createdAt:-1}).lean();res.json({epapers:items,data:items})}catch(e){next(e)}});
async function watermarkEpaper(filePath){const bytes=fs.readFileSync(filePath);const pdf=await PDFDocument.load(bytes);let logoBytes=null;const logoUrl=String(process.env.FRONTEND_URL||"").replace(/\/$/,"")+"/awaazrajasthan-logo.png";if(logoUrl.startsWith("http")){try{const r=await fetch(logoUrl);if(r.ok)logoBytes=Buffer.from(await r.arrayBuffer())}catch{}}const logo=logoBytes?await pdf.embedPng(logoBytes):null;for(const page of pdf.getPages()){const {width,height}=page.getSize();if(logo){const size=Math.min(width,height)*.28;page.drawImage(logo,{x:(width-size)/2,y:(height-size)/2,width:size,height:size,opacity:.07})}else page.drawText("आवाज़ राजस्थान",{x:width*.27,y:height*.48,size:28,color:rgb(.45,.45,.45),opacity:.08})}fs.writeFileSync(filePath,await pdf.save());return true}
app.post("/api/admin/epapers/upload",auth,ownerOnly,upload.single("file"),async(req,res,next)=>{
 try{
  if(!req.file||req.file.mimetype!=="application/pdf")return res.status(400).json({message:"केवल PDF ई-पेपर स्वीकार है।"});
  try{await watermarkEpaper(req.file.path)}catch(e){try{fs.unlinkSync(req.file.path)}catch{};return res.status(422).json({message:"ई-पेपर पर watermark लगाने में समस्या हुई। PDF दोबारा upload करें।"})}
  const stored=await storeUploadedFile(req.file,"epapers");
  return res.status(201).json({pdf:stored.relativeUrl,url:stored.url,filename:req.file.originalname,storage:"b2"});
 }catch(e){next(e)}
});
app.post("/api/admin/epapers",auth,ownerOnly,async(req,res,next)=>{try{const b=req.body||{},title=String(b.title||"आज का ई-पेपर").trim(),issueDate=new Date(b.issueDate||"");if(!Number.isFinite(issueDate.getTime()))return res.status(400).json({message:"Valid issue date required"});if(!b.pdf)return res.status(400).json({message:"PDF required"});const item=await Epaper.create({title,issueDate,pdf:String(b.pdf),status:b.status==="draft"?"draft":"published"});res.status(201).json({epaper:item})}catch(e){next(e)}});
app.patch("/api/admin/epapers/:id",auth,ownerOnly,async(req,res,next)=>{try{const u={};if(req.body?.title!==undefined)u.title=String(req.body.title).trim();if(req.body?.pdf!==undefined)u.pdf=String(req.body.pdf);if(req.body?.status!==undefined){if(!["draft","published"].includes(String(req.body.status)))return res.status(400).json({message:"Invalid status"});u.status=String(req.body.status)}if(req.body?.issueDate!==undefined){const d=new Date(req.body.issueDate);if(!Number.isFinite(d.getTime()))return res.status(400).json({message:"Invalid issue date"});u.issueDate=d}const item=await Epaper.findByIdAndUpdate(req.params.id,u,{new:true,runValidators:true});if(!item)return res.status(404).json({message:"E-paper not found"});res.json({epaper:item})}catch(e){next(e)}});
app.delete("/api/admin/epapers/:id",auth,ownerOnly,async(req,res,next)=>{try{const item=await Epaper.findByIdAndDelete(req.params.id);if(!item)return res.status(404).json({message:"E-paper not found"});res.json({ok:true})}catch(e){next(e)}});
app.get("/api/admin/categories",auth,ownerOnly,async(_r,res,next)=>{try{const items=await Category.find({}).sort({sortOrder:1,name:1}).lean();res.json({categories:items,data:items})}catch(e){next(e)}});
app.get("/api/admin/home-buttons",auth,ownerOnly,async(_r,res,next)=>{try{const items=await HomeNavButton.find({}).sort({sortOrder:1,_id:1}).lean();res.json({buttons:items,data:items})}catch(e){next(e)}});
app.get("/api/admin/legal-settings",auth,ownerOnly,async(_r,res,next)=>{try{const x=await LegalSettings.findOne({key:"default"}).lean();res.json({settings:x||{}});}catch(e){next(e)}});
app.put("/api/admin/legal-settings",auth,ownerOnly,async(req,res,next)=>{try{const name=boundedText(req.body?.grievanceOfficerName,120),email=String(req.body?.grievanceOfficerEmail||"").trim().toLowerCase(),address=boundedText(req.body?.grievanceAddress,500),privacyEmail=String(req.body?.privacyEmail||"").trim().toLowerCase(),contactEmail=String(req.body?.contactEmail||"").trim().toLowerCase();if(email&&!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({message:"Grievance Officer email सही नहीं है।"});if(contactEmail&&!/^\S+@\S+\.\S+$/.test(contactEmail))return res.status(400).json({message:"Contact email सही नहीं है।"});const x=await LegalSettings.findOneAndUpdate({key:"default"},{$set:{key:"default",aboutText:boundedText(req.body?.aboutText,5000),contactEmail,contactPhone:boundedText(req.body?.contactPhone,40),contactAddress:boundedText(req.body?.contactAddress,500),privacyText:boundedText(req.body?.privacyText,8000),termsText:boundedText(req.body?.termsText,8000),disclaimerText:boundedText(req.body?.disclaimerText,8000),editorialPolicyText:boundedText(req.body?.editorialPolicyText,8000),copyrightText:boundedText(req.body?.copyrightText,500),grievanceOfficerName:name,grievanceOfficerEmail:email,grievanceAddress:address,privacyEmail,updatedBy:req.admin._id}},{upsert:true,new:true,setDefaultsOnInsert:true});res.json({settings:x});}catch(e){next(e)}});
app.get("/api/admin/grievances",auth,ownerOnly,async(_r,res,next)=>{try{const items=await Grievance.find({}).sort({createdAt:-1}).limit(500).lean();res.json({grievances:items});}catch(e){next(e)}});
app.patch("/api/admin/grievances/:id",auth,ownerOnly,async(req,res,next)=>{try{const x=await Grievance.findById(req.params.id);if(!x)return res.status(404).json({message:"Grievance not found"});if(req.body?.status!==undefined&&!["received","under_review","resolved","rejected"].includes(req.body.status))return res.status(400).json({message:"Invalid status"});if(req.body?.status!==undefined)x.status=req.body.status;if(req.body?.adminNote!==undefined)x.adminNote=boundedText(req.body.adminNote,2000);x.updatedAt=new Date();await x.save();res.json({grievance:x});}catch(e){next(e)}});

app.post("/api/admin/home-buttons",auth,ownerOnly,async(req,res,next)=>{try{const label=boundedText(req.body?.label,40),icon=boundedText(req.body?.icon||"📰",8),action=String(req.body?.action||"latest"),category=boundedText(req.body?.category,60);if(!label)return res.status(400).json({message:"Button label required"});if(!["latest","breaking","trending","video","photo","category"].includes(action))return res.status(400).json({message:"Invalid button action"});if(action==="category"&&!category)return res.status(400).json({message:"Category required for category button"});const item=await HomeNavButton.create({label,icon,action,category:action==="category"?category:"",sortOrder:Number(req.body?.sortOrder)||0,active:req.body?.active!==false});res.status(201).json({button:item})}catch(e){next(e)}});
app.patch("/api/admin/home-buttons/:id",auth,ownerOnly,async(req,res,next)=>{try{const item=await HomeNavButton.findById(req.params.id);if(!item)return res.status(404).json({message:"Home button not found"});if(req.body?.label!==undefined){const v=boundedText(req.body.label,40);if(!v)return res.status(400).json({message:"Button label required"});item.label=v}if(req.body?.icon!==undefined)item.icon=boundedText(req.body.icon,8);if(req.body?.action!==undefined){const action=String(req.body.action);if(!["latest","breaking","trending","video","photo","category"].includes(action))return res.status(400).json({message:"Invalid button action"});item.action=action}if(req.body?.category!==undefined)item.category=boundedText(req.body.category,60);if(item.action==="category"&&!item.category)return res.status(400).json({message:"Category required for category button"});if(req.body?.sortOrder!==undefined)item.sortOrder=Number(req.body.sortOrder)||0;if(req.body?.active!==undefined)item.active=Boolean(req.body.active);await item.save();res.json({button:item})}catch(e){next(e)}});
app.delete("/api/admin/home-buttons/:id",auth,ownerOnly,async(req,res,next)=>{try{const item=await HomeNavButton.findByIdAndDelete(req.params.id);if(!item)return res.status(404).json({message:"Home button not found"});res.json({ok:true})}catch(e){next(e)}});
app.post("/api/admin/categories",auth,ownerOnly,async(req,res,next)=>{try{const name=String(req.body?.name||"").trim();const icon=String(req.body?.icon||"📰").trim().slice(0,8);if(!name)return res.status(400).json({message:"Category name required"});if(name==="होम"||name==="सभी जिले")return res.status(400).json({message:"यह system category है"});if(await Category.exists({name}))return res.status(409).json({message:"Category already exists"});const item=await Category.create({name,icon,sortOrder:Number(req.body?.sortOrder)||0});res.status(201).json({category:item})}catch(e){next(e)}});
app.patch("/api/admin/categories/:id",auth,ownerOnly,async(req,res,next)=>{try{const item=await Category.findById(req.params.id);if(!item)return res.status(404).json({message:"Category not found"});if(req.body?.name!==undefined){const name=String(req.body.name).trim();if(!name||name==="होम"||name==="सभी जिले")return res.status(400).json({message:"Invalid category name"});const clash=await Category.findOne({name,_id:{$ne:item._id}});if(clash)return res.status(409).json({message:"Category already exists"});item.name=name}if(req.body?.icon!==undefined)item.icon=String(req.body.icon).trim().slice(0,8);if(req.body?.active!==undefined)item.active=Boolean(req.body.active);if(req.body?.sortOrder!==undefined)item.sortOrder=Number(req.body.sortOrder)||0;await item.save();res.json({category:item})}catch(e){next(e)}});
app.delete("/api/admin/categories/:id",auth,ownerOnly,async(req,res,next)=>{try{const item=await Category.findByIdAndDelete(req.params.id);if(!item)return res.status(404).json({message:"Category not found"});res.json({ok:true})}catch(e){next(e)}});
app.get("/api/admin/ad-prices",auth,ownerOnly,async(_req,res,next)=>{try{const rows=await AdPrice.find({}).sort({position:1}).lean();const by=new Map(rows.map(x=>[x.position,x]));const data=AD_POSITIONS.map(position=>by.get(position)||{position,label:DEFAULT_AD_PRICE_META[position]?.label||position,description:DEFAULT_AD_PRICE_META[position]?.description||"",ratePerDay:Number(AD_BOOKING_RATES[position]||0),active:true});res.json({prices:data});}catch(e){next(e)}});
app.put("/api/admin/ad-prices",auth,ownerOnly,async(req,res,next)=>{try{const items=Array.isArray(req.body?.prices)?req.body.prices:[];if(!items.length)return res.status(400).json({message:"Pricing list required"});for(const item of items){const position=String(item.position||"");const rate=Number(item.ratePerDay),imageRate=Number(item.imageRatePerDay),videoRate=Number(item.videoRatePerDay);if(!AD_POSITIONS.includes(position)||!Number.isFinite(rate)||rate<0||rate>10000000||!Number.isFinite(imageRate)||imageRate<0||imageRate>10000000||!Number.isFinite(videoRate)||videoRate<0||videoRate>10000000)return res.status(400).json({message:"Invalid ad pricing"});await AdPrice.findOneAndUpdate({position},{position,label:boundedText(item.label||DEFAULT_AD_PRICE_META[position]?.label||position,80),description:boundedText(item.description||DEFAULT_AD_PRICE_META[position]?.description||"",200),ratePerDay:rate,imageRatePerDay:imageRate,videoRatePerDay:videoRate,active:item.active!==false},{upsert:true,new:true,setDefaultsOnInsert:true});}res.json({ok:true,prices:await AdPrice.find({}).sort({position:1}).lean()});}catch(e){next(e)}});
app.get("/api/admin/ad-bookings",auth,ownerOnly,async(req,res,next)=>{try{const status=String(req.query?.status||"").trim();const f=status&&AD_BOOKING_STATUSES.includes(status)?{status}:{};const bookings=await AdBooking.find(f).sort({createdAt:-1}).limit(500).lean();res.json({bookings,data:bookings});}catch(e){next(e)}});
app.patch("/api/admin/ad-bookings/:id",auth,ownerOnly,async(req,res,next)=>{try{const b=await AdBooking.findById(req.params.id);if(!b)return res.status(404).json({message:"Ad booking not found"});const nextStatus=req.body?.status?String(req.body.status):b.status;if(!AD_BOOKING_STATUSES.includes(nextStatus))return res.status(400).json({message:"Invalid booking status"});if(["approved","active"].includes(nextStatus)&&b.paymentStatus!=="paid")return res.status(400).json({message:"पहले payment को Paid करें"});if(["approved","active"].includes(nextStatus)&&(!b.startDate||!b.endDate))return res.status(400).json({message:"पहले Owner Panel से Ad की Live Start Date सेट करें"});if(req.body?.paymentStatus!==undefined&&!["pending","submitted","paid","failed","refunded"].includes(String(req.body.paymentStatus)))return res.status(400).json({message:"Invalid payment status"});if(req.body?.adminNote!==undefined)b.adminNote=boundedText(req.body.adminNote,1000);if(req.body?.startDate!==undefined){const start=normalizeDate(req.body.startDate);if(!start)return res.status(400).json({message:"Valid start date जरूरी है"});const end=new Date(start);end.setDate(end.getDate()+Math.max(1,Number(b.days||1))-1);end.setHours(23,59,59,999);b.startDate=start;b.endDate=end;}if(req.body?.paymentStatus!==undefined)b.paymentStatus=String(req.body.paymentStatus);b.status=nextStatus;if(nextStatus==="paid"&&b.paymentStatus!=="paid")b.paymentStatus="paid";if(["approved","active"].includes(nextStatus)){const conflict=await AdBooking.findOne({_id:{$ne:b._id},position:b.position,device:{$in:[b.device,"all"]},status:{$in:["approved","active"]},startDate:{$lte:b.endDate},endDate:{$gte:b.startDate}}).select("_id bookingId").lean();if(conflict)return res.status(409).json({message:"इस position और date range में दूसरा approved/live ad मौजूद है"});const adData={title:b.title,image:b.image,video:b.video,link:b.link,position:b.position,device:b.device,status:"active",startDate:b.startDate,endDate:b.endDate,createdBy:req.admin._id};if(b.adId){await Ad.findByIdAndUpdate(b.adId,adData,{runValidators:true});}else{const ad=await Ad.create(adData);b.adId=ad._id;}b.status="active";}b.updatedAt=new Date();await b.save();res.json({booking:b});}catch(e){next(e)}});
app.delete("/api/admin/ad-bookings/:id",auth,ownerOnly,async(req,res,next)=>{try{const b=await AdBooking.findByIdAndDelete(req.params.id);if(!b)return res.status(404).json({message:"Ad booking not found"});if(b.adId)await Ad.findByIdAndDelete(b.adId);res.json({ok:true})}catch(e){next(e)}});
app.get("/api/admin/ads",auth,ownerOnly,async(_r,res,next)=>{try{const ads=await Ad.find({}).sort({createdAt:-1}).lean();res.json({ads,data:ads});}catch(e){next(e);}});
app.post("/api/admin/ads",auth,ownerOnly,async(req,res,next)=>{try{const b=req.body||{},title=String(b.title||"").trim();if(!title)return res.status(400).json({message:"Ad title required"});if(b.position!==undefined&&!AD_POSITIONS.includes(String(b.position)))return res.status(400).json({message:"Invalid ad position"});if(b.device!==undefined&&!AD_DEVICES.includes(String(b.device)))return res.status(400).json({message:"Invalid ad device"});if(b.link&&!isHttpUrl(b.link))return res.status(400).json({message:"Invalid ad link"});const schedule=validateAdDates(b.startDate,b.endDate);if(schedule.error)return res.status(400).json({message:schedule.error});const ad=await Ad.create({...b,title,position:b.position||"home_top",device:b.device||"all",startDate:schedule.start,endDate:schedule.end,createdBy:req.admin._id});res.status(201).json({ad});}catch(e){next(e);}});
app.patch("/api/admin/ads/:id",auth,ownerOnly,async(req,res,next)=>{try{const allowed=["title","image","video","link","position","device","status","startDate","endDate"],u={};allowed.forEach(k=>{if(req.body?.[k]!==undefined)u[k]=req.body[k]});if(u.title!==undefined){u.title=String(u.title).trim();if(!u.title)return res.status(400).json({message:"Ad title required"});}if(u.position!==undefined&&!AD_POSITIONS.includes(String(u.position)))return res.status(400).json({message:"Invalid ad position"});if(u.device!==undefined&&!AD_DEVICES.includes(String(u.device)))return res.status(400).json({message:"Invalid ad device"});if(u.status!==undefined&&!['active','paused'].includes(String(u.status)))return res.status(400).json({message:"Invalid ad status"});if(u.link&&!isHttpUrl(u.link))return res.status(400).json({message:"Invalid ad link"});const existing=await Ad.findById(req.params.id).select("startDate endDate").lean();if(!existing)return res.status(404).json({message:"Ad not found"});const schedule=validateAdDates(u.startDate!==undefined?u.startDate:existing.startDate,u.endDate!==undefined?u.endDate:existing.endDate);if(schedule.error)return res.status(400).json({message:schedule.error});u.startDate=schedule.start;u.endDate=schedule.end;const ad=await Ad.findByIdAndUpdate(req.params.id,u,{new:true,runValidators:true});res.json({ad});}catch(e){next(e);}});
app.delete("/api/admin/ads/:id",auth,ownerOnly,async(req,res,next)=>{try{const ad=await Ad.findByIdAndDelete(req.params.id);if(!ad)return res.status(404).json({message:"Ad not found"});res.json({ok:true});}catch(e){next(e);}});
app.get("/api/admin/admins",auth,ownerOnly,async(_r,res,next)=>{try{const admins=await Admin.find({}).sort({createdAt:-1}).lean();res.json({admins:admins.map(safe),data:admins.map(safe)});}catch(e){next(e);}});
app.post("/api/admin/admins",auth,ownerOnly,async(req,res,next)=>{try{const b=req.body||{},email=String(b.email||"").toLowerCase().trim(),password=String(b.password||"");if(!isValidEmail(email))return res.status(400).json({message:"Valid email required"});if(password.length<10)return res.status(400).json({message:"Password must be at least 10 characters"});if(await Admin.exists({email}))return res.status(409).json({message:"Admin already exists"});const selectedPermissions=Array.isArray(b.permissions)?b.permissions.map(String).filter(p=>ADMIN_PERMISSIONS.includes(p)):[];const allowedCategories=cleanAssignmentList(b.allowedCategories);const allowedDistricts=cleanAssignmentList(b.allowedDistricts).filter(x=>NEWS_DISTRICTS.includes(x));const avatar=String(b.avatar||"").trim().slice(0,600);const post=boundedText(b.post||"",100);const requestedRole=String(b.role||"admin").trim();const wantsSecondaryOwner=requestedRole==="owner"||requestedRole==="secondary_owner";if(requestedRole==="primary_owner")return res.status(400).json({message:"Primary Owner account केवल system bootstrap से बनाया जाता है।"});const a=await Admin.create({name:b.name,post,avatar,email,passwordHash:await bcrypt.hash(password,12),role:wantsSecondaryOwner?"owner":"admin",ownerType:wantsSecondaryOwner?"secondary":null,permissions:selectedPermissions,allowedCategories,allowedDistricts});res.status(201).json({admin:safe(a)});}catch(e){next(e);}});
app.patch("/api/admin/admins/:id",auth,ownerOnly,async(req,res,next)=>{try{const target=await Admin.findById(req.params.id);if(!target)return res.status(404).json({message:"Admin not found"});const self=String(target._id)===String(req.admin._id);const isPrimary=target.ownerType==="primary";const actorIsPrimary=req.admin.ownerType==="primary";const targetIsOwner=target.role==="owner";if(isPrimary&&!actorIsPrimary)return res.status(403).json({message:"Primary Owner account केवल Primary Owner स्वयं manage कर सकता है।"});if(targetIsOwner&&!actorIsPrimary&&!self)return res.status(403).json({message:"Secondary Owner दूसरे Owner account को edit नहीं कर सकता।"});const u={};let invalidateSessions=false;if(self&&!actorIsPrimary){const allowedSelf=new Set(["email","password","avatar"]);for(const key of Object.keys(req.body||{})){if(!allowedSelf.has(key))return res.status(403).json({message:"अपने account में केवल email, password और profile photo बदली जा सकती है।"});}}if(req.body?.post!==undefined)u.post=boundedText(req.body.post,100);if(req.body?.avatar!==undefined){const avatar=String(req.body.avatar||"").trim().slice(0,600);if(avatar&&!isHttpUrl(avatar))return res.status(400).json({message:"Invalid admin photo URL"});u.avatar=avatar;}if(req.body?.permissions!==undefined){if(!Array.isArray(req.body.permissions)||req.body.permissions.some(p=>!ADMIN_PERMISSIONS.includes(String(p))))return res.status(400).json({message:"Invalid permission"});u.permissions=req.body.permissions.map(String);invalidateSessions=true;}if(req.body?.allowedCategories!==undefined){const v=cleanAssignmentList(req.body.allowedCategories);const dynamic=v.filter(x=>!NEWS_CATEGORIES.includes(x));if(dynamic.length){const valid=await Category.find({name:{$in:dynamic},active:true}).select("name").lean();const validNames=new Set(valid.map(x=>x.name));if(dynamic.some(x=>!validNames.has(x)))return res.status(400).json({message:"Invalid category assignment"});}u.allowedCategories=v;invalidateSessions=true;}if(req.body?.allowedDistricts!==undefined){const v=cleanAssignmentList(req.body.allowedDistricts);if(v.some(x=>!NEWS_DISTRICTS.includes(x)))return res.status(400).json({message:"Invalid district assignment"});u.allowedDistricts=v;invalidateSessions=true;}["name","active"].forEach(k=>{if(req.body?.[k]!==undefined){if(k==="active"&&self)return;u[k]=req.body[k];if(k==="active")invalidateSessions=true;}});if(req.body?.email!==undefined){const email=String(req.body.email||"").toLowerCase().trim();if(!isValidEmail(email))return res.status(400).json({message:"Valid email required"});const clash=await Admin.findOne({email,_id:{$ne:req.params.id}}).select("_id").lean();if(clash)return res.status(409).json({message:"Email is already in use"});u.email=email;invalidateSessions=true;}if(req.body?.role!==undefined){if(isPrimary)return res.status(403).json({message:"Primary Owner role is protected"});if(req.body.role==="owner"){u.role="owner";u.ownerType=target.role==="owner"?(target.ownerType||"secondary"):"secondary";}else if(req.body.role==="admin"){u.role="admin";u.ownerType=null;}else return res.status(400).json({message:"Role must be Admin or Owner"});invalidateSessions=true;}if(req.body?.password){if(String(req.body.password).length<10)return res.status(400).json({message:"Password must be at least 10 characters"});u.passwordHash=await bcrypt.hash(String(req.body.password),12);invalidateSessions=true;}if(invalidateSessions)u.$inc={sessionVersion:1};const a=await Admin.findByIdAndUpdate(req.params.id,u,{new:true,runValidators:true});res.json({admin:safe(a)});}catch(e){next(e);}});
app.delete("/api/admin/admins/:id",auth,ownerOnly,async(req,res,next)=>{try{if(String(req.admin._id)===String(req.params.id))return res.status(400).json({message:"आप अपना account delete नहीं कर सकते।"});const target=await Admin.findById(req.params.id).select("role ownerType").lean();if(!target)return res.status(404).json({message:"Admin not found"});if(target.ownerType==="primary")return res.status(403).json({message:"Primary Owner account cannot be deleted"});if(target.role==="owner"&&req.admin.ownerType!=="primary")return res.status(403).json({message:"Secondary Owner दूसरे Owner account को delete नहीं कर सकता।"});await Admin.deleteOne({_id:req.params.id});res.json({ok:true});}catch(e){next(e);}});
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
const DEFAULT_CATEGORY_ROWS=[["भारत","🇮🇳",1],["विश्व","🌍",2],["राजस्थान","🏜️",3],["जयपुर","🏛️",4],["जोधपुर","🏰",5],["उदयपुर","🌊",6],["कोटा","🎓",7],["अजमेर","🕌",8],["भीलवाड़ा","🏭",9],["अपराध","🚨",10],["राजनीति","🏛️",11],["शिक्षा","📚",12],["नौकरी","💼",13],["खेल","🏆",14],["मनोरंजन","🎬",15],["बिजनेस","📈",16]];
async function bootstrap(){if(!process.env.MONGODB_URI){if(PROD)throw new Error("MONGODB_URI is required in production");return;}if(PROD&&!B2_ENABLED)throw new Error("B2 durable media storage is required in production");await mongoose.connect(process.env.MONGODB_URI,{
 serverSelectionTimeoutMS:10000,
 connectTimeoutMS:10000,
 socketTimeoutMS:45000,
 maxPoolSize:Number(process.env.MONGO_MAX_POOL_SIZE||50),
 minPoolSize:Number(process.env.MONGO_MIN_POOL_SIZE||5),
 maxIdleTimeMS:60000,
 waitQueueTimeoutMS:10000,
 heartbeatFrequencyMS:10000
});await Promise.all([News,Ad,AdBooking,Admin,Subscriber,Epaper,Category,HomeNavButton,LegalSettings,Grievance,AdPrice,AdminOtp].map(model=>model.createIndexes()));await ensureMeiliIndex();const missingShareCodes=await News.find({status:"published",$or:[{shareCode:{$exists:false}},{shareCode:""}]}).select("_id").limit(5000).lean();for(const row of missingShareCodes){for(let i=0;i<8;i++){const code=makeShareCode();try{const r=await News.updateOne({_id:row._id, $or:[{shareCode:{$exists:false}},{shareCode:""}]},{$set:{shareCode:code}});if(r.modifiedCount)break;}catch(e){if(i===7)console.error("shareCode backfill failed",e);}}}await Promise.all(DEFAULT_CATEGORY_ROWS.map(([name,icon,sortOrder])=>Category.updateOne({name},{$setOnInsert:{name,icon,sortOrder,active:true}},{upsert:true})));
const defaultHomeButtons=[["ताज़ा खबरें","🕒","latest","",1],["ब्रेकिंग न्यूज़","🔴","breaking","",2],["ट्रेंडिंग","🔥","trending","",3],["वीडियो","▶️","video","",4],["फोटो","📷","photo","",5]];await Promise.all(defaultHomeButtons.map(([label,icon,action,category,sortOrder])=>HomeNavButton.updateOne({action,label},{$setOnInsert:{label,icon,action,category,sortOrder,active:true}},{upsert:true})));const email=String(process.env.OWNER_EMAIL||"harshrajsinghgour1@gmail.com").toLowerCase().trim(),password=String(process.env.OWNER_PASSWORD||"");if(email&&password){let primaryOwner=await Admin.findOne({role:"owner",ownerType:"primary"});if(!primaryOwner){const configured=await Admin.findOne({email});if(configured){if(configured.role!=="owner")configured.role="owner";configured.ownerType="primary";if(!Array.isArray(configured.permissions)||!configured.permissions.length)configured.permissions=["news:read","news:write","news:delete","media:write"];if(!configured.passwordHash)configured.passwordHash=await bcrypt.hash(password,12);await configured.save();primaryOwner=configured;}else{const hash=await bcrypt.hash(password,12);primaryOwner=await Admin.create({name:"harshraj singh gour",email,passwordHash:hash,role:"owner",ownerType:"primary",permissions:["news:read","news:write","news:delete","media:write"],active:true,sessionVersion:0});}}if(primaryOwner.role!=="owner")primaryOwner.role="owner";if(primaryOwner.ownerType!=="primary")primaryOwner.ownerType="primary";if(!primaryOwner.passwordHash)primaryOwner.passwordHash=await bcrypt.hash(password,12);await primaryOwner.save();}const b2Status=await verifyB2Storage();if(PROD&&!b2Status.ok)console.error(`B2 storage verification warning: ${b2Status.reason}`);app.listen(PORT,async()=>{ console.log(`Awaaz Rajasthan API listening on ${PORT}`); console.log(`MongoDB pool: min=${process.env.MONGO_MIN_POOL_SIZE||5} max=${process.env.MONGO_MAX_POOL_SIZE||50}`); console.log(`B2 storage: ${b2Status.ok?"READY":b2Status.reason}`); if(process.env.ENABLE_PUSH_WORKER!=="false" && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT){ const worker=spawn(process.execPath,[path.join(path.dirname(process.argv[1]),"push-worker.js")],{stdio:"inherit",env:process.env}); worker.on("exit",(code,signal)=>console.log(`Push worker exited: code=${code??""} signal=${signal??""}`)); worker.on("error",error=>console.error("Push worker process error:",error)); } else console.log("Push worker not started: VAPID configuration is not complete or ENABLE_PUSH_WORKER=false"); });}
bootstrap().catch(e=>{console.error(e);process.exit(1);});