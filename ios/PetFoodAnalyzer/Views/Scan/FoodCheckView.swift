import SwiftUI
import AVFoundation

struct FoodCheckView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    
    @State private var capturedImage: UIImage?
    @State private var isAnalyzing = false
    @State private var result: FoodCheckResult?
    @State private var errorMessage: String?
    @State private var showCamera = false
    @State private var showPhotoLibrary = false
    @State private var showSourceOptions = false
    
    var body: some View {
        NavigationView {
            ZStack {
                Color.appBackground.ignoresSafeArea()
                
                if isAnalyzing {
                    // Loading State
                    FoodAnalyzingView(image: capturedImage)
                } else if let result = result {
                    // Result View
                    FoodCheckResultView(
                        result: result,
                        image: capturedImage,
                        petName: appState.selectedPet?.name ?? "your pet",
                        onCheckAnother: {
                            self.result = nil
                            self.capturedImage = nil
                            self.errorMessage = nil
                        },
                        onDone: {
                            dismiss()
                        }
                    )
                } else if let error = errorMessage {
                    // Error State
                    FoodErrorView(
                        message: error,
                        onRetry: {
                            errorMessage = nil
                        },
                        onCancel: {
                            dismiss()
                        }
                    )
                } else {
                    // Initial State - show camera prompt
                    FoodCapturePromptView(
                        onTakePhoto: {
                            showCamera = true
                        },
                        onChoosePhoto: {
                            showPhotoLibrary = true
                        }
                    )
                }
            }
            .navigationTitle("Food Check")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") {
                        dismiss()
                    }
                    .foregroundColor(.appPrimary)
                }
            }
            .fullScreenCover(isPresented: $showCamera) {
                FoodCameraCaptureView(
                    onCapture: { image in
                        capturedImage = image
                        showCamera = false
                        analyzeFood(image)
                    },
                    onDismiss: {
                        showCamera = false
                    }
                )
                .ignoresSafeArea()
            }
            .fullScreenCover(isPresented: $showPhotoLibrary) {
                FoodPhotoLibraryPicker(
                    onSelect: { image in
                        capturedImage = image
                        showPhotoLibrary = false
                        analyzeFood(image)
                    },
                    onDismiss: {
                        showPhotoLibrary = false
                    }
                )
                .ignoresSafeArea()
            }
        }
    }
    
    private func analyzeFood(_ image: UIImage) {
        guard let pet = appState.selectedPet else {
            errorMessage = "Please select a pet first"
            return
        }
        
        isAnalyzing = true
        errorMessage = nil
        
        Task {
            do {
                let checkResult = try await ScanService.shared.checkFood(
                    image: image,
                    pet: pet
                )
                
                await MainActor.run {
                    isAnalyzing = false
                    result = checkResult
                }
            } catch {
                await MainActor.run {
                    isAnalyzing = false
                    errorMessage = error.localizedDescription
                }
            }
        }
    }
}

// MARK: - Food Capture Prompt View
struct FoodCapturePromptView: View {
    let onTakePhoto: () -> Void
    let onChoosePhoto: () -> Void
    
    var body: some View {
        VStack(spacing: AppSpacing.xl) {
            Spacer()
            
            // Icon with animation
            ZStack {
                Circle()
                    .fill(Color.appAccent.opacity(0.15))
                    .frame(width: 140, height: 140)
                
                Image(systemName: "questionmark.circle")
                    .font(.system(size: 60))
                    .foregroundColor(.appAccent)
            }
            .staggeredAppear(index: 0)
            
            // Instructions
            VStack(spacing: AppSpacing.md) {
                Text("Check Any Food")
                    .font(AppTypography.displaySmall())
                    .foregroundColor(.appTextPrimary)
                
                Text("Take a photo of any food to see if it's safe for your pet")
                    .font(AppTypography.bodyMedium())
                    .foregroundColor(.appTextSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, AppSpacing.xl)
            }
            .staggeredAppear(index: 1)
            
            // Examples
            HStack(spacing: AppSpacing.md) {
                FoodExampleBadge(emoji: "🍎", name: "Apple")
                FoodExampleBadge(emoji: "🥚", name: "Egg")
                FoodExampleBadge(emoji: "🍫", name: "Chocolate")
                FoodExampleBadge(emoji: "🧀", name: "Cheese")
            }
            .padding(.top, AppSpacing.md)
            .staggeredAppear(index: 2)
            
            Spacer()
            
            // Action buttons
            VStack(spacing: AppSpacing.md) {
                Button(action: onTakePhoto) {
                    HStack {
                        Image(systemName: "camera.fill")
                        Text("Take Photo")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                
                Button(action: onChoosePhoto) {
                    HStack {
                        Image(systemName: "photo.on.rectangle")
                        Text("Choose from Library")
                    }
                }
                .buttonStyle(SecondaryButtonStyle())
            }
            .padding(.horizontal, AppSpacing.xl)
            .padding(.bottom, AppSpacing.xxl)
            .staggeredAppear(index: 3)
        }
    }
}

// MARK: - Food Example Badge
struct FoodExampleBadge: View {
    let emoji: String
    let name: String
    
    var body: some View {
        VStack(spacing: 4) {
            Text(emoji)
                .font(.system(size: 28))
            Text(name)
                .font(AppTypography.labelSmall())
                .foregroundColor(.appTextSecondary)
        }
        .frame(width: 70, height: 70)
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.medium)
        .cardShadow()
    }
}

// MARK: - Food Analyzing View
struct FoodAnalyzingView: View {
    let image: UIImage?
    @State private var rotation: Double = 0
    @State private var pulse = false
    
