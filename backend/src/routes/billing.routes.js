const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { getPlusStatus, handleWebhook, syncSubscription } = require('../services/billingService');

/**
 * GET /api/billing/status
 * Returns Plus subscription status for the logged-in user.
 */
router.get('/status', authenticateToken, async (req, res, next) => {
  try {
    if (!req.user || req.user.id === 'anonymous') {
      return res.json({ plus: false, expiresAt: null, willRenew: false });
    }
    const status = await getPlusStatus(req.user.id);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/billing/sync
 * Client calls after a successful purchase to force-check RevenueCat.
 */
router.post('/sync', authenticateToken, async (req, res, next) => {
  try {
    if (!req.user || req.user.id === 'anonymous') {
      return res.json({ synced: false });
    }
    const result = await syncSubscription(req.user.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/billing/revenuecat
 * RevenueCat webhook endpoint. Authenticated by webhook secret, not JWT.
 */
router.post('/revenuecat', async (req, res) => {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[Billing] REVENUECAT_WEBHOOK_SECRET not set, rejecting webhook');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const event = req.body?.event;
    if (!event) {
      return res.status(200).json({ ok: true });
    }

    const result = await handleWebhook(event);
    console.log(`[Billing] Webhook ${event.type} user=${event.app_user_id} →`, result);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[Billing] Webhook error:', error);
    res.status(200).json({ ok: true });
  }
});

module.exports = router;
