import Foundation
import UIKit
import SwiftUI

// MARK: - Pet
struct Pet: Codable, Identifiable {
    let id: String
    var name: String
    var petType: PetType
    var breed: String?
    var ageMonths: Int?
    var weightKg: Double?
    var sex: PetSex?
    var activityLevel: ActivityLevel
    var isPrimary: Bool
    var healthConditions: [HealthCondition]
    var photoData: Data?  // Pet's photo stored as Data
    
    enum CodingKeys: String, CodingKey {
        case id, name, breed, sex, photoData
        case petType = "pet_type"
        case ageMonths = "age_months"
        case weightKg = "weight_kg"
        case activityLevel = "activity_level"
        case isPrimary = "is_primary"
        case healthConditions = "healthConditions"
    }
    
    // Custom initializer with default values for optional parameters
    init(
        id: String,
        name: String,
        petType: PetType,
        breed: String? = nil,
        ageMonths: Int? = nil,
        weightKg: Double? = nil,
        sex: PetSex? = nil,
        activityLevel: ActivityLevel,
        isPrimary: Bool,
        healthConditions: [HealthCondition],
        photoData: Data? = nil
    ) {
        self.id = id
        self.name = name
        self.petType = petType
        self.breed = breed
        self.ageMonths = ageMonths
        self.weightKg = weightKg
        self.sex = sex
        self.activityLevel = activityLevel
        self.isPrimary = isPrimary
        self.healthConditions = healthConditions
        self.photoData = photoData
    }
    
    // Helper to get UIImage from photoData
    var photo: UIImage? {
        guard let data = photoData else { return nil }
        return UIImage(data: data)
    }
    
    var displayAge: String {
        guard let months = ageMonths else { return "Unknown" }
        if months < 12 {
            return "\(months) months"
        } else {
            let years = months / 12
            let remainingMonths = months % 12
            if remainingMonths == 0 {
                return "\(years) \(years == 1 ? "year" : "years")"
            }
            return "\(years)y \(remainingMonths)m"
        }
    }
    
    var displayWeight: String {
        guard let kg = weightKg else { return "Unknown" }
        let lbs = kg / 0.453592  // Convert kg to lbs for display
        return String(format: "%.1f lbs", lbs)
    }
}

enum PetType: String, Codable, CaseIterable {
    case dog
    case cat
    
    var displayName: String {
        switch self {
        case .dog: return "Dog"
        case .cat: return "Cat"
        }
    }
    
    var icon: String {
        switch self {
        case .dog: return "🐕"
        case .cat: return "🐱"
        }
    }
}

enum PetSex: String, Codable, CaseIterable {
    case male
    case female
    case neuteredMale = "neutered_male"
    case spayedFemale = "spayed_female"
    
    var displayName: String {
        switch self {
        case .male: return "Male"
        case .female: return "Female"
        case .neuteredMale: return "Neutered Male"
        case .spayedFemale: return "Spayed Female"
        }
    }
}

enum ActivityLevel: String, Codable, CaseIterable {
    case low
    case moderate
    case high
    
    var displayName: String {
        rawValue.capitalized
    }
}

// MARK: - Health Conditions
struct HealthCondition: Codable, Identifiable {
    let id: String
    let conditionType: ConditionType
    var severity: Severity
    var notes: String?
    
    enum CodingKeys: String, CodingKey {
        case id, severity, notes
        case conditionType = "condition_type"
    }
}

enum ConditionType: String, Codable, CaseIterable {
    case allergyChicken = "allergy_chicken"
    case allergyBeef = "allergy_beef"
    case allergyFish = "allergy_fish"
    case allergyDairy = "allergy_dairy"
    case allergyGrains = "allergy_grains"
    case allergyEggs = "allergy_eggs"
    case allergySoy = "allergy_soy"
    case allergyLamb = "allergy_lamb"
    case digestiveSensitivity = "digestive_sensitivity"
    case skinIssues = "skin_issues"
    case jointIssues = "joint_issues"
    case kidneyDisease = "kidney_disease"
    case liverDisease = "liver_disease"
    case heartDisease = "heart_disease"
    case diabetes
    case obesity
    case urinaryIssues = "urinary_issues"
    case thyroidIssues = "thyroid_issues"
    case pancreatitis
    case ibd
    
