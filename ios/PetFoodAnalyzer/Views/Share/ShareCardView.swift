import SwiftUI

/// A beautiful shareable card that shows analysis results
struct ShareCardView: View {
    let result: ScanResult
    
    private var score: Int { result.analysis.finalScore }
    private var grade: String { result.analysis.grade }
    private var petName: String { result.pet.name }
    
    private var productName: String {
        result.extracted?.productName ?? result.product?.name ?? "Pet Food"
    }
    
    private var brand: String? {
        result.extracted?.brand ?? result.product?.brand
    }
    
    // Get top positives (max 3)
    private var topPositives: [String] {
        guard let positives = result.analysis.positives else { return [] }
        return Array(positives.prefix(3))
    }
    
    // Get top warnings (max 2)
    private var topWarnings: [String] {
        if let keyIssues = result.analysis.keyIssues, !keyIssues.isEmpty {
            return Array(keyIssues.prefix(2))
        }
        if let warnings = result.analysis.warnings {
            return Array(warnings.prefix(2).map { $0.reason })
        }
        return []
    }
    
    private var gradeColor: Color {
        Color.gradeColor(grade)
    }
    
    private var petEmoji: String {
        result.pet.petType.lowercased() == "dog" ? "🐕" : "🐱"
    }
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            headerSection
            
            // Main Content
            VStack(spacing: 20) {
                productInfoSection
                scoreCircleSection
                highlightsSection
                Spacer(minLength: 16)
                footerSection
            }
            .background(Color.white)
        }
        .frame(width: 320, height: 480)
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .shadow(color: Color.appTextPrimary.opacity(0.15), radius: 10, x: 0, y: 5)
    }
    
    // MARK: - Subviews
    
    private var headerSection: some View {
        HStack {
            Text("\(petEmoji) \(petName)'s Food Check")
                .font(.system(size: 18, weight: .semibold))
                .foregroundColor(.white)
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .background(
            LinearGradient(
                colors: [Color.appPrimary, Color.appPrimary.opacity(0.85)],
                startPoint: .leading,
                endPoint: .trailing
            )
        )
    }
    
    private var productInfoSection: some View {
        VStack(spacing: 4) {
            if let brandName = brand {
                Text(brandName.uppercased())
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.appTextSecondary)
                    .tracking(1)
            }
            Text(productName)
                .font(.system(size: 20, weight: .bold))
                .foregroundColor(.appTextPrimary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
        }
        .padding(.top, 20)
        .padding(.horizontal, 20)
    }
    
    private var scoreCircleSection: some View {
        ZStack {
            Circle()
                .stroke(gradeColor.opacity(0.2), lineWidth: 12)
                .frame(width: 120, height: 120)
            
            Circle()
                .trim(from: 0, to: CGFloat(score) / 100)
                .stroke(gradeColor, style: StrokeStyle(lineWidth: 12, lineCap: .round))
                .frame(width: 120, height: 120)
                .rotationEffect(.degrees(-90))
            
            VStack(spacing: 2) {
                Text("\(score)")
                    .font(.system(size: 42, weight: .bold, design: .rounded))
                    .foregroundColor(gradeColor)
                Text("Grade \(grade)")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(gradeColor)
            }
        }
    }
    
    private var highlightsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(topPositives, id: \.self) { positive in
                highlightRow(emoji: "✅", text: positive)
            }
            
            ForEach(topWarnings, id: \.self) { warning in
                highlightRow(emoji: "⚠️", text: warning)
            }
        }
        .padding(.horizontal, 20)
    }
    
    private func highlightRow(emoji: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(emoji)
                .font(.system(size: 14))
            Text(text)
                .font(.system(size: 13))
                .foregroundColor(.appTextPrimary.opacity(0.8))
                .lineLimit(2)
        }
    }
    
    private var footerSection: some View {
        VStack(spacing: 6) {
            Divider()
            
            HStack(spacing: 6) {
                Text("🐾")
                    .font(.system(size: 16))
                Text("PetFood Analyzer")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.appPrimary)
            }
            
            Text("Know what's in your pet's food")
                .font(.system(size: 11))
                .foregroundColor(.appTextSecondary)
        }
        .padding(.bottom, 16)
    }
}

// MARK: - Render to Image
extension ShareCardView {
    @MainActor
    func renderAsImage() -> UIImage? {
        // Wrap in a view that provides proper environment
        let wrappedView = self
            .background(Color.white)
            .environment(\.colorScheme, .light)
        
        let controller = UIHostingController(rootView: wrappedView)
        controller.view.backgroundColor = .white
        
        // Set fixed size matching our card
        let size = CGSize(width: 320, height: 480)
        controller.view.frame = CGRect(origin: .zero, size: size)
        
        // Add to a window temporarily for proper rendering
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        
        // Force layout
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        
        // Small delay to ensure rendering completes
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
        
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { context in
            controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
        }
        
        // Clean up
        window.isHidden = true
        
        return image
    }
}

// MARK: - Share Sheet Helper
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
