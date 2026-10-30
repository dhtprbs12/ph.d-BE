const { query } = require('../database/connection');

const PLUS_PRODUCT_IDS = (process.env.BILLING_PLUS_PRODUCT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const BONE_GRANTS = new Map(
  (process.env.BILLING_BONE_GRANTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const [productId, count] = pair.split(':');
      return [productId, parseInt(count, 10)];
    })
);

const ALLOW_SANDBOX = (process.env.BILLING_ALLOW_SANDBOX || 'false') === 'true';

function isPlus(user) {
  return user.plus_expires_at && new Date(user.plus_expires_at) > new Date();
}

async function getPlusStatus(userId) {
  const [row] = await query(
    'SELECT plus_product_id, plus_store, plus_will_renew, plus_expires_at FROM users WHERE id = ?',
    [userId]
  );
  if (!row) return { plus: false, expiresAt: null, willRenew: false };
  return {
    plus: row.plus_expires_at ? new Date(row.plus_expires_at) > new Date() : false,
    expiresAt: row.plus_expires_at,
    willRenew: !!row.plus_will_renew,
  };
}

async function handleWebhook(event) {
  const eventType = event.type;
  const appUserId = event.app_user_id;
  const environment = event.environment; // SANDBOX or PRODUCTION
  const productId = event.product_id;
  const store = event.store; // APP_STORE or PLAY_STORE
  const expiresAt = event.expiration_at_ms ? new Date(event.expiration_at_ms) : null;
  const transactionId = event.transaction_id || event.id;

  // TRANSFER: fired when Purchases.logIn() moves anonymous purchases to an
  // identified user. app_user_id may be undefined; the real target is in
  // transferred_to[]. Reconcile any bone packs that were bought anonymously.
  if (eventType === 'TRANSFER') {
    const targetId = (event.transferred_to || [])[0] || appUserId;
    if (!targetId || targetId.startsWith('$RCAnonymous')) {
      console.log(`[Billing] TRANSFER with no identified target, ignoring`);
      return { handled: false, reason: 'no_target_user' };
    }
    const [targetUser] = await query('SELECT id FROM users WHERE id = ?', [targetId]);
    if (!targetUser) {
      console.log(`[Billing] TRANSFER target user=${targetId} not found, ignoring`);
      return { handled: false, reason: 'unknown_target_user' };
    }
    return reconcileBonePurchases(targetId, environment);
  }

  if (!ALLOW_SANDBOX && environment === 'SANDBOX') {
    console.log(`[Billing] Ignoring sandbox event for user=${appUserId}`);
    return { handled: false, reason: 'sandbox_blocked' };
  }

  const [user] = await query('SELECT id FROM users WHERE id = ?', [appUserId]);
  if (!user) {
    console.log(`[Billing] Unknown user=${appUserId}, ignoring`);
    return { handled: false, reason: 'unknown_user' };
  }

  const storeValue = store === 'APP_STORE' ? 'apple' : 'google';

  if (PLUS_PRODUCT_IDS.includes(productId)) {
    return handleSubscriptionEvent(eventType, appUserId, productId, storeValue, expiresAt);
  }

  if (BONE_GRANTS.has(productId)) {
    return handleBonePurchase(appUserId, productId, transactionId);
  }

  console.log(`[Billing] Unknown product_id=${productId} for user=${appUserId}`);
  return { handled: false, reason: 'unknown_product' };
}

async function handleSubscriptionEvent(eventType, userId, productId, store, expiresAt) {
  switch (eventType) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'PRODUCT_CHANGE':
    case 'UNCANCELLATION': {
      // Guard: never overwrite with an earlier expiration than what's already in the DB
      if (expiresAt) {
        const [cur] = await query('SELECT plus_expires_at FROM users WHERE id = ?', [userId]);
        if (cur && cur.plus_expires_at && new Date(cur.plus_expires_at) > new Date(expiresAt)) {
          console.log(`[Billing] Skipping stale ${eventType} user=${userId} product=${productId} expires=${expiresAt} (current=${cur.plus_expires_at} is later)`);
          return { handled: true, action: 'stale_skipped' };
        }
      }
      await query(
        `UPDATE users
         SET plus_product_id = ?, plus_store = ?, plus_will_renew = 1, plus_expires_at = ?
         WHERE id = ?`,
        [productId, store, expiresAt, userId]
      );
      console.log(`[Billing] Plus activated user=${userId} product=${productId} expires=${expiresAt}`);
      return { handled: true, action: 'plus_activated' };
    }

    case 'CANCELLATION':
      await query('UPDATE users SET plus_will_renew = 0 WHERE id = ?', [userId]);
      console.log(`[Billing] Plus cancel-pending user=${userId}`);
      return { handled: true, action: 'cancel_pending' };

    case 'EXPIRATION':
      console.log(`[Billing] Plus expired user=${userId}`);
      return { handled: true, action: 'expired' };

    case 'BILLING_ISSUE':
      await query('UPDATE users SET plus_will_renew = 0 WHERE id = ?', [userId]);
      console.log(`[Billing] Billing issue user=${userId}`);
      return { handled: true, action: 'billing_issue' };

    case 'REFUND':
      await query(
        `UPDATE users SET plus_expires_at = CURRENT_TIMESTAMP, plus_will_renew = 0 WHERE id = ?`,
        [userId]
      );
      console.log(`[Billing] Refunded user=${userId}, Plus revoked`);
      return { handled: true, action: 'refunded' };

    default:
      console.log(`[Billing] Unhandled subscription event=${eventType} user=${userId}`);
      return { handled: false, reason: 'unhandled_event' };
  }
}

