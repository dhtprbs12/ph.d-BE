/**
 * Comprehensive Pet Food Ingredient List
 * 
 * Sources:
 * 1. AAFCO Official Publication Defined Ingredients (~800 entries)
 * 2. Our 100 seeded products (real-label names, ~350 entries)
 * 3. Common whole-food & processed names found on real Petco/Chewy/PetSmart labels
 * 
 * This list is used to pre-populate the ai_assessment_cache so that
 * ingredient lookups are instant instead of requiring real-time AI calls.
 */

// =============================================
// PROTEINS - Whole & Named Meats
// =============================================
const PROTEINS_WHOLE = [
  // Chicken
  'Chicken', 'Deboned Chicken', 'Chicken Meal', 'Chicken Fat', 'Chicken Liver',
  'Chicken Heart', 'Chicken Gizzard', 'Chicken Cartilage', 'Chicken Necks',
  'Chicken Breast', 'Chicken Thigh', 'Chicken Broth', 'Chicken Eggs',
  'Dehydrated Chicken', 'Freeze-Dried Chicken', 'Freeze-Dried Chicken Liver',
  'Chicken By-Product Meal', 'Chicken By-Products', 'Chicken Flavor',
  'Chicken Liver Flavor', 'Natural Chicken Flavor', 'Organic Chicken Flavor',
  'Chicken Skin',
  
  // Turkey
  'Turkey', 'Deboned Turkey', 'Turkey Meal', 'Turkey Liver', 'Turkey Heart',
  'Turkey Gizzard', 'Turkey Broth', 'Turkey By-Product Meal',
  'Dehydrated Turkey', 'Freeze-Dried Turkey Liver', 'Turkey Necks',
  
  // Beef
  'Beef', 'Deboned Beef', 'Beef Meal', 'Beef Fat', 'Beef Liver',
  'Beef Heart', 'Beef Kidney', 'Beef Tripe', 'Beef Broth', 'Beef Lung',
  'Freeze-Dried Beef Liver', 'Beef Flavor', 'Beef Tallow',
  'Beef By-Products', 'Beef By-Product Meal',
  
  // Lamb
  'Lamb', 'Deboned Lamb', 'Lamb Meal', 'Lamb Liver', 'Lamb Heart',
  'Lamb Broth', 'Lamb Fat', 'Lamb Lung', 'New Zealand Lamb',
  'Lamb By-Products', 'Lamb By-Product Meal',
  
  // Pork
  'Pork', 'Deboned Pork', 'Pork Meal', 'Pork Fat', 'Pork Liver',
  'Pork Kidney', 'Pork Heart', 'Pork Broth', 'Pork By-Products',
  'Pork Liver Flavor', 'Bacon', 'Pork Plasma',
  
  // Duck
  'Duck', 'Deboned Duck', 'Duck Meal', 'Duck Liver', 'Duck Fat',
  'Duck Broth', 'Duck Heart', 'Duck By-Products', 'Duck By-Product Meal',
  
  // Venison / Game
  'Venison', 'Venison Meal', 'Roasted Venison', 'Venison Liver',
  'Bison', 'Bison Meal', 'Roasted Bison', 'Buffalo',
  'Rabbit', 'Rabbit Meal', 'Rabbit Liver',
  'Elk', 'Elk Meal',
  'Wild Boar', 'Wild Boar Meal',
  'Kangaroo', 'Kangaroo Meal',
  'Goat', 'Goat Meal', 'Goat Liver',
  'Pheasant', 'Quail',
  
  // Generic/Mixed Meat
  'Meat', 'Meat Meal', 'Meat and Bone Meal', 'Meat By-Products',
  'Dried Meat By-Products', 'Meat Meal Tankage', 'Meat Protein Isolate',
  'Animal Digest', 'Animal Fat', 'Animal Liver', 'Animal Liver Flavor',
  'Poultry', 'Poultry Meal', 'Poultry By-Product Meal', 'Poultry By-Products',
  'Poultry Fat', 'Natural Poultry Flavor', 'Hydrolyzed Whole Poultry',
  'Hydrolyzed Poultry Feathers', 'Hydrolyzed Poultry By-Products Aggregate',
  'Blood Meal', 'Blood Meal Flash Dried', 'Blood Protein',
  'Liver', 'Liver Flavor',
];

