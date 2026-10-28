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
    case 'UNCANCELLATION':
      await query(
        `UPDATE users
         SET plus_product_id = ?, plus_store = ?, plus_will_renew = 1, plus_expires_at = ?
         WHERE id = ?`,
        [productId, store, expiresAt, userId]
      );
      console.log(`[Billing] Plus activated user=${userId} product=${productId} expires=${expiresAt}`);
      return { handled: true, action: 'plus_activated' };

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

module.exports = { isPlus, getPlusStatus, handleWebhook };
