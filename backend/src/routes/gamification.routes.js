const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const tokenService = require('../services/tokenService');
const { query } = require('../database/connection');

/**
 * GET /api/gamification/tokens
 * Get user's token balance
 */
router.get('/tokens', authenticateToken, async (req, res, next) => {
  try {
    const info = await tokenService.getTokenInfo(req.user.userId);
    res.json(info);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/gamification/tokens/history
 * Get token transaction history
 */
router.get('/tokens/history', authenticateToken, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const transactions = await tokenService.getTransactionHistory(req.user.userId, limit, offset);
    res.json({ transactions });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/gamification/scan-level
 * Get user's scan level info
 */
const { SCAN_LEVELS } = require('../services/tokenService');

router.get('/scan-level', authenticateToken, async (req, res, next) => {
  try {
    const [row] = await query('SELECT total_scans, current_level FROM user_scan_level WHERE user_id = ?', [req.user.userId]);
    const totalScans = row?.total_scans || 0;
    const currentLevel = row?.current_level || 1;
    
    const nextLevelDef = SCAN_LEVELS.find(l => l.level === currentLevel + 1);
    
    res.json({
      currentLevel,
      totalScans,
      nextLevel: nextLevelDef ? {
        level: nextLevelDef.level,
        scansRequired: nextLevelDef.scansRequired,
        reward: nextLevelDef.reward,
        progress: { current: totalScans, target: nextLevelDef.scansRequired },
      } : null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/gamification/streak
 * Get user's streak info
 */
router.get('/streak', authenticateToken, async (req, res, next) => {
  try {
    const [row] = await query(
      'SELECT current_streak, longest_streak, last_checkin_date FROM user_streaks WHERE user_id = ?',
      [req.user.userId]
    );
    
    const milestones = [
      { days: 7, reward: 10, reached: (row?.current_streak || 0) >= 7 },
      { days: 30, reward: 30, reached: (row?.current_streak || 0) >= 30 },
      { days: 100, reward: 50, reached: (row?.current_streak || 0) >= 100 },
    ];
    
    res.json({
      currentStreak: row?.current_streak || 0,
      longestStreak: row?.longest_streak || 0,
      lastCheckinDate: row?.last_checkin_date || null,
      milestones,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/gamification/summary
 * Combined summary: tokens + scan level + streak (for HomeScreen)
 */
router.get('/summary', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const [tokenRow] = await query('SELECT balance, total_earned, total_spent FROM user_tokens WHERE user_id = ?', [userId]);
    const [levelRow] = await query('SELECT total_scans, current_level FROM user_scan_level WHERE user_id = ?', [userId]);
    const [streakRow] = await query('SELECT current_streak, longest_streak, last_checkin_date FROM user_streaks WHERE user_id = ?', [userId]);
    
    const currentLevel = levelRow?.current_level || 1;
    const totalScans = levelRow?.total_scans || 0;
    const nextLevelDef = SCAN_LEVELS.find(l => l.level === currentLevel + 1);
    
    res.json({
      tokens: {
        balance: tokenRow?.balance || 0,
        totalEarned: tokenRow?.total_earned || 0,
        totalSpent: tokenRow?.total_spent || 0,
      },
      scanLevel: {
        currentLevel,
        totalScans,
        nextLevel: nextLevelDef ? {
          level: nextLevelDef.level,
          scansRequired: nextLevelDef.scansRequired,
          reward: nextLevelDef.reward,
          progress: { current: totalScans, target: nextLevelDef.scansRequired },
        } : null,
      },
      streak: {
        currentStreak: streakRow?.current_streak || 0,
        longestStreak: streakRow?.longest_streak || 0,
        lastCheckinDate: streakRow?.last_checkin_date || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