async function handleBonePurchase(userId, productId, transactionId) {
  const boneCount = BONE_GRANTS.get(productId);
  if (!boneCount) return { handled: false, reason: 'no_bone_grant' };

  const { getPool } = require('../database/connection');
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      "SELECT id FROM token_transactions WHERE type = 'bone_pack' AND reference_id = ? LIMIT 1",
      [transactionId]
    );
    if (existing.length > 0) {
      await conn.rollback();
      console.log(`[Billing] Duplicate bone purchase txn=${transactionId} user=${userId}`);
      return { handled: true, action: 'duplicate_skipped' };
    }

    const { v4: uuidv4 } = require('uuid');
    const txId = uuidv4();
    await conn.query(
      'INSERT INTO token_transactions (id, user_id, amount, type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?)',
      [txId, userId, boneCount, 'bone_pack', transactionId, `Bone pack ×${boneCount} 🦴`]
    );
    await conn.query(
      'UPDATE user_tokens SET balance = balance + ?, total_earned = total_earned + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [boneCount, boneCount, userId]
    );

    await conn.commit();
    console.log(`[Billing] Bones granted user=${userId} count=${boneCount} txn=${transactionId}`);
    return { handled: true, action: 'bones_granted', count: boneCount };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * After a TRANSFER event, call the RevenueCat REST API to list the
 * customer's non-subscription (bone pack) purchases and grant any
 * that are missing from token_transactions.
 */
async function reconcileBonePurchases(userId, environment) {
  const RC_SECRET = process.env.REVENUECAT_SECRET_API_KEY;
  if (!RC_SECRET) {
    console.log(`[Billing] REVENUECAT_SECRET_API_KEY not set, cannot reconcile bones for user=${userId}`);
    return { handled: false, reason: 'no_rc_api_key' };
  }

  if (!ALLOW_SANDBOX && environment === 'SANDBOX') {
    console.log(`[Billing] Ignoring sandbox TRANSFER reconciliation for user=${userId}`);
    return { handled: false, reason: 'sandbox_blocked' };
  }

  try {
    const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${userId}`, {
      headers: {
        Authorization: `Bearer ${RC_SECRET}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      console.log(`[Billing] RC API ${res.status} for user=${userId}`);
      return { handled: false, reason: 'rc_api_error' };
    }

    const data = await res.json();
    const nonSubs = data.subscriber?.non_subscriptions || {};
    let granted = 0;

    for (const [productId, purchases] of Object.entries(nonSubs)) {
      if (!BONE_GRANTS.has(productId)) continue;
      for (const purchase of purchases) {
        const txnId = purchase.id || purchase.store_transaction_id;
        if (!txnId) continue;
        const result = await handleBonePurchase(userId, productId, txnId);
        if (result.action === 'bones_granted') granted++;
      }
    }

    console.log(`[Billing] TRANSFER reconciled user=${userId}, bones_granted=${granted}`);
    return { handled: true, action: 'transfer_reconciled', bonesGranted: granted };
  } catch (err) {
    console.error(`[Billing] TRANSFER reconciliation failed user=${userId}:`, err);
    return { handled: false, reason: 'reconciliation_error' };
  }
}

/**
 * Client calls this after a successful purchase.
 * Fetches the subscriber from RevenueCat REST API and updates plus_expires_at.
 */
async function syncSubscription(userId) {
  const RC_SECRET = process.env.REVENUECAT_SECRET_API_KEY;
  if (!RC_SECRET) {
    return { synced: false, reason: 'no_rc_api_key' };
  }
  try {
    const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${userId}`, {
      headers: {
        Authorization: `Bearer ${RC_SECRET}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      console.log(`[Billing] sync RC API ${res.status} for user=${userId}`);
      return { synced: false, reason: 'rc_api_error' };
    }
    const data = await res.json();
    const subs = data.subscriber?.subscriptions || {};

    let latestExpires = null;
    let latestProduct = null;
    for (const [productId, sub] of Object.entries(subs)) {
      if (!PLUS_PRODUCT_IDS.includes(productId)) continue;
      const exp = sub.expires_date ? new Date(sub.expires_date) : null;
      if (exp && (!latestExpires || exp > latestExpires)) {
        latestExpires = exp;
        latestProduct = productId;
      }
    }

    if (latestExpires && latestExpires > new Date()) {
      await query(
        `UPDATE users SET plus_product_id = ?, plus_will_renew = 1, plus_expires_at = ? WHERE id = ? AND (plus_expires_at IS NULL OR plus_expires_at < ?)`,
        [latestProduct, latestExpires, userId, latestExpires]
      );
      console.log(`[Billing] sync: Plus confirmed user=${userId} product=${latestProduct} expires=${latestExpires}`);
      return { synced: true, plus: true, expiresAt: latestExpires };
    }

    console.log(`[Billing] sync: no active Plus for user=${userId}`);
    return { synced: true, plus: false };
  } catch (err) {
    console.error(`[Billing] sync error user=${userId}:`, err);
    return { synced: false, reason: 'error' };
  }
}

module.exports = { isPlus, getPlusStatus, handleWebhook, syncSubscription };