    var body: some View {
        VStack(spacing: AppSpacing.xl) {
            Spacer()
            
            // Captured image preview
            if let image = image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 160, height: 160)
                    .clipShape(RoundedRectangle(cornerRadius: AppCornerRadius.large))
                    .overlay(
                        RoundedRectangle(cornerRadius: AppCornerRadius.large)
                            .stroke(Color.appPrimary.opacity(0.3), lineWidth: 3)
                    )
                    .scaleEffect(pulse ? 1.02 : 1.0)
                    .animation(.easeInOut(duration: 1).repeatForever(autoreverses: true), value: pulse)
            }
            
            // Loading indicator
            Image(systemName: "sparkle.magnifyingglass")
                .font(.system(size: 44))
                .foregroundColor(.appPrimary)
                .rotationEffect(.degrees(rotation))
                .onAppear {
                    pulse = true
                    withAnimation(.linear(duration: 2).repeatForever(autoreverses: false)) {
                        rotation = 360
                    }
                }
            
            VStack(spacing: AppSpacing.sm) {
                Text("Identifying food...")
                    .font(AppTypography.bodyLarge())
                    .fontWeight(.semibold)
                    .foregroundColor(.appTextPrimary)
                
                Text("Checking if it's safe for your pet")
                    .font(AppTypography.bodyMedium())
                    .foregroundColor(.appTextSecondary)
            }
            
            Spacer()
        }
    }
}

// MARK: - Food Check Result View
struct FoodCheckResultView: View {
    let result: FoodCheckResult
    let image: UIImage?
    let petName: String
    let onCheckAnother: () -> Void
    let onDone: () -> Void
    
    private var safetyColor: Color {
        switch result.safetyLevel.lowercased() {
        case "safe": return .appSafe
        case "caution", "moderate": return .appCaution
        case "danger", "toxic": return .appDanger
        default: return .appTextSecondary
        }
    }
    
    private var safetyIcon: String {
        switch result.safetyLevel.lowercased() {
        case "safe": return "checkmark.circle.fill"
        case "caution", "moderate": return "exclamationmark.triangle.fill"
        case "danger", "toxic": return "xmark.octagon.fill"
        default: return "questionmark.circle.fill"
        }
    }
    
    private var safetyEmoji: String {
        switch result.safetyLevel.lowercased() {
        case "safe": return "✅"
        case "caution", "moderate": return "⚠️"
        case "danger", "toxic": return "🚫"
        default: return "❓"
        }
    }
    
