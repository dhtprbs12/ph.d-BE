import Foundation

class ProductServiceClient {
    static let shared = ProductServiceClient()
    private let api = APIService.shared
    
    private init() {}
    
    // MARK: - Search Products
    func search(query: String, petType: PetType? = nil) async throws -> [Product] {
        var endpoint = "/products/search?q=\(query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query)"
        if let petType = petType {
            endpoint += "&petType=\(petType.rawValue)"
        }
        
        let response: ProductsResponse = try await api.request(
            endpoint: endpoint,
            requiresAuth: false
        )
        return response.products
    }
    
    // MARK: - Get Product
    func getProduct(id: String) async throws -> (Product, ReviewStats?) {
        let response: ProductResponse = try await api.request(
            endpoint: "/products/\(id)",
            requiresAuth: false
        )
        return (response.product, response.reviewStats)
    }
    
    // MARK: - Get Product by Barcode
    func getProductByBarcode(barcode: String) async throws -> Product {
        let response: ProductResponse = try await api.request(
            endpoint: "/products/barcode/\(barcode)",
            requiresAuth: false
        )
        return response.product
    }
    
    // MARK: - Analyze Product for Pet (returns tuple)
    func analyzeProductBasic(productId: String, petId: String) async throws -> (Product, Analysis) {
        struct AnalysisResponse: Codable {
            let product: Product
            let analysis: Analysis
        }
        
        let response: AnalysisResponse = try await api.request(
            endpoint: "/products/\(productId)/analyze?petId=\(petId)"
        )
        return (response.product, response.analysis)
    }
    
    // MARK: - Analyze Product for Pet (returns ScanResult for ResultView)
    func analyzeProduct(productId: String, pet: Pet) async throws -> ScanResult {
        print("🔍 [ProductService] Analyzing product ID: \(productId)")
        
        struct AnalysisResponse: Codable {
            let product: Product
            let analysis: Analysis
            let aiInsights: AIInsights?
        }
        
        // Build query params with pet info
        var params: [String] = []
        params.append("petId=\(pet.id)")
        params.append("petName=\(pet.name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? pet.name)")
        params.append("petType=\(pet.petType.rawValue)")
        if let breed = pet.breed {
            params.append("petBreed=\(breed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? breed)")
        }
        if let ageMonths = pet.ageMonths {
            params.append("petAgeMonths=\(ageMonths)")
        }
        if let weight = pet.weightKg {
            params.append("petWeight=\(weight)")
        }
        if !pet.healthConditions.isEmpty {
            let conditions = pet.healthConditions.map { ["condition_type": $0.conditionType.rawValue, "severity": $0.severity.rawValue] }
            if let data = try? JSONSerialization.data(withJSONObject: conditions),
               let json = String(data: data, encoding: .utf8)?.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
                params.append("healthConditions=\(json)")
            }
        }
        
        let endpoint = "/products/\(productId)/analyze?\(params.joined(separator: "&"))"
        print("🌐 [ProductService] Full endpoint: \(endpoint)")
        
        let response: AnalysisResponse = try await api.request(
            endpoint: endpoint,
            requiresAuth: false
        )
        
