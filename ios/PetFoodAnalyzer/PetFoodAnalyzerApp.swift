import SwiftUI
import UIKit

@main
struct PetFoodAnalyzerApp: App {
    @StateObject private var appState = AppState()
    @State private var showLaunch = true
    @AppStorage("hasAcceptedDisclaimer") private var hasAcceptedDisclaimer = false
    
    var body: some Scene {
        WindowGroup {
            ZStack {
                if hasAcceptedDisclaimer {
                    ContentView()
                        .environmentObject(appState)
                        .preferredColorScheme(.light)
                        .task {
                            await appState.authenticateAndSync()
                        }
                } else {
                    DisclaimerView {
                        withAnimation(.easeInOut(duration: 0.3)) {
                            hasAcceptedDisclaimer = true
                        }
                    }
                    .preferredColorScheme(.light)
                }
                
                if showLaunch {
                    LaunchScreenView()
                        .transition(.opacity)
                        .zIndex(1)
                }
            }
            .onAppear {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
                    withAnimation(.easeOut(duration: 0.4)) {
                        showLaunch = false
                    }
                }
            }
        }
    }
}

// MARK: - App State
class AppState: ObservableObject {
    @Published var selectedPet: Pet?
    @Published var pets: [Pet] = []
    @Published var isAuthenticated = false
    
    private let petsKey = "savedPets"
    private let selectedPetIdKey = "selectedPetId"
    private let petService = PetService.shared
    
    init() {
        loadPetsLocally()
    }
    
    // MARK: - Device Auth + Sync
    func authenticateAndSync() async {
        // Step 1: Authenticate device
        let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        
        do {
            let authResponse = try await petService.authenticateDevice(deviceId: deviceId)
            APIService.shared.authToken = authResponse.token
            
            await MainActor.run {
                self.isAuthenticated = true
            }
            
            print("📱 Device authenticated: \(authResponse.isNewUser ? "new" : "existing") user")
            
            // Step 2: Sync pets
            await syncPets()
        } catch {
            print("⚠️ Device auth failed (offline mode): \(error.localizedDescription)")
            // App continues with local data — no blocker
        }
    }
    
    // MARK: - Sync: push local pets to server, then pull server pets
    private func syncPets() async {
        do {
            let serverPets = try await petService.getPets()
            
            if serverPets.isEmpty && !pets.isEmpty {
                // Server has nothing — push all local pets up
                for pet in pets {
                    await pushPetToServer(pet)
                }
            } else if !serverPets.isEmpty {
                // Server has pets — merge (server wins, preserve local photos)
                let localPhotoMap = Dictionary(uniqueKeysWithValues: pets.compactMap { pet -> (String, Data?)? in
                    return (pet.id, pet.photoData)
                })
                
                await MainActor.run {
                    self.pets = serverPets.map { serverPet in
                        // Preserve local photo if server pet doesn't have one
                        var pet = serverPet
                        if pet.photoData == nil, let localPhoto = localPhotoMap[pet.id] {
                            pet = Pet(
                                id: pet.id, name: pet.name, petType: pet.petType,
                                breed: pet.breed, ageMonths: pet.ageMonths, weightKg: pet.weightKg,
                                sex: pet.sex, activityLevel: pet.activityLevel,
                                isPrimary: pet.isPrimary, healthConditions: pet.healthConditions,
                                photoData: localPhoto
                            )
                        }
                        return pet
                    }
                    // Restore last-selected pet, fall back to primary, then first
                    let lastSelectedId = UserDefaults.standard.string(forKey: self.selectedPetIdKey)
                    self.selectedPet = self.pets.first(where: { $0.id == lastSelectedId })
                        ?? self.pets.first(where: { $0.isPrimary })
                        ?? self.pets.first
                    self.savePetsLocally()
                }
            }
        } catch {
            print("⚠️ Sync failed (using local data): \(error.localizedDescription)")
        }
    }
    
