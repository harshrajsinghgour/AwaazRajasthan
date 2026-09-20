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

const app = express();
const PORT = Number(process.env.PORT || 5000);
const isProd = process.env.NODE_ENV === "production";
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_IN_PRODUCTION";
const uploadDir = path.join(process.cwd(), "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({
  origin: (origin, cb) => {
    const allowed = FRONTEND_URL === "*" || FRONTEND_URL.split(",").map(v => v.trim()).includes(origin);
    if (!origin || allowed) return cb(null, true);
    return cb(new Error("CORS origin denied"));
  },
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"]
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());
app.use(morgan(isProd ? "combined" : "dev"));

app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, limit: 500, standardHeaders: "draft-8", legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
app.use("/api/admin/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, standardHeaders: "draft-8", legacyHeaders: false }));
app.use("/uploads", express.static(uploadDir, { maxAge: "7d", immutable: true }));

const newsSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 220 },
  slug: { type: String, unique: true, sparse: true, index: true },
  excerpt: { type: String, trim: true, maxlength: 600, default: "" },
  content: { type: String, default: "" },
  category: { type: String, default: "राजस्थान", index: true },
  location: { type: String, default: "राजस्थान", index: true },
  image: { type: String, default: "" },
  author: { type: String, default: "आवाज़ राजस्थान" },
  status: { type: String, enum: ["draft","published","archived"], default: "draft", index: true },
  featured: { type: Boolean, default: false, index: true },
  breaking: { type: Boolean, default: false, index: true },
  views: { type: Number, default: 0 },
  publishedAt: { type: Date, default: null, index: true }
}, { timestamps: true });
newsSchema.index({ title: "text", excerpt: "text", content: "text", category: "text", location: "text" });

const adSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 150 },
  image: { type: String, default: "" },
  link: { type: String, default: "" },
  position: { type: String, enum: ["home_top","home_inline","sidebar","article_top","article_bottom","mobile","desktop"], default: "home_top", index: true },
  device: { type: String, enum: ["all","mobile","desktop"], default: "all", index: true },
  status: { type: String, enum: ["active","paused"], default: "active", index: true },
  startDate: { type: Date, default: null },
  endDate: { type: Date, default: null },
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" }
}, { timestamps: true });

const adminSchema = new mongoose.Schema({
  name: { type: String, trim: true, maxlength: 100, default: "Admin" },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ["owner","admin","editor"], default: "editor", index: true },
  permissions: { type: [String], default: [] },
  active: { type: Boolean, default: true },
  sessionVersion: { type: Number, default: 0 },
  lastLoginAt: { type: Date, default: null }
}, { timestamps: true });

const subscriberSchema = new mongoose.Schema({
  endpoint: { type: String, required: true, unique: true },
  subscription: { type: mongoose.Schema.Types.Mixed, required: true },
  active: { type: Boolean, default: true }
}, { timestamps: true });

const News = mongoose.model("News", newsSchema);
const Ad = mongoose.model("Ad", adSchema);
const Admin = mongoose.model("Admin", adminSchema);
const Subscriber = mongoose.model("Subscriber", subscriberSchema);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(10).toString("hex") + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 8) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(/^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(file.mimetype) ? null : new Error("केवल JPG, PNG, WEBP, GIF या PDF फ़ाइल स्वीकार है।"), true)
});

const sign = admin => jwt.sign({ sub: String(admin._id), role: admin.role, email: admin.email, sv: admin.sessionVersion || 0 }, JWT_SECRET, { expiresIn: "8h" });
const safe = admin => { const o = admin.toObject ? admin.toObject() : admin; delete o.passwordHash; return o; };
const activeAd = (ad, now = new Date()) => ad.status === "active" && (!ad.startDate || ad.startDate <= now) && (!ad.endDate || ad.endDate >= now);
const slugify = value => String(value).toLowerCase().trim().replace(/[^a-z0-9\u0900-\u097f]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 150) || crypto.randomUUID();

