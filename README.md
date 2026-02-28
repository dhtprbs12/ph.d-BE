# PetFood Analyzer 🐕🐱

A personalized pet food analysis service that helps dog and cat owners determine if a food product is safe for their specific pet.

## 🎯 Core Features

### Pet Profile System
- Create profiles for dogs and cats with breed, age, weight, sex
- Track allergies (chicken, beef, fish, grains, etc.)
- Monitor health conditions (kidney disease, obesity, digestive sensitivity, etc.)
- Pet type influences ALL scoring logic

### Three Distinct Scan Modes

1. **Barcode Scan** - Quick lookup from product database
2. **Label Scan (Photo)** - OCR extraction via Google Gemini AI
3. **Manual Input** - Paste/type ingredient list for online shopping

### Personalized Analysis Engine
- Species-specific risk scoring (dogs vs cats have different needs)
- Allergen detection based on pet's profile
- Health condition risk adjustments
- Taurine detection (critical for cats)
- Toxic ingredient alerts

### Results & Recommendations
- 0-100 safety score with letter grade (A-F)
- Dangerous/caution ingredients with explanations
- Positive nutritional highlights
- Safer alternative recommendations

### Community Reviews
- Filter by pet type, breed, size, similar conditions
- "Pets like yours" similarity matching

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      iOS App (SwiftUI)                       │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │  Home   │  │  Scan   │  │  Pets   │  │ History │       │
│  │  View   │  │  Views  │  │  View   │  │  View   │       │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘       │
│       └────────────┴────────────┴────────────┘              │
│                         │                                    │
│              ┌──────────┴──────────┐                        │
│              │    API Services     │                        │
│              │  (Auth, Pet, Scan)  │                        │
│              └──────────┬──────────┘                        │
└─────────────────────────┼───────────────────────────────────┘
                          │ HTTPS
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Node.js Backend (Express)                  │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   Auth   │  │   Pet    │  │   Scan   │  │ Product  │   │
│  │  Routes  │  │  Routes  │  │  Routes  │  │  Routes  │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       └─────────────┴─────────────┴─────────────┘          │
│                          │                                   │
│              ┌───────────┴───────────┐                      │
│              │                       │                      │
│  ┌───────────┴──────┐    ┌──────────┴───────────┐         │
│  │   Ingredient     │    │    Gemini Service    │         │
│  │   Analyzer       │    │    (OCR + Parse)     │         │
│  │   (Scoring)      │    │                      │         │
│  └───────────┬──────┘    └──────────┬───────────┘         │
│              └───────────┬───────────┘                      │
└──────────────────────────┼──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                         MySQL                                │
│                                                              │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │  Users  │  │  Pets   │  │Products │  │Ingredi- │       │
│  │         │◄─┤         │  │         │  │  ents   │       │
│  └─────────┘  └────┬────┘  └────┬────┘  └────┬────┘       │
│                    │            │            │              │
│  ┌─────────┐  ┌────┴────┐  ┌────┴────┐  ┌────┴────┐       │
│  │ Reviews │  │ Health  │  │  Scan   │  │  Risk   │       │
│  │         │  │Conditio-│  │ History │  │ Rules   │       │
│  └─────────┘  │   ns    │  └─────────┘  └─────────┘       │
│               └─────────┘                                   │
└─────────────────────────────────────────────────────────────┘
```

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- MySQL 8.0+
- Xcode 15+ (for iOS development)
- Google Gemini API key

### Backend Setup

```bash
cd backend

# Install dependencies
npm install

# Create MySQL database
mysql -u root -p -e "CREATE DATABASE petfood_analyzer;"

# Configure environment (create .env file with):
# PORT=3000
# NODE_ENV=development
# DB_HOST=localhost
# DB_PORT=3306
# DB_USER=root
# DB_PASSWORD=your_password
# DB_NAME=petfood_analyzer
# JWT_SECRET=your-secret-key
# GEMINI_API_KEY=your_gemini_api_key

# Run migrations
npm run migrate

# Seed database with ingredients & sample products
npm run seed

# Start server
npm run dev
```

See `config.sample.js` for full configuration reference.

### iOS Setup

```bash
cd ios

# Generate Xcode project (requires XcodeGen)
brew install xcodegen
xcodegen generate

