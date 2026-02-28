/**
 * ===========================================
 * PetFood Analyzer - Configuration Reference
 * ===========================================
 * 
 * Create a .env file in the backend directory with the following variables:
 * 
 * # Server
 * PORT=3000
 * NODE_ENV=development
 * 
 * # MySQL Database
 * DB_HOST=localhost
 * DB_PORT=3306
 * DB_USER=root
 * DB_PASSWORD=your_password
 * DB_NAME=petfood_analyzer
 * 
 * # JWT (for authentication)
 * JWT_SECRET=change-this-to-a-secure-random-string
 * JWT_EXPIRES_IN=7d
 * 
 * # Google Gemini API (for OCR/AI features)
 * # Get your key: https://makersuite.google.com/app/apikey
 * GEMINI_API_KEY=your_api_key_here
 * 
 * ===========================================
 * SETUP INSTRUCTIONS
 * ===========================================
 * 
 * 1. Install MySQL and create database:
 *    CREATE DATABASE petfood_analyzer;
 * 
 * 2. Create .env file with your credentials
 * 
 * 3. Install dependencies:
 *    npm install
 * 
 * 4. Run database migrations:
 *    npm run migrate
 * 
 * 5. Seed initial data:
 *    npm run seed
 * 
 * 6. Start the server:
 *    npm run dev (development)
 *    npm start (production)
 * 
 * ===========================================
 * API ENDPOINTS
 * ===========================================
 * 
 * Health Check:
 *   GET /health
 * 
 * Products:
 *   GET /api/products/search?q=chicken&petType=dog
 *   GET /api/products/filter?petType=dog&grainFree=true&noChicken=true
 *   GET /api/products/:id
 *   GET /api/products/:id/analyze?petId=xxx
 *   GET /api/products/:id/alternatives?petId=xxx
 *   GET /api/products/:id/reviews?petType=dog
 *   GET /api/products/barcode/:barcode
 * 
 * Scans:
 *   POST /api/scan/barcode { barcode, petId }
 *   POST /api/scan/label (multipart: image, petId)
 *   POST /api/scan/manual { ingredientsText, petId }
 *   GET /api/scan/history?petId=xxx
 *   GET /api/scan/:id
 * 
 * Pets:
 *   GET /api/pets
 *   POST /api/pets
 *   GET /api/pets/:id
 *   PUT /api/pets/:id
 *   DELETE /api/pets/:id
 * 
 * Reviews:
 *   POST /api/products/:id/reviews { petId, rating, title, content }
 */

module.exports = {
  // This file is for reference only
  // Actual config comes from environment variables
};

