import Foundation

class PetService {
    static let shared = PetService()
    private let api = APIService.shared
    
    private init() {}
    
    // MARK: - Device Auth
    func authenticateDevice(deviceId: String) async throws -> DeviceAuthResponse {
        struct DeviceAuthRequest: Codable {
            let deviceId: String
        }
        
        let request = DeviceAuthRequest(deviceId: deviceId)
        let response: DeviceAuthResponse = try await api.request(
            endpoint: "/auth/device",
            method: "POST",
            body: request
        )
        return response
    }
    
    // MARK: - Get All Pets
    func getPets() async throws -> [Pet] {
        let response: PetsResponse = try await api.request(endpoint: "/pets")
        return response.pets
    }
    
    // MARK: - Get Pet by ID
    func getPet(id: String) async throws -> Pet {
        let response: PetResponse = try await api.request(endpoint: "/pets/\(id)")
        return response.pet
    }
    
    // MARK: - Create Pet
    func createPet(
        name: String,
        petType: PetType,
        breed: String?,
        ageMonths: Int?,
        weightKg: Double?,
        sex: PetSex?,
        activityLevel: ActivityLevel,
        healthConditions: [CreateHealthCondition]?
    ) async throws -> Pet {
        struct CreatePetRequest: Codable {
            let name: String
            let petType: String
            let breed: String?
            let ageMonths: Int?
            let weightKg: Double?
            let sex: String?
            let activityLevel: String
            let healthConditions: [CreateHealthCondition]?
        }
        
        let request = CreatePetRequest(
            name: name,
            petType: petType.rawValue,
            breed: breed,
            ageMonths: ageMonths,
            weightKg: weightKg,
            sex: sex?.rawValue,
            activityLevel: activityLevel.rawValue,
            healthConditions: healthConditions
        )
        
        let response: PetResponse = try await api.request(
            endpoint: "/pets",
            method: "POST",
            body: request
        )
        return response.pet
    }
    
    // MARK: - Update Pet (includes health conditions)
    func updatePet(
        id: String,
        name: String,
        petType: PetType,
        breed: String?,
        ageMonths: Int?,
        weightKg: Double?,
        sex: PetSex?,
        activityLevel: ActivityLevel,
        healthConditions: [HealthCondition]?
    ) async throws -> Pet {
        struct UpdateConditionDTO: Codable {
            let conditionType: String
            let severity: String
            let notes: String?
        }
        
        struct UpdatePetRequest: Codable {
            let name: String
            let petType: String
            let breed: String?
            let ageMonths: Int?
            let weightKg: Double?
            let sex: String?
            let activityLevel: String
            let healthConditions: [UpdateConditionDTO]?
        }
        
        let conditionDTOs = healthConditions?.map { c in
            UpdateConditionDTO(
                conditionType: c.conditionType.rawValue,
                severity: c.severity.rawValue,
                notes: c.notes
            )
        }
        
        let request = UpdatePetRequest(
            name: name,
            petType: petType.rawValue,
            breed: breed,
            ageMonths: ageMonths,
            weightKg: weightKg,
            sex: sex?.rawValue,
            activityLevel: activityLevel.rawValue,
            healthConditions: conditionDTOs
        )
        
        let response: PetResponse = try await api.request(
            endpoint: "/pets/\(id)",
            method: "PUT",
            body: request
        )
        return response.pet
    }
    
    // MARK: - Delete Pet
    func deletePet(id: String) async throws {
        let _: MessageResponse = try await api.request(
            endpoint: "/pets/\(id)",
            method: "DELETE"
        )
    }
    
    // MARK: - Set Primary Pet
    func setPrimaryPet(id: String) async throws {
        let _: MessageResponse = try await api.request(
            endpoint: "/pets/\(id)/primary",
            method: "POST"
        )
    }
    
    // MARK: - Add Health Condition
    func addCondition(
        petId: String,
        conditionType: ConditionType,
        severity: Severity,
        notes: String?
    ) async throws -> HealthCondition {
        struct AddConditionRequest: Codable {
            let conditionType: String
            let severity: String
            let notes: String?
        }
        
        struct ConditionResponse: Codable {
            let condition: HealthCondition
        }
        
        let request = AddConditionRequest(
            conditionType: conditionType.rawValue,
            severity: severity.rawValue,
            notes: notes
        )
        
        let response: ConditionResponse = try await api.request(
            endpoint: "/pets/\(petId)/conditions",
            method: "POST",
            body: request
        )
        return response.condition
    }
    
    // MARK: - Remove Health Condition
    func removeCondition(petId: String, conditionId: String) async throws {
        let _: MessageResponse = try await api.request(
            endpoint: "/pets/\(petId)/conditions/\(conditionId)",
            method: "DELETE"
        )
    }
}

// MARK: - Create Health Condition DTO
struct CreateHealthCondition: Codable {
    let type: String
    let severity: String
    let notes: String?
}

// MARK: - Device Auth Response
struct DeviceAuthResponse: Codable {
    let message: String
    let user: DeviceUser
    let token: String
    let isNewUser: Bool
    
    struct DeviceUser: Codable {
        let id: String
        let email: String
        let name: String?
    }
}