    var displayName: String {
        switch self {
        case .allergyChicken: return "Chicken Allergy"
        case .allergyBeef: return "Beef Allergy"
        case .allergyFish: return "Fish Allergy"
        case .allergyDairy: return "Dairy Allergy"
        case .allergyGrains: return "Grain Allergy"
        case .allergyEggs: return "Egg Allergy"
        case .allergySoy: return "Soy Allergy"
        case .allergyLamb: return "Lamb Allergy"
        case .digestiveSensitivity: return "Digestive Sensitivity"
        case .skinIssues: return "Skin Issues"
        case .jointIssues: return "Joint Issues"
        case .kidneyDisease: return "Kidney Disease"
        case .liverDisease: return "Liver Disease"
        case .heartDisease: return "Heart Disease"
        case .diabetes: return "Diabetes"
        case .obesity: return "Obesity"
        case .urinaryIssues: return "Urinary Issues"
        case .thyroidIssues: return "Thyroid Issues"
        case .pancreatitis: return "Pancreatitis"
        case .ibd: return "IBD"
        }
    }
    
    var isAllergy: Bool {
        rawValue.starts(with: "allergy_")
    }
    
    var category: String {
        if isAllergy { return "Allergies" }
        switch self {
        case .digestiveSensitivity, .pancreatitis, .ibd:
            return "Digestive"
        case .kidneyDisease, .liverDisease, .urinaryIssues:
            return "Organ Health"
        case .heartDisease, .diabetes, .obesity, .thyroidIssues:
            return "Metabolic"
        case .skinIssues, .jointIssues:
            return "Physical"
        default:
            return "Other"
        }
    }
}

enum Severity: String, Codable, CaseIterable {
    case mild
    case moderate
    case severe
    
    var displayName: String {
        rawValue.capitalized
    }
    
    var color: String {
        switch self {
        case .mild: return "yellow"
        case .moderate: return "orange"
        case .severe: return "red"
        }
    }
}

// MARK: - Product
struct Product: Codable, Identifiable, Hashable {
    let id: String
    var barcode: String?
    var name: String
    var brand: String?
    var productType: ProductType?
    var texture: ProductTexture?
    var targetPetType: TargetPetType?
    var targetLifeStage: LifeStage?
    var imageUrl: String?
    var rawIngredientsText: String?
    var baseDogScore: Int?
    var baseCatScore: Int?
    var verified: Bool?
    var scanCount: Int?
    
    enum CodingKeys: String, CodingKey {
        case id, barcode, name, brand, verified, texture
        case productType = "product_type"
        case targetPetType = "target_pet_type"
        case targetLifeStage = "target_life_stage"
        case imageUrl = "image_url"
        case rawIngredientsText = "raw_ingredients_text"
        case baseDogScore = "base_dog_score"
        case baseCatScore = "base_cat_score"
        case scanCount = "scan_count"
    }
    
    // Custom decoder to handle verified as both Int (0/1) or Bool
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        barcode = try container.decodeIfPresent(String.self, forKey: .barcode)
        name = try container.decode(String.self, forKey: .name)
        brand = try container.decodeIfPresent(String.self, forKey: .brand)
        productType = try container.decodeIfPresent(ProductType.self, forKey: .productType)
        texture = try container.decodeIfPresent(ProductTexture.self, forKey: .texture)
        targetPetType = try container.decodeIfPresent(TargetPetType.self, forKey: .targetPetType)
        targetLifeStage = try container.decodeIfPresent(LifeStage.self, forKey: .targetLifeStage)
        imageUrl = try container.decodeIfPresent(String.self, forKey: .imageUrl)
        rawIngredientsText = try container.decodeIfPresent(String.self, forKey: .rawIngredientsText)
        baseDogScore = try container.decodeIfPresent(Int.self, forKey: .baseDogScore)
        baseCatScore = try container.decodeIfPresent(Int.self, forKey: .baseCatScore)
        scanCount = try container.decodeIfPresent(Int.self, forKey: .scanCount)
        
