# PHD (Pet Health Diet) — React Native Rebuild Prompt

## IMPORTANT: Reference Existing Code

The original iOS (SwiftUI) app and backend code already exist in this workspace. **You MUST read and reference these files** as the source of truth for UI layout, logic, and API integration. Do NOT guess — read the actual code.

### Key Reference Files

**iOS App (SwiftUI) — replicate these screens in React Native:**
```
petfood-analyzer/ios/PetFoodAnalyzer/
├── Theme/AppTheme.swift              — Design tokens (colors, spacing, typography, shadows, button styles)
├── Config/AppConfig.swift            — App config constants
├── Models/Models.swift               — All data models (Pet, Product, ScanResult, Analysis, etc.)
├── Services/
│   ├── APIService.swift              — Base API client (endpoints, auth, error handling)
│   ├── ScanService.swift             — Scan API calls (front/back/quick-analyze/poll/food-check)
│   ├── ProductService.swift          — Product API calls (search/filter/analyze/alternatives/batch-scores)
│   ├── PetService.swift              — Pet CRUD + device auth
│   └── NetworkMonitor.swift          — Network connectivity monitor
├── PetFoodAnalyzerApp.swift          — App entry + AppState (auth flow, pet management)
├── Views/
│   ├── ContentView.swift             — Tab bar structure
│   ├── Home/HomeView.swift           — Dashboard with action cards, badge, pet selector
│   ├── Scan/TwoStepScanView.swift    — 2-step scan flow (front→candidates→back→analyze→result)
│   ├── Scan/ResultView.swift         — Full result display (score ring, AI insights, ingredients, alternatives)
│   ├── Scan/FoodCheckView.swift      — "Can my pet eat this?" camera flow
│   ├── Scan/LabelScanView.swift      — Single-photo label scan (legacy, not primary)
│   ├── Search/ProductSearchView.swift— Product search with chip filters + pagination
│   ├── History/HistoryView.swift     — Scan history list
│   ├── Pets/PetsView.swift           — Pet list with condition badges
│   ├── Pets/AddPetView.swift         — 3-step pet creation wizard
│   ├── Pets/EditPetView.swift        — Pet edit + condition management
│   ├── Settings/SettingsView.swift   — Settings page
│   ├── Share/ShareCardView.swift     — Share image renderer
│   ├── Onboarding/DisclaimerView.swift — First-run disclaimer
│   ├── LaunchScreen/LaunchScreenView.swift — Animated splash
│   └── Components/PetAvatarView.swift — Pet avatar component
```

**Backend (Express.js) — DO NOT modify, just understand the API:**
```
petfood-analyzer/backend/src/
├── server.js                         — Express config, route mounts, middleware
├── database/
│   ├── schema.sql                    — Full DB schema (all tables)
│   └── connection.js                 — MySQL connection pool
├── routes/
│   ├── auth.routes.js                — Device auth, register, login
│   ├── pet.routes.js                 — Pet CRUD + conditions
│   ├── scan.routes.js                — All scan endpoints (front/back/quick/manual/food-check/poll)
│   ├── product.routes.js             — Product search/filter/analyze/alternatives/batch-scores
│   ├── review.routes.js              — Product reviews
│   └── admin.routes.js               — Admin stats
├── services/
│   ├── geminiService.js              — Gemini AI integration (OCR, analysis, food check)
│   ├── ingredientAnalyzer.js         — Rule-based analysis + condition warnings
│   ├── productService.js             — Product DB queries + filtering
│   └── imageService.js               — Product image search + storage
├── middleware/
│   ├── auth.js                       — JWT auth (anonymous fallback for MVP)
│   └── errorHandler.js               — Centralized error handling
└── utils/
    └── cacheHelpers.js               — Cache key generation, grade conversion
```

**When building each screen, ALWAYS read the corresponding SwiftUI file first** to understand exact layout, logic, state management, and API calls. Translate SwiftUI patterns to React Native equivalents.

---

## Project Overview

Rebuild the existing native iOS SwiftUI app as a **React Native (Expo)** app to support both iOS and Android. The backend API is already deployed and must be used as-is without any changes.

- **App Name:** PHD (Pet Health Diet)
- **Description:** AI-powered pet food ingredient analyzer that scores products (0-100) and grades them (A-F)
- **Platforms:** iOS 16+ / Android API 24+ (via Expo)
- **Backend API:** `https://phd-be-production.up.railway.app/api` (Express.js + MySQL + Gemini AI)
- **Backend is NOT to be modified** — only consume its API

---

## Tech Stack