        // Build ScanResult from response
        return ScanResult(
            scanId: UUID().uuidString,
            scanType: "product_search",
            extracted: ScanResult.ExtractedInfo(
                productName: response.product.name,
                brand: response.product.brand,
                targetPet: response.product.targetPetType?.rawValue,
                ingredientCount: response.analysis.ingredients.count,
                confidence: 1.0
            ),
            product: ScanResult.ProductSummary(
                id: response.product.id,
                name: response.product.name,
                brand: response.product.brand,
                imageUrl: response.product.imageUrl,
                productType: response.product.productType?.rawValue
            ),
            analysis: response.analysis,
            aiInsights: response.aiInsights,
            pet: PetSummary(
                id: pet.id,
                name: pet.name,
                petType: pet.petType.rawValue
            )
        )
    }
    
    // MARK: - Analyze Product as Generic Healthy Pet (pet type mismatch)
    func analyzeProduct(productId: String, petType: String, petName: String) async throws -> ScanResult {
        print("🔍 [ProductService] Analyzing product ID: \(productId) as \(petName)")
        
        struct AnalysisResponse: Codable {
            let product: Product
            let analysis: Analysis
            let aiInsights: AIInsights?
        }
        
        var params: [String] = []
        params.append("petName=\(petName.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? petName)")
        params.append("petType=\(petType)")
        
        let endpoint = "/products/\(productId)/analyze?\(params.joined(separator: "&"))"
        print("🌐 [ProductService] Full endpoint: \(endpoint)")
        
        let response: AnalysisResponse = try await api.request(
            endpoint: endpoint,
            requiresAuth: false
        )
        
        return ScanResult(
            scanId: UUID().uuidString,
            scanType: "product_search",
            extracted: ScanResult.ExtractedInfo(
                productName: response.product.name,
                brand: response.product.brand,
                targetPet: response.product.targetPetType?.rawValue,
                ingredientCount: response.analysis.ingredients.count,
                confidence: 1.0
            ),
            product: ScanResult.ProductSummary(
                id: response.product.id,
                name: response.product.name,
                brand: response.product.brand,
                imageUrl: response.product.imageUrl,
                productType: response.product.productType?.rawValue
            ),
            analysis: response.analysis,
            aiInsights: response.aiInsights,
            pet: PetSummary(
                id: nil,
                name: petName,
                petType: petType
            )
        )
    }
    
    // MARK: - Get Alternatives
    func getAlternatives(productId: String, pet: Pet, limit: Int = 5) async throws -> [AlternativeProduct] {
        struct AlternativesRequest: Codable {
            let petType: String
            let healthConditions: [[String: String]]
            let petName: String
            let limit: Int
        }
        
        let conditions = pet.healthConditions.map {
            ["condition_type": $0.conditionType.rawValue, "severity": $0.severity.rawValue]
        }
        
        let response: AlternativesResponse = try await api.request(
            endpoint: "/products/\(productId)/alternatives",
            method: "POST",
            body: AlternativesRequest(
                petType: pet.petType.rawValue,
                healthConditions: conditions,
                petName: pet.name,
                limit: limit
            ),
            requiresAuth: false
        )
        return response.alternatives
    }
    
    // MARK: - Get Reviews
    func getReviews(
        productId: String,
        petType: PetType? = nil,
        petSize: String? = nil
    ) async throws -> (reviews: [Review], stats: ReviewStats) {
        var endpoint = "/products/\(productId)/reviews?"
        if let petType = petType {
            endpoint += "petType=\(petType.rawValue)&"
        }
        if let petSize = petSize {
            endpoint += "petSize=\(petSize)&"
        }
        
        let response: ReviewsResponse = try await api.request(
            endpoint: endpoint,
            requiresAuth: false
        )
        return (response.reviews, response.stats)
    }
    
    // MARK: - Add Review
    func addReview(
        productId: String,
        petId: String,
        rating: Int,
        title: String?,
        content: String?
    ) async throws {
        struct ReviewRequest: Codable {
            let petId: String
            let rating: Int
            let title: String?
            let content: String?
        }
        
        let _: MessageResponse = try await api.request(
            endpoint: "/products/\(productId)/reviews",
            method: "POST",
            body: ReviewRequest(
                petId: petId,
                rating: rating,
                title: title,
                content: content
            )
        )
    }
    
    // MARK: - Get Similar Pet Reviews
    func getSimilarPetReviews(productId: String, petId: String) async throws -> [Review] {
        struct SimilarReviewsResponse: Codable {
            let reviews: [Review]
        }
        
        let response: SimilarReviewsResponse = try await api.request(
            endpoint: "/reviews/similar-pets/\(productId)?petId=\(petId)"
        )
        return response.reviews
    }
    
    // MARK: - Filter Products (Advanced Search)
    /// Returns products and inline personalized scores (computed server-side)
    func filterProducts(
        searchTerm: String? = nil,
        petType: PetType? = nil,
        productType: String? = nil,
        lifeStage: String? = nil,
        allergenExclusions: [String] = [],
        ingredientInclusions: [String] = [],
        pet: Pet? = nil,
        minScore: Int? = nil,
        limit: Int = 20,
        offset: Int = 0
    ) async throws -> (products: [Product], scores: [String: CachedScore]) {
        var params: [String] = []
        
        if let q = searchTerm, !q.isEmpty {
            params.append("q=\(q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q)")
        }
        if let petType = petType {
            params.append("petType=\(petType.rawValue)")
        }
        if let productType = productType {
            params.append("productType=\(productType)")
        }
        if let lifeStage = lifeStage {
            params.append("lifeStage=\(lifeStage)")
        }
        for allergen in allergenExclusions {
            params.append("\(allergen)=true")
        }
        for inclusion in ingredientInclusions {
            params.append("with\(inclusion.capitalized)=true")
        }
        // Pass pet health conditions for inline score computation
        // When pet is provided, always send healthConditions (empty [] for healthy pet)
        // When pet is nil (e.g. dog owner browsing cat products), omit entirely to skip scoring
        if let pet = pet {
            if pet.healthConditions.isEmpty {
                params.append("healthConditions=%5B%5D")
            } else {
                let conditions = pet.healthConditions.map { ["condition_type": $0.conditionType.rawValue, "severity": $0.severity.rawValue] }
                if let data = try? JSONSerialization.data(withJSONObject: conditions),
                   let json = String(data: data, encoding: .utf8)?.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
                    params.append("healthConditions=\(json)")
                }
            }
        }
        if let minScore = minScore {
            params.append("minScore=\(minScore)")
        }
        params.append("limit=\(limit)")
        params.append("offset=\(offset)")
        
        let endpoint = "/products/filter?\(params.joined(separator: "&"))"
        
        struct FilterResponse: Codable {
            let products: [Product]
            let scores: [String: CachedScore]?
        }
        
        let response: FilterResponse = try await api.request(
            endpoint: endpoint,
            requiresAuth: false
        )
        return (response.products, response.scores ?? [:])
    }
    
    // MARK: - Fetch Product Image (lightweight, on-demand)
    func fetchProductImage(productId: String) async throws -> String? {
        struct ImageResponse: Codable {
            let imageUrl: String?
        }
        
        let response: ImageResponse = try await api.request(
            endpoint: "/products/\(productId)/image",
            requiresAuth: false
        )
        return response.imageUrl
    }
    
    // MARK: - Batch Get Cached Scores
    /// Get personalized cached scores for multiple products
    /// Returns scores only for products that have been analyzed for this pet's conditions
    func getBatchCachedScores(
        productIds: [String],
        pet: Pet
    ) async throws -> [String: CachedScore] {
        struct BatchRequest: Codable {
            let productIds: [String]
            let petType: String
            let healthConditions: [[String: String]]
        }
        
        struct BatchResponse: Codable {
            let scores: [String: CachedScore]
        }
        
        // Convert health conditions to format expected by backend
        let conditions = pet.healthConditions.map {
            ["condition_type": $0.conditionType.rawValue, "severity": $0.severity.rawValue]
        }
        
        let response: BatchResponse = try await api.request(
            endpoint: "/products/batch-scores",
            method: "POST",
            body: BatchRequest(
                productIds: productIds,
                petType: pet.petType.rawValue,
                healthConditions: conditions
            ),
            requiresAuth: false
        )
        
        return response.scores
    }
}

// MARK: - Cached Score
struct CachedScore: Codable {
    let score: Int
    let grade: String
    let recommendation: String?
    let conditionWarnings: [ConditionWarning]?
}

