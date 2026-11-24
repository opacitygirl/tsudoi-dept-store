// つどい百貨店（ネットショップの百貨店）サーバー
// 役割：店舗データの管理、出店申込の受付・承認、店舗ごとの決済（Stripe）
// 環境変数：STRIPE_SECRET_KEY / ADMIN_KEY / PLATFORM_FEE_PERCENT（任意・既定0）/ BASE_URL（任意）
// データ保存：DATABASE_URL（Postgres接続文字列）があればデータベースに保存し、再起動・再デプロイでも消えない。なければ従来のJSONファイル保存。
// メール通知用：SMTP_USER / SMTP_PASS（Gmailアプリパスワード）/ NOTIFY_EMAIL（通知先・任意）
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "tsudoi-admin";
const FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 0);

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
}

const DATA_DIR = path.join(__dirname, "data");
const SHOPS_FILE = path.join(DATA_DIR, "shops.json");
const APPS_FILE = path.join(DATA_DIR, "applications.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

// ---- データ保存 ----
// DATABASE_URL がある場合：起動時にDBから読み込んでメモリに持ち、変更のたびにDBへ書き戻す。
// ない場合：従来どおりJSONファイルに保存する（ローカル確認用）。
let USE_DB = Boolean(process.env.DATABASE_URL);
let pool = null;
const memCache = {};
const KEY_OF_FILE = { [SHOPS_FILE]: "shops", [APPS_FILE]: "applications", [ORDERS_FILE]: "orders" };

function readJson(file, fallback) {
  if (USE_DB) return memCache[file] !== undefined ? memCache[file] : fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return fallback;
  }
}
let persistChain = Promise.resolve();
function persistToDb(key, data) {
  persistChain = persistChain.then(async () => {
    try {
      await pool.query(
        "INSERT INTO tsudoi_store(key, value, updated_at) VALUES($1, $2::jsonb, now()) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [key, JSON.stringify(data)]
      );
    } catch (e) {
      console.error("[db] 保存に失敗: " + e.message);
    }
  });
  return persistChain;
}
function writeJson(file, data) {
  if (USE_DB) {
    memCache[file] = data;
    persistToDb(KEY_OF_FILE[file], data);
    return;
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}
async function initData() {
  if (!USE_DB) return;
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS tsudoi_store (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  } catch (e) {
    // テーブルが既にある等で作成が不要な場合は、続く読み込みで成否を判定する
    console.error("[db] テーブル作成で警告: " + e.message);
  }
  for (const file of [SHOPS_FILE, APPS_FILE, ORDERS_FILE]) {
    const key = KEY_OF_FILE[file];
    const r = await pool.query("SELECT value FROM tsudoi_store WHERE key = $1", [key]);
    if (r.rows.length) {
      memCache[file] = r.rows[0].value;
      console.log("[db] 読み込み: " + key + "（" + (Array.isArray(r.rows[0].value) ? r.rows[0].value.length : 0) + "件）");
    } else {
      let seed = [];
      try { seed = JSON.parse(fs.readFileSync(file, "utf-8")); } catch (e) { /* 初期データなし */ }
      memCache[file] = seed;
      await pool.query("INSERT INTO tsudoi_store(key, value) VALUES($1, $2::jsonb)", [key, JSON.stringify(seed)]);
      console.log("[db] 初期データを投入: " + key + "（" + (Array.isArray(seed) ? seed.length : 0) + "件）");
    }
  }
}
function slugify(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "shop-" + Date.now().toString(36);
}
// ---- メール通知 ----
let mailer = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = require("nodemailer").createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    family: 4,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000
  });
}
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || process.env.SMTP_USER || "";

// Brevo（メール送信専用サービス）のAPI送信。BREVO_API_KEY があればこちらを優先する。
// SMTPのポートはRender無料プランで塞がれているため、HTTPS（443）で送るこの方式が確実。
// 送信元アドレス（MAIL_FROM、未設定なら SMTP_USER）は Brevo 側で認証済みの必要がある。
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || "";

async function sendViaBrevo(to, subject, text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        sender: { name: "つどい百貨店", email: MAIL_FROM },
        to: [{ email: to }],
        subject,
        textContent: text
      }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error("Brevo API " + res.status + ": " + body.slice(0, 200));
    }
  } finally {
    clearTimeout(timer);
  }
}