        // Handle verified as either Bool or Int (MySQL returns 0/1)
        if let boolValue = try? container.decodeIfPresent(Bool.self, forKey: .verified) {
            verified = boolValue
        } else if let intValue = try? container.decodeIfPresent(Int.self, forKey: .verified) {
            verified = intValue == 1
        } else {
            verified = nil
        }
    }
}

enum ProductTexture: String, Codable {
    case dry
    case wet
    case semiMoist = "semi_moist"
    case freezeDried = "freeze_dried"
}

enum ProductType: String, Codable {
    case dryFood = "dry_food"
    case wetFood = "wet_food"
    case treats
    case supplement
    case other
}

enum TargetPetType: String, Codable {
    case dog
    case cat
    case both
}

enum LifeStage: String, Codable {
    case puppyKitten = "puppy_kitten"
    case adult
    case senior
    case all
}

// MARK: - Analysis Result
struct AnalysisResult: Codable, Hashable {
    let finalScore: Int
    let grade: Grade
    let recommendation: Recommendation
    let summary: String
    let ingredients: [IngredientAnalysis]
    let warnings: [Warning]
    let positives: [Positive]
    let hasTaurine: Bool?
    let toxicCount: Int?
    let allergenCount: Int?
    let healthConcernCount: Int?
}

enum Grade: String, Codable {
    case A, B, C, D, F
    
    var color: String {
        switch self {
        case .A: return "green"
        case .B: return "teal"
        case .C: return "yellow"
        case .D: return "orange"
        case .F: return "red"
        }
    }
    
    var description: String {
        switch self {
        case .A: return "Excellent"
        case .B: return "Good"
        case .C: return "Acceptable"
        case .D: return "Caution"
        case .F: return "Not Recommended"
        }
    }
}

enum Recommendation: String, Codable {
    case highlyRecommended = "highly_recommended"
    case recommended
    case acceptable
    case caution
    case notRecommended = "not_recommended"
}

struct IngredientAnalysis: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let normalizedName: String?
    let position: Int
    let riskLevel: String
    let adjustedRiskScore: Double
    let isToxic: Bool
    let isAllergenMatch: Bool
    let isHealthConcern: Bool
    let hasTaurine: Bool?
    let explanation: String?
    let positiveBenefit: String?
    
    init(name: String, normalizedName: String?, position: Int, riskLevel: String,
         adjustedRiskScore: Double, isToxic: Bool, isAllergenMatch: Bool, isHealthConcern: Bool,
         hasTaurine: Bool?, explanation: String?, positiveBenefit: String?) {
        self.name = name
        self.normalizedName = normalizedName
        self.position = position
        self.riskLevel = riskLevel
        self.adjustedRiskScore = adjustedRiskScore
        self.isToxic = isToxic
        self.isAllergenMatch = isAllergenMatch
        self.isHealthConcern = isHealthConcern
        self.hasTaurine = hasTaurine
        self.explanation = explanation
        self.positiveBenefit = positiveBenefit
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        normalizedName = try? container.decodeIfPresent(String.self, forKey: .normalizedName)
        position = (try? container.decode(Int.self, forKey: .position)) ?? 0
        riskLevel = (try? container.decode(String.self, forKey: .riskLevel)) ?? "safe"
        if let dbl = try? container.decode(Double.self, forKey: .adjustedRiskScore) {
            adjustedRiskScore = dbl
        } else if let intVal = try? container.decode(Int.self, forKey: .adjustedRiskScore) {
            adjustedRiskScore = Double(intVal)
        } else {
            adjustedRiskScore = 0
        }
        isToxic = (try? container.decode(Bool.self, forKey: .isToxic)) ?? false
        isAllergenMatch = (try? container.decode(Bool.self, forKey: .isAllergenMatch)) ?? false
        isHealthConcern = (try? container.decode(Bool.self, forKey: .isHealthConcern)) ?? false
        hasTaurine = try? container.decodeIfPresent(Bool.self, forKey: .hasTaurine)
        explanation = try? container.decodeIfPresent(String.self, forKey: .explanation)
        positiveBenefit = try? container.decodeIfPresent(String.self, forKey: .positiveBenefit)
    }
}

