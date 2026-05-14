/**
 * Base URL for PHD backend (same contract as iOS APIService).
 * Set EXPO_PUBLIC_API_BASE in .env or app.config extra for production.
 */
export const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE?.replace(/\/$/, '') ||
  'https://phd-be-production.up.railway.app/api';