# Open in Xcode
open PetFoodAnalyzer.xcodeproj
```

1. Update `APIConfig.baseURL` in `APIService.swift` with your backend URL
2. Build and run on simulator or device (iOS 15+)

## 📊 Database Schema

### Key Tables

- **users** - User accounts
- **pets** - Pet profiles (dog/cat) with physical attributes
- **pet_health_conditions** - Allergies and health conditions per pet
- **ingredients** - Master ingredient database with risk scores
- **ingredient_health_risks** - Health-condition-specific risk modifiers
- **products** - Pet food products (barcode, name, ingredients)
- **scan_history** - User scan history with personalized analysis
- **product_reviews** - Community reviews filterable by pet attributes

## 🧮 Scoring Algorithm

```
START_SCORE = 100

for each ingredient (weighted by position):
    risk = base_risk_score
    risk += species_modifier (dog_risk_modifier OR cat_risk_modifier)
    
    for each pet_health_condition:
        risk += health_condition_risk_modifier
    
    if allergen_match:
        risk += 50
    
    if toxic_to_species:
        risk = 100 (maximum)
    
    position_weight = 1.0 (pos 1-3), 0.75 (pos 4-6), 0.5 (pos 7-10), 0.25 (pos 11+)
    
    SCORE -= risk * position_weight
    SCORE += nutritional_bonus * position_weight

# Species-specific checks
if pet_type == CAT and no_taurine_found:
    SCORE -= 25

# Clamp and grade
FINAL_SCORE = clamp(SCORE, 0, 100)
GRADE = A (85+), B (70-84), C (55-69), D (40-54), F (<40)
```

## 🎨 Design System

### Color Palette
| Color | Hex | Usage |
|-------|-----|-------|
| Teal | `#008080` | Primary/Brand |
| Orange | `#FF8C42` | CTA/Highlights |
| Red | `#E74C3C` | Danger |
| Yellow | `#F1C40F` | Caution |
| Green | `#2ECC71` | Safe/Positive |

### Typography
- **SF Pro Display** - Headings
- **SF Pro Text** - Body text
- **SF Pro Rounded** - Numeric scores

## 📱 API Endpoints

### Authentication
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user

### Pets
- `GET /api/pets` - List user's pets
- `POST /api/pets` - Create pet
- `PUT /api/pets/:id` - Update pet
- `DELETE /api/pets/:id` - Delete pet
- `POST /api/pets/:id/conditions` - Add health condition

### Scanning
- `POST /api/scan/barcode` - Scan by barcode
- `POST /api/scan/label` - OCR scan from photo
- `POST /api/scan/manual` - Manual ingredient input
- `GET /api/scan/history` - Get scan history

### Products
- `GET /api/products/search?q=...&petType=dog` - Search products by name/brand
- `GET /api/products/filter?petType=dog&grainFree=true&noChicken=true` - Filter by criteria
- `GET /api/products/:id` - Get product details
- `GET /api/products/:id/analyze?petId=...` - Analyze for specific pet
- `GET /api/products/:id/alternatives?petId=...` - Get safer alternatives
- `GET /api/products/:id/reviews?petType=dog` - Get filtered reviews
- `GET /api/products/barcode/:barcode` - Lookup by barcode

## 🛠️ Tech Stack

- **iOS**: Swift, SwiftUI, AVFoundation (camera)
- **Backend**: Node.js, Express.js
- **Database**: MySQL
- **AI/OCR**: Google Gemini API
- **Auth**: JWT

## 📋 MVP vs Phase 2

### MVP (Current)
- [x] Pet profile system (dog & cat)
- [x] Three scan modes
- [x] Ingredient analysis with personalized scoring
- [x] Species-specific risk rules
- [x] Results with warnings and positives
- [x] Scan history

### Phase 2 (Future)
- [ ] Vet-reviewed badges
- [ ] Purchase links (Amazon, Chewy)
- [ ] Push notifications for recalls
- [ ] Offline mode with cached ingredients
- [ ] Social sharing of safe foods
- [ ] Premium subscription tier

## ⚠️ Technical Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| OCR accuracy | Fallback to manual input; confidence scores |
| Ingredient database coverage | Allow user-contributed products; Gemini parsing |
| Performance with large ingredient lists | Caching; background processing |
| API rate limits (Gemini) | Response caching; queue system |
| Data accuracy | Vet review process; community flagging |

## 📄 License

MIT License - See LICENSE file for details.

---

Built with ❤️ for pet parents everywhere.

