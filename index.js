/**
 * KaziLink Mtaani — Firebase Cloud Functions
 * Complete backend: M-Pesa STK Push, Auto-Withdrawal, Gifts, Fraud Detection
 *
 * APP:       KAZILINKPROMTAANI (Sandbox)
 * TILL NAME: KAZILINK MTAANI
 * STORE NO:  8933038
 * TILL NO:   5725479
 *
 * TO GO LIVE — run these commands then redeploy:
 *   firebase functions:config:set mpesa.env="production"
 *   firebase functions:config:set mpesa.passkey="YOUR_LIVE_PASSKEY"
 *   firebase functions:config:set mpesa.initiator_password="YOUR_LIVE_INITIATOR_PASSWORD"
 */

const functions = require("firebase-functions");
const admin     = require("firebase-admin");
const axios     = require("axios");

admin.initializeApp();
const db = admin.firestore();

// ── CONFIG ───────────────────────────────────────────────────
const cfg = functions.config();

// KAZILINKPROMTAANI — Sandbox credentials (active)
const MPESA_KEY       = cfg.mpesa?.key       || "7fO8qShz29lZq1kAqBooZb2VZ6S0riJhsGYI8qgAl9s2XsMt";
const MPESA_SECRET    = cfg.mpesa?.secret    || "OLFJ4teT4suiw4ZiTsq2spnwaFbNN6aVDZhqJZJRcATpBsKMPxUMIRXdduFeO1Ti";
const MPESA_SHORTCODE = cfg.mpesa?.shortcode || "5725479";   // Till number
const MPESA_STORE     = cfg.mpesa?.store     || "8933038";   // Store number
// Sandbox uses Safaricom's standard test passkey
const MPESA_PASSKEY   = cfg.mpesa?.passkey   || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
const IS_SANDBOX      = (cfg.mpesa?.env || "sandbox") === "sandbox";

const MPESA_BASE = IS_SANDBOX
  ? "https://sandbox.safaricom.co.ke"
  : "https://api.safaricom.co.ke";

const CALLBACK_URL = IS_SANDBOX
  ? "https://us-central1-YOUR_PROJECT.cloudfunctions.net/mpesaCallback"
  : "https://us-central1-YOUR_PROJECT.cloudfunctions.net/mpesaCallback";

const TILL_NAME       = "KAZILINK MTAANI";
const MAX_AUTO_PAYOUT = 5000;   // Max KES for auto-processing
const MAX_FRAUD_SCORE = 79;     // Fraud score above this = manual review

// ── TIERED GIFT COMMISSIONS ───────────────────────────────────
// giftType must be sent from the frontend: "sticker" | "virtual" | "livestream"
// Platform takes a cut; creator keeps the rest.
const GIFT_COMMISSION = {
  sticker:    { platform: 0.15, creator: 0.85 }, // Small gifts / stickers
  virtual:    { platform: 0.20, creator: 0.80 }, // Premium virtual gifts
  livestream: { platform: 0.25, creator: 0.75 }, // VIP / live-stream gifts
};
// Fallback if giftType is missing or unrecognised
const DEFAULT_COMMISSION = GIFT_COMMISSION.virtual;

function getCommission(giftType) {
  return GIFT_COMMISSION[giftType] || DEFAULT_COMMISSION;
}

// ── RATE LIMIT HELPER (Firestore-backed, multi-instance safe) ──
async function checkRateLimit(uid, action, limitMs) {
  const ref = db.collection("rateLimits").doc(`${uid}_${action}`);
  return db.runTransaction(async (t) => {
    const doc = await t.get(ref);
    const last = doc.exists ? (doc.data().last || 0) : 0;
    if (Date.now() - last < limitMs) return false;
    t.set(ref, { last: Date.now() }, { merge: true });
    return true;
  });
}

