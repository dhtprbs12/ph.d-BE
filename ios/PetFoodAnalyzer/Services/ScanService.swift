import Foundation
import UIKit

// Response when front label is detected
struct FrontLabelDetectedResponse: Codable {
    let error: String
    let message: String
    let detected: DetectedInfo?
    let suggestion: String?
    
    struct DetectedInfo: Codable {
        let imageType: String?
        let productName: String?
        let brand: String?
        let targetPet: String?
    }
}

// Initial async response (immediate)
struct AsyncScanResponse: Codable {
    let scanId: String
    let status: String
    let message: String?
    let extracted: ExtractedInfo?
    let ingredients: [IngredientPreview]?
    let product: ProductInfo?
    let pet: PetInfo?
    
    struct ExtractedInfo: Codable {
        let productName: String?
        let brand: String?
        let targetPet: String?
        let ingredientCount: Int?
        let confidence: Double?
        let imageType: String?
    }
    
    struct IngredientPreview: Codable {
        let name: String
        let position: Int
        let status: String
    }
    
    struct ProductInfo: Codable {
        let id: String?
        let name: String?
        let brand: String?
    }
    
    struct PetInfo: Codable {
        let id: String?
        let name: String?
        let petType: String?
    }
}

// Polling response
struct PollResponse: Codable {
    let status: String
    let progress: String?
    let elapsedSeconds: Int?
    let duration: Double?
    // Full result fields (when complete)
    let scanId: String?
    let analysis: Analysis?
    let aiInsights: AIInsights?
    let extracted: ExtractedInfoResponse?
    let product: ProductInfoResponse?
    let pet: PetInfoResponse?
    
    struct ExtractedInfoResponse: Codable {
        let productName: String?
        let brand: String?
        let targetPet: String?
        let ingredientCount: Int?
        let confidence: Double?
    }
    
    struct ProductInfoResponse: Codable {
        let id: String?
        let name: String?
        let brand: String?
        let imageUrl: String?
        let productType: String?
        
        enum CodingKeys: String, CodingKey {
            case id, name, brand
            case imageUrl = "image_url"
            case productType = "product_type"
        }
    }
    
    struct PetInfoResponse: Codable {
        let id: String?
        let name: String?
        let petType: String?
    }
}

enum ScanError: Error {
    case frontLabelDetected(message: String, suggestion: String?, productName: String?)
    case noIngredientsFound(message: String)
    case apiError(String)
    case analysisTimeout
}

class ScanService {
    static let shared = ScanService()
    private let api = APIService.shared
    
    private init() {}
    
    // Get device ID for optional tracking
    private var deviceId: String {
        UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
    }
    
    // Callback for progress updates
    typealias ProgressCallback = (String, AsyncScanResponse?) -> Void
    
    // MARK: - Label Photo Scan (Smart Detection) with Progressive Loading
    func scanLabelPhoto(
        image: UIImage,
        pet: Pet,
        progressCallback: ProgressCallback? = nil
    ) async throws -> ScanResult {
        guard let imageData = image.jpegData(compressionQuality: 0.8) else {
            throw APIError.invalidURL
        }
        
        // Build pet fields for the request
        var fields: [String: String] = [
            "petName": pet.name,
            "petType": pet.petType.rawValue,
            "deviceId": deviceId
        ]
        
        if let breed = pet.breed { fields["petBreed"] = breed }
        if let age = pet.ageMonths { fields["petAgeMonths"] = String(age) }
        if let weight = pet.weightKg { fields["petWeightKg"] = String(weight) }
        
        // Encode health conditions as JSON
        if !pet.healthConditions.isEmpty {
            if let data = try? JSONEncoder().encode(pet.healthConditions) {
                fields["petHealthConditions"] = String(data: data, encoding: .utf8)
            }
        }
        
        do {
            // Use async mode for progressive loading
            let asyncResponse: AsyncScanResponse = try await api.uploadImage(
                endpoint: "/scan/label?async=true",
                imageData: imageData,
                additionalFields: fields
            )
            
            // Notify callback with initial data
            progressCallback?("Product detected: \(asyncResponse.extracted?.productName ?? "Unknown")", asyncResponse)
            
            // Poll for full result
            return try await pollForResult(
                scanId: asyncResponse.scanId,
                initialResponse: asyncResponse,
                pet: pet,
                progressCallback: progressCallback
            )
            
        } catch let error as APIError {
            // Check if this is a front label detection response
            if case .serverError(let message, let data) = error, let data = data {
                if let frontLabelResponse = try? JSONDecoder().decode(FrontLabelDetectedResponse.self, from: data) {
                    if frontLabelResponse.error == "front_label_detected" {
                        throw ScanError.frontLabelDetected(
                            message: frontLabelResponse.message,
                            suggestion: frontLabelResponse.suggestion,
                            productName: frontLabelResponse.detected?.productName
                        )
                    } else if frontLabelResponse.error == "no_ingredients_found" {
                        throw ScanError.noIngredientsFound(message: frontLabelResponse.message)
                    }
                }
            }
            throw error
        }
    }
    