// =============================================
// PROTEINS - Fish & Seafood
// =============================================
const PROTEINS_FISH = [
  // Salmon
  'Salmon', 'Deboned Salmon', 'Salmon Meal', 'Salmon Oil', 'Salmon Liver Oil',
  'Smoked Salmon', 'Wild Pacific Salmon', 'Wild Caught Salmon',
  'Atlantic Salmon', 'Pacific Salmon',
  
  // Other Named Fish
  'Whitefish', 'Whitefish Meal', 'Deboned Whitefish',
  'Trout', 'Trout Meal', 'Rainbow Trout',
  'Herring', 'Herring Meal', 'Herring Oil', 'Whole Atlantic Herring',
  'Mackerel', 'Mackerel Meal', 'Whole Atlantic Mackerel', 'Dehydrated Mackerel',
  'Tuna', 'Tuna Meal', 'Tuna Fillet', 'Tuna Flavor', 'Tuna Oil',
  'Cod', 'Cod Meal', 'Cod Liver Oil', 'Cod Liver Oil with Added Vitamins A and D',
  'Sardine', 'Sardine Meal', 'Sardine Oil',
  'Anchovy', 'Anchovy Meal', 'Anchovy Oil',
  'Pollock', 'Pollock Meal', 'Alaska Pollock',
  'Catfish', 'Catfish Meal',
  'Tilapia', 'Tilapia Meal',
  'Flounder', 'Whole Atlantic Flounder', 'Yellowtail Flounder',
  'Haddock', 'Haddock Meal',
  'Menhaden Fish Meal', 'Menhaden Oil',
  'Ocean Fish Meal', 'Ocean Whitefish',
  
  // Shellfish
  'Shrimp', 'Shrimp Meal', 'Prawn',
  'Crab', 'Crab Meal',
  'Lobster',
  'Krill', 'Krill Meal', 'Krill Oil',
  'Green Lipped Mussel', 'Perna Canaliculus (Green Lipped Mussel)',
  'Clam',
  'Oyster',
  'Squid',
  
  // Generic Fish
  'Fish', 'Fish Meal', 'Fish Oil', 'Fish Broth', 'Fish Stock',
  'Fish By-Products', 'Fish Protein Concentrate',
  'Dried Fish Solubles', 'Condensed Fish Solubles',
  'Purified Fish Oil', 'Purified Fish Oil (from Anchovies and Sardines)',
];

// =============================================
// EGGS & DAIRY
// =============================================
const EGGS_DAIRY = [
  // Eggs
  'Whole Eggs', 'Dried Eggs', 'Egg Product', 'Dried Egg Product',
  'Egg Whites', 'Egg Yolk', 'Dried Egg Whites',
  
  // Dairy
  'Milk', 'Dried Milk', 'Dried Skimmed Milk', 'Condensed Milk',
  'Whey', 'Dried Whey', 'Whey Protein Concentrate', 'Dried Whey Protein Concentrate',
  'Cheese', 'Dried Cheese', 'Cheddar Cheese', 'Cottage Cheese', 'Cheese Rind',
  'Yogurt', 'Yogurt Powder', 'Dried Yogurt',
  'Casein', 'Dried Hydrolyzed Casein',
  'Buttermilk', 'Dried Buttermilk', 'Condensed Buttermilk',
  'Cream', 'Dried Cream',
  'Lactose',
  'Bovine Colostrum', 'Dried Bovine Colostrum',
];

