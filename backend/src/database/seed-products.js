require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

/**
 * Generates ingredient_hash: MD5 of normalized, sorted ingredient list
 */
function generateIngredientHash(rawIngredients) {
  const normalized = rawIngredients
    .toLowerCase()
    .split(',')
    .map(i => i.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .sort()
    .join(',');
  return crypto.createHash('md5').update(normalized).digest('hex');
}

// =============================================
// 50 DOG PRODUCTS
// =============================================
const dogProducts = [
  // ---- DRY FOOD (18) ----
  {
    name: 'Life Protection Formula Adult Chicken & Brown Rice',
    brand: 'Blue Buffalo',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Deboned Chicken, Chicken Meal, Brown Rice, Oatmeal, Barley, Chicken Fat, Fish Meal, Peas, Flaxseed, Dried Tomato Pomace, Potatoes, Alfalfa Meal, Potato Starch, Fish Oil, Calcium Carbonate, Salt, DL-Methionine, Potassium Chloride, Dried Chicory Root, Blueberries, Cranberries, Barley Grass, Parsley, Kelp, Yucca Schidigera Extract, Taurine, L-Carnitine, L-Lysine, Glucosamine Hydrochloride, Vitamin E, Vitamin A, Vitamin D3, Zinc, Iron'
  },
  {
    name: 'Pro Plan Savor Shredded Blend Chicken & Rice',
    brand: 'Purina',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Rice, Whole Grain Wheat, Poultry By-Product Meal, Soybean Meal, Beef Fat, Corn Gluten Meal, Dried Egg Product, Oat Meal, Fish Meal, Animal Digest, Fish Oil, Calcium Carbonate, Salt, Phosphoric Acid, Potassium Chloride, L-Lysine, Choline Chloride, Zinc Sulfate, Vitamin E, Ferrous Sulfate, Manganese Sulfate, Vitamin A, Vitamin B-12, Vitamin D-3'
  },
  {
    name: 'Science Diet Adult Chicken & Barley Recipe',
    brand: "Hill's",
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Cracked Pearled Barley, Whole Grain Wheat, Whole Grain Sorghum, Whole Grain Corn, Chicken Meal, Chicken Fat, Soybean Meal, Dried Beet Pulp, Pork Fat, Fish Oil, Lactic Acid, Flaxseed, Iodized Salt, Potassium Chloride, Choline Chloride, Vitamin E, Calcium Carbonate, Taurine, L-Carnitine, Vitamin A, Vitamin D3, Zinc, Iron, Mixed Tocopherols'
  },
  {
    name: 'Medium Adult',
    brand: 'Royal Canin',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken By-Product Meal, Brewers Rice, Wheat, Corn, Wheat Gluten, Chicken Fat, Natural Flavors, Dried Plain Beet Pulp, Fish Oil, Vegetable Oil, Sodium Silico Aluminate, Potassium Chloride, Fructooligosaccharides, Salt, Calcium Carbonate, Choline Chloride, DL-Methionine, Taurine, Vitamins, Trace Minerals, L-Carnitine, Glucosamine, Chondroitin, Rosemary Extract'
  },
  {
    name: 'Original',
    brand: 'Orijen',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Deboned Chicken, Deboned Turkey, Yellowtail Flounder, Whole Eggs, Whole Atlantic Mackerel, Chicken Liver, Turkey Liver, Chicken Heart, Turkey Heart, Whole Atlantic Herring, Dehydrated Chicken, Dehydrated Turkey, Dehydrated Mackerel, Chicken Necks, Chicken Fat, Red Lentils, Green Lentils, Green Peas, Lentil Fiber, Chickpeas, Yellow Peas, Pinto Beans, Whole Pumpkin, Whole Butternut Squash, Kale, Spinach, Carrots, Apples, Pears, Cranberries, Blueberries, Turmeric, Dried Kelp, Freeze-Dried Chicken Liver, Freeze-Dried Turkey Liver'
  },
  {
    name: 'High Prairie Canine Recipe',
    brand: 'Taste of the Wild',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Buffalo, Lamb Meal, Chicken Meal, Sweet Potatoes, Peas, Potatoes, Canola Oil, Egg Product, Roasted Bison, Roasted Venison, Beef, Flaxseed, Potato Fiber, Natural Flavor, Ocean Fish Meal, Salt, Choline Chloride, Dried Chicory Root, Tomatoes, Blueberries, Raspberries, Yucca Schidigera Extract, Dried Lactobacillus Plantarum, Dried Lactobacillus Casei, Dried Enterococcus Faecium, Dried Lactobacillus Acidophilus, Zinc, Iron, Vitamin E, Vitamin A'
  },
  {
    name: 'Complete Health Adult Deboned Chicken & Oatmeal',
    brand: 'Wellness',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Deboned Chicken, Chicken Meal, Oatmeal, Ground Barley, Ground Brown Rice, Peas, Chicken Fat, Tomato Pomace, Ground Flaxseed, Salmon Meal, Natural Chicken Flavor, Fish Oil, Potassium Chloride, Salt, Choline Chloride, Spinach, Broccoli, Carrots, Parsley, Apples, Blueberries, Kale, Sweet Potatoes, Taurine, Zinc, Iron, Vitamin E, Vitamin A, Vitamin D3, Mixed Tocopherols, Glucosamine Hydrochloride, Chondroitin Sulfate'
  },
  {
    name: 'Real Texas Beef & Sweet Potato Grain-Free',
    brand: 'Merrick',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Deboned Beef, Lamb Meal, Sweet Potatoes, Potatoes, Peas, Salmon Meal, Potato Protein, Pea Protein, Canola Oil, Natural Flavor, Flaxseed, Salmon Oil, Apples, Blueberries, Organic Alfalfa, Glucosamine Hydrochloride, Chondroitin Sulfate, Salt, Potassium Chloride, Minerals, Vitamins, Yucca Schidigera Extract, Dried Lactobacillus Plantarum, Dried Lactobacillus Casei'
  },
  {
    name: 'Naturals Adult Lamb Meal & Rice Formula',
    brand: 'Diamond',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Lamb Meal, Ground Rice, Cracked Pearled Barley, Chicken Fat, Peas, Egg Product, Dried Beet Pulp, Flaxseed, Natural Flavor, Fish Meal, Salt, Potassium Chloride, Choline Chloride, Dried Chicory Root, Vitamin E, Iron, Zinc, Selenium, Glucosamine Hydrochloride, Chondroitin Sulfate, Dried Lactobacillus Acidophilus, Dried Bacillus Subtilis'
  },
  {
    name: 'Ultra Adult Superfood Plate',
    brand: 'Nutro',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Chicken Meal, Whole Brown Rice, Brewers Rice, Rice Bran, Lamb Meal, Salmon Meal, Whole Grain Oatmeal, Chicken Fat, Dried Plain Beet Pulp, Pea Protein, Sunflower Oil, Natural Flavor, Potassium Chloride, Flaxseed Meal, Choline Chloride, Chia Seed, Dried Coconut, Kale, Dried Pumpkin, Spinach, Blueberries, Apples, Carrots, Vitamin E, Zinc, Mixed Tocopherols'
  },
  {
    name: 'Nutrish Zero Grain Turkey & Potato',
    brand: 'Rachael Ray',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Turkey, Turkey Meal, Chickpeas, Peas, Tapioca Starch, Chicken Fat, Dried Plain Beet Pulp, Natural Chicken Flavor, Pea Fiber, Fish Meal, Salt, Potassium Chloride, Flaxseed, Vitamin E, Zinc, Iron, Dried Bacillus Coagulans Fermentation Product, Rosemary Extract'
  },
  {
    name: 'PURE Real Salmon & Sweet Potato Grain-Free',
    brand: 'Canidae',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Salmon, Salmon Meal, Menhaden Fish Meal, Sweet Potatoes, Peas, Canola Oil, Suncured Alfalfa Meal, Potatoes, Sun-Dried Tomato Pomace, Natural Flavor, Minerals, Vitamins, Fish Oil, Flaxseed, Probiotics, Mixed Tocopherols'
  },
  {
    name: 'Red Meat Recipe Grain-Free',
    brand: 'Acana',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Deboned Beef, Deboned Pork, Beef Meal, Whole Green Peas, Red Lentils, Beef Liver, Pork Liver, Herring Meal, Whole Chickpeas, Green Lentils, Pinto Beans, Beef Fat, Beef Kidney, Beef Tripe, Pork Kidney, Dried Kelp, Pumpkin, Butternut Squash, Kale, Spinach, Turnip Greens, Carrots, Apples, Pears, Freeze-Dried Beef Liver'
  },
  {
    name: 'ProActive Health Adult MiniChunks',
    brand: 'Iams',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Corn Grits, Chicken By-Product Meal, Dried Beet Pulp, Natural Flavor, Dried Egg Product, Chicken Fat, Brewers Dried Yeast, Potassium Chloride, Caramel, Salt, Fish Oil, Fructooligosaccharides, Choline Chloride, L-Carnitine, Zinc, Vitamin E, Calcium Carbonate, Rosemary Extract'
  },
  {
    name: 'ONE SmartBlend Lamb & Rice Formula',
    brand: 'Purina',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Lamb, Rice, Corn Gluten Meal, Whole Grain Corn, Oat Meal, Soybean Meal, Poultry By-Product Meal, Beef Fat, Soy Protein Concentrate, Whole Grain Wheat, Fish Meal, Animal Liver Flavor, Calcium Carbonate, Salt, Potassium Chloride, Caramel Color, Zinc, Vitamin A, Vitamin E, Vitamin D-3'
  },
  {
    name: 'Hi-Pro Plus',
    brand: 'Victor',
    product_type: 'dry_food',
    target_life_stage: 'all',
    raw_ingredients_text: 'Beef Meal, Grain Sorghum, Whole Grain Millet, Chicken Fat, Chicken Meal, Pork Meal, Fish Meal, Blood Meal, Dried Yeast, Flaxseed, Dried Tomato Pomace, Natural Flavor, Potassium Chloride, Salt, Selenium Yeast, Mineral Oil, Dried Chicory Root, Vitamin E, Zinc, Iron, Glucosamine Hydrochloride, Chondroitin Sulfate, Dried Lactobacillus Acidophilus'
  },
  {
    name: 'Science Diet Puppy Chicken & Brown Rice',
    brand: "Hill's",
    product_type: 'dry_food',
    target_life_stage: 'puppy_kitten',
    raw_ingredients_text: 'Chicken, Whole Grain Wheat, Cracked Pearled Barley, Chicken Meal, Whole Grain Corn, Chicken Fat, Soybean Meal, Dried Beet Pulp, Fish Oil, Lactic Acid, Pork Liver Flavor, Flaxseed, Iodized Salt, Potassium Chloride, Calcium Carbonate, Choline Chloride, DL-Methionine, L-Lysine, Vitamin E, Taurine, Vitamin A, Vitamin D3, Zinc, Iron, Mixed Tocopherols'
  },
  {
    name: 'Wilderness Rocky Mountain Red Meat',
    brand: 'Blue Buffalo',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Deboned Beef, Chicken Meal, Peas, Tapioca Starch, Pea Protein, Chicken Fat, Dried Tomato Pomace, Potatoes, Fish Meal, Natural Flavor, Flaxseed, Fish Oil, Salt, DL-Methionine, Potassium Chloride, Dried Chicory Root, Alfalfa Nutrient Concentrate, Pea Fiber, Blueberries, Cranberries, Taurine, Vitamin E, Vitamin A, Zinc'
  },

  // ---- WET FOOD (10) ----
  {
    name: 'Filets in Gravy Filet Mignon Flavor',
    brand: 'Cesar',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Water, Beef, Meat By-Products, Chicken, Liver, Wheat Gluten, Wheat Flour, Corn Starch, Natural Flavor, Sodium Tripolyphosphate, Salt, Carrageenan, Potassium Chloride, Guar Gum, Caramel Color, Calcium Carbonate, Erythorbic Acid, Zinc Sulfate, Vitamin E, Vitamin A, Vitamin D3'
  },
  {
    name: 'Chopped Ground Dinner Chicken',
    brand: 'Pedigree',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Water, Chicken, Meat By-Products, Wheat Gluten, Corn Starch, Soybean Meal, Natural Flavor, Sodium Tripolyphosphate, Guar Gum, Minerals, Vitamins, Salt, Potassium Chloride, Dried Yam, Carrageenan'
  },
  {
    name: 'Homestyle Recipe Chicken Dinner with Garden Vegetables',
    brand: 'Blue Buffalo',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Chicken Broth, Chicken Liver, Brown Rice, Carrots, Sweet Potatoes, Peas, Oatmeal, Flaxseed, Potassium Chloride, Salt, Guar Gum, Cassia Gum, Carrageenan, Iron Proteinate, Zinc Proteinate, Fish Oil, Vitamin E, Vitamin A, Vitamin D3, Taurine, Blueberries'
  },
  {
    name: 'CORE Grain-Free Turkey, Chicken Liver & Turkey Liver',
    brand: 'Wellness',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Turkey, Chicken Liver, Turkey Liver, Turkey Broth, Chicken, Chicken Meal, Sweet Potatoes, Chickpeas, Ground Flaxseed, Cranberries, Guar Gum, Cassia Gum, Carrageenan, Taurine, Potassium Chloride, Iron, Zinc, Vitamin E, Vitamin A, Vitamin D3'
  },
  {
    name: 'Pro Plan Savor Chicken & Rice Entrée',
    brand: 'Purina',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Water, Chicken, Rice, Liver, Meat By-Products, Wheat Gluten, Soy Flour, Corn Starch, Oat Fiber, Natural Flavor, Tricalcium Phosphate, Added Color, Salt, Guar Gum, Potassium Chloride, Carrageenan, Minerals, Vitamins'
  },
  {
    name: 'Medium Adult Loaf in Sauce',
    brand: 'Royal Canin',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Water, Pork By-Products, Chicken, Pork Liver, Chicken Liver, Wheat Gluten, Wheat Flour, Corn Starch, Powdered Cellulose, Natural Flavor, Fish Oil, Sodium Tripolyphosphate, Salt, Guar Gum, Calcium Carbonate, Carrageenan, Taurine, Vitamin E, Zinc, Iron, Vitamin A, Vitamin D3'
  },
  {
    name: 'Savory Stew Beef & Vegetables',
    brand: "Hill's Science Diet",
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Water, Beef, Chicken, Pork Liver, Carrots, Peas, Rice, Potato Starch, Corn Starch, Powdered Cellulose, Chicken Fat, Dried Beet Pulp, Fish Oil, Guar Gum, Calcium Carbonate, Salt, Potassium Chloride, Choline Chloride, Taurine, Vitamins, Minerals, Mixed Tocopherols'
  },
  {
    name: 'Hearty Stew Chunky Chicken & Turkey in Gravy',
    brand: 'Nutro',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken Broth, Chicken, Turkey, Chicken Liver, Dried Egg Product, Pea Protein, Dried Potatoes, Potato Starch, Natural Flavor, Guar Gum, Salt, Potassium Chloride, Carrageenan, Sunflower Oil, Fish Oil, Taurine, Zinc, Iron, Vitamin E, Vitamin A'
  },
  {
    name: 'Stew Lamb Rice & Barley',
    brand: "Nature's Recipe",
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Lamb Broth, Lamb, Lamb Liver, Brown Rice, Barley, Peas, Carrots, Potato Starch, Natural Flavor, Salt, Guar Gum, Potassium Chloride, Carrageenan, Zinc, Iron, Vitamin E, Vitamin A, Vitamin D3'
  },

  // ---- TREATS (17) ----
  {
    name: 'Original Dental Treats Regular',
    brand: 'Greenies',
    product_type: 'treats',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Wheat Flour, Wheat Protein Isolate, Glycerin, Gelatin, Oat Fiber, Water, Lecithin, Natural Poultry Flavor, Minerals, Dried Apple Pomace, Dried Tomato Pomace, Dried Potato Product, Potassium Sorbate, Vitamins, Choline Chloride, Parsley Flake, Turmeric Color'
  },
  {
    name: 'Blue Bits Chicken Recipe Training Treats',
    brand: 'Blue Buffalo',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken, Oatmeal, Barley, Flaxseed, Oat Flour, Dried Tomato Pomace, Oil of Rosemary, Blueberries, Cranberries, DL-Methionine, Salt, Vitamin E'
  },
  {
    name: 'Original Dog Biscuits Medium',
    brand: 'Milk-Bone',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Wheat Flour, Wheat Bran, Meat and Bone Meal, Milk, Beef Fat, Poultry By-Product Meal, Salt, Dicalcium Phosphate, Wheat Germ, BHA, Natural and Artificial Flavors, Calcium Carbonate, Vitamins, Minerals'
  },
  {
    name: 'Mini Naturals Peanut Butter & Oats',
    brand: "Zuke's",
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Peanut Butter, Ground Oats, Ground Barley, Malted Barley Extract, Chicken, Gelatin, Ground Rice, Coconut Glycerin, Phosphoric Acid, Turmeric, Rosemary Extract, Mixed Tocopherols, Vitamin E'
  },
  {
    name: 'Classic P-Nuttier Biscuits',
    brand: 'Old Mother Hubbard',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Whole Wheat Flour, Peanuts, Oatmeal, Corn Meal, Chicken Fat, Peanut Butter, Cane Molasses, Apples, Carrots, Mixed Tocopherols, Rosemary Extract'
  },
  {
    name: 'Busy Bone Original Long-Lasting Chew',
    brand: 'Purina',
    product_type: 'treats',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Wheat Flour, Glycerin, Chicken, Wheat Gluten, Chicken By-Product Meal, Rice, Soy Flour, Sugar, Calcium Carbonate, Natural Flavor, Phosphoric Acid, Salt, Sorbic Acid, Dried Cheese, Added Color, BHA'
  },
  {
    name: 'Kitchen Crafted Chicken Jerky',
    brand: 'Full Moon',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken, Organic Cane Sugar, Vinegar, Rosemary Extract'
  },
  {
    name: 'Wilderness Trail Treats Turkey Biscuits',
    brand: 'Blue Buffalo',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Turkey, Turkey Meal, Peas, Tapioca Starch, Flaxseed, Pea Protein, Chicken Fat, Dried Tomato Pomace, Potassium Chloride, Salt, DL-Methionine, Blueberries, Cranberries, Mixed Tocopherols'
  },
  {
    name: 'Natural Dental Chews Original',
    brand: 'Whimzees',
    product_type: 'treats',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Potato Starch, Glycerin, Powdered Cellulose, Lecithin, Dried Yeast, Malt Extract, Sweet Lupine Meal, Annatto Extract Color'
  },
  {
    name: 'Soft Puppy Bites Lamb & Salmon',
    brand: 'Wellness',
    product_type: 'treats',
    target_life_stage: 'puppy_kitten',
    raw_ingredients_text: 'Lamb, Salmon, Chickpeas, Potatoes, Pea Protein, Chicken Fat, Dried Ground Potatoes, Flaxseed, Natural Flavor, Mixed Tocopherols, Rosemary Extract, Vitamin E, Zinc'
  },
  {
    name: 'Skinny Minis Apple Bacon',
    brand: 'Fruitables',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Dried Apples, Pea Flour, Chickpea Flour, Pea Protein, Glycerin, Tapioca Starch, Bacon, Natural Flavor, Coconut Oil, Apple Juice Concentrate, Cinnamon, Citric Acid, Mixed Tocopherols'
  },
  {
    name: "Lick'n Crunch Sandwich Cookies Golden & Vanilla",
    brand: 'Three Dog Bakery',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Rice Flour, Cane Sugar, Vegetable Glycerin, Palm Oil, Dried Egg Product, Oat Flour, Natural Vanilla Flavor, Pea Protein, Salt, Soy Lecithin, Calcium Carbonate, Mixed Tocopherols'
  },
  {
    name: 'Soft & Chewy Peanut Butter',
    brand: 'Buddy Biscuits',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Oat Flour, Peanut Butter, Vegetable Glycerin, Rice Flour, Cane Molasses, Tapioca Starch, Canola Oil, Flaxseed, Natural Flavor, Soy Lecithin, Phosphoric Acid, Mixed Tocopherols, Rosemary Extract'
  },
  {
    name: 'Gourmet Jerky Sticks Chicken',
    brand: 'Rocco & Roxie',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken Breast, Vegetable Glycerin, Cane Sugar, Natural Smoke Flavor, Citric Acid, Rosemary Extract, Mixed Tocopherols'
  },
  {
    name: 'Tricky Trainers Cheddar Flavor',
    brand: 'Cloud Star',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken, Chicken Meal, Oat Flour, Barley Flour, Cheddar Cheese, Oat Fiber, Canola Oil, Natural Flavor, Salt, Vinegar, Citric Acid, Rosemary Extract, Mixed Tocopherols'
  },
  {
    name: 'Minies Dental Treats',
    brand: "Minties",
    product_type: 'treats',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Rice Flour, Glycerin, Gelatin, Calcium Sulfate, Natural Peppermint Oil, Dicalcium Phosphate, Dried Parsley, Natural Flavor, Chlorophyll'
  },

  // ---- SUPPLEMENTS (5) ----
  {
    name: 'Multivitamin Bites for Dogs',
    brand: 'Zesty Paws',
    product_type: 'supplement',
    target_life_stage: 'all',
    raw_ingredients_text: 'Organic Chicken Flavor, Biotin, Vitamin A, Vitamin C, Vitamin D3, Vitamin E, Niacin, Folic Acid, CoQ10, Fish Oil, Cod Liver Oil, Glucosamine, Chondroitin, Pumpkin, Probiotics, Flaxseed, Rosemary Extract'
  },
  {
    name: 'Cosequin DS Plus MSM Joint Supplement',
    brand: 'Nutramax',
    product_type: 'supplement',
    target_life_stage: 'senior',
    raw_ingredients_text: 'Glucosamine Hydrochloride, Sodium Chondroitin Sulfate, Methylsulfonylmethane (MSM), Manganese Ascorbate, Chicken Flavor, Whey, Microcrystalline Cellulose, Silicon Dioxide, Magnesium Stearate'
  },
  {
    name: '10-in-1 Multivitamin',
    brand: 'PetHonesty',
    product_type: 'supplement',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Glucosamine, Fish Oil, Probiotics, Pumpkin, Vitamin E, Organic Turmeric, Coconut Oil, Organic Kelp, Biotin, Zinc, Mixed Tocopherols, Chicken Flavor'
  },
  {
    name: 'Omega-3 Pet Fish Oil Supplement',
    brand: 'Nordic Naturals',
    product_type: 'supplement',
    target_life_stage: 'all',
    raw_ingredients_text: 'Purified Fish Oil (from Anchovies and Sardines), Soft Gel Capsule (Bovine Gelatin, Glycerin, Water), d-Alpha Tocopherol, Rosemary Extract'
  },
  {
    name: 'GlycoFlex Plus Joint Support',
    brand: 'VetriScience',
    product_type: 'supplement',
    target_life_stage: 'senior',
    raw_ingredients_text: 'Glucosamine Hydrochloride, Perna Canaliculus (Green Lipped Mussel), Dimethylglycine, MSM, Grape Seed Extract, Manganese, Vitamin C, Chicken Liver Flavor, Brewer Yeast'
  },

  // ---- SENIOR (2) ----
  {
    name: 'Life Protection Formula Senior Chicken & Brown Rice',
    brand: 'Blue Buffalo',
    product_type: 'dry_food',
    target_life_stage: 'senior',
    raw_ingredients_text: 'Deboned Chicken, Chicken Meal, Brown Rice, Oatmeal, Barley, Peas, Pea Protein, Chicken Fat, Flaxseed, Tomato Pomace, Potatoes, Fish Meal, Natural Flavor, Potato Starch, Fish Oil, L-Carnitine, Glucosamine, Chondroitin, Blueberries, Cranberries, Kelp, Taurine, Vitamin E, Vitamin A, Zinc'
  },
  {
    name: 'Pro Plan Focus Puppy Chicken & Rice',
    brand: 'Purina',
    product_type: 'dry_food',
    target_life_stage: 'puppy_kitten',
    raw_ingredients_text: 'Chicken, Rice, Poultry By-Product Meal, Corn Gluten Meal, Whole Grain Corn, Oat Meal, Fish Meal, Animal Fat, Fish Oil, Calcium Carbonate, Phosphoric Acid, Animal Digest, Salt, Dried Egg Product, Potassium Chloride, L-Lysine, Vitamin A, Vitamin E, Vitamin D-3, Zinc, DHA'
  },
];

// =============================================
// 50 CAT PRODUCTS
// =============================================
const catProducts = [
  // ---- DRY FOOD (18) ----
  {
    name: 'Indoor Health Adult Chicken & Brown Rice',
    brand: 'Blue Buffalo',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Deboned Chicken, Chicken Meal, Brown Rice, Oatmeal, Barley, Pea Protein, Chicken Fat, Dried Tomato Pomace, Natural Flavor, Flaxseed, Fish Meal, Fish Oil, Cranberries, Blueberries, Taurine, L-Carnitine, Potassium Chloride, Salt, Vitamin E, Vitamin A, Zinc, Iron'
  },
  {
    name: 'Pro Plan Savor Adult Chicken & Rice',
    brand: 'Purina',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Rice, Corn Gluten Meal, Poultry By-Product Meal, Soy Flour, Wheat Flour, Beef Fat, Fish Meal, Liver Flavor, Phosphoric Acid, Potassium Chloride, Calcium Carbonate, Salt, Choline Chloride, Taurine, Zinc, Vitamin E, Vitamin A, Vitamin D-3'
  },
  {
    name: 'Science Diet Indoor Adult Chicken',
    brand: "Hill's",
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Whole Grain Wheat, Corn Gluten Meal, Whole Grain Corn, Chicken Meal, Pork Fat, Chicken Liver Flavor, Powdered Cellulose, Dried Beet Pulp, Lactic Acid, Soybean Oil, Fish Oil, L-Lysine, Iodized Salt, Potassium Chloride, Choline Chloride, Taurine, DL-Methionine, Vitamin E, Vitamin A, Vitamin D3, Zinc, Mixed Tocopherols'
  },
  {
    name: 'Indoor Adult',
    brand: 'Royal Canin',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken By-Product Meal, Corn, Brewers Rice, Wheat Gluten, Corn Gluten Meal, Chicken Fat, Natural Flavors, Wheat, Powdered Cellulose, Dried Plain Beet Pulp, Fish Oil, Vegetable Oil, Potassium Chloride, Fructooligosaccharides, Salt, Calcium Carbonate, Taurine, DL-Methionine, Choline Chloride, Vitamins, Minerals, Rosemary Extract'
  },
  {
    name: 'Cat & Kitten',
    brand: 'Orijen',
    product_type: 'dry_food',
    target_life_stage: 'all',
    raw_ingredients_text: 'Deboned Chicken, Deboned Turkey, Whole Atlantic Flounder, Whole Eggs, Whole Atlantic Mackerel, Chicken Liver, Turkey Liver, Chicken Heart, Turkey Heart, Whole Atlantic Herring, Dehydrated Chicken, Dehydrated Turkey, Dehydrated Mackerel, Whole Green Peas, Whole Red Lentils, Whole Chickpeas, Chicken Fat, Whole Pinto Beans, Whole Navy Beans, Herring Oil, Lentil Fiber, Chicken Necks, Pumpkin, Butternut Squash, Kale, Spinach, Turnip Greens, Carrots, Apples, Pears, Freeze-Dried Chicken Liver, Freeze-Dried Turkey Liver, Taurine'
  },
  {
    name: 'Canyon River Trout & Salmon',
    brand: 'Taste of the Wild',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Trout, Ocean Fish Meal, Sweet Potatoes, Potatoes, Peas, Canola Oil, Smoked Salmon, Potato Protein, Roasted Venison, Tomato Pomace, Potato Fiber, Natural Flavor, Salt, Choline Chloride, Dried Chicory Root, Taurine, Tomatoes, Blueberries, Raspberries, Dried Lactobacillus Plantarum, Zinc, Vitamin E, Vitamin A'
  },
  {
    name: 'Complete Health Indoor Health Deboned Chicken',
    brand: 'Wellness',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Deboned Chicken, Chicken Meal, Rice, Ground Barley, Chicken Fat, Tomato Pomace, Peas, Oatmeal, Ground Flaxseed, Salmon Meal, Natural Chicken Flavor, Cranberries, Chicory Root Extract, Taurine, Potassium Chloride, Choline Chloride, Salt, Vitamin E, Vitamin A, Zinc, Iron, Mixed Tocopherols'
  },
  {
    name: 'Purrfect Bistro Grain-Free Real Chicken',
    brand: 'Merrick',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Deboned Chicken, Chicken Meal, Sweet Potatoes, Peas, Turkey Meal, Potato Protein, Chicken Fat, Pea Protein, Natural Flavor, Salmon Meal, Flaxseed, Salmon Oil, Taurine, Blueberries, Cranberries, Apples, Salt, Potassium Chloride, Minerals, Vitamins, Mixed Tocopherols, Rosemary Extract'
  },
  {
    name: 'Wholesome Essentials Indoor Adult Chicken & Brown Rice',
    brand: 'Nutro',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Chicken Meal, Whole Brown Rice, Peas, Brewers Rice, Pea Protein, Chicken Fat, Rice Bran, Natural Flavor, Dried Plain Beet Pulp, Potassium Chloride, Fish Oil, Salt, Choline Chloride, Taurine, DL-Methionine, Zinc, Vitamin E, Iron, Mixed Tocopherols, Rosemary Extract'
  },
  {
    name: 'Nutrish Indoor Complete Chicken with Lentils & Salmon',
    brand: 'Rachael Ray',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Chicken Meal, Lentils, Peas, Chicken Fat, Salmon, Dried Plain Beet Pulp, Pea Protein, Natural Flavor, Flaxseed, Dried Chicory Root, Potassium Chloride, Salt, Taurine, Zinc, Vitamin E, Vitamin A, Rosemary Extract'
  },
  {
    name: 'ProActive Health Indoor Weight & Hairball Care',
    brand: 'Iams',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Corn Grits, Chicken By-Product Meal, Corn Gluten Meal, Dried Beet Pulp, Powdered Cellulose, Natural Flavor, Dried Egg Product, Chicken Fat, Fish Oil, Fructooligosaccharides, Potassium Chloride, DL-Methionine, Choline Chloride, Salt, Taurine, L-Carnitine, Zinc, Vitamin E, Rosemary Extract'
  },
  {
    name: 'Wilderness Indoor Chicken',
    brand: 'Blue Buffalo',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Deboned Chicken, Chicken Meal, Peas, Pea Protein, Tapioca Starch, Chicken Fat, Menhaden Fish Meal, Flaxseed, Dried Tomato Pomace, Natural Flavor, Fish Oil, Potassium Chloride, Salt, Taurine, DL-Methionine, L-Carnitine, Blueberries, Cranberries, Kelp, Yucca Schidigera Extract, Vitamin E, Zinc'
  },
  {
    name: 'ONE Indoor Advantage Hairball & Weight Management',
    brand: 'Purina',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Turkey, Corn Gluten Meal, Soybean Meal, Brewers Rice, Soy Protein Concentrate, Poultry By-Product Meal, Wheat Flour, Rice, Corn, Animal Fat, Powdered Cellulose, Natural Flavor, Phosphoric Acid, Calcium Carbonate, Potassium Chloride, Salt, Choline Chloride, Taurine, Zinc, Vitamin E, Vitamin A'
  },
  {
    name: 'Science Diet Kitten Chicken Recipe',
    brand: "Hill's",
    product_type: 'dry_food',
    target_life_stage: 'puppy_kitten',
    raw_ingredients_text: 'Chicken, Whole Grain Wheat, Chicken Meal, Corn Gluten Meal, Chicken Fat, Whole Grain Corn, Pork Liver Flavor, Soybean Oil, Fish Oil, Lactic Acid, Dried Beet Pulp, Potassium Chloride, Iodized Salt, Choline Chloride, Taurine, DL-Methionine, Vitamin E, Vitamin A, Vitamin D3, Zinc, Iron, Mixed Tocopherols, DHA'
  },
  {
    name: 'Indoor Entrée',
    brand: 'Acana',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Deboned Chicken, Chicken Meal, Whole Green Peas, Whole Red Lentils, Turkey Meal, Chicken Fat, Chicken Liver, Herring Meal, Green Lentils, Whole Chickpeas, Turkey Liver, Whole Pinto Beans, Pumpkin, Butternut Squash, Kale, Spinach, Carrots, Apples, Cranberries, Blueberries, Taurine, Freeze-Dried Chicken Liver'
  },
  {
    name: 'L.I.D. Green Pea & Duck',
    brand: 'Natural Balance',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Green Peas, Duck Meal, Duck, Canola Oil, Pea Fiber, Natural Flavor, Salmon Oil, Taurine, DL-Methionine, Potassium Chloride, Calcium Carbonate, Salt, Choline Chloride, Zinc, Vitamin E, Iron, Vitamin A, Vitamin D3, Mixed Tocopherols'
  },
  {
    name: 'Original Grain-Free Chicken',
    brand: 'Instinct',
    product_type: 'dry_food',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken, Turkey Meal, Chicken Meal, Chicken Fat, Menhaden Fish Meal, Peas, Tapioca, Chicken Eggs, Tomato Pomace, Montmorillonite Clay, Natural Flavor, Salmon Oil, Potassium Chloride, Salt, Cranberries, Blueberries, Coconut Oil, Freeze-Dried Chicken, Taurine, DL-Methionine, Choline Chloride, Zinc, Vitamin E, Iron'
  },
  {
    name: 'PURE Indoor Cat Salmon & Sweet Potato',
    brand: 'Canidae',
    product_type: 'dry_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Salmon, Menhaden Fish Meal, Sweet Potatoes, Chicken Meal, Peas, Chicken Fat, Potatoes, Suncured Alfalfa, Natural Flavor, Salmon Oil, Taurine, Potassium Chloride, Salt, Zinc, Vitamin E, Iron, Mixed Tocopherols'
  },

  // ---- WET FOOD (17) ----
  {
    name: 'Classic Paté Tender Beef & Chicken Feast',
    brand: 'Fancy Feast',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Beef, Meat By-Products, Chicken, Poultry By-Products, Liver, Fish, Water, Corn Starch, Artificial and Natural Flavors, Soy Flour, Salt, Guar Gum, Potassium Chloride, Added Color, Taurine, Vitamins, Minerals'
  },
  {
    name: 'Perfect Portions Salmon in Paté',
    brand: 'Sheba',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Salmon, Meat By-Products, Chicken, Water, Wheat Gluten, Corn Starch, Natural Flavor, Minerals, Guar Gum, Salt, Taurine, Potassium Chloride, Vitamins, Dried Yam'
  },
  {
    name: 'Tastefuls Adult Chicken Entrée',
    brand: 'Blue Buffalo',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Chicken Broth, Chicken Liver, Pea Protein, Flaxseed, Guar Gum, Potassium Chloride, Salt, Carrageenan, Cassia Gum, Fish Oil, Taurine, Cranberries, Vitamin E, Vitamin A, Zinc, Iron'
  },
  {
    name: 'Pro Plan Chicken & Cheese Entrée in Gravy',
    brand: 'Purina',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Water, Chicken, Liver, Wheat Gluten, Meat By-Products, Rice, Corn Starch, Cheese, Soy Flour, Fish, Natural and Artificial Flavor, Tricalcium Phosphate, Added Color, Guar Gum, Salt, Potassium Chloride, Carrageenan, Taurine, Minerals, Vitamins'
  },
  {
    name: 'Feline Health Nutrition Adult Instinctive Loaf in Sauce',
    brand: 'Royal Canin',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Water, Pork By-Products, Chicken By-Products, Chicken, Chicken Liver, Wheat Gluten, Corn Starch, Wheat Flour, Powdered Cellulose, Natural Flavor, Fish Oil, Carrageenan, Guar Gum, Sodium Tripolyphosphate, Salt, Taurine, Vitamins, Minerals'
  },
  {
    name: 'Science Diet Adult Savory Chicken Entrée',
    brand: "Hill's",
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Water, Chicken, Pork Liver, Chicken Liver, Corn Starch, Chicken Fat, Whole Grain Wheat Flour, Rice, Dried Beet Pulp, Guar Gum, Fish Oil, Potassium Chloride, Calcium Carbonate, Taurine, Salt, Choline Chloride, Vitamins, Minerals, Mixed Tocopherols'
  },
  {
    name: 'CORE Grain-Free Turkey & Duck Paté',
    brand: 'Wellness',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Turkey, Turkey Broth, Chicken Liver, Duck, Chicken Meal, Cranberries, Ground Flaxseed, Guar Gum, Cassia Gum, Potassium Chloride, Taurine, Choline Chloride, Salt, Iron Proteinate, Zinc Proteinate, Vitamin E, Vitamin A, Vitamin D3'
  },
  {
    name: 'Purrfect Bistro Grain-Free Cowboy Cookout',
    brand: 'Merrick',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Beef, Beef Broth, Beef Liver, Chicken, Chicken Liver, Dried Egg Product, Pea Protein, Flaxseed, Natural Flavor, Guar Gum, Potassium Chloride, Salt, Cassia Gum, Taurine, Carrageenan, Iron, Zinc, Vitamin E, Vitamin A'
  },
  {
    name: 'Luau Ahi Tuna & Chicken in Paté',
    brand: 'Tiki Cat',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Tuna, Chicken, Chicken Broth, Sunflower Oil, Tricalcium Phosphate, Taurine, Choline Chloride, Salt, Vitamin E, Vitamin A, Zinc, Iron'
  },
  {
    name: 'Cats in the Kitchen Love Me Tender Chicken',
    brand: 'Weruva',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken Breast, Chicken Broth, Chicken Liver, Gelatin, Sunflower Oil, Potassium Chloride, Taurine, Choline Chloride, Salt, Vitamin E, Zinc, Iron, Vitamin A, Vitamin D3'
  },
  {
    name: 'Shreds Turkey & Cheese Dinner',
    brand: 'Friskies',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Water, Meat By-Products, Poultry By-Products, Turkey, Wheat Gluten, Liver, Chicken, Cheese, Corn Starch, Soy Flour, Natural and Artificial Flavors, Salt, Phosphoric Acid, Added Color, Potassium Chloride, Guar Gum, Taurine, Minerals, Vitamins'
  },
  {
    name: 'Medleys Shredded Fare Collection Turkey',
    brand: 'Fancy Feast',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Turkey Broth, Turkey, Chicken, Liver, Meat By-Products, Wheat Gluten, Rice, Corn Starch, Spinach, Natural Flavor, Guar Gum, Potassium Chloride, Tricalcium Phosphate, Salt, Taurine, Added Color, Vitamins, Minerals'
  },
  {
    name: 'Perfect Portions Grain-Free Salmon & Tuna Paté',
    brand: 'Nutro',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Salmon, Tuna, Chicken Liver, Chicken Broth, Natural Flavor, Guar Gum, Potassium Chloride, Salt, Cassia Gum, Carrageenan, Taurine, Choline Chloride, Zinc, Iron, Vitamin E, Vitamin A'
  },
  {
    name: 'Tastefuls Kitten Chicken Entrée',
    brand: 'Blue Buffalo',
    product_type: 'wet_food',
    target_life_stage: 'puppy_kitten',
    raw_ingredients_text: 'Chicken, Chicken Broth, Chicken Liver, Fish Oil, Flaxseed, Pea Protein, Guar Gum, Potassium Chloride, Salt, Carrageenan, Cassia Gum, Taurine, DHA, Cranberries, Vitamin E, Vitamin A, Zinc, Iron'
  },
  {
    name: 'Grain-Free Chicken in Broth',
    brand: "Nature's Recipe",
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Chicken Broth, Chicken Liver, Dried Egg Product, Guar Gum, Potassium Chloride, Salt, Taurine, Cassia Gum, Carrageenan, Zinc, Iron, Vitamin E, Vitamin A, Vitamin D3'
  },
  {
    name: 'Original Grain-Free Real Chicken Paté',
    brand: 'Instinct',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Chicken, Chicken Liver, Chicken Broth, Ground Flaxseed, Montmorillonite Clay, Peas, Potassium Chloride, Cassia Gum, Salt, Guar Gum, Choline Chloride, Taurine, Fish Oil, Artichokes, Cranberries, Pumpkin, Tomato, Blueberries, Broccoli, Cabbage, Kale, Parsley, Zinc, Iron, Vitamin E, Vitamin A'
  },
  {
    name: 'Natural Tuna Fillet with Prawn',
    brand: 'Applaws',
    product_type: 'wet_food',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Tuna Fillet, Prawn, Fish Broth, Rice'
  },

  // ---- TREATS (12) ----
  {
    name: 'Classic Crunchy & Soft Tasty Chicken Treats',
    brand: 'Temptations',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken By-Product Meal, Ground Corn, Animal Fat, Brewers Rice, Wheat Flour, Dried Meat By-Products, Natural Flavor, Potassium Chloride, Choline Chloride, Salt, Sulfur, DL-Methionine, Taurine, Yellow 5, Red 40, Blue 1, Yellow 6, Titanium Dioxide, Vitamins, Minerals'
  },
  {
    name: 'Feline Dental Treats Tuna',
    brand: 'Greenies',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken Meal, Wheat Flour, Wheat Protein Isolate, Glycerin, Gelatin, Oat Fiber, Tuna Flavor, Natural Poultry Flavor, Dried Potato Product, Potassium Sorbate, Choline Chloride, Vitamins, Minerals, Taurine, DL-Methionine'
  },
  {
    name: 'Kitty Yums Savory Chicken Cat Treats',
    brand: 'Blue Buffalo',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken, Oatmeal, Brown Rice, Flaxseed, Oil of Rosemary, Barley, DL-Methionine, Salt, Taurine, Vitamin E'
  },
  {
    name: 'Kittles Crunchy Salmon & Cranberries',
    brand: 'Wellness',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Salmon, Salmon Meal, Dried Cranberries, Chicken Meal, Chickpeas, Chicken Fat, Turkey Meal, Potato Starch, Natural Flavor, Flaxseed, Salt, Taurine, Mixed Tocopherols, Rosemary Extract'
  },
  {
    name: 'Party Mix Original Crunch',
    brand: 'Friskies',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken By-Product Meal, Wheat Flour, Corn, Animal Fat, Corn Gluten Meal, Soybean Meal, Brewers Dried Yeast, Cheese, Turkey By-Product Meal, Glycerin, Salt, Natural and Artificial Flavors, Phosphoric Acid, Potassium Chloride, Sulfur, DL-Methionine, Added Color, Taurine, Vitamins, Minerals'
  },
  {
    name: 'Squeeze Up Tuna',
    brand: 'Delectables',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Tuna, Water, Chicken Liver, Modified Tapioca Starch, Natural Flavor, Taurine, Vitamin E, Green Tea Extract'
  },
  {
    name: 'Savory Cravings Beef & Crab',
    brand: 'Fancy Feast',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken By-Product Meal, Wheat Flour, Corn Gluten Meal, Animal Fat, Beef, Crab, Brewers Dried Yeast, Glycerin, Natural and Artificial Flavors, Salt, Potassium Chloride, Phosphoric Acid, DL-Methionine, Taurine, Added Color, Vitamins, Minerals'
  },
  {
    name: 'Stew Lickable Treat Tuna & Whitefish',
    brand: 'Hartz Delectables',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Water, Tuna, Whitefish, Modified Tapioca Starch, Natural Flavor, Guar Gum, Vitamin E, Taurine, Green Tea Extract'
  },
  {
    name: 'Freeze-Dried Chicken Breast Cat Treats',
    brand: 'Whole Hearted',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken Breast'
  },
  {
    name: 'Wilderness Crunchy Cat Treats Chicken',
    brand: 'Blue Buffalo',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken Meal, Tapioca Starch, Pea Protein, Chicken Fat, Dried Tomato Pomace, Natural Flavor, Flaxseed, Salt, DL-Methionine, Taurine, Blueberries, Cranberries, Vitamin E, Mixed Tocopherols'
  },
  {
    name: 'Churu Chicken Puree',
    brand: 'Inaba',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Chicken, Water, Tapioca Starch, Taurine, Vitamin E, Green Tea Extract'
  },
  {
    name: 'Freeze-Dried Salmon Cat Treats',
    brand: 'PureBites',
    product_type: 'treats',
    target_life_stage: 'all',
    raw_ingredients_text: 'Wild Pacific Salmon'
  },

  // ---- SUPPLEMENTS (3) ----
  {
    name: 'Nu Cat Senior Multivitamin',
    brand: 'VetriScience',
    product_type: 'supplement',
    target_life_stage: 'senior',
    raw_ingredients_text: 'Taurine, L-Lysine, Fish Oil, Vitamin A, Vitamin D3, Vitamin E, Vitamin C, Biotin, Folic Acid, Niacin, Zinc, Iron, Copper, Manganese, Selenium, Chicken Liver Flavor, Brewer Yeast, Microcrystalline Cellulose'
  },
  {
    name: 'Calming Care Probiotic Supplement',
    brand: 'Purina Pro Plan',
    product_type: 'supplement',
    target_life_stage: 'adult',
    raw_ingredients_text: 'Bifidobacterium Longum, Liver Flavor, Maltodextrin, Corn Starch, Sodium Copper Chlorophyllin, Brewers Dried Yeast, Silicon Dioxide'
  },
  {
    name: 'Dasuquin Joint Health Supplement for Cats',
    brand: 'Nutramax',
    product_type: 'supplement',
    target_life_stage: 'senior',
    raw_ingredients_text: 'Glucosamine Hydrochloride, Sodium Chondroitin Sulfate, Avocado/Soybean Unsaponifiables, Manganese Ascorbate, Chicken Liver Flavor, Microcrystalline Cellulose, Silicon Dioxide'
  }
];

// =============================================
// MAIN SEED FUNCTION
// =============================================
const seedProducts = async () => {
  let connection;

  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'petfood_analyzer'
    });

    console.log('🔌 Connected to database');

    // Clear existing products (optional - comment out if you want to keep existing data)
    console.log('🗑️  Clearing existing product data...');
    await connection.execute('DELETE FROM product_ingredients');
    await connection.execute('DELETE FROM product_alternatives');
    await connection.execute('DELETE FROM products WHERE source = "database"');

    // Keep the anonymous user
    await connection.execute(
      `INSERT INTO users (id, email, password_hash, name) 
       VALUES ('anonymous', 'anonymous@local', 'no-password', 'Anonymous User')
       ON DUPLICATE KEY UPDATE name = 'Anonymous User'`
    );

    // Insert DOG products
    console.log('\n🐕 Seeding 50 DOG products...');
    let dogCount = 0;
    for (const product of dogProducts) {
      const id = uuidv4();
      const ingredientHash = generateIngredientHash(product.raw_ingredients_text);

      try {
        await connection.execute(
          `INSERT INTO products 
           (id, name, brand, product_type, target_pet_type, target_life_stage, raw_ingredients_text, ingredient_hash, source, scan_count)
           VALUES (?, ?, ?, ?, 'dog', ?, ?, ?, 'database', ?)`,
          [
            id,
            product.name,
            product.brand,
            product.product_type,
            product.target_life_stage,
            product.raw_ingredients_text,
            ingredientHash,
            Math.floor(Math.random() * 200) + 10
          ]
        );
        dogCount++;

        // Also insert parsed ingredients
        const ingredients = product.raw_ingredients_text.split(',').map(i => i.trim()).filter(Boolean);
        for (let pos = 0; pos < ingredients.length; pos++) {
          await connection.execute(
            `INSERT INTO product_ingredients (id, product_id, raw_name, position) VALUES (?, ?, ?, ?)`,
            [uuidv4(), id, ingredients[pos], pos + 1]
          );
        }
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          console.log(`  ⚠️  Skipping duplicate: ${product.brand} - ${product.name}`);
        } else {
          throw err;
        }
      }
    }
    console.log(`  ✅ Inserted ${dogCount} dog products`);

    // Insert CAT products
    console.log('\n🐈 Seeding 50 CAT products...');
    let catCount = 0;
    for (const product of catProducts) {
      const id = uuidv4();
      const ingredientHash = generateIngredientHash(product.raw_ingredients_text);

      try {
        await connection.execute(
          `INSERT INTO products 
           (id, name, brand, product_type, target_pet_type, target_life_stage, raw_ingredients_text, ingredient_hash, source, scan_count)
           VALUES (?, ?, ?, ?, 'cat', ?, ?, ?, 'database', ?)`,
          [
            id,
            product.name,
            product.brand,
            product.product_type,
            product.target_life_stage,
            product.raw_ingredients_text,
            ingredientHash,
            Math.floor(Math.random() * 200) + 10
          ]
        );
        catCount++;

        // Also insert parsed ingredients
        const ingredients = product.raw_ingredients_text.split(',').map(i => i.trim()).filter(Boolean);
        for (let pos = 0; pos < ingredients.length; pos++) {
          await connection.execute(
            `INSERT INTO product_ingredients (id, product_id, raw_name, position) VALUES (?, ?, ?, ?)`,
            [uuidv4(), id, ingredients[pos], pos + 1]
          );
        }
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          console.log(`  ⚠️  Skipping duplicate: ${product.brand} - ${product.name}`);
        } else {
          throw err;
        }
      }
    }
    console.log(`  ✅ Inserted ${catCount} cat products`);

    // Summary
    const [total] = await connection.execute('SELECT COUNT(*) as c FROM products');
    const [dogs] = await connection.execute("SELECT COUNT(*) as c FROM products WHERE target_pet_type = 'dog'");
    const [cats] = await connection.execute("SELECT COUNT(*) as c FROM products WHERE target_pet_type = 'cat'");
    const [ingredients] = await connection.execute('SELECT COUNT(*) as c FROM product_ingredients');

    console.log('\n📊 SEED SUMMARY:');
    console.log(`  Total products: ${total[0].c}`);
    console.log(`  Dog products: ${dogs[0].c}`);
    console.log(`  Cat products: ${cats[0].c}`);
    console.log(`  Total ingredient entries: ${ingredients[0].c}`);

    // Show breakdown by type
    const [byType] = await connection.execute(
      `SELECT target_pet_type, product_type, COUNT(*) as c 
       FROM products 
       GROUP BY target_pet_type, product_type 
       ORDER BY target_pet_type, product_type`
    );
    console.log('\n📋 BY TYPE:');
    byType.forEach(r => console.log(`  ${r.target_pet_type} / ${r.product_type}: ${r.c}`));

    // Show breakdown by life stage
    const [byStage] = await connection.execute(
      `SELECT target_pet_type, target_life_stage, COUNT(*) as c 
       FROM products 
       GROUP BY target_pet_type, target_life_stage 
       ORDER BY target_pet_type, target_life_stage`
    );
    console.log('\n🎯 BY LIFE STAGE:');
    byStage.forEach(r => console.log(`  ${r.target_pet_type} / ${r.target_life_stage}: ${r.c}`));

    console.log('\n🎉 Database seeding completed!');

  } catch (error) {
    console.error('❌ Seeding failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
};

seedProducts();

