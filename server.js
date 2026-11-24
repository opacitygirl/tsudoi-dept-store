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

// ---- データ保存 ----
// DATABASE_URL がある場合：起動時にDBから読み込んでメモリに持ち、変更のたびにDBへ書き戻す。
// ない場合：従来どおりJSONファイルに保存する（ローカル確認用）。
let USE_DB = Boolean(process.env.DATABASE_URL);
let pool = null;
const memCache = {};
const KEY_OF_FILE = { [SHOPS_FILE]: "shops", [APPS_FILE]: "applications" };

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
  for (const file of [SHOPS_FILE, APPS_FILE]) {
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
  const { contactEmail, stripeAccountId, ...rest } = shop;
  return { ...rest, stripeLinked: Boolean(stripeAccountId) };
}

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
    product: { name: product.name, price: Number(product.price), description: product.description || "" },
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
    stripeAccountId: null,
    products: [{ id: 1, name: entry.product.name, price: entry.product.price, description: entry.product.description }]
  };
  shops.push(shop);
  entry.status = "approved";
  writeJson(SHOPS_FILE, shops);
  writeJson(APPS_FILE, apps);
  return { ok: true, slug, entry };
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

async function notifyApplicantApproved(req, entry, slug) {
  const url = `${baseUrlOf(req)}/shop.html?slug=${slug}`;
  await sendMail(entry.email,
    `【つどい百貨店】出店が承認されました｜${entry.shopName}`,
    `${entry.ownerName} 様\n\nつどい百貨店への出店申込ありがとうございました。\n内容を確認し、承認しました。あなたのお店ページができました。\n\nお店ページ: ${url}\n\n商品の追加や内容の変更は、百貨店までご連絡ください。\n\nつどい百貨店`);
}

async function notifyApplicantRejected(entry) {
  await sendMail(entry.email,
    `【つどい百貨店】出店申込について｜${entry.shopName}`,
    `${entry.ownerName} 様\n\nつどい百貨店への出店申込ありがとうございました。\n今回は出店を見送らせていただくことになりました。\nまたの機会にぜひお申し込みください。\n\nつどい百貨店`);
}

app.post("/api/admin/applications/:id/approve", requireAdmin, async (req, res) => {
  const result = approveApplication(req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  await notifyApplicantApproved(req, result.entry, result.slug);
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
    await notifyApplicantApproved(req, result.entry, result.slug);
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
  const { name, price, description } = req.body || {};
  if (!name || !price) return res.status(400).json({ error: "商品名と価格が必要です" });
  const id = shop.products.length ? Math.max(...shop.products.map((p) => p.id)) + 1 : 1;
  shop.products.push({ id, name, price: Number(price), description: description || "" });
  writeJson(SHOPS_FILE, shops);
  res.status(201).json({ ok: true, id });
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
  let total = 0;
  for (const item of cart) {
    const product = shop.products.find((p) => p.id === Number(item.id));
    if (!product) return res.status(400).json({ error: "商品が見つかりません: " + item.id });
    const qty = Math.max(1, Math.min(10, Number(item.quantity) || 1));
    total += product.price * qty;
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
    metadata: { shop_slug: shop.slug, shop_name: shop.name }
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
      console.log("つどい百貨店サーバー起動: port " + PORT + " / stripe: " + (stripe ? "設定済み" : "未設定") + " / 手数料: " + FEE_PERCENT + "%" + " / mail: " + (mailer ? "設定済み（通知先: " + NOTIFY_EMAIL + "）" : "未設定") + " / data: " + (USE_DB ? "データベース" : "JSONファイル"));
    });
  });