enum RiskLevel: String, Codable {
    case safe
    case low
    case moderate
    case high
    case danger
    
    var color: String {
        switch self {
        case .safe: return "green"
        case .low: return "teal"
        case .moderate: return "yellow"
        case .high: return "orange"
        case .danger: return "red"
        }
    }
}

struct Warning: Codable, Identifiable, Hashable {
    var id: String { ingredient }
    let ingredient: String
    let level: String
    let reason: String
}

struct Positive: Codable, Identifiable, Hashable {
    var id: String { ingredient }
    let ingredient: String
    let benefit: String
}

// MARK: - AI Insights
struct AIInsights: Codable, Hashable {
    let personalizedSummary: String?
    let topConcerns: [String]?
    let topBenefits: [String]?
    let feedingTip: String?
    let alternativeAdvice: String?
    let confidenceNote: String?
    let aiGenerated: Bool?
}

// MARK: - Scan Result
struct ScanResult: Codable, Hashable {
    let scanId: String
    let scanType: String  // Changed from enum to String for flexibility
    let extracted: ExtractedInfo?
    let product: ProductSummary?
    let analysis: Analysis
    let aiInsights: AIInsights?  // AI-generated personalized insights
    let pet: PetSummary
    
    struct ExtractedInfo: Codable, Hashable {
        let productName: String?
        let brand: String?
        let targetPet: String?
        let ingredientCount: Int?
        let confidence: Double?
    }
    
    struct ProductSummary: Codable, Hashable {
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
}

// Analysis type (matches backend response)
struct Analysis: Codable, Hashable {
    let finalScore: Int
    let grade: String
    let recommendation: String
    let ingredients: [IngredientAnalysis]
    let warnings: [Warning]?
    let positives: [String]?
    let summary: String?
    let hasTaurine: Bool?
    let toxicCount: Int?
    let allergenCount: Int?
    let healthConcernCount: Int?
    let keyIssues: [String]?
    let proteinQuality: String?
    let hasArtificialAdditives: Bool?
    
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Accept both Int and Double for finalScore (AI may return 97.5)
        if let intVal = try? container.decode(Int.self, forKey: .finalScore) {
            finalScore = intVal
        } else if let doubleVal = try? container.decode(Double.self, forKey: .finalScore) {
            finalScore = Int(doubleVal.rounded())
        } else {
            finalScore = 0
        }
        grade = try container.decode(String.self, forKey: .grade)
        recommendation = (try? container.decode(String.self, forKey: .recommendation)) ?? "unknown"
        ingredients = (try? container.decode([IngredientAnalysis].self, forKey: .ingredients)) ?? []
        warnings = try? container.decodeIfPresent([Warning].self, forKey: .warnings)
        positives = try? container.decodeIfPresent([String].self, forKey: .positives)
        summary = try? container.decodeIfPresent(String.self, forKey: .summary)
        hasTaurine = try? container.decodeIfPresent(Bool.self, forKey: .hasTaurine)
        toxicCount = try? container.decodeIfPresent(Int.self, forKey: .toxicCount)
        allergenCount = try? container.decodeIfPresent(Int.self, forKey: .allergenCount)
        healthConcernCount = try? container.decodeIfPresent(Int.self, forKey: .healthConcernCount)
        keyIssues = try? container.decodeIfPresent([String].self, forKey: .keyIssues)
        proteinQuality = try? container.decodeIfPresent(String.self, forKey: .proteinQuality)
        hasArtificialAdditives = try? container.decodeIfPresent(Bool.self, forKey: .hasArtificialAdditives)
    }
    
