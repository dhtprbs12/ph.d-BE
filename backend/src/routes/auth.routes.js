const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query } = require('../database/connection');
const { authenticateToken } = require('../middleware/auth');

// Validation middleware
const validateRegistration = [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('name').optional().trim().isLength({ max: 100 })
];

const validateLogin = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
];

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', validateRegistration, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name } = req.body;

    // Check if user exists
    const existing = await query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);
    const userId = uuidv4();

    // Create user
    await query(
      'INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)',
      [userId, email, passwordHash, name || null]
    );

    // Generate token
    const token = jwt.sign(
      { userId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      message: 'Registration successful',
      user: { id: userId, email, name },
      token
    });

  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/login
 * Login user
 */
router.post('/login', validateLogin, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Find user
    const users = await query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = users[0];

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate token
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      message: 'Login successful',
      user: { id: user.id, email: user.email, name: user.name },
      token
    });

  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/auth/me
 * Get current user
 */
router.get('/me', authenticateToken, async (req, res) => {
  res.json({ user: req.user });
});

/**
 * PUT /api/auth/me
 * Update current user
 */
router.put('/me', authenticateToken, async (req, res, next) => {
  try {
    const { name } = req.body;

    await query('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);

    res.json({
      message: 'Profile updated',
      user: { ...req.user, name }
    });

  } catch (error) {
    next(error);
  }
});

// In-memory rate limiting for PIN attempts
const pinAttempts = new Map(); // nickname -> { count, lastAttempt }
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000; // 1 minute

function checkPinRateLimit(nickname) {
  const key = nickname.toLowerCase();
  const record = pinAttempts.get(key);
  if (!record) return { allowed: true };
  if (Date.now() - record.lastAttempt > LOCKOUT_MS) {
    pinAttempts.delete(key);
    return { allowed: true };
  }
  if (record.count >= MAX_PIN_ATTEMPTS) {
    return { allowed: false, retryAfter: Math.ceil((LOCKOUT_MS - (Date.now() - record.lastAttempt)) / 1000) };
  }
  return { allowed: true };
}

function recordPinFailure(nickname) {
  const key = nickname.toLowerCase();
  const record = pinAttempts.get(key) || { count: 0, lastAttempt: 0 };
  record.count += 1;
  record.lastAttempt = Date.now();
  pinAttempts.set(key, record);
}

function clearPinFailures(nickname) {
  pinAttempts.delete(nickname.toLowerCase());
}

/**
 * GET /api/auth/check-nickname?nickname=xxx
 * Check nickname availability (no auth required)
 */
router.get('/check-nickname', async (req, res, next) => {
  try {
    const nickname = (req.query.nickname || '').trim();
    if (!nickname || nickname.length < 2 || nickname.length > 30) {
      return res.json({ available: false, reason: 'Nickname must be 2-30 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(nickname)) {
      return res.json({ available: false, reason: 'Only letters, numbers, and underscores allowed' });
    }
    const rows = await query('SELECT id FROM users WHERE LOWER(nickname) = LOWER(?) LIMIT 1', [nickname]);
    res.json({ available: rows.length === 0 });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/register-nickname
 * Register with nickname + PIN
 */
router.post('/register-nickname', [
  body('nickname').trim().isLength({ min: 2, max: 30 }).matches(/^[a-zA-Z0-9_]+$/),
  body('pin').isLength({ min: 4, max: 6 }).isNumeric(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { nickname, pin } = req.body;

    // Check uniqueness
    const existing = await query('SELECT id FROM users WHERE LOWER(nickname) = LOWER(?) LIMIT 1', [nickname]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'nickname_taken', message: 'This nickname is already in use.' });
    }

    const userId = uuidv4();
    const pinHash = await bcrypt.hash(pin, 10);
    const placeholderEmail = `${nickname.toLowerCase()}@nickname.local`;
    const placeholderPasswordHash = await bcrypt.hash(uuidv4(), 4);

    await query(
      'INSERT INTO users (id, email, password_hash, nickname, pin_hash, name) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, placeholderEmail, placeholderPasswordHash, nickname, pinHash, nickname]
    );

    const token = jwt.sign(
      { userId },
      process.env.JWT_SECRET,
      { expiresIn: '365d' }
    );

    console.log(`📱 New nickname user: ${nickname} (id=${userId})`);

    res.status(201).json({
      user: { id: userId, nickname, name: nickname },
      token,
      isNewUser: true,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/login-nickname
 * Login with nickname + PIN
 */
router.post('/login-nickname', [
  body('nickname').trim().notEmpty(),
  body('pin').notEmpty(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { nickname, pin } = req.body;

    // Rate limit check
    const rateCheck = checkPinRateLimit(nickname);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'too_many_attempts',
        message: `Too many failed attempts. Try again in ${rateCheck.retryAfter}s.`,
        retryAfter: rateCheck.retryAfter,
      });
    }

    const users = await query('SELECT id, nickname, pin_hash, name FROM users WHERE LOWER(nickname) = LOWER(?) LIMIT 1', [nickname]);
    if (users.length === 0) {
      recordPinFailure(nickname);
      return res.status(401).json({ error: 'invalid_credentials', message: 'Invalid nickname or PIN.' });
    }

    const user = users[0];
    if (!user.pin_hash) {
      return res.status(401).json({ error: 'no_pin', message: 'This account does not use PIN login.' });
    }

    const pinValid = await bcrypt.compare(pin, user.pin_hash);
    if (!pinValid) {
      recordPinFailure(nickname);
      return res.status(401).json({ error: 'invalid_credentials', message: 'Invalid nickname or PIN.' });
    }

    clearPinFailures(nickname);

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '365d' }
    );

    console.log(`🔑 Nickname login: ${user.nickname} (id=${user.id})`);

    res.json({
      user: { id: user.id, nickname: user.nickname, name: user.name },
      token,
      isNewUser: false,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/device
 * Device-based auto-auth: creates or finds a user by deviceId, returns JWT
 * No password required — uses a placeholder email ({deviceId}@device.local)
 */
router.post('/device', async (req, res, next) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 5) {
      return res.status(400).json({ error: 'Valid deviceId is required' });
    }

    const deviceEmail = `${deviceId.toLowerCase()}@device.local`;

    // Check if device user already exists
    const existing = await query('SELECT id, email, name FROM users WHERE email = ?', [deviceEmail]);

    if (existing.length > 0) {
      // Existing device user — issue token
      const user = existing[0];
      const token = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET,
        { expiresIn: '365d' }  // Long-lived for device auth
      );

      return res.json({
        message: 'Device authenticated',
        user: { id: user.id, email: user.email, name: user.name },
        token,
        isNewUser: false
      });
    }

    // New device — create user with placeholder email and no password
    const userId = uuidv4();
    const placeholderHash = await bcrypt.hash(uuidv4(), 4);  // Random hash, not used for login

    await query(
      'INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)',
      [userId, deviceEmail, placeholderHash, null]
    );

    const token = jwt.sign(
      { userId },
      process.env.JWT_SECRET,
      { expiresIn: '365d' }
    );

    console.log(`📱 New device user created: ${deviceEmail}`);

    res.status(201).json({
      message: 'Device registered',
      user: { id: userId, email: deviceEmail, name: null },
      token,
      isNewUser: true
    });

  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/auth/upgrade
 * Upgrade a device user to a full account with email/password
 * Requires existing device auth token
 */
router.put('/upgrade', authenticateToken, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('name').optional().trim().isLength({ max: 100 })
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name } = req.body;
    const userId = req.user.id;

    // Check if the new email is already taken by another user
    const emailTaken = await query('SELECT id FROM users WHERE email = ? AND id != ?', [email, userId]);
    if (emailTaken.length > 0) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    // Hash the real password
    const passwordHash = await bcrypt.hash(password, 12);

    // Upgrade: replace placeholder email and set real password
    await query(
      'UPDATE users SET email = ?, password_hash = ?, name = ? WHERE id = ?',
      [email, passwordHash, name || req.user.name, userId]
    );

    // Issue a new token
    const token = jwt.sign(
      { userId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    console.log(`🔑 Device user upgraded: ${req.user.email} → ${email}`);

    res.json({
      message: 'Account upgraded successfully',
      user: { id: userId, email, name: name || req.user.name },
      token
    });

  } catch (error) {
    next(error);
  }
});

module.exports = router;

