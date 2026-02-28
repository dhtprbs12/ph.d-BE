#!/bin/bash
# Auto-restart precache script until it completes successfully
cd /Users/kayoh/Desktop/petfood-analyzer/backend

MAX_RETRIES=20
RETRY=0

while [ $RETRY -lt $MAX_RETRIES ]; do
  echo ""
  echo "=========================================="
  echo "🔄 Attempt $((RETRY + 1))/$MAX_RETRIES"
  echo "=========================================="
  
  node src/database/precache-ingredients.js 2>&1
  EXIT_CODE=$?
  
  if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Pre-cache completed successfully!"
    exit 0
  fi
  
  RETRY=$((RETRY + 1))
  echo "❌ Script exited with code $EXIT_CODE. Retrying in 10s... (attempt $RETRY/$MAX_RETRIES)"
  sleep 10
done

echo "💥 Failed after $MAX_RETRIES attempts"
exit 1

