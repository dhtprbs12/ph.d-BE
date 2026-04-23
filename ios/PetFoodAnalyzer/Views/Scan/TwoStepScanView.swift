import SwiftUI

/// Two-step scanning flow: Front label first, then back label
struct TwoStepScanView: View {
    let pet: Pet
    let onComplete: (ScanResult) -> Void
    let onCancel: () -> Void
    
    @State private var currentStep: ScanStep = .front
    @State private var pendingScanId: String?
    @State private var capturedFrontData: CapturedFrontData?
    @State private var isProcessing = false
    @State private var errorMessage: String?
    @State private var showImageSourceOptions = false
    @State private var showCamera = false
    @State private var showPhotoLibrary = false
    @State private var analysisProgress: String = "Analyzing ingredients..."
    @State private var ingredientCount: Int = 0
    @State private var analysisSteps: [AnalysisStep] = []
    @State private var candidates: [ScanService.ProductCandidate] = []
    
    struct AnalysisStep: Identifiable {
        let id = UUID()
        let label: String
        var isComplete: Bool
    }
    
    enum ScanStep {
        case front
        case frontCaptured
        case selectCandidate
        case back
        case analyzing
    }
    
    struct CapturedFrontData {
        let productName: String?
        let brand: String?
        let targetPet: String?
        let productType: String?
    }
    
