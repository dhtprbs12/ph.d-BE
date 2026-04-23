import SwiftUI

struct ResultView: View {
    let result: ScanResult
    
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var showAllIngredients = false
    @State private var alternatives: [AlternativeProduct] = []
    @State private var isLoadingAlternatives = false
    @State private var isSharing = false
    
    var body: some View {
        ScrollView {
            VStack(spacing: AppSpacing.lg) {
                // Header with Score (animated)
                ScoreHeaderCard(result: result)
                    .staggeredAppear(index: 0)
                
                // Visual Charts Section
                AnalysisChartsCard(ingredients: result.analysis.ingredients, analysis: result.analysis)
                    .staggeredAppear(index: 1)
                
                // Quick Verdict (3 bullets max)
                QuickVerdictCard(
                    insights: result.aiInsights,
                    analysis: result.analysis,
                    petName: result.pet.name
                )
                .staggeredAppear(index: 2)
                
                // Ingredient Pills (visual, scannable)
                IngredientPillsCard(
                    ingredients: result.analysis.ingredients,
                    showDetails: $showAllIngredients
                )
                .staggeredAppear(index: 3)
                
                // Alternatives
                AlternativesCard(
                    alternatives: alternatives,
                    isLoading: isLoadingAlternatives
                )
                .onAppear {
                    loadAlternatives()
                }
                .staggeredAppear(index: 4)
                
                // Share Button
                ShareResultButton {
                    guard !isSharing else { return }
                    isSharing = true
                    Task {
                        let productImg = await downloadProductImage()
                        let image = ShareCardRenderer.render(result: result, productImage: productImg)
                        await MainActor.run {
                            isSharing = false
                            presentShareSheet(with: image)
                        }
                    }
                }
                .padding(.horizontal)
                .staggeredAppear(index: 5)
                
                // Trust & Disclaimer Footer
                TrustDisclaimerFooter()
                    .staggeredAppear(index: 6)
                
                Spacer(minLength: AppSpacing.xxl)
            }
            .padding(.top)
        }
        .background(Color.appBackground)
        .navigationTitle("Analysis Result")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    dismiss()
                } label: {
                    HStack(spacing: AppSpacing.xxs) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 14, weight: .semibold))
                        Text("Back")
                    }
                    .foregroundColor(.appPrimary)
                }
            }
        }
    }
    
    private func downloadProductImage() async -> UIImage? {
        guard let urlStr = result.product?.imageUrl, !urlStr.isEmpty else { return nil }
        let fullUrl: URL?
        if urlStr.hasPrefix("http") {
            fullUrl = URL(string: urlStr)
        } else {
            let base = APIConfig.baseURL.replacingOccurrences(of: "/api", with: "")
            fullUrl = URL(string: "\(base)\(urlStr)")
        }
        guard let url = fullUrl else { return nil }
        guard let (data, _) = try? await URLSession.shared.data(from: url) else { return nil }
        return UIImage(data: data)
    }
    
    private func presentShareSheet(with image: UIImage) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let root = scene.windows.first?.rootViewController else { return }
            var top = root
            while let presented = top.presentedViewController { top = presented }
            let ac = UIActivityViewController(activityItems: [image], applicationActivities: nil)
            top.present(ac, animated: true)
        }
    }
    
    private func loadAlternatives() {
        guard let productId = result.product?.id,
              let pet = appState.selectedPet else { return }
        
        isLoadingAlternatives = true
        
        Task {
            do {
                let alts = try await ProductServiceClient.shared.getAlternatives(
                    productId: productId,
                    pet: pet
                )
                await MainActor.run {
                    alternatives = alts
                    isLoadingAlternatives = false
                }
            } catch {
                print("⚠️ [Alternatives] Error: \(error)")
                await MainActor.run {
                    isLoadingAlternatives = false
                }
            }
        }
    }
}

// MARK: - Score Header Card
struct ScoreHeaderCard: View {
    let result: ScanResult
    @State private var animatedProgress: CGFloat = 0
    @State private var displayedScore: Int = 0
    