    // Legacy method without progress callback
    func scanLabelPhoto(image: UIImage, pet: Pet) async throws -> ScanResult {
        return try await scanLabelPhoto(image: image, pet: pet, progressCallback: nil)
    }
    
    // MARK: - Poll for Result
    private func pollForResult(
        scanId: String,
        initialResponse: AsyncScanResponse,
        pet: Pet,
        progressCallback: ProgressCallback?,
        maxWaitSeconds: Int = 120
    ) async throws -> ScanResult {
        let startTime = Date()
        let pollInterval: UInt64 = 1_500_000_000 // 1.5 seconds in nanoseconds
        
        while Date().timeIntervalSince(startTime) < Double(maxWaitSeconds) {
            // Wait before polling
            try await Task.sleep(nanoseconds: pollInterval)
            
            // Poll for status
            let pollResponse: PollResponse = try await api.request(endpoint: "/scan/\(scanId)/result")
            
            if pollResponse.status == "complete" {
                // Convert poll response to ScanResult
                let extractedInfo: ScanResult.ExtractedInfo?
                if let pollExtracted = pollResponse.extracted {
                    extractedInfo = ScanResult.ExtractedInfo(
                        productName: pollExtracted.productName,
                        brand: pollExtracted.brand,
                        targetPet: pollExtracted.targetPet,
                        ingredientCount: pollExtracted.ingredientCount,
                        confidence: pollExtracted.confidence
                    )
                } else {
                    extractedInfo = ScanResult.ExtractedInfo(
                        productName: initialResponse.extracted?.productName,
                        brand: initialResponse.extracted?.brand,
                        targetPet: initialResponse.extracted?.targetPet,
                        ingredientCount: initialResponse.extracted?.ingredientCount,
                        confidence: initialResponse.extracted?.confidence
                    )
                }
                
                let productSummary: ScanResult.ProductSummary?
                if let pollProduct = pollResponse.product {
                    productSummary = ScanResult.ProductSummary(
                        id: pollProduct.id,
                        name: pollProduct.name,
                        brand: pollProduct.brand,
                        imageUrl: pollProduct.imageUrl,
                        productType: pollProduct.productType
                    )
                } else {
                    productSummary = nil
                }
                
                let petSummary: PetSummary
                if let pollPet = pollResponse.pet {
                    petSummary = PetSummary(
                        id: pollPet.id,
                        name: pollPet.name ?? pet.name,
                        petType: pollPet.petType ?? pet.petType.rawValue
                    )
                } else {
                    petSummary = PetSummary(
                        id: "local",
                        name: pet.name,
                        petType: pet.petType.rawValue
                    )
                }
                
                return ScanResult(
                    scanId: pollResponse.scanId ?? scanId,
                    scanType: "label_photo",
                    extracted: extractedInfo,
                    product: productSummary,
                    analysis: pollResponse.analysis ?? Analysis(
                        finalScore: 0,
                        grade: "?",
                        recommendation: "unknown",
                        ingredients: [],
                        warnings: nil,
                        positives: nil,
                        summary: "Analysis incomplete",
                        hasTaurine: nil,
                        toxicCount: nil,
                        allergenCount: nil,
                        healthConcernCount: nil,
                        keyIssues: nil,
                        proteinQuality: nil,
                        hasArtificialAdditives: nil
                    ),
                    aiInsights: pollResponse.aiInsights,
                    pet: petSummary
                )
            }
            
            if pollResponse.status == "error" {
                throw ScanError.apiError("Analysis failed")
            }
            
            // Still processing - update progress
            progressCallback?(pollResponse.progress ?? "Analyzing...", nil)
        }
        
        throw ScanError.analysisTimeout
    }
    
    // MARK: - Manual Ingredient Input
    func scanManualInput(ingredientsText: String, pet: Pet, productName: String?) async throws -> ScanResult {
        struct ManualRequest: Codable {
            let ingredientsText: String
            let productName: String?
            let petName: String
            let petType: String
            let petHealthConditions: String?
            let deviceId: String
        }
        
        var conditionsJson: String? = nil
        if !pet.healthConditions.isEmpty {
            if let data = try? JSONEncoder().encode(pet.healthConditions) {
                conditionsJson = String(data: data, encoding: .utf8)
            }
        }
        
        return try await api.request(
            endpoint: "/scan/manual",
            method: "POST",
            body: ManualRequest(
                ingredientsText: ingredientsText,
                productName: productName,
                petName: pet.name,
                petType: pet.petType.rawValue,
                petHealthConditions: conditionsJson,
                deviceId: deviceId
            )
        )
    }
    
