require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const mysql = require('mysql2/promise');

const seedData = async () => {
  let connection;

  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    console.log('🔌 Connected to database');

    // =============================================
    // SEED ANONYMOUS USER (for MVP testing without auth)
    // =============================================
    console.log('👤 Creating anonymous user...');
    await connection.execute(
      `INSERT INTO users (id, email, password_hash, name) 
       VALUES ('anonymous', 'anonymous@local', 'no-password', 'Anonymous User')
       ON DUPLICATE KEY UPDATE name = 'Anonymous User'`
    );

    // =============================================
    // NOTE: Ingredients are no longer seeded here.
    // We use AI-generated assessments cached in ai_assessment_cache table.
    // This provides personalized assessments per pet health condition.
    // =============================================

    // =============================================
    // SEED SAMPLE PRODUCTS
    // =============================================
    console.log('📦 Seeding sample products...');

    const products = [
      {
        id: uuidv4(),
        barcode: '0079100003525',
        name: 'Premium Chicken & Rice Adult Dog Food',
        brand: 'PetNutrition Pro',
        product_type: 'dry_food',
        target_pet_type: 'dog',
        target_life_stage: 'adult',
        raw_ingredients_text: 'Chicken, Brown Rice, Chicken Meal, Oatmeal, Chicken Fat, Flaxseed, Fish Oil, Sweet Potato, Pumpkin, Blueberries, Taurine, Glucosamine, Chondroitin, Probiotics, Tocopherols, Vitamin E, Zinc, Calcium',
        base_dog_score: 85,
        base_cat_score: 45
      },
      {
        id: uuidv4(),
        barcode: '0079100003526',
        name: 'Grain-Free Salmon Formula Cat Food',
        brand: 'PetNutrition Pro',
        product_type: 'dry_food',
        target_pet_type: 'cat',
        target_life_stage: 'adult',
        raw_ingredients_text: 'Salmon, Salmon Meal, Sweet Potato, Peas, Chicken Fat, Fish Oil, Taurine, Cranberries, Probiotics, Tocopherols, Vitamin E, Vitamin A, Zinc, Calcium, Phosphorus',
        base_dog_score: 70,
        base_cat_score: 88
      },
      {
        id: uuidv4(),
        barcode: '0079100003527',
        name: 'Budget Corn & Wheat Dog Kibble',
        brand: 'ValuePet',
        product_type: 'dry_food',
        target_pet_type: 'dog',
        target_life_stage: 'all',
        raw_ingredients_text: 'Corn, Wheat, Corn Gluten Meal, Meat By-Products, Animal Digest, Soy, Chicken Fat, BHA, BHT, Cellulose',
        base_dog_score: 35,
        base_cat_score: 20
      },
      {
        id: uuidv4(),
        barcode: '0079100003528',
        name: 'Sensitive Stomach Turkey Formula',
        brand: 'GentleDigest',
        product_type: 'wet_food',
        target_pet_type: 'both',
        target_life_stage: 'adult',
        raw_ingredients_text: 'Turkey, Turkey Broth, Brown Rice, Oatmeal, Pumpkin, Fish Oil, Probiotics, Taurine, Tocopherols, Vitamin E, Zinc',
        base_dog_score: 82,
        base_cat_score: 75
      },
      {
        id: uuidv4(),
        barcode: '0079100003529',
        name: 'Senior Joint Care Dog Food',
        brand: 'GoldenYears',
        product_type: 'dry_food',
        target_pet_type: 'dog',
        target_life_stage: 'senior',
        raw_ingredients_text: 'Chicken, Brown Rice, Chicken Meal, Oatmeal, Glucosamine, Chondroitin, Fish Oil, Flaxseed, Pumpkin, Blueberries, Cranberries, Taurine, Probiotics, Tocopherols, Vitamin E, Calcium, Zinc',
        base_dog_score: 90,
        base_cat_score: 50
      }
    ];

    for (const product of products) {
      await connection.execute(
        `INSERT IGNORE INTO products 
         (id, barcode, name, brand, product_type, target_pet_type, target_life_stage, raw_ingredients_text, base_dog_score, base_cat_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [product.id, product.barcode, product.name, product.brand, product.product_type, 
         product.target_pet_type, product.target_life_stage, product.raw_ingredients_text,
         product.base_dog_score, product.base_cat_score]
      );
    }

    console.log(`✅ Seeded ${products.length} sample products`);
    console.log('🎉 Database seeding completed!');

  } catch (error) {
    console.error('❌ Seeding failed:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
};

seedData();