    var body: some View {
        VStack(spacing: AppSpacing.md) {
            // Product Info (if available)
            if let product = result.product {
                VStack(spacing: AppSpacing.sm) {
                    // Product Image
                    if let imageUrlString = product.imageUrl,
                       let imageUrl = URL(string: imageUrlString) {
                        AsyncImage(url: imageUrl) { phase in
                            switch phase {
                            case .success(let image):
                                image
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                                    .frame(width: 80, height: 80)
                                    .clipShape(RoundedRectangle(cornerRadius: AppCornerRadius.medium))
                            case .failure:
                                EmptyView()
                            case .empty:
                                ProgressView()
                                    .frame(width: 80, height: 80)
                            @unknown default:
                                EmptyView()
                            }
                        }
                    }
                    
                    VStack(spacing: AppSpacing.xxs) {
                        if let brand = product.brand {
                            Text(brand.uppercased())
                                .font(AppTypography.labelSmall())
                                .foregroundColor(.appTextSecondary)
                        }
                        
                        if let name = product.name {
                            Text(name)
                                .font(AppTypography.bodyLarge())
                                .fontWeight(.semibold)
                                .multilineTextAlignment(.center)
                        }
                        
                        if let productType = product.productType {
                            Text(productTypeLabel(productType))
                                .font(AppTypography.labelSmall())
                                .foregroundColor(productTypeColor(productType))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(productTypeColor(productType).opacity(0.12))
                                .cornerRadius(AppCornerRadius.full)
                        }
                    }
                }
            }
            
            // Animated Score Circle
            ZStack {
                Circle()
                    .stroke(Color.gradeColor(result.analysis.grade).opacity(0.2), lineWidth: 12)
                    .frame(width: 140, height: 140)
                
                Circle()
                    .trim(from: 0, to: animatedProgress)
                    .stroke(
                        Color.gradeColor(result.analysis.grade),
                        style: StrokeStyle(lineWidth: 12, lineCap: .round)
                    )
                    .frame(width: 140, height: 140)
                    .rotationEffect(.degrees(-90))
                
                VStack(spacing: 0) {
                    Text("\(displayedScore)")
                        .font(AppTypography.scoreDisplay())
                        .foregroundColor(.appTextPrimary)
                    
                    Text("out of 100")
                        .font(AppTypography.labelSmall())
                        .foregroundColor(.appTextSecondary)
                }
            }
            .onAppear {
                // Animate score circle and number
                withAnimation(.easeOut(duration: 1.2)) {
                    animatedProgress = CGFloat(result.analysis.finalScore) / 100
                }
                // Animate the number counting up
                animateScore()
            }
            
            // Grade Badge
            HStack(spacing: AppSpacing.sm) {
                Text("Grade")
                    .font(AppTypography.labelMedium())
                    .foregroundColor(.appTextSecondary)
                
                Text(result.analysis.grade)
                    .font(AppTypography.gradeDisplay())
                    .foregroundColor(Color.gradeColor(result.analysis.grade))
                
                Text("- \(Color.gradeDescription(result.analysis.grade))")
                    .font(AppTypography.bodyMedium())
                    .foregroundColor(.appTextSecondary)
            }
            
            // Pet Context
            VStack(spacing: AppSpacing.xxs) {
                HStack {
                    Text(Color.petTypeIcon(result.pet.petType))
                    Text("Analysis for \(result.pet.name)")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                }
                .padding(.horizontal, AppSpacing.md)
                .padding(.vertical, AppSpacing.xs)
                .background(Color.appLightGray)
                .cornerRadius(AppCornerRadius.full)
                
                if result.pet.id == nil {
                    Text("Scored as a healthy \(result.pet.petType) with no specific conditions")
                        .font(AppTypography.caption())
                        .foregroundColor(.appTextSecondary.opacity(0.7))
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.large)
        .cardShadow()
        .padding(.horizontal)
    }
    
    private func productTypeLabel(_ type: String) -> String {
        switch type {
        case "dry_food": return "🥣 Dry Food"
        case "wet_food": return "🥫 Wet Food"
        case "treats": return "🦴 Treat"
        case "supplement": return "💊 Supplement"
        default: return "🍽️ Food"
        }
    }
    
    private func productTypeColor(_ type: String) -> Color {
        switch type {
        case "supplement": return .purple
        case "treats": return .orange
        case "wet_food": return .blue
        case "dry_food": return .brown
        default: return .gray
        }
    }
    
    private func animateScore() {
        let targetScore = result.analysis.finalScore
        let duration = 1.2
        let steps = 30
        let stepDuration = duration / Double(steps)
        
        for i in 0...steps {
            DispatchQueue.main.asyncAfter(deadline: .now() + stepDuration * Double(i)) {
                let progress = Double(i) / Double(steps)
                // Ease out curve
                let easedProgress = 1 - pow(1 - progress, 3)
                displayedScore = Int(Double(targetScore) * easedProgress)
            }
        }
    }
}

// MARK: - Analysis Charts Card (Donut + Stats)
struct AnalysisChartsCard: View {
    let ingredients: [IngredientAnalysis]
    let analysis: Analysis
    
    // Count ingredients with actual concerns vs safe ones
    private var concernCount: Int {
        ingredients.filter { $0.isToxic || $0.isAllergenMatch || $0.isHealthConcern || $0.riskLevel == "high" || $0.riskLevel == "danger" }.count
    }
    
    private var cautionCount: Int {
        ingredients.filter { $0.riskLevel == "moderate" }.count
    }
    
    private var safeCount: Int {
        ingredients.count - concernCount - cautionCount
    }
    
    // Simplicity score - fewer ingredients = simpler = often better
    private var simplicityRating: String {
        if ingredients.count <= 5 { return "Very Simple" }
        if ingredients.count <= 10 { return "Simple" }
        if ingredients.count <= 20 { return "Moderate" }
        return "Complex"
    }
    
    var body: some View {
        VStack(spacing: AppSpacing.lg) {
            HStack(spacing: AppSpacing.xl) {
                // Donut Chart - Score visualization
                VStack(spacing: AppSpacing.sm) {
                    ZStack {
                        // Background circle
                        Circle()
                            .stroke(Color.appLightGray, lineWidth: 14)
                            .frame(width: 90, height: 90)
                        
                        // Score arc
                        Circle()
                            .trim(from: 0, to: CGFloat(analysis.finalScore) / 100)
                            .stroke(
                                Color.gradeColor(analysis.grade),
                                style: StrokeStyle(lineWidth: 14, lineCap: .round)
                            )
                            .frame(width: 90, height: 90)
                            .rotationEffect(.degrees(-90))
                        
                        // Center text
                        VStack(spacing: 0) {
                            Text("\(analysis.finalScore)")
                                .font(AppTypography.displaySmall())
                                .fontWeight(.bold)
                                .foregroundColor(Color.gradeColor(analysis.grade))
                            Text("score")
                                .font(AppTypography.labelSmall())
                                .foregroundColor(.appTextSecondary)
                        }
                    }
                }
                
                // Key Stats
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    StatRow(icon: "leaf.fill", label: "Ingredients", value: "\(ingredients.count)", color: .appTeal)
                    StatRow(icon: "sparkles", label: "Complexity", value: simplicityRating, color: ingredients.count <= 10 ? .appSafe : .appCaution)
                    
                    if concernCount > 0 {
                        StatRow(icon: "exclamationmark.triangle.fill", label: "Concerns", value: "\(concernCount)", color: .appDanger)
                    } else if cautionCount > 0 {
                        StatRow(icon: "exclamationmark.circle.fill", label: "Watch", value: "\(cautionCount)", color: .appCaution)
                    } else {
                        StatRow(icon: "checkmark.circle.fill", label: "Issues", value: "None found", color: .appSafe)
                    }
                }
            }
        }
        .padding()
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.large)
        .padding(.horizontal)
    }
}

