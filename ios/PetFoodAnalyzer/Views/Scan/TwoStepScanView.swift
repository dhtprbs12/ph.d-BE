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
    
    enum ScanStep {
        case front
        case frontCaptured
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
            // Step 1
            stepIndicator(number: 1, title: "Front", isActive: currentStep == .front, isComplete: currentStep != .front)
            
            // Connector
            Rectangle()
                .fill(currentStep == .front ? Color.appTextSecondary.opacity(0.3) : Color.appTeal)
                .frame(height: 2)
            
            // Step 2
            stepIndicator(number: 2, title: "Back", isActive: currentStep == .back || currentStep == .frontCaptured, isComplete: currentStep == .analyzing)
        }
        .padding()
        .background(Color.appCardBackground)
    }
    
    private func stepIndicator(number: Int, title: String, isActive: Bool, isComplete: Bool) -> some View {
        VStack(spacing: 4) {
            ZStack {
                Circle()
                    .fill(isComplete ? Color.appTeal : (isActive ? Color.appTeal.opacity(0.2) : Color.appTextSecondary.opacity(0.2)))
                    .frame(width: 32, height: 32)
                
                if isComplete {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(.white)
                } else {
                    Text("\(number)")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(isActive ? .appTeal : .appTextSecondary)
                }
            }
            
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(isActive || isComplete ? .appTextPrimary : .appTextSecondary)
        }
    }
    
    // MARK: - Step Views
    
    private var frontStepView: some View {
        VStack(spacing: AppSpacing.xl) {
            Spacer()
            
            // Icon
            ZStack {
                Circle()
                    .fill(Color.appTeal.opacity(0.1))
                    .frame(width: 120, height: 120)
                
                Image(systemName: "camera.viewfinder")
                    .font(.system(size: 50))
                    .foregroundColor(.appTeal)
            }
            
            // Instructions
            VStack(spacing: AppSpacing.sm) {
                Text("Scan Front Label")
                    .font(AppTypography.displaySmall())
                    .foregroundColor(.appTextPrimary)
                
                Text("Take a photo of the front of the package to capture the product name and brand.")
                    .font(AppTypography.bodyMedium())
                    .foregroundColor(.appTextSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, AppSpacing.xl)
            }
            
            Spacer()
            
            // Scan buttons
            VStack(spacing: AppSpacing.md) {
                Button {
                    showCamera = true
                } label: {
                    HStack {
                        Image(systemName: "camera.fill")
                        Text("Take Photo")
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
            
            // Success icon
            ZStack {
                Circle()
                    .fill(Color.appSafe.opacity(0.1))
                    .frame(width: 100, height: 100)
                
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 50))
                    .foregroundColor(.appSafe)
            }
            
            // Captured info
            VStack(spacing: AppSpacing.md) {
                Text("Front Label Captured!")
                    .font(AppTypography.displaySmall())
                    .foregroundColor(.appTextPrimary)
                
                if let data = capturedFrontData {
                    VStack(spacing: AppSpacing.xs) {
                        if let brand = data.brand {
                            Text(brand.uppercased())
                                .font(AppTypography.labelSmall())
                                .foregroundColor(.appTextSecondary)
                        }
                        Text(data.productName ?? "Product")
                            .font(AppTypography.labelLarge())
                            .foregroundColor(.appTextPrimary)
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                    .background(Color.appCardBackground)
                    .cornerRadius(AppCornerRadius.medium)
                }
            }
            
            Spacer()
            
            // Next step button
            VStack(spacing: AppSpacing.md) {
                Text("Now flip the package over")
                    .font(AppTypography.bodyMedium())
                    .foregroundColor(.appTextSecondary)
                
                Button {
                    currentStep = .back
                } label: {
                    HStack {
                        Image(systemName: "arrow.right")
                        Text("Continue to Back Label")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
            }
            .padding(.horizontal, AppSpacing.xl)
            .padding(.bottom, AppSpacing.xl)
        }
    }
    
    private var backStepView: some View {
        VStack(spacing: AppSpacing.xl) {
            Spacer()
            
            // Icon
            ZStack {
                Circle()
                    .fill(Color.appTeal.opacity(0.1))
                    .frame(width: 120, height: 120)
                
                Image(systemName: "list.bullet.rectangle")
                    .font(.system(size: 50))
                    .foregroundColor(.appTeal)
            }
            
            // Instructions
            VStack(spacing: AppSpacing.sm) {
                Text("Scan Ingredients")
                    .font(AppTypography.displaySmall())
                    .foregroundColor(.appTextPrimary)
                
                Text("Take a photo of the ingredients list on the back of the package.")
                    .font(AppTypography.bodyMedium())
                    .foregroundColor(.appTextSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, AppSpacing.xl)
            }
            
            // Show what we captured
            if let data = capturedFrontData {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.appSafe)
                    Text("\(data.brand ?? "") \(data.productName ?? "")".trimmingCharacters(in: .whitespaces))
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                }
                .padding(.horizontal)
                .padding(.vertical, AppSpacing.xs)
                .background(Color.appSafe.opacity(0.1))
                .cornerRadius(AppCornerRadius.small)
            }
            
            Spacer()
            
            // Scan buttons
            VStack(spacing: AppSpacing.md) {
                Button {
                    showCamera = true
                } label: {
                    HStack {
                        Image(systemName: "camera.fill")
                        Text("Take Photo")
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
        VStack(spacing: AppSpacing.xl) {
            Spacer()
            
            ProgressView()
                .scaleEffect(1.5)
                .tint(.appTeal)
            
            Text("Analyzing ingredients...")
                .font(AppTypography.labelLarge())
                .foregroundColor(.appTextPrimary)
            
            if let data = capturedFrontData {
                Text("\(data.brand ?? "") \(data.productName ?? "")")
                    .font(AppTypography.bodyMedium())
                    .foregroundColor(.appTextSecondary)
            }
            
            Spacer()
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
                    currentStep = .frontCaptured
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
        
        Task {
            do {
                let result = try await ScanService.shared.scanBackLabel(
                    image: image,
                    pendingScanId: pendingScanId,
                    pet: pet
                )
                
                await MainActor.run {
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