function baseUrlOf(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
}

async function sendMail(to, subject, text) {
  const useBrevo = !!BREVO_API_KEY;
  if ((!useBrevo && !mailer) || !to) {
    console.log("[mail] 未設定または宛先なしのため送信スキップ: " + subject);
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (useBrevo) {
        await sendViaBrevo(to, subject, text);
      } else {
        await mailer.sendMail({ from: process.env.SMTP_USER, to, subject, text });
      }
      console.log("[mail] 送信しました（" + attempt + "回目）: " + subject + " -> " + to);
      return;
    } catch (e) {
      console.error("[mail] 送信失敗（" + attempt + "回目）: " + e.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}

// メール内リンク用の署名（管理キーを秘密鍵にして改ざん防止）
function signDecision(id, action) {
  return crypto.createHmac("sha256", ADMIN_KEY).update(id + ":" + action).digest("hex").slice(0, 32);
}
function decisionUrl(req, id, action) {
  return `${baseUrlOf(req)}/decide/${id}?action=${action}&token=${signDecision(id, action)}`;
}

function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(401).json({ error: "管理キーが必要です" });
  }
  next();
}
function publicShop(shop) {
  const { contactEmail, stripeAccountId, editKey, ...rest } = shop;
  return { ...rest, stripeLinked: Boolean(stripeAccountId) };
}

// テナント（店主）用の編集キー。お店ごとに1つ発行し、公開APIには絶対に含めない。
function generateEditKey() {
  return crypto.randomBytes(12).toString("hex");
}

// テナント認証：対象のお店と編集キーが一致した場合だけ次へ進む。
function requireTenant(req, res, next) {
  const shops = readJson(SHOPS_FILE, []);
  const shop = shops.find((s) => s.slug === req.params.slug);
  if (!shop) return res.status(404).json({ error: "お店が見つかりません" });
  if (!shop.editKey) {
    return res.status(403).json({ error: "このお店の編集キーはまだ発行されていません。百貨店の運営に発行を依頼してください" });
  }
  if (req.headers["x-tenant-key"] !== shop.editKey) {
    return res.status(401).json({ error: "編集キーが違います" });
  }
  req.tenantShop = shop;
  req.allShops = shops;
  next();
}

function cleanProductInput(body) {
  const { name, price, description, image } = body || {};
  const priceNum = Number(price);
  if (!name || !String(name).trim() || !priceNum || priceNum < 1 || priceNum > 10000000) {
    return { error: "商品名と正しい価格（1円〜10,000,000円）が必要です" };
  }
  return {
    name: String(name).trim().slice(0, 60),
    price: Math.floor(priceNum),
    description: String(description || "").slice(0, 500),
    image: image && /^https?:\/\//.test(image) ? String(image).slice(0, 500) : ""
  };
}

// ---- Stripe Webhook（注文の記録と通知） ----
// 署名検証には生のボディが必要なため、express.json() より前に登録する。
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

function formatAddress(details) {
  if (!details || !details.address) return "";
  const a = details.address;
  const parts = [a.postal_code ? "〒" + a.postal_code : "", a.state || "", a.city || "", a.line1 || "", a.line2 || ""].filter(Boolean).join(" ");
  return (details.name ? details.name + " / " : "") + parts;
}

