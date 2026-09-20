import "dotenv/config";
import mongoose from "mongoose";
import webpush from "web-push";

const MONGODB_URI = process.env.MONGODB_URI;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;
const POLL_MS = Math.max(Number(process.env.PUSH_WORKER_POLL_MS || 30000), 10000);
const PUSH_CONCURRENCY = Math.min(Math.max(Number(process.env.PUSH_WORKER_CONCURRENCY || 10), 1), 50);
const CLAIM_TIMEOUT_MS = Math.max(Number(process.env.PUSH_WORKER_CLAIM_TIMEOUT_MS || 10 * 60 * 1000), 60 * 1000);

if (!MONGODB_URI) throw new Error("MONGODB_URI is required for push worker");
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) throw new Error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are required for push worker");

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const newsSchema = new mongoose.Schema({ title: String, slug: String, excerpt: String, category: String, location: String, image: String, status: String, breaking: Boolean, publishedAt: Date }, { collection: "news", timestamps: true });
const subscriberSchema = new mongoose.Schema({ endpoint: { type: String, unique: true }, subscription: mongoose.Schema.Types.Mixed, active: Boolean }, { collection: "subscribers", timestamps: true });
const deliverySchema = new mongoose.Schema({
  newsId: { type: mongoose.Schema.Types.ObjectId, unique: true },
  claimToken: { type: String, default: "" },
  status: { type: String, enum: ["processing", "sent"], default: "processing", index: true },
  lockedAt: { type: Date, default: null, index: true },
  sentAt: { type: Date, default: null },
  deliveredEndpoints: { type: [String], default: [] }
}, { collection: "pushdeliveries", timestamps: true });

const News = mongoose.models.PushNews || mongoose.model("PushNews", newsSchema);
const Subscriber = mongoose.models.PushSubscriber || mongoose.model("PushSubscriber", subscriberSchema);
const Delivery = mongoose.models.PushDelivery || mongoose.model("PushDelivery", deliverySchema);

function newsUrl(news) { return `/news/${encodeURIComponent(String(news.slug || news._id))}`; }

async function claimDelivery(newsId) {
  const claimToken = new mongoose.Types.ObjectId().toString();
  const cutoff = new Date(Date.now() - CLAIM_TIMEOUT_MS);
  const existing = await Delivery.findOne({ newsId }).select("status lockedAt claimToken").lean();
  if (existing?.status === "sent") return null;
  if (existing?.status === "processing" && existing.lockedAt && existing.lockedAt >= cutoff) return null;
  try {
    const filter = existing ? { newsId, status: "processing", lockedAt: { $lt: cutoff } } : { newsId };
    const row = await Delivery.findOneAndUpdate(
      filter,
      { $set: { claimToken, status: "processing", lockedAt: new Date() }, $setOnInsert: { deliveredEndpoints: [] } },
      { new: true, upsert: !existing }
    ).lean();
    return row?.claimToken === claimToken ? claimToken : null;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return null;
  }
}

async function createInitialClaim(newsId) {
  const claimToken = new mongoose.Types.ObjectId().toString();
  try {
    const row = await Delivery.create({ newsId, claimToken, status: "processing", lockedAt: new Date(), deliveredEndpoints: [] });
    return String(row.claimToken) === claimToken ? claimToken : null;
  } catch (error) {
    if (error?.code === 11000) return claimDelivery(newsId);
    throw error;
  }
}

async function claim(newsId) {
  const existing = await Delivery.findOne({ newsId }).select("status lockedAt").lean();
  if (!existing) return createInitialClaim(newsId);
  return claimDelivery(newsId);
}

async function releaseClaim(newsId, claimToken) {
  if (!claimToken) return;
  await Delivery.updateOne({ newsId, claimToken, status: "processing" }, { $set: { claimToken: "", lockedAt: null } });
}

async function markSent(newsId, claimToken) {
  if (!claimToken) return;
  await Delivery.updateOne(
    { newsId, claimToken, status: "processing" },
    { $set: { status: "sent", sentAt: new Date(), lockedAt: null, claimToken: "" } }
  );
}

async function markDelivered(newsId, claimToken, endpoint) {
  if (!endpoint) return;
  await Delivery.updateOne({ newsId, claimToken, status: "processing" }, { $addToSet: { deliveredEndpoints: endpoint } });
}