// =============================================
// GRAINS & CEREALS
// =============================================
const GRAINS = [
  // Rice
  'Rice', 'Brown Rice', 'White Rice', 'Ground Brown Rice', 'Ground Rice',
  'Brewers Rice', 'Rice Flour', 'Rice Bran', 'Rice Protein',
  'Rice Protein Concentrate', 'Whole Brown Rice', 'Parboiled Rice',
  'Rice Hulls', 'Rice Polishings', 'Rice Mill By-Product',
  
  // Wheat
  'Wheat', 'Whole Grain Wheat', 'Wheat Flour', 'Whole Wheat Flour',
  'Whole Grain Wheat Flour', 'Wheat Bran', 'Wheat Middlings',
  'Wheat Germ', 'Wheat Germ Meal', 'Wheat Germ Oil',
  'Wheat Gluten', 'Wheat Protein Isolate', 'Wheat Shorts',
  'Wheat Red Dog', 'Wheat Mill Run',
  
  // Corn
  'Corn', 'Ground Corn', 'Whole Grain Corn', 'Corn Meal', 'Corn Flour',
  'Corn Starch', 'Corn Gluten Meal', 'Corn Gluten Feed', 'Corn Grits',
  'Corn Bran', 'Corn Germ Meal', 'Corn Protein Concentrate',
  'Cracked Corn', 'Flaked Corn', 'Kibbled Corn',
  
  // Oats
  'Oats', 'Oatmeal', 'Oat Meal', 'Whole Grain Oatmeal', 'Ground Oats',
  'Oat Flour', 'Oat Fiber', 'Oat Groats', 'Rolled Oats',
  'Steel Cut Oats', 'Oat Hulls', 'Oat Mill By-Product',
  
  // Barley
  'Barley', 'Ground Barley', 'Barley Flour', 'Pearl Barley',
  'Cracked Pearled Barley', 'Barley Grass', 'Barley Mill By-Product',
  'Malted Barley', 'Malted Barley Extract', 'Malt Extract',
  
  // Sorghum
  'Sorghum', 'Grain Sorghum', 'Whole Grain Sorghum', 'Ground Grain Sorghum',
  'Sorghum Flour', 'Grain Sorghum Gluten Meal',
  
  // Other Grains
  'Millet', 'Whole Grain Millet', 'Pearl Millet',
  'Quinoa', 'Quinoa Seed',
  'Amaranth',
  'Buckwheat', 'Buckwheat Flour',
  'Spelt',
  'Rye', 'Rye Flour', 'Rye Middlings',
  'Teff',
  'Farro',
];

// =============================================
// LEGUMES & PULSES
// =============================================
const LEGUMES = [
  // Peas
  'Peas', 'Green Peas', 'Whole Green Peas', 'Yellow Peas',
  'Split Peas', 'Pea Protein', 'Pea Fiber', 'Pea Flour', 'Pea Starch',
  
  // Lentils
  'Lentils', 'Red Lentils', 'Whole Red Lentils', 'Green Lentils',
  'Lentil Fiber', 'Lentil Flour', 'Yellow Lentils', 'Brown Lentils',
  
  // Chickpeas
  'Chickpeas', 'Whole Chickpeas', 'Chickpea Flour', 'Garbanzo Beans',
  
  // Beans
  'Pinto Beans', 'Whole Pinto Beans', 'Navy Beans', 'Whole Navy Beans',
  'Black Beans', 'White Beans', 'Kidney Beans', 'Lima Beans',
  'Fava Beans', 'Dried Beans', 'Adzuki Beans', 'Mung Beans',
  
  // Soy
  'Soybeans', 'Ground Soybeans', 'Soybean Meal', 'Soybean Oil', 'Soy Flour',
  'Soy Protein Concentrate', 'Soy Protein Isolate', 'Hydrolyzed Soy Protein',
  'Soy Lecithin', 'Soy Grits', 'Soybean Hulls', 'Textured Soy Protein',
  
  // Other
  'Lupine', 'Sweet Lupin Meal',
  'Alfalfa Meal', 'Suncured Alfalfa Meal', 'Organic Alfalfa', 'Suncured Alfalfa',
];

