const express = require('express');
const nodemailer = require('nodemailer');
const router = express.Router();
const { query } = require('../database/connection');
const { authenticateToken } = require('../middleware/auth');

const TOPICS = ['Account', 'PHD Plus', 'A food or scan', 'Something else'];
const GMAIL_USER = 'seefarcompany12@gmail.com';
const TO = process.env.CONTACT_EMAIL_TO || GMAIL_USER;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS = 5;
const recentSends = new Map();

function realEmail(value) {
  const email = String(value || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  if (email.endsWith('@nickname.local') || email.endsWith('@device.local') || email === 'anonymous@local') return '';
  return email;
}

function limited(userId) {
  const now = Date.now();
  const stamps = (recentSends.get(userId) || []).filter(time => now - time < WINDOW_MS);
  recentSends.set(userId, stamps);
  return stamps.length >= MAX_SENDS;
}

function remember(userId) {
  const stamps = recentSends.get(userId) || [];
  stamps.push(Date.now());
  recentSends.set(userId, stamps);
}

async function sendContactEmail({ topic, message, replyEmail, userId, nickname, accountEmail, appVersion, platform }) {
  const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!pass) {
    const error = new Error('Email is not configured');
    error.status = 503;
    throw error;
  }
  const lines = [
    `Topic: ${topic}`,
    '',
    message,
    '',
    `Reply email: ${replyEmail}`,
    accountEmail ? `Account email: ${accountEmail}` : '',
    `User id: ${userId}`,
    nickname ? `Nickname: ${nickname}` : '',
    `App: ${appVersion} · ${platform}`,
  ].filter(line => line !== '');
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass },
  });
  try {
    await transporter.sendMail({
      from: `PHD <${GMAIL_USER}>`,
      to: TO,
      subject: `PHD contact: ${topic}`,
      text: lines.join('\n'),
    });
  } catch (err) {
    console.error('[Contact] gmail send failed:', err && err.response ? err.response : err.message);
    const error = new Error('Could not send the message');
    error.status = 502;
    throw error;
  }
}

router.post('/', authenticateToken, async (req, res, next) => {
  try {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return res.status(401).json({ error: 'Sign in to send a message' });
    }
    const topic = String(req.body?.topic || '').trim();
    const message = String(req.body?.message || '').trim();
    const replyEmail = realEmail(req.body?.email);
    const appVersion = String(req.body?.appVersion || '').trim().slice(0, 20) || 'unknown';
    const platform = ['ios', 'android'].includes(req.body?.platform) ? req.body.platform : 'unknown';

    if (!TOPICS.includes(topic)) return res.status(400).json({ error: 'Choose a topic' });
    if (!message || message.length > 4000) return res.status(400).json({ error: 'Write a message before sending.' });
    if (!replyEmail || replyEmail.length > 254) return res.status(400).json({ error: 'Enter an email address so we can reply.' });
    if (limited(req.user.id)) {
      return res.status(429).json({ error: 'Please wait a few minutes before sending another message.' });
    }

    const [row] = await query('SELECT nickname FROM users WHERE id = ?', [req.user.id]);
    await sendContactEmail({
      topic,
      message,
      replyEmail,
      userId: req.user.id,
      nickname: row?.nickname || '',
      accountEmail: realEmail(req.user.email),
      appVersion,
      platform,
    });
    remember(req.user.id);
    res.json({ ok: true });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

module.exports = router;