    var body: some View {
        NavigationView {
            ZStack {
                Color.appBackground.ignoresSafeArea()
                
                VStack(spacing: 0) {
                    // Progress indicator
                    progressHeader
                    
                    // Content based on step
                    switch currentStep {
                    case .front:
                        frontStepView
                    case .frontCaptured:
                        frontCapturedView
                    case .selectCandidate:
                        candidateSelectionView
                    case .back:
                        backStepView
                    case .analyzing:
                        analyzingView
                    }
                }
            }
            .navigationTitle("Scan Product")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") {
                        onCancel()
                    }
                    .foregroundColor(.appTeal)
                }
            }
            .confirmationDialog("Choose Image Source", isPresented: $showImageSourceOptions, titleVisibility: .visible) {
                Button("Take Photo") {
                    showCamera = true
                }
                Button("Choose from Library") {
                    showPhotoLibrary = true
                }
                Button("Cancel", role: .cancel) {}
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraCaptureView(
                    onCapture: { image in
                        handleCapturedImage(image)
                    },
                    onDismiss: {
                        showCamera = false
                    }
                )
                .ignoresSafeArea()
            }
            .fullScreenCover(isPresented: $showPhotoLibrary) {
                PhotoLibraryPicker(
                    onSelect: { image in
                        handleCapturedImage(image)
                    },
                    onDismiss: {
                        showPhotoLibrary = false
                    }
                )
                .ignoresSafeArea()
            }
            .alert("Error", isPresented: .constant(errorMessage != nil)) {
                Button("OK") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
            .overlay {
                // Loading overlay when processing photo
                if isProcessing && currentStep != .analyzing {
                    ZStack {
                        Color.black.opacity(0.4)
                            .ignoresSafeArea()
                        
                        VStack(spacing: AppSpacing.md) {
                            ProgressView()
                                .scaleEffect(1.5)
                                .tint(.white)
                            
                            Text(currentStep == .front ? "Reading front label..." : "Processing image...")
                                .font(AppTypography.labelLarge())
                                .foregroundColor(.white)
                        }
                        .padding(AppSpacing.xl)
                        .background(Color.appTextPrimary.opacity(0.85))
                        .cornerRadius(AppCornerRadius.large)
                    }
                    .transition(.opacity)
                    .animation(.easeInOut(duration: 0.2), value: isProcessing)
                }
            }
        }
    }
    
    // MARK: - Progress Header
    
    private var progressHeader: some View {
        HStack(spacing: 0) {
            stepIndicator(
                number: 1,
                title: "Front Label",
                subtitle: "Name & Brand",
                isActive: currentStep == .front,
                isComplete: currentStep != .front
            )
            
            Rectangle()
                .fill(currentStep == .front ? Color.appTextSecondary.opacity(0.2) : Color.appTeal)
                .frame(height: 2)
                .padding(.horizontal, 4)
            
            stepIndicator(
                number: 2,
                title: "Back Label",
                subtitle: "Ingredients",
                isActive: currentStep == .back || currentStep == .frontCaptured,
                isComplete: currentStep == .analyzing || currentStep == .selectCandidate
            )
        }
        .padding(.horizontal, AppSpacing.lg)
        .padding(.vertical, AppSpacing.md)
        .background(Color.appCardBackground)
    }
    
    private func stepIndicator(number: Int, title: String, subtitle: String, isActive: Bool, isComplete: Bool) -> some View {
        VStack(spacing: 6) {
            ZStack {
                Circle()
                    .fill(isComplete ? Color.appTeal : (isActive ? Color.appTeal : Color.appTextSecondary.opacity(0.15)))
                    .frame(width: 36, height: 36)
                    .shadow(color: isActive ? Color.appTeal.opacity(0.3) : .clear, radius: 6, y: 2)
                
                if isComplete {
                    Image(systemName: "checkmark")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(.white)
                } else {
                    Text("\(number)")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(isActive ? .white : .appTextSecondary)
                }
            }
            
            VStack(spacing: 1) {
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(isActive || isComplete ? .appTextPrimary : .appTextSecondary)
                
                Text(subtitle)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(isActive || isComplete ? .appTeal : .appTextSecondary.opacity(0.6))
            }
        }
    }
    
    // MARK: - Step Views
    
    private var frontStepView: some View {
        VStack(spacing: AppSpacing.lg) {
            Spacer()
            
            // Visual illustration
            ZStack {
                RoundedRectangle(cornerRadius: 20)
                    .fill(Color.appTeal.opacity(0.08))
                    .frame(width: 180, height: 220)
                
                VStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color.appTeal.opacity(0.4), style: StrokeStyle(lineWidth: 2, dash: [8, 4]))
                        .frame(width: 140, height: 160)
                        .overlay(
                            VStack(spacing: 8) {
                                Image(systemName: "pawprint.fill")
                                    .font(.system(size: 28))
                                    .foregroundColor(.appTeal.opacity(0.5))
                                Text("BRAND")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundColor(.appTeal.opacity(0.5))
                                    .tracking(2)
                                Text("Product Name")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundColor(.appTeal.opacity(0.6))
                            }
                        )
                    
                    Text("FRONT")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(.appTeal)
                        .tracking(2)
                }
            }
            
            VStack(spacing: AppSpacing.sm) {
                Text("Step 1: Front Label")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundColor(.appTextPrimary)
                
                Text("Capture the **product name** and **brand** from the front of the package")
                    .font(AppTypography.bodyMedium())
                    .foregroundColor(.appTextSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, AppSpacing.xl)
            }
            
            Spacer()
            
            VStack(spacing: AppSpacing.md) {
                Button {
                    showCamera = true
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 18))
                        Text("Scan Front Label")
                            .fontWeight(.semibold)
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                
                Button {
                    showPhotoLibrary = true
                } label: {
                    HStack {
                        Image(systemName: "photo.on.rectangle")
                        Text("Choose from Library")
                    }
                }
                .buttonStyle(SecondaryButtonStyle())
            }
            .padding(.horizontal, AppSpacing.xl)
            .padding(.bottom, AppSpacing.xl)
        }
    }
    
    private var frontCapturedView: some View {
        VStack(spacing: AppSpacing.xl) {
            Spacer()
            
            ZStack {
                Circle()
                    .fill(Color.appSafe.opacity(0.1))
                    .frame(width: 100, height: 100)
                
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 50))
                    .foregroundColor(.appSafe)
            }
            
            VStack(spacing: AppSpacing.md) {
                Text("Front Label Captured!")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundColor(.appTextPrimary)
                
                if let data = capturedFrontData {
                    VStack(spacing: AppSpacing.xs) {
                        if let brand = data.brand {
                            Text(brand.uppercased())
                                .font(.system(size: 11, weight: .bold))
                                .foregroundColor(.appTeal)
                                .tracking(1.5)
                        }
                        Text(data.productName ?? "Product")
                            .font(AppTypography.labelLarge())
                            .foregroundColor(.appTextPrimary)
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                    .frame(maxWidth: .infinity)
                    .background(Color.appCardBackground)
                    .cornerRadius(AppCornerRadius.medium)
                    .shadow(color: .black.opacity(0.04), radius: 8, y: 4)
                    .padding(.horizontal, AppSpacing.xl)
                }
            }
            
            // Flip instruction
            VStack(spacing: 8) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 28))
                    .foregroundColor(.appTeal)
                
                Text("Flip the package over")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.appTextPrimary)
                
                Text("We need the ingredients list from the back")
                    .font(AppTypography.bodySmall())
                    .foregroundColor(.appTextSecondary)
            }
            .padding(.vertical, AppSpacing.md)
            
            Spacer()
            
            Button {
                currentStep = .back
            } label: {
                HStack(spacing: 10) {
                    Text("Continue to Back Label")
                        .fontWeight(.semibold)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 14, weight: .bold))
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .padding(.horizontal, AppSpacing.xl)
            .padding(.bottom, AppSpacing.xl)
        }
    }
    
    // MARK: - Candidate Selection View
    
    private var candidateSelectionView: some View {
        VStack(spacing: 0) {
            // Header
            VStack(spacing: AppSpacing.sm) {
                ZStack {
                    Circle()
                        .fill(Color.appTeal.opacity(0.1))
                        .frame(width: 64, height: 64)
                    
                    Image(systemName: "sparkle.magnifyingglass")
                        .font(.system(size: 28))
                        .foregroundColor(.appTeal)
                }
                .padding(.top, AppSpacing.lg)
                
                Text("Is this your product?")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundColor(.appTextPrimary)
                
                if let data = capturedFrontData {
                    Text("We found matches for \"\(data.brand ?? "") \(data.productName ?? "")\"")
                        .font(AppTypography.bodySmall())
                        .foregroundColor(.appTextSecondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .padding(.horizontal, AppSpacing.xl)
                }
            }
            
            // Candidate list
            ScrollView {
                VStack(spacing: AppSpacing.sm) {
                    ForEach(candidates) { candidate in
                        Button {
                            selectCandidate(candidate)
                        } label: {
                            HStack(spacing: 12) {
                                // Product image or placeholder
                                if let urlStr = candidate.imageUrl, let url = URL(string: urlStr) {
                                    AsyncImage(url: url) { image in
                                        image.resizable().aspectRatio(contentMode: .fill)
                                    } placeholder: {
                                        RoundedRectangle(cornerRadius: 8)
                                            .fill(Color.appTeal.opacity(0.08))
                                            .overlay(
                                                Image(systemName: "photo")
                                                    .foregroundColor(.appTeal.opacity(0.3))
                                            )
                                    }
                                    .frame(width: 56, height: 56)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                } else {
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(Color.appTeal.opacity(0.08))
                                        .frame(width: 56, height: 56)
                                        .overlay(
                                            Image(systemName: "pawprint.fill")
                                                .foregroundColor(.appTeal.opacity(0.3))
                                        )
                                }
                                
                                VStack(alignment: .leading, spacing: 3) {
                                    if let brand = candidate.brand, !brand.isEmpty {
                                        Text(brand.uppercased())
                                            .font(.system(size: 10, weight: .bold))
                                            .foregroundColor(.appTeal)
                                            .tracking(1)
                                    }
                                    Text(candidate.name ?? "Unknown Product")
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundColor(.appTextPrimary)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                    
                                    if let type = candidate.productType {
                                        Text(type.replacingOccurrences(of: "_", with: " ").capitalized)
                                            .font(.system(size: 11))
                                            .foregroundColor(.appTextSecondary)
                                    }
                                }
                                
                                Spacer()
                                
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundColor(.appTeal)
                            }
                            .padding(12)
                            .background(Color.appCardBackground)
                            .cornerRadius(AppCornerRadius.medium)
                            .shadow(color: .black.opacity(0.04), radius: 6, y: 3)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, AppSpacing.lg)
                .padding(.top, AppSpacing.md)
            }
            
            // "Not my product" button
            VStack(spacing: AppSpacing.sm) {
                Divider()
                
                Button {
                    currentStep = .frontCaptured
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.right.circle")
                            .font(.system(size: 16))
                        Text("Not here — scan back label instead")
                            .font(.system(size: 15, weight: .medium))
                    }
                    .foregroundColor(.appTextSecondary)
                    .padding(.vertical, AppSpacing.md)
                }
            }
            .padding(.horizontal, AppSpacing.lg)
            .padding(.bottom, AppSpacing.md)
        }
    }
    
    private func selectCandidate(_ candidate: ScanService.ProductCandidate) {
        currentStep = .analyzing
        isProcessing = true
        
        capturedFrontData = CapturedFrontData(
            productName: candidate.name,
            brand: candidate.brand,
            targetPet: candidate.targetPetType,
            productType: candidate.productType
        )
        
        analysisSteps = [
            AnalysisStep(label: "Loading ingredients", isComplete: false),
            AnalysisStep(label: "Checking database", isComplete: false),
            AnalysisStep(label: "Scoring for \(pet.name)", isComplete: false),
            AnalysisStep(label: "Generating report", isComplete: false)
        ]
        
        Task {
            do {
                let result = try await ScanService.shared.quickAnalyze(
                    productId: candidate.id,
                    pet: pet
                ) { progress, response in
                    Task { @MainActor in
                        if let count = response?.extracted?.ingredientCount, count > 0 {
                            ingredientCount = count
                        }
                        updateSteps(from: progress)
                    }
                }
                
                await MainActor.run {
                    for i in analysisSteps.indices {
                        analysisSteps[i].isComplete = true
                    }
                    isProcessing = false
                    onComplete(result)
                }
            } catch {
                await MainActor.run {
                    errorMessage = "Analysis failed. Please try scanning the back label instead."
                    currentStep = .frontCaptured
                    isProcessing = false
                }
            }
        }
    }
    
    private var backStepView: some View {
        VStack(spacing: AppSpacing.lg) {
            Spacer()
            
            // Visual illustration
            ZStack {
                RoundedRectangle(cornerRadius: 20)
                    .fill(Color.appTeal.opacity(0.08))
                    .frame(width: 180, height: 220)
                
                VStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color.appTeal.opacity(0.4), style: StrokeStyle(lineWidth: 2, dash: [8, 4]))
                        .frame(width: 140, height: 160)
                        .overlay(
                            VStack(spacing: 4) {
                                Text("Ingredients:")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundColor(.appTeal.opacity(0.6))
                                
                                ForEach(0..<4, id: \.self) { _ in
                                    RoundedRectangle(cornerRadius: 1)
                                        .fill(Color.appTeal.opacity(0.2))
                                        .frame(width: 100, height: 4)
                                }
                                
                                Spacer().frame(height: 8)
                                
                                Text("Nutrition Facts")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundColor(.appTeal.opacity(0.5))
                                
                                ForEach(0..<3, id: \.self) { _ in
                                    RoundedRectangle(cornerRadius: 1)
                                        .fill(Color.appTeal.opacity(0.15))
                                        .frame(width: 80, height: 3)
                                }
                            }
                            .padding(.vertical, 12)
                        )
                    
                    Text("BACK")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(.appTeal)
                        .tracking(2)
                }
            }
            
            VStack(spacing: AppSpacing.sm) {
                Text("Step 2: Back Label")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundColor(.appTextPrimary)
                
                Text("Now flip the package and capture the **ingredients list** and **nutrition info**")
                    .font(AppTypography.bodyMedium())
                    .foregroundColor(.appTextSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, AppSpacing.xl)
            }
            
            if let data = capturedFrontData {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.appSafe)
                        .font(.system(size: 16))
                    Text("\(data.brand ?? "") \(data.productName ?? "")".trimmingCharacters(in: .whitespaces))
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextPrimary)
                        .lineLimit(1)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.appSafe.opacity(0.1))
                .cornerRadius(AppCornerRadius.medium)
            }
            
            Spacer()
            
            VStack(spacing: AppSpacing.md) {
                Button {
                    showCamera = true
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 18))
                        Text("Scan Back Label")
                            .fontWeight(.semibold)
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                
                Button {
                    showPhotoLibrary = true
                } label: {
                    HStack {
                        Image(systemName: "photo.on.rectangle")
                        Text("Choose from Library")
                    }
                }
                .buttonStyle(SecondaryButtonStyle())
            }
            .padding(.horizontal, AppSpacing.xl)
            .padding(.bottom, AppSpacing.xl)
        }
    }
    
    private var analyzingView: some View {
        VStack(spacing: 0) {
            Spacer()
            
            // Product info card
            if let data = capturedFrontData {
                VStack(spacing: 12) {
                    if let brand = data.brand {
                        Text(brand.uppercased())
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(.appTeal)
                            .tracking(1.5)
                    }
                    
                    Text(data.productName ?? "Product")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundColor(.appTextPrimary)
                        .multilineTextAlignment(.center)
                    
                    if ingredientCount > 0 {
                        Text("\(ingredientCount) ingredients detected")
                            .font(.system(size: 13))
                            .foregroundColor(.appTextSecondary)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity)
                .background(Color.appCardBackground)
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.04), radius: 8, y: 4)
                .padding(.horizontal, AppSpacing.xl)
            }
            
            Spacer().frame(height: 32)
            
            // Progress steps
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(analysisSteps.enumerated()), id: \.element.id) { index, step in
                    HStack(spacing: 12) {
                        if step.isComplete {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 20))
                                .foregroundColor(.appSafe)
                        } else if index == analysisSteps.firstIndex(where: { !$0.isComplete }) {
                            ProgressView()
                                .scaleEffect(0.8)
                                .frame(width: 20, height: 20)
                        } else {
                            Circle()
                                .stroke(Color.appTextSecondary.opacity(0.3), lineWidth: 1.5)
                                .frame(width: 20, height: 20)
                        }
                        
                        Text(step.label)
                            .font(.system(size: 14, weight: step.isComplete ? .medium : .regular))
                            .foregroundColor(step.isComplete ? .appTextPrimary : .appTextSecondary)
                    }
                    .animation(.easeInOut(duration: 0.3), value: step.isComplete)
                }
            }
            .padding(.horizontal, 40)
            
            Spacer()
            
            // Bottom info
            VStack(spacing: 8) {
                Text("First-time scans take longer while we build the analysis")
                    .font(.system(size: 12))
                    .foregroundColor(.appTextSecondary.opacity(0.6))
                    .multilineTextAlignment(.center)
                
                Text("Previously scanned products are instant")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.appTeal.opacity(0.7))
            }
            .padding(.horizontal, AppSpacing.xl)
            .padding(.bottom, AppSpacing.xl)
        }
    }
    
    // MARK: - Image Handling
    
    private func handleCapturedImage(_ image: UIImage) {
        showCamera = false
        
        switch currentStep {
        case .front:
            processFrontLabel(image)
        case .back, .frontCaptured:
            processBackLabel(image)
        default:
            break
        }
    }
    
    private func processFrontLabel(_ image: UIImage) {
        isProcessing = true
        
        Task {
            do {
                let result = try await ScanService.shared.scanFrontLabel(image: image)
                
                await MainActor.run {
                    pendingScanId = result.pendingScanId
                    capturedFrontData = CapturedFrontData(
                        productName: result.productName,
                        brand: result.brand,
                        targetPet: result.targetPet,
                        productType: result.productType
                    )
                    candidates = result.candidates
                    
                    if !result.candidates.isEmpty {
                        currentStep = .selectCandidate
                    } else {
                        currentStep = .frontCaptured
                    }
                    isProcessing = false
                }
            } catch let error as ScanError {
                await MainActor.run {
                    switch error {
                    case .apiError(let message):
                        errorMessage = message
                    default:
                        errorMessage = "Could not read the front label. Please try again."
                    }
                    isProcessing = false
                }
            } catch let error as APIError {
                await MainActor.run {
                    if case .serverError(let message, _) = error {
                        errorMessage = message
                    } else {
                        errorMessage = "Could not read the front label. Please try again."
                    }
                    isProcessing = false
                }
            } catch {
                await MainActor.run {
                    errorMessage = "Could not read the front label. Please try again."
                    isProcessing = false
                }
            }
        }
    }
    
    private func processBackLabel(_ image: UIImage) {
        guard let pendingScanId = pendingScanId else {
            errorMessage = "No front label data. Please start over."
            currentStep = .front
            return
        }
        
        currentStep = .analyzing
        isProcessing = true
        
        analysisSteps = [
            AnalysisStep(label: "Reading ingredients", isComplete: false),
            AnalysisStep(label: "Checking database", isComplete: false),
            AnalysisStep(label: "Scoring for \(pet.name)", isComplete: false),
            AnalysisStep(label: "Generating report", isComplete: false)
        ]
        
        Task {
            do {
                let result = try await ScanService.shared.scanBackLabel(
                    image: image,
                    pendingScanId: pendingScanId,
                    pet: pet
                ) { progress, response in
                    Task { @MainActor in
                        if let count = response?.extracted?.ingredientCount, count > 0 {
                            ingredientCount = count
                        }
                        updateSteps(from: progress)
                    }
                }
                
                await MainActor.run {
                    for i in analysisSteps.indices {
                        analysisSteps[i].isComplete = true
                    }
                    isProcessing = false
                    onComplete(result)
                }
            } catch {
                await MainActor.run {
                    errorMessage = "Something went wrong. Please try scanning again."
                    currentStep = .back
                    isProcessing = false
                }
            }
        }
    }
    
    private func updateSteps(from progress: String) {
        let lower = progress.lowercased()
        
        // "Analyzing ingredients..." -> step 0 complete
        if lower.contains("analyzing ingredient") || lower.contains("reading ingredient") {
            markStepsComplete(through: 0)
        }
        // "Checking ingredient database..." -> step 1 complete
        if lower.contains("database") || lower.contains("checking") {
            markStepsComplete(through: 1)
        }
        // "Analyzing X condition(s)..." -> step 2 complete
        if lower.contains("condition") {
            markStepsComplete(through: 2)
        }
        // "Calculating score..." / "Generating personalized insights..." -> step 3 in progress
        if lower.contains("calculating") || lower.contains("generating") {
            markStepsComplete(through: 2)
        }
    }
    
    private func markStepsComplete(through index: Int) {
        for i in 0...min(index, analysisSteps.count - 1) {
            if !analysisSteps[i].isComplete {
                withAnimation(.easeInOut(duration: 0.3)) {
                    analysisSteps[i].isComplete = true
                }
            }
        }
    }
}