// MARK: - Stat Row
struct StatRow: View {
    let icon: String
    let label: String
    let value: String
    let color: Color
    
    var body: some View {
        HStack(spacing: AppSpacing.sm) {
            Image(systemName: icon)
                .foregroundColor(color)
                .frame(width: 20)
            
            Text(label)
                .font(AppTypography.labelSmall())
                .foregroundColor(.appTextSecondary)
            
            Spacer()
            
            Text(value)
                .font(AppTypography.labelSmall())
                .fontWeight(.semibold)
                .foregroundColor(.appTextPrimary)
        }
    }
}


// MARK: - Quick Verdict Card (Benefits & Concerns)
struct QuickVerdictCard: View {
    let insights: AIInsights?
    let analysis: Analysis
    let petName: String
    
    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            // Header
            HStack {
                Image(systemName: "sparkles")
                    .foregroundColor(.appPrimary)
                Text("Analysis for \(petName)")
                    .font(AppTypography.labelLarge())
                    .foregroundColor(.appTextPrimary)
            }
            
            // Benefits Section
            if let benefits = insights?.topBenefits, !benefits.isEmpty {
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.appSafe)
                            .font(.system(size: 14))
                        Text("Benefits")
                            .font(AppTypography.labelMedium())
                            .fontWeight(.semibold)
                            .foregroundColor(.appTextPrimary)
                    }
                    
                    ForEach(benefits, id: \.self) { benefit in
                        HStack(alignment: .top, spacing: AppSpacing.sm) {
                            Circle()
                                .fill(Color.appSafe)
                                .frame(width: 6, height: 6)
                                .padding(.top, 6)
                            Text(benefit)
                                .font(AppTypography.bodySmall())
                                .foregroundColor(.appTextSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding()
                .background(Color.appSafe.opacity(0.08))
                .cornerRadius(AppCornerRadius.medium)
            }
            
            // Concerns Section
            if let concerns = insights?.topConcerns, !concerns.isEmpty {
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundColor(.appCaution)
                            .font(.system(size: 14))
                        Text("Concerns")
                            .font(AppTypography.labelMedium())
                            .fontWeight(.semibold)
                            .foregroundColor(.appTextPrimary)
                    }
                    
                    ForEach(concerns, id: \.self) { concern in
                        HStack(alignment: .top, spacing: AppSpacing.sm) {
                            Circle()
                                .fill(Color.appCaution)
                                .frame(width: 6, height: 6)
                                .padding(.top, 6)
                            Text(concern)
                                .font(AppTypography.bodySmall())
                                .foregroundColor(.appTextSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding()
                .background(Color.appCaution.opacity(0.08))
                .cornerRadius(AppCornerRadius.medium)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.large)
        .cardShadow()
        .padding(.horizontal)
    }
}

// MARK: - Ingredient Pills Card
struct IngredientPillsCard: View {
    let ingredients: [IngredientAnalysis]
    @Binding var showDetails: Bool
    
    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            HStack {
                Text("Ingredients (\(ingredients.count))")
                    .font(AppTypography.labelLarge())
                    .foregroundColor(.appTextPrimary)
                Spacer()
                Button {
                    withAnimation {
                        showDetails.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(showDetails ? "Collapse" : "Expand")
                        Image(systemName: showDetails ? "chevron.up" : "chevron.down")
                    }
                    .font(AppTypography.labelSmall())
                    .foregroundColor(.appTeal)
                }
            }
            
            // Always show pills in a clean grid
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible())
            ], spacing: AppSpacing.sm) {
                ForEach(ingredients) { ingredient in
                    IngredientPill(ingredient: ingredient, showDetails: false)
                }
            }
            
            // Show detailed breakdown when expanded
            if showDetails {
                Divider()
                    .padding(.vertical, AppSpacing.sm)
                
                ForEach(ingredients) { ingredient in
                    IngredientDetailRow(ingredient: ingredient)
                }
            }
        }
        .padding()
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.large)
        .padding(.horizontal)
        .onAppear {
            // Start expanded by default
            showDetails = true
        }
    }
}