    // MARK: - Get Scan History
    func getScanHistory(petId: String? = nil, limit: Int = 20) async throws -> [ScanHistoryItem] {
        var endpoint = "/scan/history?deviceId=\(deviceId)&limit=\(limit)"
        if let petId = petId {
            endpoint += "&petId=\(petId)"
        }
        
        let response: ScanHistoryResponse = try await api.request(endpoint: endpoint)
        return response.history
    }
    
    // MARK: - Get Scan Details
    func getScanDetails(scanId: String) async throws -> ScanHistoryItem {
        struct ScanResponse: Codable {
            let scan: ScanHistoryItem
        }
        
        let response: ScanResponse = try await api.request(endpoint: "/scan/\(scanId)")
        return response.scan
    }
    
    // MARK: - Two-Step Scanning
    
    /// Response from front label scan
    struct FrontScanResult {
        let pendingScanId: String
        let productName: String?
        let brand: String?
        let targetPet: String?
        let productType: String?
    }
    
    /// Step 1: Scan front label to get product name
    func scanFrontLabel(image: UIImage) async throws -> FrontScanResult {
        guard let imageData = image.jpegData(compressionQuality: 0.8) else {
            throw APIError.invalidURL
        }
        
        struct FrontResponse: Codable {
            let success: Bool?
            let pendingScanId: String
            let captured: CapturedInfo
            let nextStep: String?
            
            // Error fields
            let error: String?
            let message: String?
            let suggestion: String?
            
            struct CapturedInfo: Codable {
                let productName: String?
                let brand: String?
                let targetPet: String?
                let productType: String?
            }
        }
        
        do {
            let response: FrontResponse = try await api.uploadImage(
                endpoint: "/scan/front",
                imageData: imageData,
                additionalFields: [:]
            )
            
            return FrontScanResult(
                pendingScanId: response.pendingScanId,
                productName: response.captured.productName,
                brand: response.captured.brand,
                targetPet: response.captured.targetPet,
                productType: response.captured.productType
            )
        } catch APIError.serverError(let message, let data) {
            // Check for specific errors
            if let data = data,
               let errorResponse = try? JSONDecoder().decode(FrontResponse.self, from: data) {
                if errorResponse.error == "back_label_detected" {
                    throw ScanError.apiError(errorResponse.message ?? "This appears to be the back label. Please scan the front first.")
                }
                if errorResponse.error == "no_product_info" {
                    throw ScanError.apiError(errorResponse.message ?? "Could not detect product info. Please try again.")
                }
            }
            throw APIError.serverError(message, data)
        }
    }
    
    /// Step 2: Scan back label and combine with front label data
    func scanBackLabel(image: UIImage, pendingScanId: String, pet: Pet) async throws -> ScanResult {
        guard let imageData = image.jpegData(compressionQuality: 0.8) else {
            throw APIError.invalidURL
        }
        
        // Build pet fields
        var fields: [String: String] = [
            "petName": pet.name,
            "petType": pet.petType.rawValue,
            "deviceId": deviceId
        ]
        
        if let breed = pet.breed { fields["petBreed"] = breed }
        if let age = pet.ageMonths { fields["petAgeMonths"] = String(age) }
        if let weight = pet.weightKg { fields["petWeightKg"] = String(weight) }
        
        if !pet.healthConditions.isEmpty {
            if let data = try? JSONEncoder().encode(pet.healthConditions) {
                fields["petHealthConditions"] = String(data: data, encoding: .utf8)
            }
        }
        
        // Upload back label
        let asyncResponse: AsyncScanResponse = try await api.uploadImage(
            endpoint: "/scan/back/\(pendingScanId)",
            imageData: imageData,
            additionalFields: fields
        )
        
        // Poll for full result
        return try await pollForResult(
            scanId: asyncResponse.scanId,
            initialResponse: asyncResponse,
            pet: pet,
            progressCallback: nil
        )
    }
    
    // MARK: - Food Check (Single Food Item Safety)
    
    /// Check if a food item (from photo) is safe for a pet
    func checkFood(image: UIImage, pet: Pet) async throws -> FoodCheckResult {
        guard let imageData = image.jpegData(compressionQuality: 0.8) else {
            throw APIError.invalidURL
        }
        
        // Build pet fields
        var fields: [String: String] = [
            "petName": pet.name,
            "petType": pet.petType.rawValue,
            "deviceId": deviceId
        ]
        
        if let breed = pet.breed { fields["petBreed"] = breed }
        if let age = pet.ageMonths { fields["petAgeMonths"] = String(age) }
        if let weight = pet.weightKg { fields["petWeightKg"] = String(weight) }
        
        if !pet.healthConditions.isEmpty {
            if let data = try? JSONEncoder().encode(pet.healthConditions) {
                fields["petHealthConditions"] = String(data: data, encoding: .utf8)
            }
        }
        
        return try await api.uploadImage(
            endpoint: "/scan/food-check",
            imageData: imageData,
            additionalFields: fields
        )
    }
}

