import SwiftUI

struct ProductSearchView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    
    @State private var searchText = ""
    @State private var selectedFilters: Set<ProductFilter> = []
    @State private var searchResults: [Product] = []
    @State private var cachedScores: [String: CachedScore] = [:]  // productId -> cached score
    @State private var isLoading = false
    @State private var hasSearched = false
    
    // Determine selected pet type for dynamic life stage filters
    private var selectedPetTypeFilter: ProductFilter? {
        if selectedFilters.contains(.forDogs) { return .forDogs }
        if selectedFilters.contains(.forCats) { return .forCats }
        return nil
    }
    
    var body: some View {
        VStack(spacing: 0) {
            // Search Bar
            HStack(spacing: AppSpacing.sm) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.appTextSecondary)
                
                TextField("Search products or brands...", text: $searchText)
                    .textInputAutocapitalization(.never)
                    .onSubmit {
                        performSearch()
                    }
                
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                        performSearch()  // Update results when clearing
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.appTextSecondary)
                    }
                }
                
                // Search button
                Button {
                    performSearch()
                } label: {
                    Text("Search")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.white)
                        .padding(.horizontal, AppSpacing.md)
                        .padding(.vertical, AppSpacing.xs)
                        .background(Color.appOrange)
                        .cornerRadius(AppCornerRadius.small)
                }
            }
            .padding()
            .background(Color.appLightGray)
            .cornerRadius(AppCornerRadius.medium)
            .padding()
            
            // Filter Section
            ScrollView {
                VStack(alignment: .leading, spacing: AppSpacing.lg) {
                    // Filters
                    VStack(alignment: .leading, spacing: AppSpacing.sm) {
                        Text("Filters")
                            .font(AppTypography.labelMedium())
                            .foregroundColor(.appTextSecondary)
                            .padding(.horizontal)
                        
                        // Pet Type (single selection)
                        FilterCategory(title: "Pet Type", filters: ProductFilter.petTypeFilters, selectedFilters: $selectedFilters, isSingleSelection: true)
                        
                        // Food Type (single selection)
                        FilterCategory(title: "Food Type", filters: ProductFilter.foodTypeFilters, selectedFilters: $selectedFilters, isSingleSelection: true)
                        
                        // Life Stage (single selection, dynamic based on pet type)
                        FilterCategory(
                            title: "Life Stage",
                            filters: ProductFilter.lifeStageFilters(for: selectedPetTypeFilter),
                            selectedFilters: $selectedFilters,
                            isSingleSelection: true
                        )
                        
                        // Diet Type (single selection - grain-free OR with-grains)
                        FilterCategory(title: "Diet Type", filters: ProductFilter.dietFilters, selectedFilters: $selectedFilters, isSingleSelection: true)
                        
                        // Protein Type (single selection)
                        FilterCategory(title: "Protein", filters: ProductFilter.proteinFilters, selectedFilters: $selectedFilters, isSingleSelection: true)
                    }
                    
                    Divider()
                        .padding(.vertical, AppSpacing.sm)
                    
                    // Results Section
                    VStack(alignment: .leading, spacing: AppSpacing.md) {
                        if isLoading {
                            HStack {
                                Spacer()
                                ProgressView("Searching...")
                                Spacer()
                            }
                            .padding(.vertical, AppSpacing.xxl)
                        } else if hasSearched && searchResults.isEmpty {
                            EmptySearchResults()
                        } else if !searchResults.isEmpty {
                            HStack {
                                Text("\(searchResults.count) products found")
                                    .font(AppTypography.labelMedium())
                                    .foregroundColor(.appTextSecondary)
                                Spacer()
                            }
                            .padding(.horizontal)
                            .staggeredAppear(index: 0, baseDelay: 0.03)
                            
                            ForEach(Array(searchResults.enumerated()), id: \.element.id) { index, product in
                                ProductCard(
                                    product: product,
                                    pet: appState.selectedPet,
                                    cachedScore: cachedScores[product.id]
                                )
                                .padding(.horizontal)
                                .staggeredAppear(index: index + 1, baseDelay: 0.03)
                            }
                        } else {
                            // Initial state - show prompt
                            SearchPrompt()
                        }
                    }
                    
                    Spacer(minLength: AppSpacing.xxl)
                }
                .padding(.top, AppSpacing.sm)
            }
        }
        .background(Color.appBackground)
        .navigationTitle("Find Safe Food")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !selectedFilters.isEmpty {
                    Button("Reset") {
                        selectedFilters.removeAll()
                        searchText = ""
                        searchResults = []
                        cachedScores = [:]
                        hasSearched = false
                    }
                    .font(AppTypography.labelMedium())
                }
            }
        }
        .onChange(of: selectedFilters) { _ in
            // Auto-search when filters change
            performSearch()
        }
    }
    
    private func performSearch() {
        guard !searchText.isEmpty || !selectedFilters.isEmpty else { return }
        
        isLoading = true
        hasSearched = true
        
        Task {
            do {
                // Build filter parameters from user selections
                let allFilters = selectedFilters
                
                // Determine pet type from filters
                let petType: PetType? = allFilters.contains(.forDogs) ? .dog :
                                        allFilters.contains(.forCats) ? .cat : nil
                
                // Determine product type
                var productType: String? = nil
                if allFilters.contains(.dryFood) { productType = "dry_food" }
                else if allFilters.contains(.wetFood) { productType = "wet_food" }
                else if allFilters.contains(.treats) { productType = "treats" }
                else if allFilters.contains(.supplement) { productType = "supplement" }
                
                // Determine life stage (matches target_life_stage column values)
                var lifeStage: String? = nil
                if allFilters.contains(.puppy) || allFilters.contains(.kitten) { lifeStage = "puppy_kitten" }
                else if allFilters.contains(.adult) { lifeStage = "adult" }
                else if allFilters.contains(.senior) { lifeStage = "senior" }
                
                // Build allergen exclusions (for grain-free)
                var allergenExclusions: [String] = []
                if allFilters.contains(.grainFree) { allergenExclusions.append("noGrains") }
                
                // Build ingredient inclusions (protein types and grains)
                var ingredientInclusions: [String] = []
                if allFilters.contains(.withGrains) { ingredientInclusions.append("grains") }
                if allFilters.contains(.chicken) { ingredientInclusions.append("chicken") }
                if allFilters.contains(.beef) { ingredientInclusions.append("beef") }
                if allFilters.contains(.fish) { ingredientInclusions.append("fish") }
                if allFilters.contains(.lamb) { ingredientInclusions.append("lamb") }
                if allFilters.contains(.turkey) { ingredientInclusions.append("turkey") }
                if allFilters.contains(.duck) { ingredientInclusions.append("duck") }
                
                // Single call: products + scores + images all in one
                let (products, scores) = try await ProductServiceClient.shared.filterProducts(
                    searchTerm: searchText.isEmpty ? nil : searchText,
                    petType: petType,
                    productType: productType,
                    lifeStage: lifeStage,
                    allergenExclusions: allergenExclusions,
                    ingredientInclusions: ingredientInclusions,
                    pet: appState.selectedPet
                )
                
                print("✅ [Search] Got \(products.count) products with \(scores.count) scores")
                
                await MainActor.run {
                    // Products are already sorted by the backend (scored desc, then alphabetical)
                    searchResults = products
                    cachedScores = scores
                    isLoading = false
                }
            } catch {
                print("Search error: \(error)")
                await MainActor.run {
                    searchResults = []
                    isLoading = false
                }
            }
        }
    }
}

