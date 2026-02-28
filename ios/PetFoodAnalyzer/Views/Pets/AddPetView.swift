import SwiftUI

struct AddPetView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    
    @State private var name = ""
    @State private var petType: PetType = .dog
    @State private var breed = ""
    @State private var ageYears = 0
    @State private var ageMonths = 0
    @State private var weightLbs = ""
    @State private var sex: PetSex?
    @State private var activityLevel: ActivityLevel = .moderate
    @State private var selectedConditions: Set<ConditionType> = []
    @State private var petPhoto: UIImage?
    
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var currentStep = 0
    
    var body: some View {
        VStack(spacing: 0) {
            // Progress Indicator
            HStack(spacing: AppSpacing.xs) {
                ForEach(0..<3) { step in
                    Capsule()
                        .fill(step <= currentStep ? Color.appTeal : Color.appLightGray)
                        .frame(height: 4)
                }
            }
            .padding()
            
            TabView(selection: $currentStep) {
                // Step 1: Basic Info
                BasicInfoStep(
                    name: $name,
                    petType: $petType,
                    breed: $breed,
                    petPhoto: $petPhoto
                )
                .tag(0)
                
                // Step 2: Physical Details
                PhysicalDetailsStep(
                    ageYears: $ageYears,
                    ageMonths: $ageMonths,
                    weightLbs: $weightLbs,
                    sex: $sex,
                    activityLevel: $activityLevel,
                    petType: petType
                )
                .tag(1)
                
                // Step 3: Health Conditions
                HealthConditionsStep(
                    selectedConditions: $selectedConditions,
                    petType: petType
                )
                .tag(2)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .animation(.easeInOut, value: currentStep)
            
            // Navigation Buttons
            HStack(spacing: AppSpacing.md) {
                if currentStep > 0 {
                    Button("Back") {
                        withAnimation {
                            currentStep -= 1
                        }
                    }
                    .buttonStyle(SecondaryButtonStyle())
                }
                
                if currentStep < 2 {
                    Button("Next") {
                        withAnimation {
                            currentStep += 1
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle(isDisabled: !canProceed))
                    .disabled(!canProceed)
                } else {
                    Button {
                        savePet()
                    } label: {
                        HStack {
                            if isLoading {
                                ProgressView()
                                    .tint(.white)
                            } else {
                                Text("Add Pet")
                            }
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle(isDisabled: isLoading))
                    .disabled(isLoading)
                }
            }
            .padding()
        }
        .background(Color.appBackground)
        .navigationTitle("Add Pet")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") {
                    dismiss()
                }
            }
        }
        .alert("Error", isPresented: .constant(errorMessage != nil)) {
            Button("OK") {
                errorMessage = nil
            }
        } message: {
            Text(errorMessage ?? "")
        }
    }
    
    private var canProceed: Bool {
        switch currentStep {
        case 0:
            return !name.isEmpty
        case 1:
            return true
        default:
            return true
        }
    }
    
    private func savePet() {
        let totalAgeMonths = (ageYears * 12) + ageMonths
        // Convert lbs to kg for storage (backend uses kg)
        let weightInLbs = Double(weightLbs)
        let weight = weightInLbs.map { $0 * 0.453592 }  // lbs to kg
        
        let healthConditions: [HealthCondition] = selectedConditions.map { conditionType in
            HealthCondition(
                id: UUID().uuidString,
                conditionType: conditionType,
                severity: .moderate,
                notes: nil
            )
        }
        
        // Compress photo for storage
        let photoData = petPhoto?.jpegData(compressionQuality: 0.5)
        
        let pet = Pet(
            id: UUID().uuidString,
            name: name,
            petType: petType,
            breed: breed.isEmpty ? nil : breed,
            ageMonths: totalAgeMonths > 0 ? totalAgeMonths : nil,
            weightKg: weight,
            sex: sex,
            activityLevel: activityLevel,
            isPrimary: appState.pets.isEmpty,
            healthConditions: healthConditions,
            photoData: photoData
        )
        
        appState.addPet(pet)
        dismiss()
    }
}

// MARK: - Step 1: Basic Info
struct BasicInfoStep: View {
    @Binding var name: String
    @Binding var petType: PetType
    @Binding var breed: String
    @Binding var petPhoto: UIImage?
    
    @State private var showPhotoOptions = false
    @State private var showCamera = false
    @State private var showPhotoLibrary = false
    
