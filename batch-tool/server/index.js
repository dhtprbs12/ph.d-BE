const path = require('path');
const fs = require('fs');

// Load .env: prefer batch-tool's own .env, fallback to backend's
const localEnv = path.resolve(__dirname, '../.env');
const backendEnv = path.resolve(__dirname, '../../backend/.env');
require('dotenv').config({ path: fs.existsSync(localEnv) ? localEnv : backendEnv });

const express = require('express');
const cors = require('cors');
const { connectDB } = require('../../backend/src/database/connection');
const routes = require('./routes');

const app = express();
const PORT = process.env.BATCH_PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/api/batch', routes);

// Initialize DB then start server
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Batch Tool server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('❌ Failed to connect to DB:', err.message);
  process.exit(1);
});
