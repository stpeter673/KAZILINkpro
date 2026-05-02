/**
 * KaziLink Mtaani — Express Server for Render Deployment
 * Wraps all Firebase Cloud Functions as REST endpoints.
 *
 * Required environment variables on Render:
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY   (paste the full private key including -----BEGIN/END-----)
 *
 * Optional (defaults to sandbox):
 *   MPESA_ENV              "sandbox" or "production"
 *   MPESA_KEY              M-Pesa consumer key
 *   MPESA_SECRET           M-Pesa consumer secret
 *   MPESA_SHORTCODE        Till number
 *   MPESA_STORE            Store number
 *   MPESA_PASSKEY          STK passkey
 *   MPESA_INITIATOR        B2C initiator name
 *   MPESA_SECURITY_CREDENTIAL  B2C encrypted credential
 *   ADMIN_EMAILS           comma-separated admin emails
 *   RENDER_EXTERNAL_URL    your Render URL e.g. https://kazilinkmtaanipro.onrender.com
 */

const express = require("express");
const admin   = require("firebase-admin");
const axios   = require("axios");
const path    = require("path");

// ── FIREBASE ADMIN INIT ──────────────────────────────────────
if (!admin.apps.length) {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
    console.error("❌  Missing Firebase env vars. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY on Render.");
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      type:         "service_account",
      project_id:   process.env.FIREBASE_PROJECT_ID,
      private_key:  privateKey,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const db = admin.firestore();

// ── CONFIG ───────────────────────────────────────────────────
const MPESA_KEY       = process.env.MPESA_KEY       || "7fO8qShz29lZq1kAqBooZb2VZ6S0riJhsGYI8qgAl9s2XsMt";
const MPESA_SECRET    = process.env.MPESA_SECRET    || "OLFJ4teT4suiw4ZiTsq2spnwaFbNN6aVDZhqJZJRcATpBsKMPxUMIRXdduFeO1Ti";
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || "5725479";
const MPESA_STORE     = process.env.MPESA_STORE     || "8933038";
const MPESA_PASSKEY   = process.env.MPESA_PASSKEY   || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
const IS_SANDBOX      = (process.env.MPESA_ENV || "sandbox") === "sandbox";
const BASE_URL        = process.env.RENDER_EXTERNAL_URL || "https://kazilinkmtaanipro.onrender.com";

const MPESA_BASE    = IS_SANDBOX ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke";
const CALLBACK_URL  = `${BASE_URL}/mpesa/callback`;
const CALLBACK_B2C  = `${BASE_URL}/mpesa/callback-b2c`;

const TILL_NAME       = "KAZILINK MTAANI";
const MAX_AUTO_PAYOUT = 5000;
const MAX_FRAUD_SCORE = 79;

const GIFT_COMMISSION = {
  sticker:    { platform: 0.15, creator: 0.85 },
  virtual:    { platform: 0.20, creator: 0.80 },
  livestream: { platform: 0.25, creator: 0.75 },
};
const DEFAULT_COMMISSION = GIFT_COMMISSION.virtual;
function getCommission(giftType) { return GIFT_COMMISSION[giftType] || DEFAULT_COMMISSION; }

// ── EXPRESS SETUP ────────────────────────────────────────────
const app  = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// ── AUTH MIDDLEWARE ──────────────────────────────────────────
async function verifyToken(req) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    return await admin.auth().verifyIdToken(token);
  } catch {
    return null;
  }
}

// Helper: wrap callable-style functions
function callable(handler) {
  return async (req, res) => {
    try {
      const user = await verifyToken(req);
      const data   = req.body?.data ?? req.body ?? {};
      const context = { auth: user ? { uid: user.uid, token: user } : null };
      const result = await handler(data, context);
      res.json({ result });
    } catch (err) {
      const code    = err.code    || "internal";
      const message = err.message || "Internal error";
      res.status(400).json({ error: { status: code, message } });
    }
  };
}