// MARK: - Ingredient Pill
struct IngredientPill: View {
    let ingredient: IngredientAnalysis
    let showDetails: Bool
    
    private var pillColor: Color {
        Color.riskColor(ingredient.riskLevel)
    }
    
    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(pillColor)
                .frame(width: 8, height: 8)
            
            Text(ingredient.name)
                .font(AppTypography.labelSmall())
                .foregroundColor(.appTextPrimary)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(pillColor.opacity(0.1))
        .cornerRadius(AppCornerRadius.medium)
    }
}

// MARK: - Ingredient Detail Row
struct IngredientDetailRow: View {
    let ingredient: IngredientAnalysis
    
    private var riskColor: Color {
        Color.riskColor(ingredient.riskLevel)
    }
    
    private var displayText: String {
        // Show positive benefit if available
        if let benefit = ingredient.positiveBenefit, !benefit.isEmpty {
            return benefit
        }
        // Show explanation if it's meaningful (not just "unknown")
        if let explanation = ingredient.explanation, 
           !explanation.isEmpty,
           !explanation.lowercased().contains("unknown") {
            return explanation
        }
        // Default based on risk level
        switch ingredient.riskLevel.lowercased() {
        case "safe": return "Safe ingredient"
        case "low": return "Generally safe, low risk"
        case "moderate": return "Use with moderation"
        case "high": return "May cause issues for some pets"
        case "danger": return "Avoid"
        default: return "Assessment pending"
        }
    }
    
    var body: some View {
        HStack(alignment: .top, spacing: AppSpacing.sm) {
            // Position badge
            Text("#\(ingredient.position)")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.white)
                .frame(width: 22, height: 22)
                .background(riskColor)
                .cornerRadius(11)
            
            VStack(alignment: .leading, spacing: 2) {
                Text(ingredient.name)
                    .font(AppTypography.bodySmall())
                    .fontWeight(.medium)
                    .foregroundColor(.appTextPrimary)
                
                Text(displayText)
                    .font(AppTypography.labelSmall())
                    .foregroundColor(.appTextSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            
            Spacer()
            
            // Risk badge
            Text(ingredient.riskLevel.capitalized)
                .font(AppTypography.labelSmall())
                .fontWeight(.medium)
                .foregroundColor(riskColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(riskColor.opacity(0.1))
                .cornerRadius(AppCornerRadius.small)
        }
        .padding(.vertical, AppSpacing.sm)
    }
}

// MARK: - Detailed Insights Card (Collapsible)
struct DetailedInsightsCard: View {
    let insights: AIInsights
    let petName: String
    @State private var isExpanded = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            Button {
                withAnimation {
                    isExpanded.toggle()
                }
            } label: {
                HStack {
                    Image(systemName: "sparkles")
                        .foregroundColor(.appTeal)
                    Text("Detailed Analysis")
                        .font(AppTypography.labelLarge())
                        .foregroundColor(.appTextPrimary)
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .foregroundColor(.appTextSecondary)
                }
            }
            
            if isExpanded {
                VStack(alignment: .leading, spacing: AppSpacing.md) {
                    if let summary = insights.personalizedSummary {
                        Text(summary)
                            .font(AppTypography.bodySmall())
                            .foregroundColor(.appTextSecondary)
                    }
                    
                    if let concerns = insights.topConcerns, !concerns.isEmpty {
                        VStack(alignment: .leading, spacing: AppSpacing.xs) {
                            Text("⚠️ Concerns")
                                .font(AppTypography.labelMedium())
                                .fontWeight(.semibold)
                            ForEach(concerns, id: \.self) { concern in
                                Text("• \(concern)")
                                    .font(AppTypography.bodySmall())
                                    .foregroundColor(.appTextSecondary)
                            }
                        }
                    }
                    
                    if let benefits = insights.topBenefits, !benefits.isEmpty {
                        VStack(alignment: .leading, spacing: AppSpacing.xs) {
                            Text("✅ Benefits")
                                .font(AppTypography.labelMedium())
                                .fontWeight(.semibold)
                            ForEach(benefits, id: \.self) { benefit in
                                Text("• \(benefit)")
                                    .font(AppTypography.bodySmall())
                                    .foregroundColor(.appTextSecondary)
                            }
                        }
                    }
                    
                    if let advice = insights.alternativeAdvice {
                        VStack(alignment: .leading, spacing: AppSpacing.xs) {
                            Text("💡 Recommendation")
                                .font(AppTypography.labelMedium())
                                .fontWeight(.semibold)
                            Text(advice)
                                .font(AppTypography.bodySmall())
                                .foregroundColor(.appTextSecondary)
                        }
                    }
                }
            }
        }
        .padding()
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.large)
        .padding(.horizontal)
    }
}