- **Framework:** React Native with Expo (SDK 52+)
- **Language:** TypeScript
- **Navigation:** React Navigation (Stack + Bottom Tabs)
- **State Management:** React Context + useReducer (or Zustand)
- **API Client:** axios
- **Camera:** expo-camera
- **Image Picker:** expo-image-picker
- **Storage:** @react-native-async-storage/async-storage
- **Animations:** react-native-reanimated 3
- **Icons:** @expo/vector-icons (replacing SF Symbols)

---

## Design System

> Read `petfood-analyzer/ios/PetFoodAnalyzer/Theme/AppTheme.swift` for the full theme. Key tokens below:

### Color Palette — "Natural Care" Theme

```
Brand:
  primary:       #2D6A4F  (Forest Green)
  primaryLight:  #40916C
  accent:        #F4A261  (Warm Amber)
  accentSoft:    #E9C46A  (Soft Gold)

Status:
  safe:     #40916C
  caution:  #E9C46A
  warning:  #F4A261
  danger:   #E76F51  (Terracotta)

Background:
  background:     #FDFBF7  (Warm Cream)
  card:           #FFFFFF
  lightGray:      #F5F3EF
  divider:        #E8E4DD

Text:
  primary:   #1B2B27
  secondary: #5C6B66

Grades:
  A: #2D6A4F  B: #40916C  C: #E9C46A  D: #F4A261  F: #E76F51
```

### Typography (System Font)

```
Display:  32 bold / 26 bold / 20 semibold
Title:    18 semibold / 16 semibold
Body:     17 regular / 15 regular / 13 regular
Score:    56 bold rounded / 28 bold rounded
Label:    14 medium / 12 medium / 11 medium
Caption:  11 regular
```

### Spacing & Radius

```
Spacing: xxs=4, xs=8, sm=12, md=16, lg=24, xl=32, xxl=48
Radius:  small=8, medium=12, large=16, xl=24, full=9999
Shadow:  color #2D6A4F at 8% opacity, y-offset 2, blur 8
```

---

## Navigation Structure

```
App Launch
  └─ LaunchScreen (1.8s animation)
  └─ DisclaimerScreen (first run only, stored in AsyncStorage)
  └─ MainTabs (4 tabs)
       ├─ Home (Stack)
       │    ├─ HomeScreen
       │    ├─ TwoStepScanScreen (fullscreen modal)
       │    ├─ FoodCheckScreen (fullscreen modal)
       │    ├─ ProductSearchScreen (push)
       │    └─ ResultScreen (push)
       ├─ History (Stack)
       │    ├─ HistoryScreen
       │    └─ ResultScreen (push)
       ├─ Pets (Stack)
       │    ├─ PetsScreen
       │    ├─ AddPetScreen (modal)
       │    └─ EditPetScreen (modal)
       └─ Settings (Stack)
            └─ SettingsScreen
```

---

## Screen Specifications

> For each screen, read the corresponding SwiftUI file for exact UI details.