function setCookie(res, token) {
  res.cookie("awaaz_admin", token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== "false",
    sameSite: process.env.COOKIE_SECURE !== "false" ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/"
  });
}
async function auth(req, res, next) {
  try {
    const token = req.cookies.awaaz_admin || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ message: "Authentication required" });
    const p = jwt.verify(token, JWT_SECRET);
    const admin = await Admin.findById(p.sub);
    if (!admin || !admin.active || Number(p.sv || 0) !== Number(admin.sessionVersion || 0)) return res.status(401).json({ message: "Session expired" });
    req.admin = admin;
    next();
  } catch { res.status(401).json({ message: "Invalid or expired session" });
  }
}
function ownerOnly(req, res, next) {
  if (req.admin.role !== "owner") return res.status(403).json({ message: "केवल owner यह कार्रवाई कर सकता है।" });
  next();
}
function permission(name) {
  return (req, res, next) => {
    if (req.admin.role === "owner" || req.admin.permissions.includes(name)) return next();
    res.status(403).json({ message: "Permission denied" });
  };
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "awaaz-rajasthan-api", time: new Date().toISOString() }));

app.get("/api/news", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const filter = { status: "published" };
    if (req.query.category && req.query.category !== "होम") filter.category = req.query.category;
    if (req.query.location) filter.location = req.query.location;
    if (req.query.q) filter.$text = { $search: String(req.query.q) };
    if (req.query.featured === "true") filter.featured = true;
    const [items, total] = await Promise.all([
      News.find(filter).sort({ featured:-1, publishedAt:-1, createdAt:-1 }).skip((page-1)*limit).limit(limit).lean(),
      News.countDocuments(filter)
    ]);
    res.json({ news: items, data: items, pagination: { page, limit, total, pages: Math.ceil(total/limit) } });
  } catch (e) { next(e); }
});

app.get("/api/news/:id", async (req, res, next) => {
  try {
    const item = mongoose.isValidObjectId(req.params.id)
      ? await News.findOneAndUpdate({ _id:req.params.id, status:"published" }, { $inc:{views:1} }, { new:true }).lean()
      : await News.findOne({ slug:req.params.id, status:"published" }).lean();
    if (!item) return res.status(404).json({ message:"News not found" });
    res.json({ news:item, data:item });
  } catch(e) { next(e); }
});

app.get("/api/categories", async (_req,res,next) => {
  try { res.json({ categories: await News.distinct("category",{status:"published"}) }); } catch(e){ next(e); }
});

app.get("/api/ads", async (req,res,next) => {
  try {
    const device = ["mobile","desktop"].includes(req.query.device) ? req.query.device : "all";
    const position = String(req.query.position || "home_top");
    const list = await Ad.find({position,status:"active",$or:[{device:"all"},{device}]}).sort({createdAt:-1}).lean();
    const ads = list.filter(activeAd);
    res.json({ads,data:ads});
  } catch(e){next(e);}
});
app.post("/api/ads/:id/impression", async (req,res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:"Invalid ad id"});
  await Ad.updateOne({_id:req.params.id},{$inc:{impressions:1}});
  res.status(204).end();
});
app.post("/api/ads/:id/click", async (req,res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:"Invalid ad id"});
  await Ad.updateOne({_id:req.params.id},{$inc:{clicks:1}});
  res.status(204).end();
});

app.post("/api/notifications/subscribe", async(req,res,next)=>{
  try{
    if(!req.body?.endpoint) return res.status(400).json({message:"Invalid subscription"});
    await Subscriber.findOneAndUpdate({endpoint:req.body.endpoint},{subscription:req.body,active:true},{upsert:true,new:true,setDefaultsOnInsert:true});
    res.status(201).json({ok:true});
  }catch(e){next(e);}
});