// =============================================
// FRUITS
// =============================================
const FRUITS = [
  'Apples', 'Dried Apples', 'Apple Pomace', 'Dried Apple Pomace',
  'Apple Juice Concentrate',
  'Blueberries', 'Dried Blueberries',
  'Cranberries', 'Dried Cranberries',
  'Raspberries', 'Dried Raspberries',
  'Strawberries', 'Dried Strawberries',
  'Blackberries', 'Dried Blackberries',
  'Bananas', 'Dried Bananas', 'Banana Powder',
  'Pears',
  'Peaches', 'Dried Peaches',
  'Mangoes', 'Dried Mangoes', 'Mango',
  'Papaya', 'Dried Papaya',
  'Pineapple', 'Dried Pineapple',
  'Watermelon',
  'Cantaloupe',
  'Coconut', 'Dried Coconut', 'Coconut Flour', 'Coconut Cream',
  'Pomegranate', 'Pomegranate Seeds',
  'Figs', 'Dried Figs',
  'Dates',
  'Plums',
  'Cherries', 'Dried Cherries',
  'Acai', 'Goji Berries',
  'Tomatoes', 'Tomato', 'Tomato Pomace', 'Dried Tomato Pomace',
  'Sun-Dried Tomato Pomace', 'Tomato Paste',
];

// =============================================
// VEGETABLES
// =============================================
const VEGETABLES = [
  // Root Vegetables
  'Sweet Potatoes', 'Potatoes', 'Dried Potatoes', 'Dried Ground Potatoes',
  'Potato Starch', 'Potato Protein', 'Potato Fiber', 'Dried Potato Product',
  'Carrots', 'Dried Carrots', 'Carrot Powder',
  'Beets', 'Dehydrated Beets', 'Beet Pulp', 'Dried Beet Pulp', 'Dried Plain Beet Pulp',
  'Parsnips',
  'Turnips', 'Turnip Greens',
  'Yams', 'Dried Yam',
  'Ginger Root',
  
  // Leafy Greens
  'Spinach', 'Dried Spinach',
  'Kale', 'Dried Kale',
  'Broccoli', 'Dried Broccoli',
  'Cabbage',
  'Lettuce',
  'Watercress',
  'Bok Choy',
  'Collard Greens',
  'Swiss Chard',
  'Arugula',
  'Kelp', 'Dried Kelp', 'Organic Kelp', 'Dried Seaweed Meal',
  
  // Other Vegetables
  'Pumpkin', 'Whole Pumpkin', 'Dried Pumpkin', 'Pumpkin Puree',
  'Butternut Squash', 'Whole Butternut Squash',
  'Acorn Squash', 'Zucchini',
  'Green Beans',
  'Celery',
  'Asparagus',
  'Bell Peppers', 'Red Bell Pepper',
  'Cauliflower',
  'Artichokes',
  'Cucumber',
  'Okra',
  'Fennel',
  'Corn (Vegetable)', // Distinct from grain corn
  
  // Allium (Controversial/Toxic for pets)
  'Garlic', 'Garlic Oil', 'Garlic Powder',
  'Onion', 'Onion Powder',
];

// =============================================
// SEEDS, NUTS & OILS
// =============================================
const SEEDS_NUTS_OILS = [
  // Seeds
  'Flaxseed', 'Ground Flaxseed', 'Flaxseed Meal', 'Flaxseed Oil',
  'Chia Seed', 'Chia Seeds',
  'Sunflower Seeds', 'Sunflower Oil',
  'Pumpkin Seeds',
  'Hemp Seeds', 'Hemp Seed Oil',
  'Sesame Seeds', 'Sesame Oil',
  'Psyllium Seed Husk',
  
  // Nuts
  'Peanuts', 'Peanut Butter', 'Peanut Flour',
  'Almonds', 'Almond Butter',
  'Cashews',
  'Walnuts',
  'Pecans',
  
  // Oils
  'Coconut Oil', 'MCT Oil',
  'Canola Oil',
  'Soybean Oil',
  'Sunflower Oil',
  'Palm Oil', 'Palm Kernel Oil',
  'Olive Oil', 'Extra Virgin Olive Oil',
  'Avocado Oil',
  'Safflower Oil',
  'Vegetable Oil',
  'Fish Oil',
  'Salmon Oil',
  'Herring Oil',
  'Krill Oil',
  'Chicken Fat',
  'Beef Fat', 'Beef Tallow',
  'Pork Fat', 'Lard',
  'Duck Fat',
  'Lamb Fat',
  'Animal Fat',
  'Poultry Fat',
  'Mixed Tocopherols', // Fat preservative often listed
];