// MARK: - Summary Card (Fallback)
struct SummaryCard: View {
    let summary: String
    
    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            Text("Summary")
                .font(AppTypography.labelLarge())
                .foregroundColor(.appTextSecondary)
            
            Text(summary)
                .font(AppTypography.bodyMedium())
                .foregroundColor(.appTextPrimary)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.large)
        .cardShadow()
        .padding(.horizontal)
    }
}

// MARK: - Warnings Card
struct WarningsCard: View {
    let warnings: [Warning]
    
    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(.appDanger)
                Text("Warnings")
                    .font(AppTypography.labelLarge())
                    .foregroundColor(.appDanger)
            }
            
            ForEach(warnings) { warning in
                HStack(alignment: .top, spacing: AppSpacing.sm) {
                    Circle()
                        .fill(warning.level == "danger" ? Color.appDanger : Color.appCaution)
                        .frame(width: 8, height: 8)
                        .padding(.top, 6)
                    
                    VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                        Text(warning.ingredient)
                            .font(AppTypography.labelMedium())
                            .foregroundColor(.appTextPrimary)
                        
                        Text(warning.reason)
                            .font(AppTypography.bodySmall())
                            .foregroundColor(.appTextSecondary)
                    }
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appDanger.opacity(0.08))
        .cornerRadius(AppCornerRadius.large)
        .overlay(
            RoundedRectangle(cornerRadius: AppCornerRadius.large)
                .stroke(Color.appDanger.opacity(0.3), lineWidth: 1)
        )
        .padding(.horizontal)
    }
}

// MARK: - Positives Card
struct PositivesCard: View {
    let positives: [String]
    
    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(.appSafe)
                Text("Nutritional Highlights")
                    .font(AppTypography.labelLarge())
                    .foregroundColor(.appSafe)
            }
            
            ForEach(positives, id: \.self) { positive in
                HStack(alignment: .top, spacing: AppSpacing.sm) {
                    Image(systemName: "leaf.fill")
                        .font(.system(size: 12))
                        .foregroundColor(.appSafe)
                        .padding(.top, 2)
                    
                    Text(positive)
                        .font(AppTypography.bodySmall())
                        .foregroundColor(.appTextSecondary)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appSafe.opacity(0.08))
        .cornerRadius(AppCornerRadius.large)
        .overlay(
            RoundedRectangle(cornerRadius: AppCornerRadius.large)
                .stroke(Color.appSafe.opacity(0.3), lineWidth: 1)
        )
        .padding(.horizontal)
    }
}

// MARK: - Ingredients Card
struct IngredientsCard: View {
    let ingredients: [IngredientAnalysis]
    @Binding var showAll: Bool
    
    private var displayedIngredients: [IngredientAnalysis] {
        showAll ? ingredients : Array(ingredients.prefix(8))
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack {
                Text("Ingredients Breakdown")
                    .font(AppTypography.labelLarge())
                    .foregroundColor(.appTextSecondary)
                
                Spacer()
                
                Text("\(ingredients.count) total")
                    .font(AppTypography.labelSmall())
                    .foregroundColor(.appTextSecondary)
            }
            
            ForEach(displayedIngredients) { ingredient in
                IngredientRow(ingredient: ingredient)
            }
            
            if ingredients.count > 8 {
                Button {
                    withAnimation {
                        showAll.toggle()
                    }
                } label: {
                    HStack {
                        Text(showAll ? "Show Less" : "Show All \(ingredients.count) Ingredients")
                        Image(systemName: showAll ? "chevron.up" : "chevron.down")
                    }
                    .font(AppTypography.labelMedium())
                    .foregroundColor(.appTeal)
                }
                .padding(.top, AppSpacing.xs)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.large)
        .cardShadow()
        .padding(.horizontal)
    }
}

struct IngredientRow: View {
    let ingredient: IngredientAnalysis
    
    var body: some View {
        HStack(spacing: AppSpacing.sm) {
            // Position number
            Text("#\(ingredient.position)")
                .font(AppTypography.labelSmall())
                .foregroundColor(.appTextSecondary)
                .frame(width: 28)
            
            // Risk indicator
            Circle()
                .fill(Color.riskColor(ingredient.riskLevel))
                .frame(width: 10, height: 10)
            
            // Name
            Text(ingredient.name)
                .font(AppTypography.bodyMedium())
                .foregroundColor(.appTextPrimary)
                .lineLimit(1)
            
            Spacer()
            
            // Badges
            HStack(spacing: 4) {
                if ingredient.isToxic {
                    Badge(text: "TOXIC", color: .appDanger)
                }
                if ingredient.isAllergenMatch {
                    Badge(text: "ALLERGEN", color: .appOrange)
                }
                if ingredient.hasTaurine == true {
                    Badge(text: "TAURINE", color: .appSafe)
                }
            }
        }
        .padding(.vertical, AppSpacing.xxs)
    }
}

struct Badge: View {
    let text: String
    let color: Color
    