    private func pushPetToServer(_ pet: Pet) async {
        do {
            let conditions = pet.healthConditions.map { c in
                CreateHealthCondition(
                    type: c.conditionType.rawValue,
                    severity: c.severity.rawValue,
                    notes: c.notes
                )
            }
            
            let serverPet = try await petService.createPet(
                name: pet.name,
                petType: pet.petType,
                breed: pet.breed,
                ageMonths: pet.ageMonths,
                weightKg: pet.weightKg,
                sex: pet.sex,
                activityLevel: pet.activityLevel,
                healthConditions: conditions.isEmpty ? nil : conditions
            )
            
            // Update local ID to server ID
            await MainActor.run {
                if let index = self.pets.firstIndex(where: { $0.id == pet.id }) {
                    self.pets[index] = Pet(
                        id: serverPet.id, name: pet.name, petType: pet.petType,
                        breed: pet.breed, ageMonths: pet.ageMonths, weightKg: pet.weightKg,
                        sex: pet.sex, activityLevel: pet.activityLevel,
                        isPrimary: pet.isPrimary, healthConditions: pet.healthConditions,
                        photoData: pet.photoData
                    )
                    if self.selectedPet?.id == pet.id {
                        self.selectedPet = self.pets[index]
                        self.saveSelectedPetId()
                    }
                }
                self.savePetsLocally()
            }
            
            print("☁️ Pushed pet to server: \(pet.name) → \(serverPet.id)")
        } catch {
            print("⚠️ Failed to push pet \(pet.name): \(error.localizedDescription)")
        }
    }
    
    // MARK: - Local Storage (fast cache)
    private func loadPetsLocally() {
        if let data = UserDefaults.standard.data(forKey: petsKey),
           let savedPets = try? JSONDecoder().decode([Pet].self, from: data) {
            self.pets = savedPets
            // Restore last-selected pet, fall back to primary, then first
            let lastSelectedId = UserDefaults.standard.string(forKey: selectedPetIdKey)
            self.selectedPet = savedPets.first(where: { $0.id == lastSelectedId })
                ?? savedPets.first(where: { $0.isPrimary })
                ?? savedPets.first
        }
    }
    
    private func savePetsLocally() {
        if let data = try? JSONEncoder().encode(pets) {
            UserDefaults.standard.set(data, forKey: petsKey)
        }
    }
    
    private func saveSelectedPetId() {
        UserDefaults.standard.set(selectedPet?.id, forKey: selectedPetIdKey)
    }
    
    // MARK: - Select Pet (persist + set as primary on server)
    func selectPet(_ pet: Pet) {
        selectedPet = pet
        saveSelectedPetId()
        
        // Also set as primary so it's the default on next launch
        setPrimaryPet(pet)
    }
    
    // MARK: - Add Pet (local + server)
    func addPet(_ pet: Pet) {
        var newPet = pet
        if pets.isEmpty {
            newPet = Pet(
                id: pet.id, name: pet.name, petType: pet.petType,
                breed: pet.breed, ageMonths: pet.ageMonths, weightKg: pet.weightKg,
                sex: pet.sex, activityLevel: pet.activityLevel,
                isPrimary: true, healthConditions: pet.healthConditions,
                photoData: pet.photoData
            )
        }
        pets.append(newPet)
        if newPet.isPrimary || selectedPet == nil {
            selectedPet = newPet
            saveSelectedPetId()
        }
        savePetsLocally()
        
        // Sync to server in background
        let petToSync = newPet
        Task {
            guard isAuthenticated else { return }
            do {
                let conditions = petToSync.healthConditions.map { c in
                    CreateHealthCondition(
                        type: c.conditionType.rawValue,
                        severity: c.severity.rawValue,
                        notes: c.notes
                    )
                }
                
                let serverPet = try await petService.createPet(
                    name: petToSync.name,
                    petType: petToSync.petType,
                    breed: petToSync.breed,
                    ageMonths: petToSync.ageMonths,
                    weightKg: petToSync.weightKg,
                    sex: petToSync.sex,
                    activityLevel: petToSync.activityLevel,
                    healthConditions: conditions.isEmpty ? nil : conditions
                )
                
                // Update local ID with server ID
                await MainActor.run {
                    if let index = self.pets.firstIndex(where: { $0.id == petToSync.id }) {
                        self.pets[index] = Pet(
                            id: serverPet.id, name: petToSync.name, petType: petToSync.petType,
                            breed: petToSync.breed, ageMonths: petToSync.ageMonths,
                            weightKg: petToSync.weightKg, sex: petToSync.sex,
                            activityLevel: petToSync.activityLevel,
                            isPrimary: petToSync.isPrimary,
                            healthConditions: petToSync.healthConditions,
                            photoData: petToSync.photoData
                        )
                        if self.selectedPet?.id == petToSync.id {
                            self.selectedPet = self.pets[index]
                            self.saveSelectedPetId()
                        }
                        self.savePetsLocally()
                    }
                }
                print("☁️ Pet created on server: \(serverPet.id)")
            } catch {
                print("⚠️ Server create failed for \(petToSync.name): \(error.localizedDescription)")
            }
        }
    }
    