// =============================================
// STARCHES, THICKENERS & BINDERS
// =============================================
const STARCHES_BINDERS = [
  'Tapioca', 'Tapioca Starch', 'Modified Tapioca Starch', 'Tapioca Flour',
  'Potato Starch',
  'Corn Starch', 'Cornstarch', 'Modified Corn Starch',
  'Arrowroot', 'Arrowroot Powder',
  'Rice Flour',
  'Wheat Flour',
  'Oat Flour',
  'Barley Flour',
  'Chickpea Flour',
  'Pea Starch',
  'Maltodextrin', 'Maltodextrins',
  'Gelatin',
  'Glycerin', 'Vegetable Glycerin', 'Coconut Glycerin',
  'Agar-Agar', 'Agar',
  'Pectin',
  'Guar Gum',
  'Xanthan Gum',
  'Locust Bean Gum', 'Carob Bean Gum',
  'Carrageenan',
  'Cellulose', 'Powdered Cellulose', 'Microcrystalline Cellulose',
  'Cassia Gum',
  'Gellan Gum',
  'Tara Gum',
  'Sodium Carboxymethylcellulose',
  'Lecithin', 'Soy Lecithin',
];

// =============================================
// SWEETENERS & FLAVORS
// =============================================
const SWEETENERS_FLAVORS = [
  // Sweeteners
  'Sugar', 'Cane Sugar', 'Organic Cane Sugar',
  'Molasses', 'Cane Molasses', 'Beet Molasses', 'Blackstrap Molasses',
  'Honey',
  'Maple Syrup',
  'Corn Syrup', 'Dried Corn Syrup',
  'Dextrose',
  'Fructose',
  'Glucose',
  'Sucrose',
  'Caramel', 'Caramel Color',
  
  // Flavors
  'Natural Flavor', 'Natural Flavors',
  'Artificial Flavor', 'Artificial Flavors',
  'Natural and Artificial Flavor', 'Natural and Artificial Flavors',
  'Artificial and Natural Flavors',
  'Natural Smoke Flavor', 'Smoke Flavor', 'Hickory Smoke Flavor',
  'Natural Vanilla Flavor', 'Vanilla Extract',
  'Natural Peppermint Oil',
  'Liver Flavor',
  'Chicken Flavor', 'Chicken Liver Flavor',
  'Beef Flavor',
  'Tuna Flavor',
  'Pork Liver Flavor',
  'Natural Chicken Flavor',
  'Organic Chicken Flavor',
  'Natural Poultry Flavor',
  'Animal Liver Flavor',
];

// =============================================
// FIBER & PREBIOTICS
// =============================================
const FIBER_PREBIOTICS = [
  'Dried Beet Pulp', 'Dried Plain Beet Pulp', 'Beet Pulp',
  'Dried Chicory Root', 'Chicory Root Extract', 'Chicory Root',
  'Fructooligosaccharides', 'FOS',
  'Inulin',
  'Pea Fiber',
  'Oat Fiber',
  'Cellulose', 'Powdered Cellulose',
  'Lentil Fiber',
  'Potato Fiber',
  'Tomato Pomace', 'Dried Tomato Pomace',
  'Apple Pomace', 'Dried Apple Pomace',
  'Citrus Pulp', 'Dried Citrus Pulp',
  'Pumpkin Fiber',
  'Psyllium Seed Husk',
  'Flaxseed', 'Ground Flaxseed',
  'Rice Bran',
  'Wheat Bran',
  'Corn Bran',
];