    var body: some View {
        Text(text)
            .font(.system(size: 8, weight: .bold))
            .foregroundColor(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color)
            .cornerRadius(4)
    }
}

// MARK: - Alternatives Card
struct AlternativesCard: View {
    let alternatives: [AlternativeProduct]
    let isLoading: Bool
    @EnvironmentObject var appState: AppState
    
    @State private var selectedAlternative: AlternativeProduct?
    @State private var alternativeResult: ScanResult?
    @State private var showingAlternativeAnalysis = false
    @State private var analyzingAlternativeId: String?
    
    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .foregroundColor(.appTeal)
                Text("Safer Alternatives")
                    .font(AppTypography.labelLarge())
                    .foregroundColor(.appTextSecondary)
            }
            
            if isLoading {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .padding()
            } else if alternatives.isEmpty {
                Text("No alternatives found in our database yet.")
                    .font(AppTypography.bodySmall())
                    .foregroundColor(.appTextSecondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: AppSpacing.sm) {
                        ForEach(alternatives) { alt in
                            Button {
                                analyzeAlternative(alt)
                            } label: {
                                AlternativeCard(
                                    alternative: alt,
                                    isAnalyzing: analyzingAlternativeId == alt.id
                                )
                            }
                            .buttonStyle(.plain)
                            .disabled(analyzingAlternativeId != nil)
                        }
                    }
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appTeal.opacity(0.08))
        .cornerRadius(AppCornerRadius.large)
        .padding(.horizontal)
        .fullScreenCover(isPresented: $showingAlternativeAnalysis) {
            if let result = alternativeResult {
                NavigationView {
                    ResultView(result: result)
                }
                .environmentObject(appState)
            }
        }
    }
    
    private func analyzeAlternative(_ alt: AlternativeProduct) {
        guard let pet = appState.selectedPet else { return }
        analyzingAlternativeId = alt.id
        
        Task {
            do {
                let result = try await ProductServiceClient.shared.analyzeProduct(
                    productId: alt.product.id,
                    pet: pet
                )
                await MainActor.run {
                    alternativeResult = result
                    analyzingAlternativeId = nil
                    showingAlternativeAnalysis = true
                }
            } catch {
                print("⚠️ [Alternative Analysis] Error: \(error)")
                await MainActor.run {
                    analyzingAlternativeId = nil
                }
            }
        }
    }
}

struct AlternativeCard: View {
    let alternative: AlternativeProduct
    var isAnalyzing: Bool = false
    
    private var fullImageUrl: URL? {
        guard let imageUrl = alternative.product.imageUrl, !imageUrl.isEmpty else { return nil }
        if imageUrl.hasPrefix("http") {
            return URL(string: imageUrl)
        }
        let serverRoot = APIConfig.baseURL.replacingOccurrences(of: "/api", with: "")
        return URL(string: "\(serverRoot)\(imageUrl)")
    }
    
    var body: some View {
        VStack(spacing: AppSpacing.sm) {
            // Product Image or Score Circle
            if let imageUrl = fullImageUrl {
                AsyncImage(url: imageUrl) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    case .failure:
                        productPlaceholder
                    case .empty:
                        ProgressView()
                            .frame(width: 64, height: 64)
                    @unknown default:
                        productPlaceholder
                    }
                }
                .frame(width: 64, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: AppCornerRadius.medium))
            } else {
                productPlaceholder
            }
            
            // Product Name
            Text(alternative.product.name)
                .font(AppTypography.labelSmall())
                .foregroundColor(.appTextPrimary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(height: 34)
            
            // Brand
            if let brand = alternative.product.brand {
                Text(brand)
                    .font(.system(size: 10))
                    .foregroundColor(.appTextSecondary)
                    .lineLimit(1)
            }
            
            // Score Badge
            if isAnalyzing {
                ProgressView()
                    .frame(height: 28)
            } else {
                HStack(spacing: 4) {
                    Text("\(alternative.score)")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(Color.gradeColor(alternative.grade))
                    
                    Text(alternative.grade)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.gradeColor(alternative.grade))
                        .cornerRadius(4)
                }
            }
        }
        .padding(AppSpacing.sm)
        .frame(width: 120)
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.medium)
    }
    
    private var productPlaceholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: AppCornerRadius.medium)
                .fill(Color.gradeColor(alternative.grade).opacity(0.12))
                .frame(width: 64, height: 64)
            
            Text("\(alternative.score)")
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(Color.gradeColor(alternative.grade))
        }
    }
}

// MARK: - AI Insights Card
struct AIInsightsCard: View {
    let insights: AIInsights
    let petName: String
    
    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            // Header
            HStack {
                Image(systemName: "sparkles")
                    .foregroundColor(.appTeal)
                Text("Analysis for \(petName)")
                    .font(AppTypography.labelLarge())
                Spacer()
            }
            