    // MARK: - Update Pet (local + server)
    func updatePet(_ pet: Pet) {
        if let index = pets.firstIndex(where: { $0.id == pet.id }) {
            pets[index] = pet
            if selectedPet?.id == pet.id {
                selectedPet = pet
            }
            savePetsLocally()
        }
        
        // Sync to server in background
        let petToSync = pet
        Task {
            guard isAuthenticated else { return }
            do {
                _ = try await petService.updatePet(
                    id: petToSync.id,
                    name: petToSync.name,
                    petType: petToSync.petType,
                    breed: petToSync.breed,
                    ageMonths: petToSync.ageMonths,
                    weightKg: petToSync.weightKg,
                    sex: petToSync.sex,
                    activityLevel: petToSync.activityLevel,
                    healthConditions: petToSync.healthConditions
                )
                print("☁️ Pet updated on server: \(petToSync.id)")
            } catch {
                print("⚠️ Server update failed for \(petToSync.name): \(error.localizedDescription)")
            }
        }
    }
    
    // MARK: - Delete Pet (local + server)
    func deletePet(_ pet: Pet) {
        let petId = pet.id
        pets.removeAll { $0.id == petId }
        if selectedPet?.id == petId {
            selectedPet = pets.first
            saveSelectedPetId()
        }
        savePetsLocally()
        
        // Sync to server in background
        Task {
            guard isAuthenticated else { return }
            do {
                try await petService.deletePet(id: petId)
                print("☁️ Pet deleted on server: \(petId)")
            } catch {
                print("⚠️ Server delete failed for \(petId): \(error.localizedDescription)")
            }
        }
    }
    
    // MARK: - Set Primary Pet (local + server)
    func setPrimaryPet(_ pet: Pet) {
        for index in pets.indices {
            pets[index] = Pet(
                id: pets[index].id, name: pets[index].name, petType: pets[index].petType,
                breed: pets[index].breed, ageMonths: pets[index].ageMonths,
                weightKg: pets[index].weightKg, sex: pets[index].sex,
                activityLevel: pets[index].activityLevel,
                isPrimary: pets[index].id == pet.id,
                healthConditions: pets[index].healthConditions,
                photoData: pets[index].photoData
            )
        }
        selectedPet = pets.first(where: { $0.id == pet.id })
        savePetsLocally()
        
        // Sync to server in background
        let petId = pet.id
        Task {
            guard isAuthenticated else { return }
            do {
                try await petService.setPrimaryPet(id: petId)
                print("☁️ Primary pet set on server: \(petId)")
            } catch {
                print("⚠️ Server setPrimary failed: \(error.localizedDescription)")
            }
        }
    }
    
    // MARK: - Reset
    func resetApp() {
        UserDefaults.standard.removeObject(forKey: petsKey)
        UserDefaults.standard.removeObject(forKey: selectedPetIdKey)
        APIService.shared.authToken = nil
        selectedPet = nil
        pets = []
    }
}