// =============================================
// PROBIOTICS & DIGESTIVE AIDS
// =============================================
const PROBIOTICS = [
  'Dried Lactobacillus Acidophilus',
  'Dried Lactobacillus Plantarum',
  'Dried Lactobacillus Casei',
  'Dried Lactobacillus Rhamnosus',
  'Dried Lactobacillus Bulgaricus',
  'Dried Enterococcus Faecium',
  'Dried Bacillus Coagulans Fermentation Product',
  'Dried Bacillus Subtilis',
  'Dried Bifidobacterium Animalis',
  'Dried Bifidobacterium Longum',
  'Bifidobacterium Longum',
  'Dried Pediococcus Acidilactici',
  'Dried Saccharomyces Cerevisiae',
  'Probiotics',
  'Brewer Yeast', 'Brewers Dried Yeast',
  'Dried Yeast', 'Yeast Extract', 'Yeast Culture',
  'Active Dry Yeast',
];

// =============================================
// VITAMINS
// =============================================
const VITAMINS = [
  'Vitamin A', 'Vitamin A Supplement', 'Vitamin A Oil',
  'Vitamin A Acetate', 'Vitamin A Palmitate',
  'Vitamin B-12', 'Vitamin B-12 Supplement',
  'Vitamin C', 'Ascorbic Acid', 'L-Ascorbyl-2-Polyphosphate',
  'Vitamin D3', 'Vitamin D-3', 'Cholecalciferol',
  'Vitamin E', 'Vitamin E Supplement', 'd-Alpha Tocopherol',
  'Alpha Tocopherol Acetate',
  'Vitamin K', 'Menadione Sodium Bisulfite Complex',
  'Thiamine', 'Thiamine Hydrochloride', 'Thiamine Mononitrate',
  'Riboflavin', 'Riboflavin Supplement',
  'Niacin', 'Niacin Supplement', 'Niacinamide',
  'Pyridoxine Hydrochloride', 'Vitamin B-6',
  'Folic Acid',
  'Biotin',
  'Pantothenic Acid', 'Calcium Pantothenate', 'd-Calcium Pantothenate',
  'Choline Chloride', 'Choline',
  'Inositol',
  'Beta-Carotene', 'Carotene',
  'Vitamins', // Generic label term
];

// =============================================
// MINERALS
// =============================================
const MINERALS = [
  'Calcium Carbonate', 'Calcium Chloride', 'Calcium Iodate',
  'Calcium Phosphate', 'Calcium Sulfate', 'Dicalcium Phosphate',
  'Tricalcium Phosphate', 'Monocalcium Phosphate',
  'Iron', 'Ferrous Sulfate', 'Iron Proteinate', 'Iron Oxide',
  'Ferrous Fumarate', 'Ferrous Gluconate',
  'Zinc', 'Zinc Sulfate', 'Zinc Oxide', 'Zinc Proteinate',
  'Zinc Gluconate', 'Zinc Acetate',
  'Manganese', 'Manganese Sulfate', 'Manganous Oxide',
  'Manganese Proteinate', 'Manganese Gluconate', 'Manganese Ascorbate',
  'Copper', 'Copper Sulfate', 'Copper Proteinate', 'Copper Gluconate',
  'Copper Oxide', 'Copper Chloride',
  'Selenium', 'Sodium Selenite', 'Selenium Yeast', 'Sodium Selenate',
  'Iodine', 'Potassium Iodide', 'Calcium Iodate', 'Iodized Salt',
  'Cobalt', 'Cobalt Carbonate', 'Cobalt Gluconate',
  'Potassium Chloride', 'Potassium Citrate',
  'Sodium Chloride', 'Salt',
  'Magnesium Oxide', 'Magnesium Sulfate', 'Magnesium Stearate',
  'Phosphoric Acid',
  'Sulfur',
  'Minerals', 'Trace Minerals', // Generic label terms
];

