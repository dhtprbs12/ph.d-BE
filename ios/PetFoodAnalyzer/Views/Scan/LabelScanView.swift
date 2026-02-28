import SwiftUI

struct LabelScanView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    
    @State private var selectedImage: UIImage?
    @State private var showCamera = false
    @State private var showPhotoLibrary = false
    @State private var isLoading = false
    @State private var scanResult: ScanResult?
    @State private var showResult = false
    @State private var errorMessage: String?
    @State private var frontLabelDetected = false
    @State private var frontLabelProductName: String?
    @State private var frontLabelSuggestion: String?
    
    // Progressive loading state
    @State private var progressMessage: String = "Starting analysis..."
    @State private var detectedProduct: String?
    @State private var detectedIngredients: [String] = []
    
    var body: some View {
        ScrollView {
            VStack(spacing: AppSpacing.xl) {
                // Instructions
                VStack(spacing: AppSpacing.sm) {
                    Image(systemName: "doc.text.viewfinder")
                        .font(.system(size: 50))
                        .foregroundColor(.appOrange)
                    
                    Text("Scan Ingredient Label")
                        .font(AppTypography.displaySmall())
                    
                    Text("Take a clear photo of the ingredient list on the back of the package")
                        .font(AppTypography.bodyMedium())
                        .foregroundColor(.appTextSecondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, AppSpacing.xl)
                
                // Image Preview
                if let image = selectedImage {
                    VStack(spacing: AppSpacing.md) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 300)
                            .cornerRadius(AppCornerRadius.large)
                            .cardShadow()
                        
                        Button("Retake Photo") {
                            selectedImage = nil
                        }
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    }
                    .padding(.horizontal)
                } else {
                    // Capture Options
                    VStack(spacing: AppSpacing.md) {
                        // Camera Button
                        Button {
                            showCamera = true
                        } label: {
                            HStack {
                                Image(systemName: "camera.fill")
                                Text("Take Photo")
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle(color: .appOrange))
                        
                        // Photo Library
                        Button {
                            showPhotoLibrary = true
                        } label: {
                            HStack {
                                Image(systemName: "photo.on.rectangle")
                                Text("Choose from Library")
                            }
                        }
                        .buttonStyle(SecondaryButtonStyle(color: .appOrange))
                    }
                    .padding(.horizontal)
                }
                
                // Front Label Detection Warning
                if frontLabelDetected {
                    VStack(spacing: AppSpacing.md) {
                        HStack(spacing: AppSpacing.sm) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundColor(.appWarning)
                            Text("Front Label Detected")
                                .font(AppTypography.labelLarge())
                                .foregroundColor(.appWarning)
                        }
                        
                        if let productName = frontLabelProductName {
                            Text("Product: \(productName)")
                                .font(AppTypography.bodyMedium())
                                .foregroundColor(.appTextPrimary)
                        }
                        
                        Text(frontLabelSuggestion ?? "Please scan the ingredients list on the back of the package.")
                            .font(AppTypography.bodySmall())
                            .foregroundColor(.appTextSecondary)
                            .multilineTextAlignment(.center)
                        
                        Button {
                            frontLabelDetected = false
                            selectedImage = nil
                            errorMessage = nil
                            // Don't open camera directly - let user choose
                        } label: {
                            HStack {
                                Image(systemName: "arrow.triangle.2.circlepath.camera")
                                Text("Scan Back Label")
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle(color: .appWarning))
                    }
                    .padding()
                    .background(Color.appWarning.opacity(0.1))
                    .cornerRadius(AppCornerRadius.large)
                    .padding(.horizontal)
                }
                
                // Error Message
                if let error = errorMessage, !frontLabelDetected {
                    Text(error)
                        .font(AppTypography.bodySmall())
                        .foregroundColor(.appDanger)
                        .padding()
                        .background(Color.appDanger.opacity(0.1))
                        .cornerRadius(AppCornerRadius.small)
                        .padding(.horizontal)
                }
                
                // Analyze Button or Loading State
                if selectedImage != nil {
                    if isLoading {
                        // Progressive Loading View
                        VStack(spacing: AppSpacing.lg) {
                            // Progress indicator
                            VStack(spacing: AppSpacing.sm) {
                                ProgressView()
                                    .scaleEffect(1.2)
                                
                                Text(progressMessage)
                                    .font(AppTypography.labelMedium())
                                    .foregroundColor(.appTextSecondary)
                                    .multilineTextAlignment(.center)
                            }
                            .padding()
                            
                            // Show detected product
                            if let product = detectedProduct {
                                HStack(spacing: AppSpacing.sm) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundColor(.appTeal)
                                    Text("Found: \(product)")
                                        .font(AppTypography.labelLarge())
                                        .foregroundColor(.appTextPrimary)
                                }
                                .padding(.horizontal)
                            }
                            
                            // Show detected ingredients
                            if !detectedIngredients.isEmpty {
                                VStack(alignment: .leading, spacing: AppSpacing.xs) {
                                    HStack {
                                        Image(systemName: "list.bullet")
                                            .foregroundColor(.appOrange)
                                        Text("\(detectedIngredients.count) ingredients detected")
                                            .font(AppTypography.labelMedium())
                                            .foregroundColor(.appTextSecondary)
                                    }
                                    
                                    // Show first few ingredients
                                    FlowLayout(spacing: 6) {
                                        ForEach(detectedIngredients.prefix(8), id: \.self) { ingredient in
                                            Text(ingredient)
                                                .font(AppTypography.bodySmall())
                                                .padding(.horizontal, 8)
                                                .padding(.vertical, 4)
                                                .background(Color.appLightGray)
                                                .cornerRadius(AppCornerRadius.small)
                                        }
                                        if detectedIngredients.count > 8 {
                                            Text("+\(detectedIngredients.count - 8) more")
                                                .font(AppTypography.bodySmall())
                                                .foregroundColor(.appTextSecondary)
                                                .padding(.horizontal, 8)
                                                .padding(.vertical, 4)
                                        }
                                    }
                                }
                                .padding()
                                .background(Color.appLightGray.opacity(0.5))
                                .cornerRadius(AppCornerRadius.medium)
                                .padding(.horizontal)
                            }
                        }
                        .padding(.vertical)
                    } else {
                        Button {
                            analyzeImage()
                        } label: {
                            HStack {
                                Image(systemName: "sparkle.magnifyingglass")
                                Text("Analyze Ingredients")
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle(color: .appTeal, isDisabled: false))
                        .padding(.horizontal)
                    }
                }
                
                // Tips
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    Text("Tips for best results:")
                        .font(AppTypography.labelLarge())
                    
                    BulletPoint(text: "Ensure good lighting")
                    BulletPoint(text: "Keep the camera steady")
                    BulletPoint(text: "Make sure all text is readable")
                    BulletPoint(text: "Include the complete ingredient list")
                }
                .padding()
                .background(Color.appLightGray)
                .cornerRadius(AppCornerRadius.large)
                .padding(.horizontal)
                
                Spacer(minLength: AppSpacing.xxl)
            }
        }
        .background(Color.appBackground)
        .navigationTitle("Label Scan")
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(isPresented: $showCamera) {
            FullScreenImagePicker(image: $selectedImage, sourceType: .camera)
        }
        .fullScreenCover(isPresented: $showPhotoLibrary) {
            FullScreenImagePicker(image: $selectedImage, sourceType: .photoLibrary)
        }
        .background(
            NavigationLink(
                destination: Group {
                    if let result = scanResult {
                        ResultView(result: result)
                    }
                },
                isActive: $showResult
            ) {
                EmptyView()
            }
        )
    }
    
    private func analyzeImage() {
        guard let image = selectedImage, let pet = appState.selectedPet else { return }
        
        isLoading = true
        errorMessage = nil
        frontLabelDetected = false
        progressMessage = "Uploading image..."
        detectedProduct = nil
        detectedIngredients = []
        
        Task {
            do {
                let result = try await ScanService.shared.scanLabelPhoto(
                    image: image,
                    pet: pet,
                    progressCallback: { message, initialResponse in
                        Task { @MainActor in
                            progressMessage = message
                            
                            // Update with initial data if available
                            if let response = initialResponse {
                                detectedProduct = response.extracted?.productName
                                if let ingredients = response.ingredients {
                                    detectedIngredients = ingredients.map { $0.name }
                                }
                            }
                        }
                    }
                )
                
                await MainActor.run {
                    isLoading = false
                    scanResult = result
                    showResult = true
                }
            } catch let error as ScanError {
                await MainActor.run {
                    isLoading = false
                    switch error {
                    case .frontLabelDetected(let message, let suggestion, let productName):
                        frontLabelDetected = true
                        frontLabelProductName = productName
                        frontLabelSuggestion = suggestion
                        errorMessage = message
                    case .noIngredientsFound(let message):
                        errorMessage = message
                    case .apiError(let message):
                        errorMessage = message
                    case .analysisTimeout:
                        errorMessage = "Analysis took too long. Please try again."
                    }
                }
            } catch {
                await MainActor.run {
                    isLoading = false
                    if error is DecodingError || "\(error)".contains("decode") {
                        errorMessage = "Something went wrong reading the results. Please try scanning again."
                    } else {
                        errorMessage = "Something went wrong. Please try again."
                    }
                }
            }
        }
    }
}

