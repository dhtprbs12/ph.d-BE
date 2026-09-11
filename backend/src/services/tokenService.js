const { v4: uuidv4 } = require('uuid');
const { query } = require('../database/connection');

/**
 * Grant tokens to a user.
 * @param {string} userId
 * @param {number} amount - positive integer
 * @param {string} type - 'checkin' | 'product_register' | 'scan_level' | 'streak' | 'purchase'
 * @param {string} description
 * @param {string|null} referenceId - optional reference (checkin id, product id, etc.)
 */
async function grantTokens(userId, amount, type, description, referenceId = null) {
  const txId = uuidv4();
  await query(
    'INSERT INTO token_transactions (id, user_id, amount, type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?)',
    [txId, userId, amount, type, referenceId, description]
  );
  await query(
    'UPDATE user_tokens SET balance = balance + ?, total_earned = total_earned + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
    [amount, amount, userId]
  );
  console.log(`🦴 [Token] +${amount} to user=${userId} type=${type} desc="${description}"`);
  return txId;
}

/**
 * Spend tokens (for purchases).
 * Returns true if successful, false if insufficient balance.
 */
async function spendTokens(userId, amount, type, description, referenceId = null) {
  const [row] = await query('SELECT balance FROM user_tokens WHERE user_id = ?', [userId]);
  if (!row || row.balance < amount) return false;

  const txId = uuidv4();
  await query(
    'INSERT INTO token_transactions (id, user_id, amount, type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?)',
    [txId, userId, -amount, type, referenceId, description]
  );
  await query(
    'UPDATE user_tokens SET balance = balance - ?, total_spent = total_spent + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
    [amount, amount, userId]
  );
  console.log(`🦴 [Token] -${amount} from user=${userId} type=${type} desc="${description}"`);
  return true;
}

/**
 * Get token balance and totals.
 */
async function getTokenInfo(userId) {
  const [row] = await query('SELECT balance, total_earned, total_spent FROM user_tokens WHERE user_id = ?', [userId]);
  return row || { balance: 0, total_earned: 0, total_spent: 0 };
}

/**
 * Get transaction history.
 */
async function getTransactionHistory(userId, limit = 20, offset = 0) {
  return query(
    'SELECT id, amount, type, reference_id, description, created_at FROM token_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [userId, limit, offset]
  );
}

// ─── SCAN LEVEL SYSTEM ────────────────────────────────────────

const SCAN_LEVELS = [
  { level: 1,  scansRequired: 0,   reward: 0  },
  { level: 2,  scansRequired: 5,   reward: 5  },
  { level: 3,  scansRequired: 15,  reward: 5  },
  { level: 4,  scansRequired: 30,  reward: 10 },
  { level: 5,  scansRequired: 50,  reward: 10 },
  { level: 6,  scansRequired: 80,  reward: 15 },
  { level: 7,  scansRequired: 120, reward: 15 },
  { level: 8,  scansRequired: 170, reward: 20 },
  { level: 9,  scansRequired: 250, reward: 25 },
  { level: 10, scansRequired: 400, reward: 50 },
];

/**
 * Increment scan count and check for level-up.
 * Returns { leveled: boolean, newLevel?, reward? } or null if user row missing.
 */
async function recordScanAndCheckLevel(userId) {
  if (!userId) return null;

  try {
    await query(
      'UPDATE user_scan_level SET total_scans = total_scans + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [userId]
    );

    const [row] = await query(
      'SELECT total_scans, current_level FROM user_scan_level WHERE user_id = ?',
      [userId]
    );
    if (!row) return null;

    const { total_scans, current_level } = row;
    const nextDef = SCAN_LEVELS.find(l => l.level === current_level + 1);

    if (nextDef && total_scans >= nextDef.scansRequired) {
      await query(
        'UPDATE user_scan_level SET current_level = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
        [nextDef.level, userId]
      );

      if (nextDef.reward > 0) {
        await grantTokens(userId, nextDef.reward, 'scan_level', `Scan Level ${nextDef.level} reached! 🦴×${nextDef.reward}`, `level_${nextDef.level}`);
      }

      console.log(`🎯 [ScanLevel] user=${userId} leveled up to Lv.${nextDef.level} (scans=${total_scans}, reward=${nextDef.reward})`);
      return { leveled: true, newLevel: nextDef.level, reward: nextDef.reward, totalScans: total_scans };
    }

    return { leveled: false, totalScans: total_scans, currentLevel: current_level };
  } catch (e) {
    console.warn('[ScanLevel] recordScanAndCheckLevel error:', e.message);
    return null;
  }
}

module.exports = { grantTokens, spendTokens, getTokenInfo, getTransactionHistory, recordScanAndCheckLevel, SCAN_LEVELS };