// MARK: - Product Filter Enum
enum ProductFilter: String, CaseIterable, Hashable {
    // Pet Type
    case forDogs = "For Dogs"
    case forCats = "For Cats"
    
    // Food Type (matches product_type column)
    case dryFood = "Dry Food"
    case wetFood = "Wet Food"
    case treats = "Treats"
    case supplement = "Supplement"
    
    // Life Stage (matches target_life_stage column)
    case puppy = "Puppy"
    case kitten = "Kitten"
    case adult = "Adult"
    case senior = "Senior"
    
    // Diet Type (text search on raw_ingredients_text)
    case grainFree = "Grain-Free"
    case withGrains = "With Grains"
    
    // Protein Type (text search on raw_ingredients_text)
    case chicken = "Chicken"
    case beef = "Beef"
    case fish = "Fish"
    case lamb = "Lamb"
    case turkey = "Turkey"
    case duck = "Duck"
    
    var icon: String {
        switch self {
        case .forDogs: return "🐕"
        case .forCats: return "🐱"
        case .dryFood: return "🥣"
        case .wetFood: return "🥫"
        case .treats: return "🦴"
        case .supplement: return "💊"
        case .puppy: return "🐶"
        case .kitten: return "🐱"
        case .adult: return "🐾"  // Neutral paw for both
        case .senior: return "🐾"  // Neutral paw for both
        case .grainFree: return "🌾"
        case .withGrains: return "🌾"
        case .chicken: return "🍗"
        case .beef: return "🥩"
        case .fish: return "🐟"
        case .lamb: return "🐑"
        case .turkey: return "🦃"
        case .duck: return "🦆"
        }
    }
    