// MARK: - Bullet Point
struct BulletPoint: View {
    let text: String
    
    var body: some View {
        HStack(alignment: .top, spacing: AppSpacing.sm) {
            Circle()
                .fill(Color.appTextSecondary)
                .frame(width: 6, height: 6)
                .padding(.top, 6)
            
            Text(text)
                .font(AppTypography.bodySmall())
                .foregroundColor(.appTextSecondary)
        }
    }
}

// MARK: - Image Picker
struct ImagePicker: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    @Environment(\.dismiss) private var dismiss
    var sourceType: UIImagePickerController.SourceType = .photoLibrary
    
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.delegate = context.coordinator
        picker.sourceType = sourceType
        picker.modalPresentationStyle = .fullScreen
        // For camera, allow editing and use rear camera
        if sourceType == .camera {
            picker.cameraCaptureMode = .photo
            picker.cameraDevice = .rear
        }
        return picker
    }
    
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: ImagePicker
        
        init(_ parent: ImagePicker) {
            self.parent = parent
        }
        
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.image = image
            }
            parent.dismiss()
        }
        
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

// MARK: - Full Screen Image Picker Wrapper
struct FullScreenImagePicker: View {
    @Binding var image: UIImage?
    var sourceType: UIImagePickerController.SourceType
    
    var body: some View {
        ImagePicker(image: $image, sourceType: sourceType)
            .ignoresSafeArea()
    }
}

#Preview {
    NavigationView {
        LabelScanView()
            .environmentObject(AppState())
    }
}