// MARK: - Photo Library Picker
struct PhotoLibraryPicker: UIViewControllerRepresentable {
    let onSelect: (UIImage) -> Void
    let onDismiss: () -> Void
    
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .photoLibrary
        picker.delegate = context.coordinator
        picker.modalPresentationStyle = .fullScreen
        return picker
    }
    
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    
    func makeCoordinator() -> Coordinator {
        Coordinator(onSelect: onSelect, onDismiss: onDismiss)
    }
    
    class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onSelect: (UIImage) -> Void
        let onDismiss: () -> Void
        
        init(onSelect: @escaping (UIImage) -> Void, onDismiss: @escaping () -> Void) {
            self.onSelect = onSelect
            self.onDismiss = onDismiss
        }
        
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
            if let image = info[.originalImage] as? UIImage {
                onSelect(image)
            }
            onDismiss()
        }
        
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onDismiss()
        }
    }
}

// MARK: - Camera Capture View
struct CameraCaptureView: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    let onDismiss: () -> Void
    
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        picker.modalPresentationStyle = .fullScreen
        picker.cameraCaptureMode = .photo
        picker.cameraDevice = .rear
        return picker
    }
    
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    
    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onDismiss: onDismiss)
    }
    
    class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (UIImage) -> Void
        let onDismiss: () -> Void
        
        init(onCapture: @escaping (UIImage) -> Void, onDismiss: @escaping () -> Void) {
            self.onCapture = onCapture
            self.onDismiss = onDismiss
        }
        
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
            if let image = info[.originalImage] as? UIImage {
                onCapture(image)
            }
            onDismiss()
        }
        
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onDismiss()
        }
    }
}