    var body: some View {
        ScrollView {
            VStack(spacing: AppSpacing.xl) {
                VStack(spacing: AppSpacing.sm) {
                    Text("Let's meet your pet!")
                        .font(AppTypography.displaySmall())
                    
                    Text("Start with the basics")
                        .font(AppTypography.bodyMedium())
                        .foregroundColor(.appTextSecondary)
                }
                
                // Pet Photo
                VStack(spacing: AppSpacing.sm) {
                    Button {
                        showPhotoOptions = true
                    } label: {
                        ZStack {
                            if let photo = petPhoto {
                                Image(uiImage: photo)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 100, height: 100)
                                    .clipShape(Circle())
                            } else {
                                Circle()
                                    .fill(petType == .dog ? Color.appOrange.opacity(0.2) : Color.appTeal.opacity(0.2))
                                    .frame(width: 100, height: 100)
                                    .overlay(
                                        Text(petType.icon)
                                            .font(.system(size: 50))
                                    )
                            }
                            
                            // Camera badge
                            Circle()
                                .fill(Color.appTeal)
                                .frame(width: 32, height: 32)
                                .overlay(
                                    Image(systemName: "camera.fill")
                                        .font(.system(size: 14))
                                        .foregroundColor(.white)
                                )
                                .offset(x: 35, y: 35)
                        }
                    }
                    
                    Text("Add Photo (Optional)")
                        .font(AppTypography.labelSmall())
                        .foregroundColor(.appTextSecondary)
                }
                
                // Pet Type Selection
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    Text("Pet Type")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    HStack(spacing: AppSpacing.md) {
                        PetTypeButton(
                            type: .dog,
                            isSelected: petType == .dog
                        ) {
                            petType = .dog
                        }
                        
                        PetTypeButton(
                            type: .cat,
                            isSelected: petType == .cat
                        ) {
                            petType = .cat
                        }
                    }
                }
                
                // Name
                VStack(alignment: .leading, spacing: AppSpacing.xs) {
                    Text("Name")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    TextField("What's your pet's name?", text: $name)
                        .padding()
                        .background(Color.appLightGray)
                        .cornerRadius(AppCornerRadius.medium)
                }
                
                // Breed
                VStack(alignment: .leading, spacing: AppSpacing.xs) {
                    Text("Breed (Optional)")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    TextField(petType == .dog ? "e.g., Labrador, Mixed" : "e.g., Persian, Tabby", text: $breed)
                        .padding()
                        .background(Color.appLightGray)
                        .cornerRadius(AppCornerRadius.medium)
                }
                
                Spacer()
            }
            .padding()
        }
        .confirmationDialog("Add Pet Photo", isPresented: $showPhotoOptions) {
            Button("Take Photo") {
                showCamera = true
            }
            Button("Choose from Library") {
                showPhotoLibrary = true
            }
            if petPhoto != nil {
                Button("Remove Photo", role: .destructive) {
                    petPhoto = nil
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .fullScreenCover(isPresented: $showCamera) {
            PetPhotoPicker(image: $petPhoto, sourceType: .camera)
        }
        .fullScreenCover(isPresented: $showPhotoLibrary) {
            PetPhotoPicker(image: $petPhoto, sourceType: .photoLibrary)
        }
    }
}

// MARK: - Pet Photo Picker
struct PetPhotoPicker: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    @Environment(\.dismiss) private var dismiss
    var sourceType: UIImagePickerController.SourceType = .photoLibrary
    
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.delegate = context.coordinator
        picker.sourceType = sourceType
        picker.allowsEditing = true  // Allow cropping to square
        return picker
    }
    
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: PetPhotoPicker
        
        init(_ parent: PetPhotoPicker) {
            self.parent = parent
        }
        
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            // Prefer edited (cropped) image
            if let image = info[.editedImage] as? UIImage {
                parent.image = image
            } else if let image = info[.originalImage] as? UIImage {
                parent.image = image
            }
            parent.dismiss()
        }
        
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