            // Personalized Summary
            if let summary = insights.personalizedSummary {
                Text(summary)
                    .font(AppTypography.bodyMedium())
                    .foregroundColor(.appTextPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            
            // Condition Warnings (rule-based, pet-specific)
            if let warnings = insights.conditionWarnings, !warnings.isEmpty {
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.shield.fill")
                            .foregroundColor(.appDanger)
                        Text("Health Alerts for \(petName)")
                            .font(AppTypography.labelMedium())
                            .fontWeight(.semibold)
                            .foregroundColor(.appDanger)
                    }
                    
                    ForEach(warnings) { warning in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: warning.type == "allergy" ? "exclamationmark.triangle.fill" : "heart.text.square")
                                .font(.system(size: 14))
                                .foregroundColor(warning.severity == "high" ? .appDanger : .appCaution)
                                .frame(width: 20)
                            
                            VStack(alignment: .leading, spacing: 2) {
                                Text(warning.ingredient)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundColor(.appTextPrimary)
                                Text(warning.message)
                                    .font(.system(size: 12))
                                    .foregroundColor(.appTextSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .padding()
                .background(Color.appDanger.opacity(0.08))
                .cornerRadius(AppCornerRadius.medium)
            }
            
            // Top Concerns
            if let concerns = insights.topConcerns, !concerns.isEmpty {
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    HStack {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundColor(.appCaution)
                        Text("Things to Watch")
                            .font(AppTypography.labelMedium())
                            .fontWeight(.semibold)
                    }
                    
                    ForEach(concerns, id: \.self) { concern in
                        HStack(alignment: .top, spacing: AppSpacing.sm) {
                            Circle()
                                .fill(Color.appCaution)
                                .frame(width: 6, height: 6)
                                .padding(.top, 6)
                            Text(concern)
                                .font(AppTypography.bodySmall())
                                .foregroundColor(.appTextSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding()
                .background(Color.appCaution.opacity(0.1))
                .cornerRadius(AppCornerRadius.medium)
            }
            
            // Top Benefits
            if let benefits = insights.topBenefits, !benefits.isEmpty {
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    HStack {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.appSafe)
                        Text("Benefits")
                            .font(AppTypography.labelMedium())
                            .fontWeight(.semibold)
                    }
                    
                    ForEach(benefits, id: \.self) { benefit in
                        HStack(alignment: .top, spacing: AppSpacing.sm) {
                            Circle()
                                .fill(Color.appSafe)
                                .frame(width: 6, height: 6)
                                .padding(.top, 6)
                            Text(benefit)
                                .font(AppTypography.bodySmall())
                                .foregroundColor(.appTextSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding()
                .background(Color.appSafe.opacity(0.1))
                .cornerRadius(AppCornerRadius.medium)
            }
            
            // Feeding Tip
            if let tip = insights.feedingTip {
                VStack(alignment: .leading, spacing: AppSpacing.xs) {
                    HStack {
                        Image(systemName: "lightbulb.fill")
                            .foregroundColor(.appTeal)
                        Text("Feeding Tip")
                            .font(AppTypography.labelMedium())
                            .fontWeight(.semibold)
                    }
                    Text(tip)
                        .font(AppTypography.bodySmall())
                        .foregroundColor(.appTextSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding()
                .background(Color.appTeal.opacity(0.1))
                .cornerRadius(AppCornerRadius.medium)
            }
            
            // Alternative Advice (only if there are concerns)
            if let advice = insights.alternativeAdvice, insights.topConcerns?.isEmpty == false {
                VStack(alignment: .leading, spacing: AppSpacing.xs) {
                    HStack {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .foregroundColor(.appOrange)
                        Text("Better Alternatives")
                            .font(AppTypography.labelMedium())
                            .fontWeight(.semibold)
                    }
                    Text(advice)
                        .font(AppTypography.bodySmall())
                        .foregroundColor(.appTextSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding()
                .background(Color.appOrange.opacity(0.1))
                .cornerRadius(AppCornerRadius.medium)
            }
            
            if insights.aiGenerated == true {
                HStack {
                    Spacer()
                    Image(systemName: "cpu")
                        .font(.caption2)
                    Text("Auto-generated insight")
                        .font(AppTypography.labelSmall())
                }
                .foregroundColor(.appTextSecondary.opacity(0.7))
            }
        }
        .padding()
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.large)
        .padding(.horizontal)
    }
}

// MARK: - Share Result Button
struct ShareResultButton: View {
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 18, weight: .semibold))
                
                VStack(alignment: .leading, spacing: 2) {
                    Text("Share This Result")
                        .font(AppTypography.bodyMedium())
                        .fontWeight(.semibold)
                    
                    Text("Help friends know what's in their pet's food")
                        .font(AppTypography.labelSmall())
                        .foregroundColor(.white.opacity(0.8))
                }
                
                Spacer()
                
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .medium))
                    .opacity(0.7)
            }
            .foregroundColor(.white)
            .padding()
            .background(
                LinearGradient(
                    colors: [Color.appTeal, Color.appTeal.opacity(0.8)],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
            .cornerRadius(AppCornerRadius.large)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Trust & Disclaimer Footer
struct TrustDisclaimerFooter: View {
    @State private var communityStats: CommunityStats?
    
    var body: some View {
        VStack(spacing: AppSpacing.md) {
            // Trust Indicators
            HStack(spacing: AppSpacing.lg) {
                // Total Community Scans - only show when impressive (100+)
                if let stats = communityStats, stats.totalScans >= 100 {
                    TrustBadge(
                        icon: "person.3.fill",
                        value: stats.formattedTotalScans,
                        label: "Community"
                    )
                }
                
                // AAFCO Badge
                TrustBadge(
                    icon: "checkmark.shield.fill",
                    value: "AAFCO",
                    label: "Compliant"
                )
                
                // Verified Data
                TrustBadge(
                    icon: "checkmark.seal.fill",
                    value: "Expert",
                    label: "Reviewed"
                )
            }
            
            // Scoring methodology
            VStack(spacing: AppSpacing.xs) {
                HStack(spacing: 4) {
                    Image(systemName: "function")
                        .font(.system(size: 11))
                    Text("HOW WE SCORE")
                        .font(.system(size: 10, weight: .semibold))
                }
                .foregroundColor(.appTextSecondary)
                
                Text("Per AAFCO guidelines, ingredients are listed in descending order by weight. Our score reflects this — ingredients making up more of the product have a greater impact on your pet's safety rating.")
                    .font(.system(size: 11))
                    .foregroundColor(.appTextSecondary.opacity(0.8))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, AppSpacing.md)
            
            // Disclaimer
            VStack(spacing: AppSpacing.xs) {
                HStack(spacing: 4) {
                    Image(systemName: "info.circle")
                        .font(.system(size: 11))
                    Text("DISCLAIMER")
                        .font(.system(size: 10, weight: .semibold))
                }
                .foregroundColor(.appTextSecondary)
                
                Text("Analysis based on AAFCO guidelines. For informational purposes only — not veterinary advice. Always consult your veterinarian before making dietary changes.")
                    .font(.system(size: 11))
                    .foregroundColor(.appTextSecondary.opacity(0.8))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, AppSpacing.md)
        }
        .padding()
        .background(Color.appTextSecondary.opacity(0.05))
        .cornerRadius(AppCornerRadius.large)
        .padding(.horizontal)
        .task {
            await loadCommunityStats()
        }
    }
    
    private func loadCommunityStats() async {
        do {
            communityStats = try await APIService.shared.fetchCommunityStats()
        } catch {
            // Silently fail - trust indicators will still show AAFCO
            print("Failed to load community stats: \(error)")
        }
    }
}

// MARK: - Trust Badge
struct TrustBadge: View {
    let icon: String
    let value: String
    let label: String
    
    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundColor(.appPrimary)
            
            Text(value)
                .font(.system(size: 14, weight: .bold))
                .foregroundColor(.appTextPrimary)
            
            Text(label)
                .font(.system(size: 10))
                .foregroundColor(.appTextSecondary)
        }
        .frame(minWidth: 60)
    }
}

// MARK: - Preview
#Preview {
    NavigationView {
        ResultView(result: ScanResult(
            scanId: "123",
            scanType: "label_photo",
            extracted: ScanResult.ExtractedInfo(
                productName: "Premium Chicken & Rice Adult Dog Food",
                brand: "PetNutrition Pro",
                targetPet: "dog",
                ingredientCount: 2,
                confidence: 0.95
            ),
            product: ScanResult.ProductSummary(
                id: "1",
                name: "Premium Chicken & Rice Adult Dog Food",
                brand: "PetNutrition Pro",
                imageUrl: nil,
                productType: "dry_food"
            ),
            analysis: Analysis(
                finalScore: 78,
                grade: "B",
                recommendation: "recommended",
                ingredients: [
                    IngredientAnalysis(name: "Chicken", normalizedName: "chicken", position: 1, riskLevel: "safe", adjustedRiskScore: 5, isToxic: false, isAllergenMatch: false, isHealthConcern: false, hasTaurine: true, explanation: nil, positiveBenefit: "High quality protein"),
                    IngredientAnalysis(name: "Brown Rice", normalizedName: "brown_rice", position: 2, riskLevel: "low", adjustedRiskScore: 10, isToxic: false, isAllergenMatch: false, isHealthConcern: false, hasTaurine: false, explanation: nil, positiveBenefit: nil)
                ],
                warnings: [
                    Warning(ingredient: "Corn", level: "caution", reason: "Can cause digestive issues in sensitive dogs")
                ],
                positives: ["Excellent protein source from chicken"],
                summary: "This food is a good choice for your dog. It contains quality protein sources and beneficial nutrients.",
                hasTaurine: true,
                toxicCount: 0,
                allergenCount: 0,
                healthConcernCount: 0,
                keyIssues: nil,
                proteinQuality: "high",
                hasArtificialAdditives: false
            ),
            aiInsights: AIInsights(
                personalizedSummary: "This premium food is an excellent choice for Max! It features real chicken as the first ingredient.",
                topConcerns: ["Contains corn which may cause digestive issues in some dogs"],
                topBenefits: ["High-quality chicken protein supports muscle health", "Brown rice provides sustained energy"],
                feedingTip: "Feed 2-3 cups daily based on Max's activity level",
                alternativeAdvice: nil,
                confidenceNote: "High confidence analysis",
                aiGenerated: true
            ),
            pet: PetSummary(id: "1", name: "Max", petType: "dog")
        ))
        .environmentObject(AppState())
    }
}