// ── HELPERS ──────────────────────────────────────────────────
async function checkRateLimit(uid, action, limitMs) {
  const ref = db.collection("rateLimits").doc(`${uid}_${action}`);
  return db.runTransaction(async (t) => {
    const doc  = await t.get(ref);
    const last = doc.exists ? (doc.data().last || 0) : 0;
    if (Date.now() - last < limitMs) return false;
    t.set(ref, { last: Date.now() }, { merge: true });
    return true;
  });
}

async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_KEY}:${MPESA_SECRET}`).toString("base64");
  const res  = await axios.get(
    `${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

function getStkPassword() {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const password  = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString("base64");
  return { password, timestamp };
}

function calcFraudScore(userData) {
  let score = 0;
  if ((userData.giftsInLastHour       || 0) > 20) score += 40;
  if ((userData.withdrawalAttempts24h || 0) > 3)  score += 25;
  if ((userData.selfGiftAttempts      || 0) > 0)  score += 30;
  if ((userData.coins || 0) > 10000 && (userData.coinsEarned || 0) === 0) score += 20;
  return Math.min(score, 100);
}

async function processB2C(phone, amount, withdrawalId, uid) {
  try {
    const token = await getMpesaToken();
    const b2cRes = await axios.post(
      `${MPESA_BASE}/mpesa/b2c/v1/paymentrequest`,
      {
        InitiatorName:      process.env.MPESA_INITIATOR           || "testapi",
        SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL || "YOUR_ENCRYPTED_INITIATOR_PASSWORD",
        CommandID:          "BusinessPayment",
        Amount:             amount,
        PartyA:             MPESA_SHORTCODE,
        PartyB:             phone,
        Remarks:            "KaziLink Earnings",
        QueueTimeOutURL:    `${CALLBACK_B2C}Timeout`,
        ResultURL:          CALLBACK_B2C,
        Occassion:          "Creator withdrawal",
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    await db.collection("withdrawals").doc(withdrawalId).update({
      status:             "processing",
      mpesaConvId:        b2cRes.data?.ConversationID || null,
      mpesaOriginatorId:  b2cRes.data?.OriginatorConversationID || null,
      processedAt:        admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection("users").doc(uid).update({
      balance:     admin.firestore.FieldValue.increment(-amount),
      coinsEarned: admin.firestore.FieldValue.increment(-amount),
    });
  } catch (err) {
    console.error("B2C error:", err.response?.data || err.message);
    await db.collection("withdrawals").doc(withdrawalId).update({ status: "failed" });
  }
}

// ── ROUTES ───────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, env: IS_SANDBOX ? "sandbox" : "production", time: Date.now() });
});

// STK Push
app.post("/api/stkPush", callable(async (data, context) => {
  if (!context.auth) throw { code: "unauthenticated", message: "Login required" };

  const uid   = context.auth.uid;
  const phone = String(data.phone || "").replace(/^0/, "254").replace(/\+/, "");
  const amount = parseInt(data.amount);
  const type   = data.type;

  if (!(await checkRateLimit(uid, "stk", 10000)))
    throw { code: "resource-exhausted", message: "Please wait before retrying" };
  if (!phone.match(/^254[0-9]{9}$/)) throw { code: "invalid-argument", message: "Invalid phone number" };
  if (!amount || amount < 10 || amount > 100000) throw { code: "invalid-argument", message: "Invalid amount" };
  if (!["subscription", "coins"].includes(type)) throw { code: "invalid-argument", message: "Invalid type" };

  const userDoc = await db.collection("users").doc(uid).get();
  if (userDoc.exists && userDoc.data().frozen)
    throw { code: "permission-denied", message: "Account is suspended" };

  const token = await getMpesaToken();
  const { password, timestamp } = getStkPassword();

  const res = await axios.post(
    `${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,
    {
      BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: timestamp,
      TransactionType: "CustomerBuyGoodsOnline", Amount: amount,
      PartyA: phone, PartyB: MPESA_SHORTCODE, PhoneNumber: phone,
      CallBackURL: CALLBACK_URL, AccountReference: TILL_NAME,
      TransactionDesc: `KaziLink ${type}`,
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  await db.collection("pendingPayments").add({
    uid, phone, amount, type,
    checkoutId: res.data.CheckoutRequestID,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, message: "Check your phone for M-Pesa prompt" };
}));

// M-Pesa STK Callback (called by Safaricom)
app.post("/mpesa/callback", async (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return res.send("OK");

    const checkoutId = callback.CheckoutRequestID;
    const resultCode = callback.ResultCode;
    const meta       = callback.CallbackMetadata?.Item || [];

    if (resultCode === 0) {
      const amount   = meta.find(i => i.Name === "Amount")?.Value || 0;
      const phone    = String(meta.find(i => i.Name === "PhoneNumber")?.Value || "");
      const mpesaRef = meta.find(i => i.Name === "MpesaReceiptNumber")?.Value || "";

      const pendSnap = await db.collection("pendingPayments")
        .where("checkoutId", "==", checkoutId).where("status", "==", "pending").get();

      if (pendSnap.empty) return res.send("OK");

      const pendDoc = pendSnap.docs[0];
      const pend    = pendDoc.data();
      const batch   = db.batch();

      batch.update(pendDoc.ref, { status: "confirmed", mpesaRef, confirmedAt: admin.firestore.FieldValue.serverTimestamp() });

      const txRef    = db.collection("transactions").doc();
      const userDoc  = await db.collection("users").doc(pend.uid).get();
      batch.set(txRef, {
        uid: pend.uid, userEmail: userDoc.data()?.email || "",
        phone, amount, type: pend.type, mpesaRef, status: "confirmed",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const userRef = db.collection("users").doc(pend.uid);
      if (pend.type === "subscription") {
        batch.update(userRef, { subscribed: true, subscribedAt: admin.firestore.FieldValue.serverTimestamp() });
      } else if (pend.type === "coins") {
        batch.update(userRef, { coins: admin.firestore.FieldValue.increment(amount) });
      }

      const adminRef = db.collection("admin").doc("main");
      batch.set(adminRef, {
        totalRevenue:   admin.firestore.FieldValue.increment(amount),
        totalCoinsSold: pend.type === "coins"
          ? admin.firestore.FieldValue.increment(amount)
          : admin.firestore.FieldValue.increment(0),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      await batch.commit();
      console.log(`Payment confirmed: ${pend.type} | KES ${amount} | ${phone}`);
    } else {
      const pendSnap = await db.collection("pendingPayments").where("checkoutId", "==", checkoutId).get();
      if (!pendSnap.empty) await pendSnap.docs[0].ref.update({ status: "failed" });
    }
  } catch (err) {
    console.error("Callback error:", err.message);
  }
  res.send("OK");
});

// Send Gift
app.post("/api/sendGift", callable(async (data, context) => {
  if (!context.auth) throw { code: "unauthenticated", message: "Login required" };

  const senderUid = context.auth.uid;
  const { emoji, name, cost, creatorHandle, giftType } = data;

  if (!cost || cost < 1) throw { code: "invalid-argument", message: "Invalid gift cost" };
  if (!["sticker", "virtual", "livestream"].includes(giftType))
    throw { code: "invalid-argument", message: "Invalid giftType" };
  if (!(await checkRateLimit(senderUid, "gift", 1000)))
    throw { code: "resource-exhausted", message: "Sending too fast" };

  const senderRef    = db.collection("users").doc(senderUid);
  const creatorSnap  = await db.collection("users").where("handle", "==", creatorHandle).limit(1).get();

  return db.runTransaction(async (t) => {
    const senderDoc  = await t.get(senderRef);
    if (!senderDoc.exists) throw new Error("User not found");
    const senderData = senderDoc.data();

    if (senderData.handle === creatorHandle) {
      await db.collection("fraudAlerts").add({
        userId: senderUid, reason: "Self-gifting attempt",
        resolved: false, createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      t.update(senderRef, { selfGiftAttempts: admin.firestore.FieldValue.increment(1) });
      throw new Error("Self-gifting is not allowed");
    }

    if ((senderData.giftsInLastHour || 0) >= 50) {
      await db.collection("fraudAlerts").add({
        userId: senderUid, reason: "Velocity: >50 gifts/hr",
        resolved: false, createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      throw new Error("Unusual activity detected. Account flagged for review.");
    }

    if ((senderData.coins || 0) < cost) throw new Error("Insufficient coins");

    const commission       = getCommission(giftType);
    const creatorEarnings  = Math.floor(cost * commission.creator);
    const platformEarnings = cost - creatorEarnings;

    t.update(senderRef, {
      coins: admin.firestore.FieldValue.increment(-cost),
      giftsInLastHour: admin.firestore.FieldValue.increment(1),
    });

    if (!creatorSnap.empty) {
      t.update(creatorSnap.docs[0].ref, {
        balance:       admin.firestore.FieldValue.increment(creatorEarnings),
        coinsEarned:   admin.firestore.FieldValue.increment(creatorEarnings),
        giftsReceived: admin.firestore.FieldValue.increment(1),
      });
    }

    const giftRef = db.collection("gifts").doc();
    t.set(giftRef, {
      senderUid, creatorHandle, emoji, name, cost, giftType,
      commissionRate: commission.platform, creatorEarnings, platformEarnings,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    t.set(db.collection("admin").doc("main"), {
      giftRevenue:  admin.firestore.FieldValue.increment(platformEarnings),
      totalRevenue: admin.firestore.FieldValue.increment(platformEarnings),
    }, { merge: true });

    return { success: true, emoji, name, cost };
  });
}));

// Buy Coins
app.post("/api/buyCoins", callable(async (data, context) => {
  if (!context.auth) throw { code: "unauthenticated", message: "Login required" };
  const uid   = context.auth.uid;
  const coins = parseInt(data.coins);
  const kes   = parseInt(data.kes);
  if (!coins || coins < 1) throw { code: "invalid-argument", message: "Invalid coins" };
  await db.collection("users").doc(uid).update({ coins: admin.firestore.FieldValue.increment(coins) });
  await db.collection("transactions").add({
    uid, type: "coins", amount: kes, coinsAdded: coins,
    status: "confirmed", createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection("admin").doc("main").set({
    totalRevenue:   admin.firestore.FieldValue.increment(kes),
    totalCoinsSold: admin.firestore.FieldValue.increment(coins),
  }, { merge: true });
  return { success: true };
}));

// Request Withdrawal
app.post("/api/requestWithdrawal", callable(async (data, context) => {
  if (!context.auth) throw { code: "unauthenticated", message: "Login required" };
  const uid    = context.auth.uid;
  const phone  = String(data.phone || "").replace(/^0/, "254");
  const amount = parseInt(data.amount);

  if (!phone.match(/^254[0-9]{9}$/)) throw { code: "invalid-argument", message: "Invalid phone" };
  if (!amount || amount < 50)        throw { code: "invalid-argument", message: "Min withdrawal KES 50" };
  if (!(await checkRateLimit(uid, "withdraw", 60000)))
    throw { code: "resource-exhausted", message: "Wait 1 min between requests" };

  const userDoc  = await db.collection("users").doc(uid).get();
  const userData = userDoc.data() || {};
  if (userData.frozen) throw { code: "permission-denied", message: "Account suspended" };

  const fraudScore   = calcFraudScore(userData);
  const withdrawable = Math.floor(userData.balance || 0);
  if (amount > withdrawable) throw { code: "invalid-argument", message: "Insufficient earned balance" };

  const withdrawRef = await db.collection("withdrawals").add({
    userId: uid, userName: userData.name || "", userEmail: userData.email || "",
    phone, amount, fraudScore,
    status: fraudScore > MAX_FRAUD_SCORE ? "held_fraud_review" : "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (fraudScore <= MAX_FRAUD_SCORE && amount <= MAX_AUTO_PAYOUT) {
    await processB2C(phone, amount, withdrawRef.id, uid);
  }

  return { success: true, held: fraudScore > MAX_FRAUD_SCORE };
}));

// Admin: Process Withdrawal
app.post("/api/processWithdrawal", callable(async (data, context) => {
  if (!context.auth) throw { code: "unauthenticated", message: "Login required" };
  const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "admin@kazilink.com,pitahwambuajr@gmail.com").split(",");
  if (!ADMIN_EMAILS.includes(context.auth.token.email))
    throw { code: "permission-denied", message: "Admin only" };

  const { withdrawalId, phone, amount } = data;
  if (!withdrawalId || !phone || !amount) throw { code: "invalid-argument", message: "Missing fields" };

  await processB2C(phone, amount, withdrawalId, data.userId || "admin");
  return { success: true };
}));

// Admin: Auto-process All Pending Withdrawals
app.post("/api/autoProcessWithdrawals", callable(async (data, context) => {
  if (!context.auth) throw { code: "unauthenticated", message: "Login required" };
  const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "admin@kazilink.com,pitahwambuajr@gmail.com").split(",");
  if (!ADMIN_EMAILS.includes(context.auth.token.email))
    throw { code: "permission-denied", message: "Admin only" };

  const snap = await db.collection("withdrawals")
    .where("status", "==", "pending")
    .where("fraudScore", "<=", MAX_FRAUD_SCORE)
    .get();

  let processed = 0;
  await Promise.all(snap.docs
    .filter(doc => doc.data().amount <= MAX_AUTO_PAYOUT)
    .map(doc => {
      const d = doc.data();
      return processB2C(d.phone, d.amount, doc.id, d.userId)
        .then(() => processed++)
        .catch(e => console.error(`B2C failed for ${doc.id}:`, e));
    })
  );
  return { success: true, processed };
}));

// M-Pesa B2C Result Callback
app.post("/mpesa/callback-b2c", async (req, res) => {
  try {
    const result = req.body?.Result;
    if (!result) return res.send("OK");
    const convId = result.ConversationID;
    const code   = result.ResultCode;
    const snap   = await db.collection("withdrawals").where("mpesaConvId", "==", convId).get();
    if (!snap.empty) {
      await snap.docs[0].ref.update({
        status: code === 0 ? "paid" : "failed",
        resultDesc: result.ResultDesc || "",
      });
    }
  } catch (err) {
    console.error("B2C callback error:", err.message);
  }
  res.send("OK");
});

// M-Pesa B2C Timeout Callback
app.post("/mpesa/callback-b2cTimeout", async (req, res) => {
  try {
    const result = req.body?.Result || req.body;
    const convId = result?.ConversationID || result?.OriginatorConversationID;
    if (convId) {
      const snap = await db.collection("withdrawals").where("mpesaConvId", "==", convId).get();
      if (!snap.empty) {
        const wd = snap.docs[0];
        const d  = wd.data();
        await db.runTransaction(async (t) => {
          t.update(wd.ref, { status: "timeout", resultDesc: "Queue timeout" });
          if (d.userId && d.amount) {
            t.update(db.collection("users").doc(d.userId), {
              balance:     admin.firestore.FieldValue.increment(d.amount),
              coinsEarned: admin.firestore.FieldValue.increment(d.amount),
            });
          }
        });
      }
    }
  } catch (err) {
    console.error("B2C timeout error:", err.message);
  }
  res.send("OK");
});

// Catch-all: serve index.html for SPA routing
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅  KaziLink Mtaani running on port ${PORT} [${IS_SANDBOX ? "SANDBOX" : "PRODUCTION"}]`);
});