app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !WEBHOOK_SECRET) {
    console.error("[webhook] Stripeまたは STRIPE_WEBHOOK_SECRET が未設定です");
    return res.status(503).send("webhook not configured");
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], WEBHOOK_SECRET);
  } catch (e) {
    console.error("[webhook] 署名検証に失敗: " + e.message);
    return res.status(400).send("invalid signature");
  }
  if (event.type !== "checkout.session.completed") return res.json({ received: true });

  const session = event.data.object;
  const orders = readJson(ORDERS_FILE, []);
  if (orders.some((o) => o.sessionId === session.id)) {
    return res.json({ received: true, duplicate: true });
  }

  const meta = session.metadata || {};
  let items = [];
  try { items = JSON.parse(meta.items_json || "[]"); } catch (e) { items = []; }
  const shipDetails = (session.collected_information && session.collected_information.shipping_details) || session.shipping_details || null;
  const cust = session.customer_details || {};
  const order = {
    id: "ord-" + Date.now().toString(36),
    createdAt: new Date().toISOString(),
    sessionId: session.id,
    shopSlug: meta.shop_slug || "",
    shopName: meta.shop_name || "",
    items,
    summary: meta.cart_summary || items.map((i) => i.name + "×" + i.qty).join("、"),
    total: session.amount_total || 0,
    currency: session.currency || "jpy",
    buyerName: (shipDetails && shipDetails.name) || cust.name || "",
    email: cust.email || "",
    phone: cust.phone || "",
    address: formatAddress(shipDetails),
    paymentStatus: session.payment_status || ""
  };
  orders.push(order);
  writeJson(ORDERS_FILE, orders);
  console.log("[order] 注文を記録: " + order.shopName + " / " + order.summary + " / ¥" + Number(order.total).toLocaleString("ja-JP"));

  const itemLines = items.length
    ? items.map((i) => `・${i.name} × ${i.qty}（¥${Number(i.price * i.qty).toLocaleString("ja-JP")}）`).join("\n")
    : "・" + order.summary;
  const body =
    `つどい百貨店で注文が入りました。\n\nお店: ${order.shopName}\n注文日時: ${new Date(order.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}\n\n【商品】\n${itemLines}\n合計: ¥${Number(order.total).toLocaleString("ja-JP")}\n\n【購入者】\n名前: ${order.buyerName}\nメール: ${order.email}\n電話: ${order.phone}\n\n【配送先】\n${order.address || "（住所の取得ができませんでした。Stripeの管理画面でご確認ください）"}\n\n発送の手配をお願いします。注文一覧は管理画面でも確認できます。\n\nつどい百貨店`;
  const subject = `【つどい百貨店】注文が入りました｜${order.shopName}`;
  await sendMail(NOTIFY_EMAIL, subject, body);
  const shops = readJson(SHOPS_FILE, []);
  const shop = shops.find((s) => s.slug === order.shopSlug);
  if (shop && shop.contactEmail && shop.contactEmail !== NOTIFY_EMAIL) {
    await sendMail(shop.contactEmail, subject, body);
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- 店舗 ----
app.get("/api/shops", (req, res) => {
  const shops = readJson(SHOPS_FILE, []);
  res.json(shops.map(publicShop));
});

app.get("/api/shops/:slug", (req, res) => {
  const shops = readJson(SHOPS_FILE, []);
  const shop = shops.find((s) => s.slug === req.params.slug);
  if (!shop) return res.status(404).json({ error: "お店が見つかりません" });
  res.json(publicShop(shop));
});

// ---- 出店申込 ----
app.post("/api/applications", async (req, res) => {
  const { shopName, ownerName, email, genre, floor, tagline, message, product } = req.body || {};
  if (!shopName || !ownerName || !email || !product || !product.name || !product.price) {
    return res.status(400).json({ error: "必須項目が不足しています（店名・お名前・メール・最初の商品）" });
  }
  const apps = readJson(APPS_FILE, []);
  const appEntry = {
    id: "app-" + Date.now().toString(36),
    shopName, ownerName, email,
    genre: genre || "その他",
    floor: floor || "1F",
    tagline: tagline || "",
    message: message || "",
    product: { name: product.name, price: Number(product.price), description: product.description || "", image: product.image && /^https?:\/\//.test(product.image) ? product.image : "" },
    status: "pending",
    createdAt: new Date().toISOString()
  };
  apps.push(appEntry);
  writeJson(APPS_FILE, apps);

  // 百貨店（運営）へ通知メール（送信を待ってから応答する）
  await sendMail(NOTIFY_EMAIL,
    `【つどい百貨店】新しい出店申込が届きました｜${appEntry.shopName}`,
    `新しい出店申込が届きました。\n\n店名: ${appEntry.shopName}\n店主: ${appEntry.ownerName}（${appEntry.email}）\nジャンル: ${appEntry.genre} ／ 希望フロア: ${appEntry.floor}\n一言紹介: ${appEntry.tagline}\n店主のことば: ${appEntry.message}\n最初の商品: ${appEntry.product.name} ¥${Number(appEntry.product.price).toLocaleString("ja-JP")}\n${appEntry.product.description}\n\n▼ そのまま承認する（お店ページが自動でできます）\n${decisionUrl(req, appEntry.id, "approve")}\n\n▼ 見送る\n${decisionUrl(req, appEntry.id, "reject")}\n\n▼ 管理画面で確認する\n${baseUrlOf(req)}/admin.html\n\nつどい百貨店`);
  res.status(201).json({ ok: true, id: appEntry.id });
});

// ---- 管理（百貨店運営） ----
app.get("/api/admin/applications", requireAdmin, (req, res) => {
  res.json(readJson(APPS_FILE, []));
});

app.get("/api/admin/orders", requireAdmin, (req, res) => {
  res.json(readJson(ORDERS_FILE, []));
});

function approveApplication(id) {
  const apps = readJson(APPS_FILE, []);
  const entry = apps.find((a) => a.id === id);
  if (!entry) return { error: "申込が見つかりません", status: 404 };
  if (entry.status !== "pending") return { error: "すでに処理済みです", status: 400 };

  const shops = readJson(SHOPS_FILE, []);
  let slug = slugify(entry.shopName);
  if (shops.some((s) => s.slug === slug)) slug = slug + "-" + Date.now().toString(36);

  const shop = {
    slug,
    name: entry.shopName,
    owner: entry.ownerName,
    genre: entry.genre,
    floor: entry.floor,
    tagline: entry.tagline,
    message: entry.message,
    color: "#1d2a4a",
    accent: "#c9a227",
    contactEmail: entry.email,
    editKey: generateEditKey(),
    stripeAccountId: null,
    products: [{ id: 1, name: entry.product.name, price: entry.product.price, description: entry.product.description, image: entry.product.image || "" }]
  };
  shops.push(shop);
  entry.status = "approved";
  writeJson(SHOPS_FILE, shops);
  writeJson(APPS_FILE, apps);
  return { ok: true, slug, entry, editKey: shop.editKey };
}

function rejectApplication(id) {
  const apps = readJson(APPS_FILE, []);
  const entry = apps.find((a) => a.id === id);
  if (!entry) return { error: "申込が見つかりません", status: 404 };
  if (entry.status !== "pending") return { error: "すでに処理済みです", status: 400 };
  entry.status = "rejected";
  writeJson(APPS_FILE, apps);
  return { ok: true, entry };
}

async function notifyApplicantApproved(req, entry, slug, editKey) {
  const url = `${baseUrlOf(req)}/shop.html?slug=${slug}`;
  const tenantUrl = `${baseUrlOf(req)}/tenant.html?slug=${slug}`;
  const keySection = editKey
    ? `\n\n【店主用の編集ページ】\n商品の追加・変更や、お店の紹介文の編集は、こちらのページからご自身で行えます。\n編集ページ: ${tenantUrl}\n編集キー: ${editKey}\n※編集キーはパスワードのようなものです。他の人に教えず、大切に保管してください。`
    : "";
  await sendMail(entry.email,
    `【つどい百貨店】出店が承認されました｜${entry.shopName}`,
    `${entry.ownerName} 様\n\nつどい百貨店への出店申込ありがとうございました。\n内容を確認し、承認しました。あなたのお店ページができました。\n\nお店ページ: ${url}${keySection}\n\nつどい百貨店`);
}

async function notifyApplicantRejected(entry) {
  await sendMail(entry.email,
    `【つどい百貨店】出店申込について｜${entry.shopName}`,
    `${entry.ownerName} 様\n\nつどい百貨店への出店申込ありがとうございました。\n今回は出店を見送らせていただくことになりました。\nまたの機会にぜひお申し込みください。\n\nつどい百貨店`);
}

app.post("/api/admin/applications/:id/approve", requireAdmin, async (req, res) => {
  const result = approveApplication(req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  await notifyApplicantApproved(req, result.entry, result.slug, result.editKey);
  res.json({ ok: true, slug: result.slug });
});

app.post("/api/admin/applications/:id/reject", requireAdmin, async (req, res) => {
  const result = rejectApplication(req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  await notifyApplicantRejected(result.entry);
  res.json({ ok: true });
});

// ---- メール内リンクからの承認／見送り ----
app.get("/decide/:id", async (req, res) => {
  const { action, token } = req.query;
  const page = (title, body) => `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}｜つどい百貨店</title><style>body{font-family:serif;background:#faf6ee;color:#22304a;text-align:center;padding:60px 20px}a{color:#1d2a4a}</style></head><body><h1>${title}</h1><p>${body}</p><p><a href="/admin.html">管理画面を開く</a> ／ <a href="/">百貨店トップ</a></p></body></html>`;
  if (action !== "approve" && action !== "reject") {
    return res.status(400).send(page("リンクが正しくありません", "操作の指定が間違っています。"));
  }
  if (token !== signDecision(req.params.id, action)) {
    return res.status(403).send(page("リンクが無効です", "このリンクは使えません。管理画面から操作してください。"));
  }
  if (action === "approve") {
    const result = approveApplication(req.params.id);
    if (!result.ok) return res.status(result.status).send(page("処理できませんでした", result.error));
    await notifyApplicantApproved(req, result.entry, result.slug, result.editKey);
    return res.send(page("承認しました", `「${result.entry.shopName}」のお店ページができました。<br><a href="/shop.html?slug=${result.slug}">お店ページを見る</a>`));
  }
  const result = rejectApplication(req.params.id);
  if (!result.ok) return res.status(result.status).send(page("処理できませんでした", result.error));
  await notifyApplicantRejected(result.entry);
  return res.send(page("見送りました", `「${result.entry.shopName}」の出店申込を見送りました。`));
});

app.post("/api/admin/shops/:slug/products", requireAdmin, (req, res) => {
  const shops = readJson(SHOPS_FILE, []);
  const shop = shops.find((s) => s.slug === req.params.slug);
  if (!shop) return res.status(404).json({ error: "お店が見つかりません" });
  const { name, price, description, image } = req.body || {};
  if (!name || !price) return res.status(400).json({ error: "商品名と価格が必要です" });
  const id = shop.products.length ? Math.max(...shop.products.map((p) => p.id)) + 1 : 1;
  const imageUrl = image && /^https?:\/\//.test(image) ? image : "";
  shop.products.push({ id, name, price: Number(price), description: description || "", image: imageUrl });
  writeJson(SHOPS_FILE, shops);
  res.status(201).json({ ok: true, id });
});

// 運営用：店舗一覧（編集キーの有無だけを返し、キー自体は返さない）
app.get("/api/admin/shops", requireAdmin, (req, res) => {
  const shops = readJson(SHOPS_FILE, []);
  res.json(shops.map((s) => ({
    slug: s.slug, name: s.name, owner: s.owner, floor: s.floor, genre: s.genre,
    contactEmail: s.contactEmail || "", productCount: (s.products || []).length,
    hasEditKey: Boolean(s.editKey)
  })));
});

// 運営用：テナント編集キーの発行・再発行（再発行すると古いキーは使えなくなる）
app.post("/api/admin/shops/:slug/tenant-key", requireAdmin, (req, res) => {
  const shops = readJson(SHOPS_FILE, []);
  const shop = shops.find((s) => s.slug === req.params.slug);
  if (!shop) return res.status(404).json({ error: "お店が見つかりません" });
  shop.editKey = generateEditKey();
  writeJson(SHOPS_FILE, shops);
  res.json({
    ok: true,
    editKey: shop.editKey,
    tenantUrl: `${baseUrlOf(req)}/tenant.html?slug=${shop.slug}`,
    contactEmail: shop.contactEmail || ""
  });
});

// ---- テナント（店主）自身の編集 ----
app.get("/api/tenant/:slug", requireTenant, (req, res) => {
  const s = req.tenantShop;
  res.json({
    slug: s.slug, name: s.name, owner: s.owner, genre: s.genre, floor: s.floor,
    tagline: s.tagline || "", message: s.message || "", products: s.products || []
  });
});

app.put("/api/tenant/:slug", requireTenant, (req, res) => {
  const { tagline, message } = req.body || {};
  if (tagline !== undefined) req.tenantShop.tagline = String(tagline).slice(0, 120);
  if (message !== undefined) req.tenantShop.message = String(message).slice(0, 1000);
  writeJson(SHOPS_FILE, req.allShops);
  res.json({ ok: true });
});

app.post("/api/tenant/:slug/products", requireTenant, (req, res) => {
  const cleaned = cleanProductInput(req.body);
  if (cleaned.error) return res.status(400).json({ error: cleaned.error });
  const products = req.tenantShop.products || (req.tenantShop.products = []);
  const id = products.length ? Math.max(...products.map((p) => p.id)) + 1 : 1;
  products.push({ id, ...cleaned });
  writeJson(SHOPS_FILE, req.allShops);
  res.status(201).json({ ok: true, id });
});

app.put("/api/tenant/:slug/products/:id", requireTenant, (req, res) => {
  const cleaned = cleanProductInput(req.body);
  if (cleaned.error) return res.status(400).json({ error: cleaned.error });
  const product = (req.tenantShop.products || []).find((p) => p.id === Number(req.params.id));
  if (!product) return res.status(404).json({ error: "商品が見つかりません" });
  Object.assign(product, cleaned);
  writeJson(SHOPS_FILE, req.allShops);
  res.json({ ok: true });
});

app.delete("/api/tenant/:slug/products/:id", requireTenant, (req, res) => {
  const before = (req.tenantShop.products || []).length;
  req.tenantShop.products = (req.tenantShop.products || []).filter((p) => p.id !== Number(req.params.id));
  if (req.tenantShop.products.length === before) {
    return res.status(404).json({ error: "商品が見つかりません" });
  }
  writeJson(SHOPS_FILE, req.allShops);
  res.json({ ok: true });
});

// ---- 決済（店舗ごと） ----
app.post("/api/shops/:slug/create-checkout-session", async (req, res) => {
  const shops = readJson(SHOPS_FILE, []);
  const shop = shops.find((s) => s.slug === req.params.slug);
  if (!shop) return res.status(404).json({ error: "お店が見つかりません" });
  const cart = (req.body && req.body.cart) || [];
  if (!Array.isArray(cart) || cart.length === 0) {
    return res.status(400).json({ error: "カートが空です" });
  }
  if (!stripe) {
    return res.status(501).json({ error: "決済はまだ設定されていません（STRIPE_SECRET_KEY未設定）" });
  }

  const lineItems = [];
  const itemsMeta = [];
  let total = 0;
  for (const item of cart) {
    const product = shop.products.find((p) => p.id === Number(item.id));
    if (!product) return res.status(400).json({ error: "商品が見つかりません: " + item.id });
    const qty = Math.max(1, Math.min(10, Number(item.quantity) || 1));
    total += product.price * qty;
    itemsMeta.push({ name: product.name, qty, price: product.price });
    lineItems.push({
      price_data: {
        currency: "jpy",
        product_data: { name: product.name, description: product.description || undefined },
        unit_amount: product.price
      },
      quantity: qty
    });
  }

  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
  const params = {
    payment_method_types: ["card"],
    line_items: lineItems,
    mode: "payment",
    success_url: `${baseUrl}/shop.html?slug=${shop.slug}&paid=1`,
    cancel_url: `${baseUrl}/shop.html?slug=${shop.slug}`,
    shipping_address_collection: { allowed_countries: ["JP"] },
    phone_number_collection: { enabled: true },
    metadata: {
      shop_slug: shop.slug,
      shop_name: shop.name,
      cart_summary: itemsMeta.map((i) => i.name + "×" + i.qty).join("、").slice(0, 480),
      items_json: JSON.stringify(itemsMeta).length <= 480 ? JSON.stringify(itemsMeta) : ""
    }
  };

  // テナントがStripe連携済みなら、売上はテナントへ・手数料は百貨店へ（Stripe Connect）
  if (shop.stripeAccountId) {
    params.payment_intent_data = { transfer_data: { destination: shop.stripeAccountId } };
    if (FEE_PERCENT > 0) {
      params.payment_intent_data.application_fee_amount = Math.floor(total * FEE_PERCENT / 100);
    }
  }

  try {
    const session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: "決済セッションの作成に失敗しました" });
  }
});

initData()
  .catch((e) => {
    console.error("[db] 初期化に失敗しました: " + e.message + "（JSONファイル保存に切り替えて起動します）");
    USE_DB = false;
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log("つどい百貨店サーバー起動: port " + PORT + " / stripe: " + (stripe ? "設定済み" : "未設定") + " / 手数料: " + FEE_PERCENT + "%" + " / mail: " + (mailer || BREVO_API_KEY ? "設定済み（通知先: " + NOTIFY_EMAIL + "）" : "未設定") + " / webhook: " + (WEBHOOK_SECRET ? "設定済み" : "未設定") + " / data: " + (USE_DB ? "データベース" : "JSONファイル"));
    });
  });