    init(finalScore: Int, grade: String, recommendation: String, ingredients: [IngredientAnalysis],
         warnings: [Warning]? = nil, positives: [String]? = nil, summary: String? = nil,
         hasTaurine: Bool? = nil, toxicCount: Int? = nil, allergenCount: Int? = nil,
         healthConcernCount: Int? = nil, keyIssues: [String]? = nil,
         proteinQuality: String? = nil, hasArtificialAdditives: Bool? = nil) {
        self.finalScore = finalScore
        self.grade = grade
        self.recommendation = recommendation
        self.ingredients = ingredients
        self.warnings = warnings
        self.positives = positives
        self.summary = summary
        self.hasTaurine = hasTaurine
        self.toxicCount = toxicCount
        self.allergenCount = allergenCount
        self.healthConcernCount = healthConcernCount
        self.keyIssues = keyIssues
        self.proteinQuality = proteinQuality
        self.hasArtificialAdditives = hasArtificialAdditives
    }
}

enum ScanType: String, Codable {
    case barcode
    case labelPhoto = "label_photo"
    case manualInput = "manual_input"
}

struct PetSummary: Codable, Hashable {
    let id: String?  // Optional - may not be present for local pets
    let name: String
    let petType: String  // Changed from PetType enum to String for flexibility
    
    enum CodingKeys: String, CodingKey {
        case id, name
        case petType = "petType"
    }
}

// MARK: - Review
struct Review: Codable, Identifiable {
    let id: String
    let productId: String
    let rating: Int
    var title: String?
    var content: String?
    let petType: PetType
    var petBreed: String?
    var petSize: String?
    var petAgeGroup: String?
    var hasAllergies: Bool
    var hasHealthConditions: Bool
    var helpfulCount: Int
    let createdAt: String
    
    enum CodingKeys: String, CodingKey {
        case id, rating, title, content
        case productId = "product_id"
        case petType = "pet_type"
        case petBreed = "pet_breed"
        case petSize = "pet_size"
        case petAgeGroup = "pet_age_group"
        case hasAllergies = "has_allergies"
        case hasHealthConditions = "has_health_conditions"
        case helpfulCount = "helpful_count"
        case createdAt = "created_at"
    }
}

struct ReviewStats: Codable {
    let totalReviews: Int
    let averageRating: Double
    let positiveCount: Int?
    let negativeCount: Int?
    
    enum CodingKeys: String, CodingKey {
        case totalReviews = "total_reviews"
        case averageRating = "average_rating"
        case positiveCount = "positive_count"
        case negativeCount = "negative_count"
    }
}

// MARK: - Scan History
struct ScanHistoryItem: Codable, Identifiable {
    let id: String
    let scanType: String  // Changed to String for flexibility
    let finalScore: Int
    let grade: String  // Changed to String for flexibility
    let productName: String?
    let productBrand: String?
    let productImage: String?
    let petName: String?
    let petType: String?  // Changed to String for flexibility
    let createdAt: String
    
    enum CodingKeys: String, CodingKey {
        case id, grade
        case scanType = "scan_type"
        case finalScore = "final_score"
        case productName = "product_name"
        case productBrand = "product_brand"
        case productImage = "product_image"
        case petName = "pet_name"
        case petType = "pet_type"
        case createdAt = "created_at"
    }
}

// MARK: - Alternative Product
struct AlternativeProduct: Codable, Identifiable {
    let product: Product
    let score: Int
    let grade: String  // Changed to String for flexibility
    
    var id: String { product.id }
}

// MARK: - Community Stats (for trust indicators)
struct CommunityStats: Codable {
    let totalScans: Int
    let verifiedProducts: Int
    let ingredientsAnalyzed: Int
    let lastUpdated: String?
    
    var formattedTotalScans: String {
        if totalScans >= 1000000 {
            return String(format: "%.1fM+", Double(totalScans) / 1_000_000)
        } else if totalScans >= 1000 {
            return String(format: "%.1fK+", Double(totalScans) / 1_000)
        }
        return "\(totalScans)"
    }
}

// MARK: - User Stats & Badge (for gamification)
struct UserStats: Codable {
    let scanCount: Int
    let badge: UserBadge
}

struct UserBadge: Codable {
    let title: String
    let level: Int
    let icon: String
    let nextAt: Int?
    let color: String
    let progress: Int?
    
    var swiftUIColor: Color {
        Color(hex: color)
    }
}