    static var petTypeFilters: [ProductFilter] {
        [.forDogs, .forCats]
    }
    
    static var foodTypeFilters: [ProductFilter] {
        [.dryFood, .wetFood, .treats, .supplement]
    }
    
    static func lifeStageFilters(for petType: ProductFilter?) -> [ProductFilter] {
        switch petType {
        case .forDogs:
            return [.puppy, .adult, .senior]
        case .forCats:
            return [.kitten, .adult, .senior]
        default:
            // Show both puppy and kitten when no pet type selected
            return [.puppy, .kitten, .adult, .senior]
        }
    }
    
    static var dietFilters: [ProductFilter] {
        [.grainFree, .withGrains]
    }
    
    static var proteinFilters: [ProductFilter] {
        [.chicken, .beef, .fish, .lamb, .turkey, .duck]
    }
}

// MARK: - Filter Category
struct FilterCategory: View {
    let title: String
    let filters: [ProductFilter]
    @Binding var selectedFilters: Set<ProductFilter>
    var isSingleSelection: Bool = true  // Default to single selection
    
    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xs) {
            Text(title)
                .font(AppTypography.labelSmall())
                .foregroundColor(.appTextSecondary)
                .padding(.horizontal)
            
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: AppSpacing.xs) {
                    ForEach(filters, id: \.self) { filter in
                        FilterChip(
                            filter: filter,
                            isSelected: selectedFilters.contains(filter),
                            isAutoApplied: false
                        ) {
                            if selectedFilters.contains(filter) {
                                // Deselect: just remove
                                selectedFilters.remove(filter)
                            } else {
                                if isSingleSelection {
                                    // Single selection: remove others in this category first
                                    for f in filters {
                                        selectedFilters.remove(f)
                                    }
                                }
                                selectedFilters.insert(filter)
                            }
                        }
                    }
                }
                .padding(.horizontal)
            }
        }
    }
}

// MARK: - Filter Chip
struct FilterChip: View {
    let filter: ProductFilter
    let isSelected: Bool
    let isAutoApplied: Bool
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text(filter.icon)
                    .font(.system(size: 12))
                Text(filter.rawValue)
                    .font(AppTypography.labelSmall())
                
                if isAutoApplied {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 8))
                }
            }
            .padding(.horizontal, AppSpacing.sm)
            .padding(.vertical, AppSpacing.xs)
            .background(isSelected ? (isAutoApplied ? Color.appTeal : Color.appOrange) : Color.appLightGray)
            .foregroundColor(isSelected ? .white : .appTextPrimary)
            .cornerRadius(AppCornerRadius.full)
        }
        .buttonStyle(.plain)
        .disabled(isAutoApplied)
    }
}

// MARK: - Product Card
struct ProductCard: View {
    let product: Product
    let pet: Pet?
    let cachedScore: CachedScore?  // Personalized cached score (if available)
    
    @State private var showingAnalysis = false
    @State private var analysisResult: ScanResult?
    @State private var isAnalyzing = false
    @State private var localScore: CachedScore?  // Score from just-completed analysis
    @State private var localImageUrl: String?  // Image URL from just-completed analysis
    @State private var isLoadingImage = false
    
    // Use local score (just analyzed) first, then cached score
    private var score: Int? {
        return localScore?.score ?? cachedScore?.score
    }
    
    private var grade: String? {
        return localScore?.grade ?? cachedScore?.grade
    }
    
    private func productTypeIcon(_ type: ProductType) -> String {
        switch type {
        case .dryFood: return "circle.grid.3x3"
        case .wetFood: return "drop.fill"
        case .treats: return "star.fill"
        case .supplement: return "pill.fill"
        case .other: return "questionmark.circle"
        }
    }
    
