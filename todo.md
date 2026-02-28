# Save Pets to DB (Device-Based Auth)

## Goal
Persist pet data to the backend DB linked to a user. Use device-based auto-auth now; leave the door open for email/password auth later.

## Current State
- **DB**: `users`, `pets`, `pet_health_conditions` tables exist with FKs
- **Backend**: Full CRUD at `/api/pets` + `/api/pets/:id/conditions` — requires auth (falls back to anonymous)
- **iOS `PetService.swift`**: All API methods built but **unused**
- **iOS `AppState`**: Saves pets to **UserDefaults only**
- **Auth middleware**: Falls back to `anonymous` user — all pets share one user

## Plan

### 1. Backend: Device Auth Endpoint ✅
- [x] `POST /api/auth/device` — accepts `{ deviceId }`, creates or finds user by placeholder email `{deviceId}@device.local`, returns JWT (365d)
- [x] `PUT /api/auth/upgrade` — accepts `{ email, password, name }` to convert device user to real account (door open)

### 2. Backend: Health Conditions in PUT ✅
- [x] `PUT /api/pets/:id` — accepts `healthConditions` array, does full replace-sync in DB
- [x] Added `normalizePet()` helper to ensure MySQL booleans serialize correctly

### 3. iOS: Auto-Auth on Launch ✅
- [x] `authenticateAndSync()` called via `.task` on app launch
- [x] Uses `identifierForVendor` (same UUID as ScanService)
- [x] Token stored in `APIService.shared.authToken` (UserDefaults)

### 4. iOS: Wire AppState → PetService ✅
- [x] `addPet()` → local first, then POST; server ID replaces local ID
- [x] `updatePet()` → local first, then PUT with full healthConditions
- [x] `deletePet()` → local first, then DELETE
- [x] `setPrimaryPet()` → local first, then POST
- [x] On launch: load UserDefaults (instant), auth, then sync from server (server wins, local photos preserved)
- [x] Health condition changes via ManageConditionsView → `appState.updatePet()` → server PUT

### Design Decisions
- **Offline-first**: Local save happens immediately; server sync is best-effort
- **Server as source of truth on launch**: When fetching from server succeeds, server data replaces local
- **Device email pattern**: `{deviceId}@device.local` — unique per device, clearly distinguishable from real emails
- **Upgrade path**: `PUT /api/auth/upgrade` will let users attach real email/password later

## Review
- Backend device auth and pet health condition sync endpoints added
- iOS auto-authenticates on launch, syncs pets to/from DB
- Local UserDefaults remains as fast cache; server syncs in background
- Door open for real email/name auth via upgrade endpoint