### 1. LaunchScreen
> Ref: `LaunchScreenView.swift`
- App logo centered on `primary` (#2D6A4F) background
- Spring scale animation (0.8 → 1.0)
- Fade out after 1.8s

### 2. DisclaimerScreen
> Ref: `DisclaimerView.swift`
- First-run only (check `hasAcceptedDisclaimer` in AsyncStorage)
- 3 disclaimer cards + "I Understand & Agree" button
- Veterinary advice, score meaning, AI limitations

### 3. HomeScreen
> Ref: `HomeView.swift` (622 lines — read carefully)
- ScrollView layout:
  1. User badge card (`GET /scan/user-stats`, header: `x-device-id`)
  2. Community trust banner (`GET /scan/stats`)
  3. Pet selector card (tap → PetSelectorSheet)
  4. Action cards: Label Scan, Food Check, Find Safe Food
- No pet → NoPetCard → navigate to AddPetScreen

### 4. TwoStepScanScreen (Core Feature)
> Ref: `TwoStepScanView.swift` (945 lines — read very carefully)
- **ScanStep flow:** front → selectCandidate → backCapture → analyzing → complete
- **Step 1 (Front):** Camera/gallery → `POST /scan/front` (multipart)
- **Step 1.5 (Candidates):** If `candidates[]` returned, show product list → tap to select → `POST /scan/quick-analyze`; or "Not here — scan back label" to continue
- **Step 2 (Back):** Camera/gallery → `POST /scan/back/:pendingScanId` (multipart)
- **Step 3 (Analyzing):** Progress checklist + poll `GET /scan/:scanId/result` every 2s
- **Step 4 (Complete):** Navigate to ResultScreen

### 5. ResultScreen (Most Complex Screen)
> Ref: `ResultView.swift` (1530 lines — read section by section)
- ScrollView layout:
  1. **ScoreHeaderCard** — Circular score ring (0-100), grade badge (A-F), product name/brand
  2. **QuickVerdictCard** — 1-2 line AI summary
  3. **AIInsightsCard** — Benefits list, Concerns list, Health Alerts (conditionWarnings)
  4. **IngredientPillsCard** — Color-coded ingredient chips by risk level
  5. **DetailedInsightsCard** — Protein quality, artificial additives, etc.
  6. **AlternativesCard** — Horizontal scroll of alternative products (`POST /products/:id/alternatives`)
  7. **ShareButton** — Generate & share result image
  8. **TrustDisclaimerFooter** — AI disclaimer

### 6. FoodCheckScreen
> Ref: `FoodCheckView.swift` (578 lines)
- Camera snap food → `POST /scan/food-check` (multipart)
- Result: food name, category, safety level (safe/caution/danger), explanation, tip
- Color-coded result UI

### 7. ProductSearchScreen
> Ref: `ProductSearchView.swift` (867 lines)
- Search bar + filter chip system
- **Filter categories:** Pet Type, Product Type, Life Stage, Main Protein (single-select), Grain
- `GET /products/filter` + `POST /products/batch-scores`
- ProductCard: image + name + brand + score/grade
- Tap card → analyze → ResultScreen
- Infinite scroll pagination

### 8. HistoryScreen
> Ref: `HistoryView.swift` (331 lines)
- `GET /scan/history?deviceId=xxx`
- Scan history cards (date, product, score, grade)
- Pet filter menu, pull-to-refresh
- Tap → re-analyze → ResultScreen

### 9. PetsScreen
> Ref: `PetsView.swift` (288 lines)
- Pet list with PetCard (photo/emoji, name, type, age, weight, condition badges)
- Empty state → "Add Your Pet" CTA
- Tap → EditPetScreen

### 10. AddPetScreen
> Ref: `AddPetView.swift` (590 lines)
- 3-step horizontal wizard:
  - Step 1: Name, pet type (Dog/Cat), photo (optional)
  - Step 2: Breed, age (months), weight (kg), sex, activity level
  - Step 3: Health conditions toggle grid (8 allergies + 12 diseases)
- Save → `POST /pets` + local cache

### 11. EditPetScreen
> Ref: `EditPetView.swift` (515 lines)
- Single-page edit form
- Manage health conditions (add/remove)
- Delete pet with confirmation
- `PUT /pets/:id` / `DELETE /pets/:id`

### 12. SettingsScreen
> Ref: `SettingsView.swift` (196 lines)
- App info (version, build)
- Registered pet count
- External links: Privacy Policy, Terms of Service, Rate App
- "Reset All Data" destructive button

---

## API Endpoints

> Read `petfood-analyzer/backend/src/routes/*.routes.js` for exact request/response shapes.

### Authentication
```
POST /auth/device         { deviceId }  → { user, token, isNewUser }
```

### Pets
```
GET    /pets                             → { pets: Pet[] }
POST   /pets              { name, petType, breed, ageMonths, weightKg, sex, activityLevel, healthConditions[] }
GET    /pets/:id                         → { pet }
PUT    /pets/:id           { ...fields } → { pet }
DELETE /pets/:id                         → { message }
POST   /pets/:id/primary                 → { message }
POST   /pets/:id/conditions { conditionType, severity?, notes? }
DELETE /pets/:id/conditions/:condId
```

### Scanning
```
POST /scan/front            (multipart: image)
  → { pendingScanId, captured, candidates[], nextStep }

POST /scan/back/:pendingId  (multipart: image + pet form fields)
  → { scanId, status, pollUrl }

POST /scan/quick-analyze    { productId, petName, petType, petBreed, petAgeMonths, petWeightKg, petAllergies, petHealthConditions, deviceId }
  → { scanId, status, pollUrl }

GET  /scan/:scanId/result
  → { status: 'processing'|'complete'|'error', result?, progress? }

POST /scan/food-check       (multipart: image + petType, petName?, petHealthConditions?, deviceId?)
  → { foodName, category, safetyLevel, explanation, tip }

POST /scan/manual           { ingredientsText, productName?, petName, petType, petBreed?, petAgeMonths?, petWeightKg?, petHealthConditions?, deviceId? }
  → { scanId, analysis, aiInsights, ... }

GET  /scan/history          ?deviceId&petName?&petType?&limit&offset
  → { history: ScanHistoryItem[] }

GET  /scan/stats            → { totalScans, totalProducts, ingredientsAnalyzed }
GET  /scan/user-stats       (header: x-device-id) → { scanCount, badge }
```

### Products
```
GET  /products/search       ?q&petType?&limit&offset
  → { products[] }

GET  /products/filter       ?petType&productType&lifeStage&noGrains&withGrains&withChicken&...&healthConditions(JSON)&minScore&q&limit&offset
  → { products[], scores{}, pagination }

POST /products/batch-scores { productIds[], petType, healthConditions[]? }
  → { scores: { [id]: { score, grade, recommendation, conditionWarnings?[] } } }

GET  /products/:id                → { product, reviewStats }
GET  /products/:id/analyze        ?petName&petType&petBreed?&petAge?&petWeight?&healthConditions(JSON)
  → { product, analysis, aiInsights, pet }
POST /products/:id/alternatives   { petType, healthConditions[], petName, limit }
  → { alternatives: [{ product, score, grade }] }
GET  /products/:id/reviews        ?limit&offset
  → { reviews[], stats }
POST /products/:id/reviews        { petId, rating, title?, content? }
  → { review }
GET  /products/:id/image          → { imageUrl }
```

---

## Data Models (TypeScript)

> Read `petfood-analyzer/ios/PetFoodAnalyzer/Models/Models.swift` for the complete model definitions. Key types:

```typescript
interface Pet {
  id: string;
  name: string;
  pet_type: 'dog' | 'cat';
  breed?: string;
  age_months?: number;
  weight_kg?: number;
  sex?: 'male' | 'female' | 'neutered_male' | 'spayed_female';
  activity_level: 'low' | 'moderate' | 'high';
  is_primary: boolean;
  healthConditions: HealthCondition[];
  photoData?: string; // base64, local only
}

interface HealthCondition {
  id: string;
  condition_type: string; // allergy_chicken, diabetes, obesity, etc.
  severity: 'mild' | 'moderate' | 'severe';
  notes?: string;
}

interface Product {
  id: string;
  name: string;
  brand?: string;
  product_type: 'dry_food' | 'wet_food' | 'treats' | 'supplement' | 'other';
  target_pet_type: 'dog' | 'cat' | 'both';
  target_life_stage: 'puppy_kitten' | 'adult' | 'senior' | 'all';
  image_url?: string;
  raw_ingredients_text?: string;
  scan_count: number;
}

interface ScanResult {
  scanId: string;
  scanType: string;
  extracted: { productName?: string; brand?: string; targetPet?: string; ingredientCount: number };
  product?: { id: string; name: string; brand?: string; imageUrl?: string };
  parsedIngredients: string[];
  analysis: Analysis;
  aiInsights?: AIInsights;
  pet: { id: string; name: string; petType: string };
}

interface Analysis {
  finalScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  recommendation: string;
  ingredients: IngredientAnalysis[];
  warnings: { ingredient: string; level: string; reason: string }[];
  positives: string[];
  summary: string;
  keyIssues: string[];
  proteinQuality?: string;
  hasArtificialAdditives: boolean;
}

interface IngredientAnalysis {
  name: string;
  position: number;
  riskLevel: 'safe' | 'low' | 'moderate' | 'high' | 'danger';
  riskScore: number;
  explanation?: string;
  positiveBenefit?: string;
}

interface AIInsights {
  topBenefits: string[];
  topConcerns: string[];
  conditionWarnings?: ConditionWarning[];
  aiGenerated: boolean;
}

interface ConditionWarning {
  type: 'allergy' | 'disease';
  severity: 'high' | 'medium';
  condition: string;
  conditionLabel: string;
  ingredient: string;
  position?: number;
  message: string;
}

interface ProductCandidate {
  id: string;
  name?: string;
  brand?: string;
  imageUrl?: string;
  productType?: string;
  targetPetType?: string;
}

interface CachedScore {
  score: number;
  grade: string;
  recommendation?: string;
  conditionWarnings?: ConditionWarning[];
}

interface FoodCheckResult {
  foodName: string;
  category?: string;
  safetyLevel: 'safe' | 'caution' | 'danger' | 'unknown';
  explanation: string;
  tip?: string;
}

interface ScanHistoryItem {
  id: string;
  pet_name: string;
  pet_type: string;
  product_id?: string;
  product_name?: string;
  product_brand?: string;
  product_image_url?: string;
  scan_type: string;
  final_score: number;
  grade: string;
  recommendation: string;
  created_at: string;
}

interface AlternativeProduct {
  product: Product;
  score: number;
  grade: string;
}

interface UserBadge {
  title: string;
  level: number;
  icon: string;
  color: string;
  nextAt: number;
  progress: number;
}
```

---

## Authentication Flow

1. On app launch, check AsyncStorage for `authToken`
2. If missing → generate device UUID → `POST /auth/device` → store JWT token
3. All API requests include `Authorization: Bearer {token}` header
4. Pet data synced to both server and local AsyncStorage

---

## Key Client-Side Logic

### Scan Polling Mechanism
```
1. POST request → receive scanId
2. Poll GET /scan/:scanId/result every 2 seconds
3. status === 'processing' → update progress UI
4. status === 'complete' → parse result → navigate to ResultScreen
5. status === 'error' → show error UI
6. Timeout after 60 seconds
```

### Image Upload (multipart/form-data)
```
- All image uploads use multipart/form-data
- Field name: "image"
- Additional text fields: petName, petType, petBreed, petAgeMonths, petWeightKg, deviceId
- JSON string fields: petAllergies, petHealthConditions
- Content-Type: image/jpeg
- Max size: 10MB
```

### Product Search Filters
- `ingredientInclusions`: matches keyword in 1st or 2nd ingredient position
- OR logic when multiple ingredients selected
- Single-select for Main Protein category

---

## UI Patterns

### Card Style
- White background, border-radius 12-16, green-tinted shadow
- Internal padding: 16-20

### Score Ring
- Circular progress indicator (0-100)
- Ring color = grade color
- Large centered number (56pt bold)
- Grade label below

### Ingredient Pills
- Small rounded pill shapes in a flow/wrap layout
- Color = risk level (safe→green, low→lightgreen, moderate→amber, high→orange, danger→red)

### Loading / Error / Empty States
- Skeleton/shimmer for loading
- Error: icon + message + retry button
- Empty: illustration + description + CTA button

### Pull-to-Refresh
- Supported on History, Pets, Search screens

---

## Recommended File Structure

```
src/
├── components/
│   ├── cards/              # ScoreCard, ProductCard, PetCard, etc.
│   ├── common/             # Button, Badge, Divider, EmptyState
│   └── scan/               # CameraView, ProgressSteps
├── screens/
│   ├── HomeScreen.tsx
│   ├── TwoStepScanScreen.tsx
│   ├── ResultScreen.tsx
│   ├── FoodCheckScreen.tsx
│   ├── ProductSearchScreen.tsx
│   ├── HistoryScreen.tsx
│   ├── PetsScreen.tsx
│   ├── AddPetScreen.tsx
│   ├── EditPetScreen.tsx
│   ├── SettingsScreen.tsx
│   ├── DisclaimerScreen.tsx
│   └── LaunchScreen.tsx
├── services/
│   ├── api.ts              # axios instance + interceptors
│   ├── authService.ts
│   ├── petService.ts
│   ├── scanService.ts
│   └── productService.ts
├── context/
│   └── AppContext.tsx       # Pets, auth, global state
├── types/
│   └── index.ts
├── theme/
│   └── index.ts            # colors, spacing, typography, shadows
├── utils/
│   ├── storage.ts          # AsyncStorage wrapper
│   └── helpers.ts          # formatting, grade conversion
└── navigation/
    └── index.tsx
```

---

## Recommended Build Order

1. **Project setup** — Expo + navigation + theme system
2. **Auth & state** — Context + API service + token management
3. **Home screen** — Dashboard layout + pet selector
4. **Pet management** — CRUD + health conditions
5. **Scan flow** — Camera + 2-step scan + candidate selection + polling
6. **Result screen** — Score ring + AI insights + warnings + ingredients
7. **Product search** — Filters + batch scores + pagination
8. **History** — Scan history list
9. **Food Check** — Food safety camera flow
10. **Settings & misc** — Settings + share + disclaimer

---

## Critical Requirements

1. **DO NOT modify the backend** — consume API as-is
2. **Match the design exactly** — colors, spacing, fonts, layouts from AppTheme.swift
3. **Light mode only** — force light mode, no dark mode support
4. **Camera permissions** — iOS: NSCameraUsageDescription, Android: CAMERA
5. **Image uploads** — multipart/form-data, field "image", JPEG, max 10MB
6. **English UI only** — all user-facing text in English
7. **Offline banner** — show red banner when network disconnected
8. **Loading states** — proper loading indicators for all API calls
9. **Error handling** — network errors, server errors, timeouts → user-friendly messages
10. **Pet photos** — stored locally only (base64 in AsyncStorage), never uploaded to server