    var body: some View {
        ScrollView {
            VStack(spacing: AppSpacing.lg) {
                // Image + Food Name Header
                VStack(spacing: AppSpacing.md) {
                    if let image = image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 120, height: 120)
                            .clipShape(RoundedRectangle(cornerRadius: AppCornerRadius.large))
                            .overlay(
                                RoundedRectangle(cornerRadius: AppCornerRadius.large)
                                    .stroke(safetyColor.opacity(0.5), lineWidth: 3)
                            )
                    }
                    
                    Text(result.foodName)
                        .font(AppTypography.displaySmall())
                        .foregroundColor(.appTextPrimary)
                    
                    if let category = result.category {
                        Text(category)
                            .font(AppTypography.labelMedium())
                            .foregroundColor(.appTextSecondary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 4)
                            .background(Color.appLightGray)
                            .cornerRadius(AppCornerRadius.small)
                    }
                }
                .padding(.top, AppSpacing.lg)
                .staggeredAppear(index: 0)
                
                // Safety Badge
                HStack(spacing: AppSpacing.md) {
                    Text(safetyEmoji)
                        .font(.system(size: 40))
                    
                    VStack(alignment: .leading, spacing: 4) {
                        Text(result.safetyLevel.uppercased())
                            .font(.system(size: 22, weight: .bold))
                            .foregroundColor(safetyColor)
                        
                        Text("for \(petName)")
                            .font(AppTypography.bodyMedium())
                            .foregroundColor(.appTextSecondary)
                    }
                    
                    Spacer()
                    
                    Image(systemName: safetyIcon)
                        .font(.system(size: 36))
                        .foregroundColor(safetyColor)
                }
                .padding()
                .background(safetyColor.opacity(0.1))
                .cornerRadius(AppCornerRadius.large)
                .overlay(
                    RoundedRectangle(cornerRadius: AppCornerRadius.large)
                        .stroke(safetyColor.opacity(0.3), lineWidth: 1)
                )
                .padding(.horizontal)
                .staggeredAppear(index: 1)
                
                // Explanation Card
                VStack(alignment: .leading, spacing: AppSpacing.md) {
                    Text("Details")
                        .font(AppTypography.labelLarge())
                        .foregroundColor(.appTextPrimary)
                    
                    Text(result.explanation)
                        .font(AppTypography.bodyMedium())
                        .foregroundColor(.appTextSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    
                    if let tip = result.tip {
                        HStack(alignment: .top, spacing: AppSpacing.sm) {
                            Image(systemName: "lightbulb.fill")
                                .foregroundColor(.appPrimary)
                                .font(.system(size: 16))
                            
                            Text(tip)
                                .font(AppTypography.bodySmall())
                                .foregroundColor(.appTextSecondary)
                        }
                        .padding()
                        .background(Color.appPrimary.opacity(0.08))
                        .cornerRadius(AppCornerRadius.medium)
                    }
                }
                .padding()
                .background(Color.appCardBackground)
                .cornerRadius(AppCornerRadius.large)
                .cardShadow()
                .padding(.horizontal)
                .staggeredAppear(index: 2)
                
                // Action Buttons
                VStack(spacing: AppSpacing.md) {
                    Button(action: onCheckAnother) {
                        HStack {
                            Image(systemName: "camera.fill")
                            Text("Check Another Food")
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    
                    Button(action: onDone) {
                        Text("Done")
                            .font(AppTypography.bodyMedium())
                            .foregroundColor(.appPrimary)
                    }
                }
                .padding(.horizontal, AppSpacing.xl)
                .padding(.bottom, AppSpacing.xxl)
                .staggeredAppear(index: 3)
            }
        }
    }
}

// MARK: - Food Error View
struct FoodErrorView: View {
    let message: String
    let onRetry: () -> Void
    let onCancel: () -> Void
    
    var body: some View {
        VStack(spacing: AppSpacing.xl) {
            Spacer()
            
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 60))
                .foregroundColor(.appCaution)
                .staggeredAppear(index: 0)
            
            VStack(spacing: AppSpacing.md) {
                Text("Couldn't Identify Food")
                    .font(AppTypography.displaySmall())
                    .foregroundColor(.appTextPrimary)
                
                Text(message)
                    .font(AppTypography.bodyMedium())
                    .foregroundColor(.appTextSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, AppSpacing.xl)
            }
            .staggeredAppear(index: 1)
            
            Spacer()
            
            VStack(spacing: AppSpacing.md) {
                Button(action: onRetry) {
                    Text("Try Again")
                }
                .buttonStyle(PrimaryButtonStyle())
                
                Button(action: onCancel) {
                    Text("Cancel")
                        .font(AppTypography.bodyMedium())
                        .foregroundColor(.appTextSecondary)
                }
            }
            .padding(.horizontal, AppSpacing.xl)
            .padding(.bottom, AppSpacing.xxl)
            .staggeredAppear(index: 2)
        }
    }
}

// MARK: - Food Check Result Model
struct FoodCheckResult: Codable {
    let foodName: String
    let category: String?
    let safetyLevel: String  // "safe", "caution", "danger"
    let explanation: String
    let tip: String?
}

// MARK: - Camera Capture View for Food Check
struct FoodCameraCaptureView: UIViewControllerRepresentable {
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

// MARK: - Photo Library Picker for Food Check
struct FoodPhotoLibraryPicker: UIViewControllerRepresentable {
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

#Preview {
    FoodCheckView()
        .environmentObject(AppState())
}