// =============================================
// AMINO ACIDS & SUPPLEMENTS
// =============================================
const AMINO_ACIDS_SUPPLEMENTS = [
  // Amino Acids
  'DL-Methionine', 'L-Methionine',
  'L-Lysine', 'L-Lysine Monohydrochloride',
  'Taurine',
  'L-Carnitine',
  'L-Tryptophan',
  'L-Threonine',
  'L-Arginine',
  'L-Tyrosine',
  'Glycine',
  
  // Joint Supplements
  'Glucosamine', 'Glucosamine Hydrochloride',
  'Chondroitin', 'Chondroitin Sulfate', 'Sodium Chondroitin Sulfate',
  'MSM', 'Methylsulfonylmethane (MSM)',
  'Green Lipped Mussel',
  'Collagen',
  
  // Other Supplements
  'CoQ10', 'Coenzyme Q10',
  'DHA', 'EPA',
  'Dimethylglycine',
  'Grape Seed Extract',
  'Green Tea Extract',
  'Turmeric', 'Organic Turmeric', 'Turmeric Oleoresin',
  'Spirulina', 'Dried Algae Meal',
  'Chlorella',
  'Chlorophyll', 'Sodium Copper Chlorophyllin',
  'Yucca Schidigera Extract',
];

// =============================================
// PRESERVATIVES & ADDITIVES
// =============================================
const PRESERVATIVES_ADDITIVES = [
  // Natural Preservatives
  'Mixed Tocopherols', 'Tocopherols',
  'Rosemary Extract', 'Oil of Rosemary',
  'Citric Acid',
  'Ascorbic Acid',
  'Sorbic Acid',
  'Vinegar', 'Apple Cider Vinegar',
  
  // Chemical Preservatives
  'BHA', 'Butylated Hydroxyanisole',
  'BHT', 'Butylated Hydroxytoluene',
  'Ethoxyquin',
  'Potassium Sorbate',
  'Sodium Bisulfite',
  'Sodium Nitrite',
  'Erythorbic Acid',
  'Propionic Acid',
  'Calcium Propionate',
  
  // Processing Aids
  'Silicon Dioxide',
  'Sodium Silico Aluminate',
  'Sodium Tripolyphosphate',
  'Sodium Hexametaphosphate',
  'Sodium Bisulfate',
  'Titanium Dioxide',
  'Montmorillonite Clay',
  'Kaolin',
  'Mineral Oil',
  
  // Colors
  'Caramel Color',
  'Annatto Extract', 'Annatto Extract Color',
  'Turmeric Color',
  'Paprika', 'Paprika Oleoresin',
  'Red 40', 'Yellow 5', 'Yellow 6', 'Blue 1',
  'Added Color',
  
  // Acids
  'Lactic Acid',
  'Phosphoric Acid',
  'Malic Acid',
  'Fumaric Acid',
];

// =============================================
// HERBS, SPICES & BOTANICALS
// =============================================
const HERBS_BOTANICALS = [
  'Parsley', 'Dried Parsley', 'Parsley Flake',
  'Rosemary', 'Rosemary Extract',
  'Thyme',
  'Oregano',
  'Basil',
  'Sage',
  'Dill',
  'Mint', 'Spearmint', 'Peppermint',
  'Cinnamon',
  'Ginger',
  'Turmeric',
  'Fennel',
  'Chamomile',
  'Dandelion', 'Dandelion Root',
  'Aloe Vera', 'Aloe Vera Gel Concentrate',
  'Kelp', 'Dried Kelp', 'Organic Kelp',
  'Seaweed', 'Dried Seaweed Meal',
  'Fenugreek', 'Fenugreek Seed',
  'Anise', 'Anise Seed',
  'Capsicum', 'Red Pepper',
  'Garlic Oil',
  'Marigold Extract', 'Tagetes Extract',
  'Saffron',
  'Valerian Root',
  'Licorice Root',
  'Milk Thistle',
  'Echinacea',
  'Calendula',
  'Cranberry Extract',
  'Blueberry Extract',
];