app.post("/api/admin/login", async(req,res,next)=>{
  try{
    const email=String(req.body.email||"").toLowerCase().trim();
    const password=String(req.body.password||"");
    const admin=await Admin.findOne({email});
    if(!admin || !admin.active || !(await bcrypt.compare(password,admin.passwordHash))) return res.status(401).json({message:"ईमेल या पासवर्ड गलत है।"});
    admin.lastLoginAt=new Date(); await admin.save();
    setCookie(res,sign(admin));
    res.json({admin:safe(admin)});
  }catch(e){next(e);}
});
app.post("/api/admin/logout",(req,res)=>{res.clearCookie("awaaz_admin",{httpOnly:true,secure:process.env.COOKIE_SECURE!=="false",sameSite:process.env.COOKIE_SECURE!=="false"?"none":"lax",path:"/"});res.json({ok:true});});
app.get("/api/admin/me",auth,(req,res)=>res.json({admin:safe(req.admin)}));
app.post("/api/admin/change-password",auth,authLimiter,async(req,res,next)=>{
  try{
    const current=String(req.body.currentPassword||""),nextPassword=String(req.body.newPassword||"");
    if(nextPassword.length<10)return res.status(400).json({message:"New password must be at least 10 characters"});
    if(!(await bcrypt.compare(current,req.admin.passwordHash)))return res.status(401).json({message:"Current password is incorrect"});
    req.admin.passwordHash=await bcrypt.hash(nextPassword,12);
    req.admin.sessionVersion+=1;
    await req.admin.save();
    setCookie(res,sign(req.admin));
    res.json({ok:true});
  }catch(e){next(e);}
});
app.post("/api/admin/logout-all",auth,async(req,res)=>{req.admin.sessionVersion+=1;await req.admin.save();res.clearCookie("awaaz_admin",{httpOnly:true,secure:process.env.COOKIE_SECURE!=="false",sameSite:process.env.COOKIE_SECURE!=="false"?"none":"lax",path:"/"});res.json({ok:true});});

app.get("/api/admin/dashboard",auth,async(req,res,next)=>{
  try{
    const [news,published,drafts,ads,views,adStats]=await Promise.all([
      News.countDocuments(),News.countDocuments({status:"published"}),News.countDocuments({status:"draft"}),Ad.countDocuments(),
      News.aggregate([{$group:{_id:null,total:{$sum:"$views"}}}]),
      Ad.aggregate([{$group:{_id:null,impressions:{$sum:"$impressions"},clicks:{$sum:"$clicks"}}}])
    ]);
    res.json({stats:{news,published,drafts,ads,views:views[0]?.total||0,impressions:adStats[0]?.impressions||0,clicks:adStats[0]?.clicks||0}});
  }catch(e){next(e);}
});

app.get("/api/admin/news",auth,permission("news:read"),async(req,res,next)=>{
  try{const items=await News.find({}).sort({createdAt:-1}).limit(100).lean();res.json({news:items,data:items});}catch(e){next(e);}
});
app.post("/api/admin/news",auth,permission("news:write"),async(req,res,next)=>{
  try{
    const b=req.body||{},title=String(b.title||"").trim();
    if(!title)return res.status(400).json({message:"Title required"});
    let slug=slugify(b.slug||title); if(await News.exists({slug}))slug += "-"+Date.now().toString(36);
    const item=await News.create({...b,title,slug,author:b.author||req.admin.name,publishedAt:b.status==="published"?(b.publishedAt||new Date()):null});
    res.status(201).json({news:item});
  }catch(e){next(e);}
});
app.patch("/api/admin/news/:id",auth,permission("news:write"),async(req,res,next)=>{
  try{
    const keys=["title","slug","excerpt","content","category","location","image","author","status","featured","breaking","publishedAt"];
    const u={};keys.forEach(k=>{if(req.body[k]!==undefined)u[k]=req.body[k]});
    if(u.status==="published"&&!u.publishedAt)u.publishedAt=new Date();
    const item=await News.findByIdAndUpdate(req.params.id,u,{new:true,runValidators:true});
    if(!item)return res.status(404).json({message:"News not found"});
    res.json({news:item});
  }catch(e){next(e);}
});
app.delete("/api/admin/news/:id",auth,permission("news:delete"),async(req,res,next)=>{
  try{const item=await News.findByIdAndDelete(req.params.id);if(!item)return res.status(404).json({message:"News not found"});res.json({ok:true});}catch(e){next(e);}
});