// ── M-PESA TOKEN ─────────────────────────────────────────────
async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_KEY}:${MPESA_SECRET}`).toString("base64");
  const res = await axios.get(
    `${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

// ── STK PUSH PASSWORD ────────────────────────────────────────
function getStkPassword() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const password = Buffer.from(
    `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
  ).toString("base64");
  return { password, timestamp };
}

// ── STK PUSH (Callable) ──────────────────────────────────────
exports.stkPush = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const uid   = context.auth.uid;
  const phone = String(data.phone || "").replace(/^0/, "254").replace(/\+/,"");
  const amount = parseInt(data.amount);
  const type   = data.type; // "subscription" | "coins"

  // Rate limit: max 1 STK push per 10 seconds
  if (!(await checkRateLimit(uid, "stk", 10000))) {
    throw new functions.https.HttpsError("resource-exhausted", "Please wait before retrying");
  }

  // Validate
  if (!phone.match(/^254[0-9]{9}$/)) throw new functions.https.HttpsError("invalid-argument", "Invalid phone number");
  if (!amount || amount < 10 || amount > 100000) throw new functions.https.HttpsError("invalid-argument", "Invalid amount");
  if (!["subscription","coins"].includes(type)) throw new functions.https.HttpsError("invalid-argument", "Invalid type");

  // Fraud check
  const userDoc = await db.collection("users").doc(uid).get();
  if (userDoc.exists && userDoc.data().frozen) {
    throw new functions.https.HttpsError("permission-denied", "Account is suspended");
  }

  try {
    const token = await getMpesaToken();
    const { password, timestamp } = getStkPassword();

    const res = await axios.post(
      `${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: MPESA_SHORTCODE,
        Password:          password,
        Timestamp:         timestamp,
        TransactionType:   "CustomerBuyGoodsOnline",
        Amount:            amount,
        PartyA:            phone,
        PartyB:            MPESA_SHORTCODE,
        PhoneNumber:       phone,
        CallBackURL:       CALLBACK_URL,
        AccountReference:  TILL_NAME,
        TransactionDesc:   `KaziLink ${type}`
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Log the pending payment
    await db.collection("pendingPayments").add({
      uid, phone, amount, type,
      checkoutId: res.data.CheckoutRequestID,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, message: "Check your phone for M-Pesa prompt" };
  } catch (err) {
    console.error("STK Push error:", err.response?.data || err.message);
    throw new functions.https.HttpsError("internal", "M-Pesa push failed. Try again.");
  }
});

// ── M-PESA CALLBACK (HTTP) ───────────────────────────────────
exports.mpesaCallback = functions.https.onRequest(async (req, res) => {
  const callback = req.body?.Body?.stkCallback;
  if (!callback) return res.send("OK");

  const checkoutId  = callback.CheckoutRequestID;
  const resultCode  = callback.ResultCode;
  const meta        = callback.CallbackMetadata?.Item || [];

  if (resultCode === 0) {
    // Payment confirmed
    const amount = meta.find(i => i.Name === "Amount")?.Value || 0;
    const phone  = String(meta.find(i => i.Name === "PhoneNumber")?.Value || "");
    const mpesaRef = meta.find(i => i.Name === "MpesaReceiptNumber")?.Value || "";

    // Find the pending payment
    const pendSnap = await db.collection("pendingPayments")
      .where("checkoutId", "==", checkoutId)
      .where("status", "==", "pending")
      .get();

    if (pendSnap.empty) return res.send("OK");

    const pendDoc = pendSnap.docs[0];
    const pend    = pendDoc.data();

    const batch = db.batch();

    // Mark pending payment done
    batch.update(pendDoc.ref, { status: "confirmed", mpesaRef, confirmedAt: admin.firestore.FieldValue.serverTimestamp() });

    // Record transaction
    const txRef = db.collection("transactions").doc();
    const userDoc = await db.collection("users").doc(pend.uid).get();
    batch.set(txRef, {
      uid: pend.uid,
      userEmail: userDoc.data()?.email || "",
      phone, amount, type: pend.type,
      mpesaRef, status: "confirmed",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update user record
    const userRef = db.collection("users").doc(pend.uid);
    if (pend.type === "subscription") {
      batch.update(userRef, { subscribed: true, subscribedAt: admin.firestore.FieldValue.serverTimestamp() });
    } else if (pend.type === "coins") {
      batch.update(userRef, { coins: admin.firestore.FieldValue.increment(amount) });
    }

    // Update admin revenue
    const adminRef = db.collection("admin").doc("main");
    batch.set(adminRef, {
      totalRevenue:   admin.firestore.FieldValue.increment(amount),
      totalCoinsSold: pend.type === "coins" ? admin.firestore.FieldValue.increment(amount) : admin.firestore.FieldValue.increment(0),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await batch.commit();
    console.log(`Payment confirmed: ${pend.type} | KES ${amount} | ${phone}`);
  } else {
    // Payment failed or cancelled
    const pendSnap = await db.collection("pendingPayments")
      .where("checkoutId", "==", checkoutId)
      .get();
    if (!pendSnap.empty) {
      await pendSnap.docs[0].ref.update({ status: "failed" });
    }
  }

  res.send("OK");
});

// ── SEND GIFT (Callable) ─────────────────────────────────────
exports.sendGift = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const senderUid     = context.auth.uid;
  const { emoji, name, cost, creatorHandle, giftType } = data;

  if (!cost || cost < 1) throw new functions.https.HttpsError("invalid-argument", "Invalid gift cost");
  if (!["sticker","virtual","livestream"].includes(giftType)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid giftType. Must be sticker, virtual, or livestream");
  }

  // Rate limit: max 1 gift per second
  if (!(await checkRateLimit(senderUid, "gift", 1000))) {
    throw new functions.https.HttpsError("resource-exhausted", "Sending too fast");
  }

  const senderRef = db.collection("users").doc(senderUid);

  // Find creator by handle
  const creatorSnap = await db.collection("users")
    .where("handle", "==", creatorHandle)
    .limit(1).get();

  return db.runTransaction(async (t) => {
    const senderDoc = await t.get(senderRef);
    if (!senderDoc.exists) throw new Error("User not found");

    const senderData = senderDoc.data();

    // Fraud: self-gifting detection
    if (senderData.handle === creatorHandle) {
      // Log fraud attempt
      await db.collection("fraudAlerts").add({
        userId: senderUid, reason: "Self-gifting attempt",
        resolved: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      t.update(senderRef, { selfGiftAttempts: admin.firestore.FieldValue.increment(1) });
      throw new Error("Self-gifting is not allowed");
    }

    // Fraud: velocity check
    const giftsLastHour = (senderData.giftsInLastHour || 0);
    if (giftsLastHour >= 50) {
      await db.collection("fraudAlerts").add({
        userId: senderUid, reason: "Velocity: >50 gifts/hr",
        resolved: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      throw new Error("Unusual activity detected. Account flagged for review.");
    }

    const coins = senderData.coins || 0;
    if (coins < cost) throw new Error("Insufficient coins");

    const commission        = getCommission(giftType);
    const creatorEarnings   = Math.floor(cost * commission.creator);
    const platformEarnings  = cost - creatorEarnings;

    // Deduct coins from sender
    t.update(senderRef, {
      coins: admin.firestore.FieldValue.increment(-cost),
      giftsInLastHour: admin.firestore.FieldValue.increment(1)
    });

    // Credit creator
    if (!creatorSnap.empty) {
      const creatorRef = creatorSnap.docs[0].ref;
      t.update(creatorRef, {
        balance:         admin.firestore.FieldValue.increment(creatorEarnings),
        coinsEarned:     admin.firestore.FieldValue.increment(creatorEarnings),
        giftsReceived:   admin.firestore.FieldValue.increment(1)
      });
    }

    // Record gift
    const giftRef = db.collection("gifts").doc();
    t.set(giftRef, {
      senderUid, creatorHandle, emoji, name, cost,
      giftType,
      commissionRate: commission.platform,
      creatorEarnings, platformEarnings,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update admin balance
    const adminRef = db.collection("admin").doc("main");
    t.set(adminRef, {
      giftRevenue: admin.firestore.FieldValue.increment(platformEarnings),
      totalRevenue: admin.firestore.FieldValue.increment(platformEarnings)
    }, { merge: true });

    return { success: true, emoji, name, cost };
  });
});

// ── BUY COINS (Callable) ─────────────────────────────────────
exports.buyCoins = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  const uid   = context.auth.uid;
  const coins = parseInt(data.coins);
  const kes   = parseInt(data.kes);
  if (!coins || coins < 1) throw new functions.https.HttpsError("invalid-argument", "Invalid coins");
  await db.collection("users").doc(uid).update({
    coins: admin.firestore.FieldValue.increment(coins)
  });
  await db.collection("transactions").add({
    uid, type: "coins", amount: kes, coinsAdded: coins,
    status: "confirmed", createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await db.collection("admin").doc("main").set({
    totalRevenue:   admin.firestore.FieldValue.increment(kes),
    totalCoinsSold: admin.firestore.FieldValue.increment(coins)
  }, { merge: true });
  return { success: true };
});

// ── REQUEST WITHDRAWAL (Callable) ────────────────────────────
exports.requestWithdrawal = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const uid   = context.auth.uid;
  const phone = String(data.phone || "").replace(/^0/, "254");
  const amount = parseInt(data.amount);

  if (!phone.match(/^254[0-9]{9}$/)) throw new functions.https.HttpsError("invalid-argument", "Invalid phone");
  if (!amount || amount < 50) throw new functions.https.HttpsError("invalid-argument", "Min withdrawal KES 50");
  if (!(await checkRateLimit(uid, "withdraw", 60000))) throw new functions.https.HttpsError("resource-exhausted", "Wait 1 min between requests");

  // Fraud check
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data() || {};
  if (userData.frozen) throw new functions.https.HttpsError("permission-denied", "Account suspended");

  const fraudScore = calcFraudScore(userData);
  // balance is already the creator's post-commission earnings (set directly in sendGift)
  const withdrawable = Math.floor(userData.balance || 0);

  if (amount > withdrawable) throw new functions.https.HttpsError("invalid-argument", "Insufficient earned balance");

  const withdrawRef = await db.collection("withdrawals").add({
    userId: uid,
    userName: userData.name || "",
    userEmail: userData.email || "",
    phone, amount, fraudScore,
    status: fraudScore > MAX_FRAUD_SCORE ? "held_fraud_review" : "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Auto-process if low fraud score and under limit
  if (fraudScore <= MAX_FRAUD_SCORE && amount <= MAX_AUTO_PAYOUT) {
    await processB2C(phone, amount, withdrawRef.id, uid);
  }

  return { success: true, held: fraudScore > MAX_FRAUD_SCORE };
});

// ── PROCESS WITHDRAWAL — B2C (Internal) ──────────────────────
async function processB2C(phone, amount, withdrawalId, uid) {
  try {
    const token = await getMpesaToken();
    const { timestamp } = getStkPassword();

    const b2cRes = await axios.post(
      `${MPESA_BASE}/mpesa/b2c/v1/paymentrequest`,
      {
        InitiatorName:      cfg.mpesa?.initiator          || "testapi",
        SecurityCredential: cfg.mpesa?.security_credential || "YOUR_ENCRYPTED_INITIATOR_PASSWORD",
        CommandID:          "BusinessPayment",
        Amount:             amount,
        PartyA:             MPESA_SHORTCODE,
        PartyB:             phone,
        Remarks:            "KaziLink Earnings",
        QueueTimeOutURL:    `${CALLBACK_URL}Timeout`,
        ResultURL:          `${CALLBACK_URL}B2C`,
        Occassion:          "Creator withdrawal"
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    await db.collection("withdrawals").doc(withdrawalId).update({
      status: "processing",
      mpesaConvId: b2cRes.data?.ConversationID || null,
      mpesaOriginatorId: b2cRes.data?.OriginatorConversationID || null,
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Deduct from user balance
    await db.collection("users").doc(uid).update({
      balance:     admin.firestore.FieldValue.increment(-amount),
      coinsEarned: admin.firestore.FieldValue.increment(-amount)
    });

  } catch (err) {
    console.error("B2C error:", err.response?.data || err.message);
    await db.collection("withdrawals").doc(withdrawalId).update({ status: "failed" });
  }
}

// ── ADMIN: PROCESS WITHDRAWAL (Callable) ─────────────────────
exports.processWithdrawal = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  const ADMIN_EMAILS = (cfg.admin?.emails || "admin@kazilink.com,pitahwambuajr@gmail.com").split(",");
  if (!ADMIN_EMAILS.includes(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }

  const { withdrawalId, phone, amount } = data;
  if (!withdrawalId || !phone || !amount) {
    throw new functions.https.HttpsError("invalid-argument", "Missing fields");
  }
  await processB2C(phone, amount, withdrawalId, data.userId || "admin");

  return { success: true };
});

// Same admin guard on autoProcessWithdrawals
const _origAuto = exports.autoProcessWithdrawals;

// ── ADMIN: AUTO-PROCESS ALL PENDING (Callable) ───────────────
exports.autoProcessWithdrawals = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
  const ADMIN_EMAILS = (cfg.admin?.emails || "admin@kazilink.com,pitahwambuajr@gmail.com").split(",");
  if (!ADMIN_EMAILS.includes(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }

  const snap = await db.collection("withdrawals")
    .where("status", "==", "pending")
    .where("fraudScore", "<=", MAX_FRAUD_SCORE)
    .get();

  let processed = 0;
  const promises = [];

  snap.forEach(doc => {
    const d = doc.data();
    if (d.amount <= MAX_AUTO_PAYOUT) {
      promises.push(
        processB2C(d.phone, d.amount, doc.id, d.userId)
          .then(() => processed++)
          .catch(e => console.error(`B2C failed for ${doc.id}:`, e))
      );
    }
  });

  await Promise.all(promises);
  return { success: true, processed };
});

// ── FRAUD SCORE HELPER ───────────────────────────────────────
function calcFraudScore(userData) {
  let score = 0;
  if ((userData.giftsInLastHour   || 0) > 20) score += 40;
  if ((userData.withdrawalAttempts24h || 0) > 3) score += 25;
  if ((userData.selfGiftAttempts  || 0) > 0)  score += 30;
  if ((userData.coins || 0) > 10000 && (userData.coinsEarned || 0) === 0) score += 20;
  return Math.min(score, 100);
}

// ── SCHEDULED: RESET HOURLY COUNTERS ─────────────────────────
exports.resetHourlyCounters = functions.pubsub
  .schedule("every 60 minutes")
  .onRun(async () => {
    const snap = await db.collection("users").where("giftsInLastHour", ">", 0).get();
    const batch = db.batch();
    snap.forEach(doc => batch.update(doc.ref, { giftsInLastHour: 0 }));
    await batch.commit();
    console.log(`Reset hourly counters for ${snap.size} users`);
  });

// ── SCHEDULED: DAILY FRAUD AUDIT ─────────────────────────────
exports.dailyFraudAudit = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async () => {
    const users = await db.collection("users").get();
    const batch = db.batch();
    let flagged = 0;

    users.forEach(doc => {
      const d = doc.data();
      const score = calcFraudScore(d);
      if (score >= 80 && !d.frozen) {
        batch.update(doc.ref, { frozen: true, frozenAt: admin.firestore.FieldValue.serverTimestamp() });
        const alertRef = db.collection("fraudAlerts").doc();
        batch.set(alertRef, {
          userId: doc.id, reason: `Daily audit: score ${score}`,
          resolved: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        flagged++;
      }
    });

    await batch.commit();
    console.log(`Daily fraud audit: ${flagged} accounts flagged`);
  });

// ── B2C RESULT CALLBACK ───────────────────────────────────────
exports.mpesaCallbackB2C = functions.https.onRequest(async (req, res) => {
  const result = req.body?.Result;
  if (!result) return res.send("OK");

  const convId = result.ConversationID;
  const code   = result.ResultCode;

  const snap = await db.collection("withdrawals")
    .where("mpesaConvId", "==", convId).get();

  if (!snap.empty) {
    await snap.docs[0].ref.update({
      status: code === 0 ? "paid" : "failed",
      resultDesc: result.ResultDesc || ""
    });
  }

  res.send("OK");
});

module.exports.calcFraudScore = calcFraudScore;

// ── B2C TIMEOUT CALLBACK ──────────────────────────────────────
exports.mpesaCallbackB2CTimeout = functions.https.onRequest(async (req, res) => {
  const result = req.body?.Result || req.body;
  const convId = result?.ConversationID || result?.OriginatorConversationID;
  if (convId) {
    const snap = await db.collection("withdrawals")
      .where("mpesaConvId", "==", convId).get();
    if (!snap.empty) {
      const wd = snap.docs[0];
      const d = wd.data();
      // Refund the user's balance since the payment timed out
      await db.runTransaction(async (t) => {
        t.update(wd.ref, { status: "timeout", resultDesc: "Queue timeout" });
        if (d.userId && d.amount) {
          t.update(db.collection("users").doc(d.userId), {
            balance:     admin.firestore.FieldValue.increment(d.amount),
            coinsEarned: admin.firestore.FieldValue.increment(d.amount)
          });
        }
      });
    }
  }
  res.send("OK");
});

// ── SCHEDULED: RECONCILE STALE PENDING PAYMENTS ──────────────
exports.reconcileStalePayments = functions.pubsub
  .schedule("every 15 minutes")
  .onRun(async () => {
    const cutoff = Date.now() - 10 * 60 * 1000; // 10 minutes old
    const snap = await db.collection("pendingPayments")
      .where("status", "==", "pending")
      .get();
    const batch = db.batch();
    let n = 0;
    snap.forEach(doc => {
      const created = doc.data().createdAt?.toMillis?.() || 0;
      if (created && created < cutoff) {
        batch.update(doc.ref, { status: "expired" });
        n++;
      }
    });
    if (n > 0) await batch.commit();
    console.log(`Expired ${n} stale STK payments`);
  });

// ── SCHEDULED: RESET DAILY WITHDRAWAL ATTEMPT COUNTERS ───────
exports.resetDailyCounters = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async () => {
    const snap = await db.collection("users")
      .where("withdrawalAttempts24h", ">", 0).get();
    const batch = db.batch();
    snap.forEach(doc => batch.update(doc.ref, { withdrawalAttempts24h: 0 }));
    if (!snap.empty) await batch.commit();
    console.log(`Reset 24h withdrawal counters for ${snap.size} users`);
  });

// ── HEALTH CHECK ──────────────────────────────────────────────
exports.health = functions.https.onRequest((req, res) => {
  res.json({ ok: true, env: IS_SANDBOX ? "sandbox" : "production", time: Date.now() });
});