// =============================================
// MISCELLANEOUS / SPECIALTY
// =============================================
const MISC = [
  'Water', 'Sufficient Water for Processing',
  'Bone Broth', 'Chicken Bone Broth', 'Beef Bone Broth',
  'Avocado/Soybean Unsaponifiables',
  'Dried Black Soldier Fly Larvae',
  'Cricket Flour', 'Cricket Protein',
  'Carob', 'Carob Powder',
  'Propylene Glycol',
  'Ethylene Glycol', // Toxic - should be flagged
  'Xylitol', // Toxic to dogs
  // Generic by-products (not species-specific)
  'Poultry By-Product Meal', 'Poultry By-Products',
  'Meat By-Products', 'Meat By-Product Meal',
  'Animal By-Product Meal', 'Animal By-Products',
  'Meat and Bone Meal', 'Poultry Meal',
  'Animal Fat', 'Poultry Fat',
];


// =============================================
// MERGE ALL & DEDUPLICATE
// =============================================
function getAllIngredients() {
  const allArrays = [
    PROTEINS_WHOLE, PROTEINS_FISH, EGGS_DAIRY,
    GRAINS, LEGUMES, FRUITS, VEGETABLES,
    SEEDS_NUTS_OILS, STARCHES_BINDERS, SWEETENERS_FLAVORS,
    FIBER_PREBIOTICS, PROBIOTICS,
    VITAMINS, MINERALS, AMINO_ACIDS_SUPPLEMENTS,
    PRESERVATIVES_ADDITIVES, HERBS_BOTANICALS, MISC,
  ];
  
  const seen = new Set();
  const unique = [];
  
  for (const arr of allArrays) {
    for (const ingredient of arr) {
      const normalized = ingredient.toLowerCase().trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique.push(ingredient); // Keep original casing
      }
    }
  }
  
  return unique.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// Also include AAFCO ingredients not already covered
function getAAFCOIngredients(aafcoFilePath) {
  const fs = require('fs');
  const content = fs.readFileSync(aafcoFilePath, 'utf8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (!line) return false;
      // Skip category headers, references, and non-ingredient lines
      if (line.startsWith('*')) return false;
      if (line.startsWith('See ')) return false;
      if (line.startsWith('Reference ')) return false;
      if (line.startsWith('Descriptions of')) return false;
      if (line.includes('Section of OP')) return false;
      if (line.includes('Metal (Mineral)')) return false;
      // Skip very long lines (likely descriptions)
      if (line.length > 100) return false;
      return true;
    })
    .map(line => line.replace(/\*+$/, '').trim()) // Remove trailing asterisks
    .filter(Boolean);
}

function getComprehensiveList(aafcoFilePath) {
  const curated = getAllIngredients();
  const aafco = getAAFCOIngredients(aafcoFilePath);
  
  const seen = new Set(curated.map(i => i.toLowerCase().trim()));
  const combined = [...curated];
  
  for (const ingredient of aafco) {
    const normalized = ingredient.toLowerCase().trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      combined.push(ingredient);
    }
  }
  
  return combined.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

module.exports = {
  getAllIngredients,
  getAAFCOIngredients,
  getComprehensiveList,
  // Export individual categories for reference
  PROTEINS_WHOLE,
  PROTEINS_FISH,
  EGGS_DAIRY,
  GRAINS,
  LEGUMES,
  FRUITS,
  VEGETABLES,
  SEEDS_NUTS_OILS,
  STARCHES_BINDERS,
  SWEETENERS_FLAVORS,
  FIBER_PREBIOTICS,
  PROBIOTICS,
  VITAMINS,
  MINERALS,
  AMINO_ACIDS_SUPPLEMENTS,
  PRESERVATIVES_ADDITIVES,
  HERBS_BOTANICALS,
  MISC,
};