app.get("/api/admin/ads",auth,ownerOnly,async(_req,res,next)=>{try{const ads=await Ad.find({}).sort({createdAt:-1}).lean();res.json({ads,data:ads});}catch(e){next(e);}});
app.post("/api/admin/ads",auth,ownerOnly,async(req,res,next)=>{try{if(!req.body?.title)return res.status(400).json({message:"Ad title required"});const ad=await Ad.create({...req.body,createdBy:req.admin._id});res.status(201).json({ad});}catch(e){next(e);}});
app.patch("/api/admin/ads/:id",auth,ownerOnly,async(req,res,next)=>{
  try{const keys=["title","image","link","position","device","status","startDate","endDate"],u={};keys.forEach(k=>{if(req.body[k]!==undefined)u[k]=req.body[k]});const ad=await Ad.findByIdAndUpdate(req.params.id,u,{new:true,runValidators:true});if(!ad)return res.status(404).json({message:"Ad not found"});res.json({ad});}catch(e){next(e);}
});
app.delete("/api/admin/ads/:id",auth,ownerOnly,async(req,res,next)=>{try{await Ad.findByIdAndDelete(req.params.id);res.json({ok:true});}catch(e){next(e);}});
app.get("/api/admin/ad-analytics",auth,ownerOnly,async(_req,res,next)=>{
  try{const ads=await Ad.find({}).select("title position device impressions clicks status startDate endDate").sort({clicks:-1,impressions:-1}).lean();const totals=ads.reduce((a,x)=>({impressions:a.impressions+x.impressions,clicks:a.clicks+x.clicks}),{impressions:0,clicks:0});res.json({ads,totals,ctr:totals.impressions?Number((totals.clicks/totals.impressions*100).toFixed(2)):0});}catch(e){next(e);}
});

app.get("/api/admin/admins",auth,ownerOnly,async(_req,res,next)=>{try{res.json({admins:await Admin.find({}).select("-passwordHash").sort({createdAt:1}).lean()});}catch(e){next(e);}});
app.post("/api/admin/admins",auth,ownerOnly,async(req,res,next)=>{
  try{const b=req.body||{},email=String(b.email||"").toLowerCase().trim();if(!email||!b.password)return res.status(400).json({message:"Email and password required"});if(b.role==="owner")return res.status(400).json({message:"Owner role is reserved"});if(await Admin.exists({email}))return res.status(409).json({message:"Admin already exists"});const a=await Admin.create({name:b.name,email,passwordHash:await bcrypt.hash(String(b.password),12),role:b.role||"editor",permissions:Array.isArray(b.permissions)?b.permissions:[]});res.status(201).json({admin:safe(a)});}catch(e){next(e);}
});
app.patch("/api/admin/admins/:id",auth,ownerOnly,async(req,res,next)=>{
  try{const u={};["name","permissions","active"].forEach(k=>{if(req.body[k]!==undefined)u[k]=req.body[k]});if(req.body.role!==undefined){if(req.body.role==="owner")return res.status(400).json({message:"Owner role is reserved"});u.role=req.body.role;}if(req.body.password)u.passwordHash=await bcrypt.hash(String(req.body.password),12);const a=await Admin.findByIdAndUpdate(req.params.id,u,{new:true,runValidators:true});if(!a)return res.status(404).json({message:"Admin not found"});res.json({admin:safe(a)});}catch(e){next(e);}
});
app.delete("/api/admin/admins/:id",auth,ownerOnly,async(req,res,next)=>{try{if(String(req.admin._id)===req.params.id)return res.status(400).json({message:"Owner cannot delete own account"});await Admin.findByIdAndDelete(req.params.id);res.json({ok:true});}catch(e){next(e);}});

app.post("/api/admin/upload",auth,permission("upload:write"),upload.single("file"),async(req,res)=>{
  if(!req.file)return res.status(400).json({message:"File required"});
  res.status(201).json({url:"/uploads/"+req.file.filename,filename:req.file.filename,mimetype:req.file.mimetype,size:req.file.size});
});

async function ensureOwner(){
  const email=String(process.env.OWNER_EMAIL||"").toLowerCase().trim(),password=String(process.env.OWNER_PASSWORD||"");
  if(!email||!password){console.warn("OWNER_EMAIL/OWNER_PASSWORD not set; owner bootstrap skipped.");return;}
  if(await Admin.exists({email}))return;
  await Admin.create({name:"Owner",email,passwordHash:await bcrypt.hash(password,12),role:"owner",permissions:["news:read","news:write","news:delete","upload:write"]});
  console.log("Owner account created:",email);
}

app.use((err,_req,res,_next)=>{
  console.error(err);
  if(err?.code===11000)return res.status(409).json({message:"Duplicate value"});
  if(err instanceof multer.MulterError)return res.status(400).json({message:err.message});
  res.status(500).json({message:"Server error"});
});

mongoose.connect(process.env.MONGODB_URI).then(async()=>{await ensureOwner();app.listen(PORT,()=>console.log("Awaaz Rajasthan API running on :"+PORT));}).catch(err=>{console.error("MongoDB connection failed",err);process.exit(1);});