struct PetTypeButton: View {
    let type: PetType
    let isSelected: Bool
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            VStack(spacing: AppSpacing.sm) {
                Text(type.icon)
                    .font(.system(size: 40))
                
                Text(type.displayName)
                    .font(AppTypography.labelLarge())
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, AppSpacing.lg)
            .background(isSelected ? (type == .dog ? Color.appTeal : Color.appOrange).opacity(0.15) : Color.appLightGray)
            .cornerRadius(AppCornerRadius.large)
            .overlay(
                RoundedRectangle(cornerRadius: AppCornerRadius.large)
                    .stroke(isSelected ? (type == .dog ? Color.appTeal : Color.appOrange) : Color.clear, lineWidth: 2)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Step 2: Physical Details
struct PhysicalDetailsStep: View {
    @Binding var ageYears: Int
    @Binding var ageMonths: Int
    @Binding var weightLbs: String
    @Binding var sex: PetSex?
    @Binding var activityLevel: ActivityLevel
    let petType: PetType
    
    var body: some View {
        ScrollView {
            VStack(spacing: AppSpacing.xl) {
                VStack(spacing: AppSpacing.sm) {
                    Text("Physical Details")
                        .font(AppTypography.displaySmall())
                    
                    Text("This helps us personalize the analysis")
                        .font(AppTypography.bodyMedium())
                        .foregroundColor(.appTextSecondary)
                }
                
                // Age
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    Text("Age")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    HStack(spacing: AppSpacing.md) {
                        VStack {
                            Picker("Years", selection: $ageYears) {
                                ForEach(0..<20) { year in
                                    Text("\(year)").tag(year)
                                }
                            }
                            .pickerStyle(.wheel)
                            .frame(height: 100)
                            
                            Text("Years")
                                .font(AppTypography.labelSmall())
                                .foregroundColor(.appTextSecondary)
                        }
                        
                        VStack {
                            Picker("Months", selection: $ageMonths) {
                                ForEach(0..<12) { month in
                                    Text("\(month)").tag(month)
                                }
                            }
                            .pickerStyle(.wheel)
                            .frame(height: 100)
                            
                            Text("Months")
                                .font(AppTypography.labelSmall())
                                .foregroundColor(.appTextSecondary)
                        }
                    }
                }
                
                // Weight
                VStack(alignment: .leading, spacing: AppSpacing.xs) {
                    Text("Weight (lbs)")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    TextField(petType == .dog ? "e.g., 55" : "e.g., 10", text: $weightLbs)
                        .keyboardType(.decimalPad)
                        .padding()
                        .background(Color.appLightGray)
                        .cornerRadius(AppCornerRadius.medium)
                }
                
                // Sex
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    Text("Sex")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: AppSpacing.sm) {
                        ForEach(PetSex.allCases, id: \.self) { sexOption in
                            Button {
                                sex = sexOption
                            } label: {
                                Text(sexOption.displayName)
                                    .font(AppTypography.labelMedium())
                                    .frame(maxWidth: .infinity)
                                    .padding()
                                    .background(sex == sexOption ? Color.appTeal.opacity(0.15) : Color.appLightGray)
                                    .foregroundColor(sex == sexOption ? .appTeal : .appTextPrimary)
                                    .cornerRadius(AppCornerRadius.medium)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: AppCornerRadius.medium)
                                            .stroke(sex == sexOption ? Color.appTeal : Color.clear, lineWidth: 1)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                
                // Activity Level
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    Text("Activity Level")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    Picker("Activity Level", selection: $activityLevel) {
                        ForEach(ActivityLevel.allCases, id: \.self) { level in
                            Text(level.displayName).tag(level)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                
                Spacer()
            }
            .padding()
        }
    }
}

// MARK: - Step 3: Health Conditions
struct HealthConditionsStep: View {
    @Binding var selectedConditions: Set<ConditionType>
    let petType: PetType
    
    private let categories = ["Allergies", "Digestive", "Organ Health", "Metabolic", "Physical"]
    
    var body: some View {
        ScrollView {
            VStack(spacing: AppSpacing.xl) {
                VStack(spacing: AppSpacing.sm) {
                    Text("Health Conditions")
                        .font(AppTypography.displaySmall())
                    
                    Text("Select any that apply (optional)")
                        .font(AppTypography.bodyMedium())
                        .foregroundColor(.appTextSecondary)
                }
                
                ForEach(categories, id: \.self) { category in
                    let conditions = ConditionType.allCases.filter { $0.category == category }
                    
                    if !conditions.isEmpty {
                        VStack(alignment: .leading, spacing: AppSpacing.sm) {
                            Text(category)
                                .font(AppTypography.labelLarge())
                                .foregroundColor(.appTextSecondary)
                            
                            FlowLayout(spacing: AppSpacing.xs) {
                                ForEach(conditions, id: \.self) { condition in
                                    ConditionToggleButton(
                                        condition: condition,
                                        isSelected: selectedConditions.contains(condition)
                                    ) {
                                        if selectedConditions.contains(condition) {
                                            selectedConditions.remove(condition)
                                        } else {
                                            selectedConditions.insert(condition)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                
                if !selectedConditions.isEmpty {
                    VStack(alignment: .leading, spacing: AppSpacing.sm) {
                        Text("Selected: \(selectedConditions.count)")
                            .font(AppTypography.labelMedium())
                            .foregroundColor(.appTeal)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                
                Spacer()
            }
            .padding()
        }
    }
}

struct ConditionToggleButton: View {
    let condition: ConditionType
    let isSelected: Bool
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                }
                Text(condition.displayName)
                    .font(AppTypography.labelSmall())
            }
            .padding(.horizontal, AppSpacing.sm)
            .padding(.vertical, AppSpacing.xs)
            .background(isSelected ? Color.appTeal : Color.appLightGray)
            .foregroundColor(isSelected ? .white : .appTextPrimary)
            .cornerRadius(AppCornerRadius.full)
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    NavigationView {
        AddPetView()
            .environmentObject(AppState())
    }
}