    private func productTypeLabel(_ type: ProductType) -> String {
        switch type {
        case .dryFood: return "Dry Food"
        case .wetFood: return "Wet Food"
        case .treats: return "Treats"
        case .supplement: return "Supplement"
        case .other: return "Other"
        }
    }
    
    private func textureLabel(_ texture: ProductTexture) -> String {
        switch texture {
        case .dry: return "Dry"
        case .wet: return "Wet"
        case .semiMoist: return "Semi-Moist"
        case .freezeDried: return "Freeze-Dried"
        }
    }
    
    // Cute emoji based on target pet
    private var petEmoji: String {
        if let targetPetType = product.targetPetType {
            switch targetPetType {
            case .dog: return "🐕"
            case .cat: return "🐱"
            case .both: return "🐾"
            }
        }
        // Fallback: check selected pet type
        if let pet = pet {
            return pet.petType == .dog ? "🐕" : "🐱"
        }
        return "🐾"
    }
    
    /// Build the full image URL — prefer localImageUrl (from analysis) over product.imageUrl
    private var fullImageUrl: URL? {
        guard let imageUrl = localImageUrl ?? product.imageUrl, !imageUrl.isEmpty else { return nil }
        if imageUrl.hasPrefix("http") {
            return URL(string: imageUrl)
        }
        let serverRoot = APIConfig.baseURL.replacingOccurrences(of: "/api", with: "")
        return URL(string: "\(serverRoot)\(imageUrl)")
    }
    