async function sendOne(row, payload) {
  try {
    await webpush.sendNotification(row.subscription, payload);
    return { endpoint: String(row.endpoint || ""), sent: 1, removed: 0, retry: 0 };
  } catch (error) {
    if (error?.statusCode === 404 || error?.statusCode === 410) {
      await Subscriber.updateOne({ _id: row._id }, { $set: { active: false } });
      return { endpoint: String(row.endpoint || ""), sent: 0, removed: 1, retry: 0 };
    }
    console.error("Push delivery failed:", error?.statusCode || error?.message || error);
    return { endpoint: String(row.endpoint || ""), sent: 0, removed: 0, retry: 1 };
  }
}

async function sendToSubscribers(news, claimToken) {
  const subscribers = await Subscriber.find({ active: true }).select("endpoint subscription").lean();
  if (!subscribers.length) return { sent: 0, removed: 0, retry: 0, remaining: 0, noSubscribers: true };

  const delivery = await Delivery.findOne({ newsId: news._id, claimToken, status: "processing" }).select("deliveredEndpoints").lean();
  const delivered = new Set(Array.isArray(delivery?.deliveredEndpoints) ? delivery.deliveredEndpoints : []);
  const pending = subscribers.filter(row => row.endpoint && !delivered.has(String(row.endpoint)));
  if (!pending.length) return { sent: 0, removed: 0, retry: 0, remaining: 0, noSubscribers: false };

  const payload = JSON.stringify({
    title: "🔴 ब्रेकिंग न्यूज़ — आवाज़ राजस्थान",
    body: String(news.title || "राजस्थान की बड़ी खबर").slice(0, 180),
    url: newsUrl(news),
    tag: `news-${news._id}`,
    renotify: true
  });

  let sent = 0, removed = 0, retry = 0;
  for (let i = 0; i < pending.length; i += PUSH_CONCURRENCY) {
    const results = await Promise.all(pending.slice(i, i + PUSH_CONCURRENCY).map(row => sendOne(row, payload)));
    for (const result of results) {
      sent += result.sent;
      removed += result.removed;
      retry += result.retry;
      if ((result.sent || result.removed) && result.endpoint) await markDelivered(news._id, claimToken, result.endpoint);
    }
  }

  const latest = await Delivery.findOne({ newsId: news._id, claimToken, status: "processing" }).select("deliveredEndpoints").lean();
  const done = new Set(Array.isArray(latest?.deliveredEndpoints) ? latest.deliveredEndpoints : []);
  const remaining = subscribers.filter(row => row.endpoint && !done.has(String(row.endpoint))).length;
  return { sent, removed, retry, remaining, noSubscribers: false };
}

async function processBreakingNews() {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const candidates = await News.find({ status: "published", breaking: true, publishedAt: { $gte: since } }).sort({ publishedAt: 1, createdAt: 1 }).limit(25).lean();
  for (const news of candidates) {
    const claimToken = await claim(news._id);
    if (!claimToken) continue;
    try {
      const result = await sendToSubscribers(news, claimToken);
      if (result.noSubscribers) {
        await releaseClaim(news._id, claimToken);
        console.log(`Push deferred for ${news._id}: no active subscribers`);
        continue;
      }
      if (result.remaining === 0) {
        await markSent(news._id, claimToken);
        console.log(`Push delivery complete for ${news._id}: sent=${result.sent}, removed=${result.removed}, retry=${result.retry}`);
      } else {
        await releaseClaim(news._id, claimToken);
        console.log(`Push pending retry for ${news._id}: sent=${result.sent}, removed=${result.removed}, retry=${result.retry}, remaining=${result.remaining}`);
      }
    } catch (error) {
      await releaseClaim(news._id, claimToken);
      throw error;
    }
  }
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(`Awaaz Rajasthan push worker started; polling every ${POLL_MS}ms; concurrency=${PUSH_CONCURRENCY}`);
  let running = false;
  const tick = async () => { if (running) return; running = true; try { await processBreakingNews(); } catch (error) { console.error("Push worker cycle failed:", error); } finally { running = false; } };
  await tick();
  setInterval(tick, POLL_MS);
}

process.on("SIGTERM", async () => { await mongoose.disconnect().catch(() => {}); process.exit(0); });
process.on("SIGINT", async () => { await mongoose.disconnect().catch(() => {}); process.exit(0); });
main().catch(error => { console.error("Push worker failed to start:", error); process.exit(1); });