    var body: some View {
        Button {
            analyzeProduct()
        } label: {
            HStack(spacing: AppSpacing.md) {
                // Product Image / Score / Pet Icon
                ZStack {
                    if let score = score, let grade = grade {
                        // Show personalized score badge over image
                        if let imageUrl = fullImageUrl {
                            AsyncImage(url: imageUrl) { phase in
                                switch phase {
                                case .success(let image):
                                    image
                                        .resizable()
                                        .aspectRatio(contentMode: .fill)
                                case .failure:
                                    scoreCircle(score: score, grade: grade)
                                case .empty:
                                    ProgressView()
                                @unknown default:
                                    scoreCircle(score: score, grade: grade)
                                }
                            }
                            .frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(alignment: .bottomTrailing) {
                                // Score badge
                                Text("\(score)")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 2)
                                    .background(Color.gradeColor(grade))
                                    .cornerRadius(6)
                                    .offset(x: 4, y: 4)
                            }
                        } else {
                            scoreCircle(score: score, grade: grade)
                        }
                    } else if let imageUrl = fullImageUrl {
                        // No score yet, but has image
                        AsyncImage(url: imageUrl) { phase in
                            switch phase {
                            case .success(let image):
                                image
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                            case .failure:
                                placeholderCircle
                            case .empty:
                                ProgressView()
                            @unknown default:
                                placeholderCircle
                            }
                        }
                        .frame(width: 56, height: 56)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    } else if isLoadingImage {
                        // Image is being fetched
                        ZStack {
                            Circle()
                                .fill(Color.appPrimary.opacity(0.08))
                                .frame(width: 56, height: 56)
                            ProgressView()
                                .scaleEffect(0.7)
                        }
                    } else {
                        // No image, no score - show pet icon
                        placeholderCircle
                    }
                }
                .frame(width: 56, height: 56)
                
                // Product Info
                VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                    if let brand = product.brand {
                        Text(brand.uppercased())
                            .font(AppTypography.labelSmall())
                            .foregroundColor(.appTextSecondary)
                    }
                    
                    Text(product.name)
                        .font(AppTypography.bodyMedium())
                        .fontWeight(.medium)
                        .foregroundColor(.appTextPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    
                    HStack(spacing: AppSpacing.sm) {
                        // Show texture + product type (e.g., "Dry Treats", "Wet Food")
                        if let type = product.productType {
                            HStack(spacing: 2) {
                                Image(systemName: productTypeIcon(type))
                                    .font(.system(size: 10))
                                if let texture = product.texture {
                                    Text("\(textureLabel(texture)) \(productTypeLabel(type))")
                                } else {
                                    Text(productTypeLabel(type))
                                }
                            }
                            .font(AppTypography.labelSmall())
                            .foregroundColor(.appTextSecondary)
                        }
                        
                        if product.verified == true {
                            HStack(spacing: 2) {
                                Image(systemName: "checkmark.seal.fill")
                                    .font(.system(size: 10))
                                Text("Verified")
                            }
                            .font(AppTypography.labelSmall())
                            .foregroundColor(.appTeal)
                        }
                    }
                }
                
                Spacer()
                
                if isAnalyzing {
                    ProgressView()
                        .scaleEffect(0.8)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 14))
                        .foregroundColor(.appTextSecondary)
                }
            }
            .padding()
            .background(Color.appCardBackground)
            .cornerRadius(AppCornerRadius.large)
            .cardShadow()
        }
        .buttonStyle(.plain)
        .disabled(isAnalyzing)
        .fullScreenCover(isPresented: $showingAnalysis) {
            if let result = analysisResult {
                NavigationView {
                    ResultView(result: result)
                }
            }
        }
        .task {
            // Async fetch image on appear if not already loaded
            guard localImageUrl == nil, product.imageUrl == nil || product.imageUrl?.isEmpty == true else { return }
            isLoadingImage = true
            do {
                if let url = try await ProductServiceClient.shared.fetchProductImage(productId: product.id) {
                    localImageUrl = url
                }
            } catch {
                // Silently fail — placeholder will show
            }
            isLoadingImage = false
        }
    }
    
    // MARK: - Helper Views
    private func scoreCircle(score: Int, grade: String) -> some View {
        ZStack {
            Circle()
                .fill(Color.gradeColor(grade).opacity(0.15))
                .frame(width: 56, height: 56)
            
            VStack(spacing: 0) {
                Text("\(score)")
                    .font(AppTypography.numericMedium())
                    .foregroundColor(Color.gradeColor(grade))
                
                Text(grade)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(Color.gradeColor(grade))
            }
        }
    }
    
    private var placeholderCircle: some View {
        ZStack {
            Circle()
                .fill(Color.appPrimary.opacity(0.1))
                .frame(width: 56, height: 56)
            
            Text(petEmoji)
                .font(.system(size: 26))
        }
    }
    
    private func analyzeProduct() {
        guard let pet = pet else { 
            print("❌ No pet selected")
            return 
        }
        let productId = product.id
        print("🔍 [ProductCard] Product ID: \(productId), Name: \(product.name)")
        
        isAnalyzing = true
        
        Task {
            do {
                let result = try await ProductServiceClient.shared.analyzeProduct(
                    productId: productId,
                    pet: pet
                )
                
                await MainActor.run {
                    analysisResult = result
                    // Save the score locally so it shows after returning from analysis
                    localScore = CachedScore(
                        score: result.analysis.finalScore,
                        grade: result.analysis.grade,
                        recommendation: result.analysis.recommendation
                    )
                    // Save the image URL if the backend fetched one during analysis
                    if let newImageUrl = result.product?.imageUrl, !newImageUrl.isEmpty {
                        localImageUrl = newImageUrl
                    }
                    isAnalyzing = false
                    showingAnalysis = true
                }
            } catch {
                print("Analysis error: \(error)")
                await MainActor.run {
                    isAnalyzing = false
                }
            }
        }
    }
}

// MARK: - Empty Search Results
struct EmptySearchResults: View {
    var body: some View {
        VStack(spacing: AppSpacing.md) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 40))
                .foregroundColor(.appTextSecondary.opacity(0.5))
            
            Text("No products found")
                .font(AppTypography.bodyLarge())
                .foregroundColor(.appTextPrimary)
            
            Text("Try adjusting your filters or search terms")
                .font(AppTypography.bodySmall())
                .foregroundColor(.appTextSecondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, AppSpacing.xxl)
    }
}

// MARK: - Search Prompt
struct SearchPrompt: View {
    var body: some View {
        VStack(spacing: AppSpacing.md) {
            Image(systemName: "sparkle.magnifyingglass")
                .font(.system(size: 40))
                .foregroundColor(.appTeal.opacity(0.6))
            
            Text("Search for pet food")
                .font(AppTypography.bodyLarge())
                .foregroundColor(.appTextPrimary)
            
            Text("Enter a product name, brand, or use filters to find safe food for your pet")
                .font(AppTypography.bodySmall())
                .foregroundColor(.appTextSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, AppSpacing.xxl)
    }
}

#Preview {
    NavigationView {
        ProductSearchView()
            .environmentObject(AppState())
    }
}

