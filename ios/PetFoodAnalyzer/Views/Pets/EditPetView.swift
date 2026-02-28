import SwiftUI

struct EditPetView: View {
    let pet: Pet
    
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    
    @State private var name: String
    @State private var petType: PetType
    @State private var breed: String
    @State private var ageYears: Int
    @State private var ageMonths: Int
    @State private var weightLbs: String
    @State private var sex: PetSex?
    @State private var activityLevel: ActivityLevel
    
    @State private var petPhoto: UIImage?
    
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showDeleteConfirm = false
    @State private var showPhotoOptions = false
    @State private var showCamera = false
    @State private var showPhotoLibrary = false
    
    init(pet: Pet) {
        self.pet = pet
        _name = State(initialValue: pet.name)
        _petType = State(initialValue: pet.petType)
        _breed = State(initialValue: pet.breed ?? "")
        
        let totalMonths = pet.ageMonths ?? 0
        _ageYears = State(initialValue: totalMonths / 12)
        _ageMonths = State(initialValue: totalMonths % 12)
        
        // Convert kg to lbs for display
        _weightLbs = State(initialValue: pet.weightKg != nil ? String(format: "%.1f", pet.weightKg! / 0.453592) : "")
        _sex = State(initialValue: pet.sex)
        _activityLevel = State(initialValue: pet.activityLevel)
        _petPhoto = State(initialValue: pet.photo)
    }
    
    var body: some View {
        ScrollView {
            VStack(spacing: AppSpacing.xl) {
                // Pet Photo & Type
                HStack(spacing: AppSpacing.lg) {
                    Button {
                        showPhotoOptions = true
                    } label: {
                        ZStack {
                            if let photo = petPhoto {
                                Image(uiImage: photo)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 80, height: 80)
                                    .clipShape(Circle())
                            } else {
                                Circle()
                                    .fill(petType == .dog ? Color.appOrange.opacity(0.2) : Color.appTeal.opacity(0.2))
                                    .frame(width: 80, height: 80)
                                    .overlay(
                                        Text(petType.icon)
                                            .font(.system(size: 40))
                                    )
                            }
                            
                            // Camera badge
                            Circle()
                                .fill(Color.appTeal)
                                .frame(width: 28, height: 28)
                                .overlay(
                                    Image(systemName: "camera.fill")
                                        .font(.system(size: 12))
                                        .foregroundColor(.white)
                                )
                                .offset(x: 28, y: 28)
                        }
                    }
                    
                    VStack(alignment: .leading) {
                        Text(petType.displayName)
                            .font(AppTypography.displaySmall())
                        Text("Tap photo to change")
                            .font(AppTypography.labelSmall())
                            .foregroundColor(.appTextSecondary)
                    }
                    
                    Spacer()
                }
                .padding()
                .background(Color.appLightGray)
                .cornerRadius(AppCornerRadius.large)
                
                // Name
                VStack(alignment: .leading, spacing: AppSpacing.xs) {
                    Text("Name")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    TextField("Pet's name", text: $name)
                        .padding()
                        .background(Color.appLightGray)
                        .cornerRadius(AppCornerRadius.medium)
                }
                
                // Breed
                VStack(alignment: .leading, spacing: AppSpacing.xs) {
                    Text("Breed")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    TextField("Breed (optional)", text: $breed)
                        .padding()
                        .background(Color.appLightGray)
                        .cornerRadius(AppCornerRadius.medium)
                }
                
                // Age
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    Text("Age")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    HStack(spacing: AppSpacing.md) {
                        HStack {
                            Picker("Years", selection: $ageYears) {
                                ForEach(0..<20) { year in
                                    Text("\(year)").tag(year)
                                }
                            }
                            .pickerStyle(.menu)
                            
                            Text("years")
                                .font(AppTypography.bodyMedium())
                                .foregroundColor(.appTextSecondary)
                        }
                        
                        HStack {
                            Picker("Months", selection: $ageMonths) {
                                ForEach(0..<12) { month in
                                    Text("\(month)").tag(month)
                                }
                            }
                            .pickerStyle(.menu)
                            
                            Text("months")
                                .font(AppTypography.bodyMedium())
                                .foregroundColor(.appTextSecondary)
                        }
                    }
                }
                
                // Weight
                VStack(alignment: .leading, spacing: AppSpacing.xs) {
                    Text("Weight (lbs)")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    TextField("Weight", text: $weightLbs)
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
                
                // Health Conditions Link
                NavigationLink {
                    ManageConditionsView(pet: pet)
                } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text("Health Conditions")
                                .font(AppTypography.bodyMedium())
                                .foregroundColor(.appTextPrimary)
                            
                            let conditionCount = appState.pets.first(where: { $0.id == pet.id })?.healthConditions.count ?? pet.healthConditions.count
                            Text("\(conditionCount) conditions")
                                .font(AppTypography.labelSmall())
                                .foregroundColor(.appTextSecondary)
                        }
                        
                        Spacer()
                        
                        Image(systemName: "chevron.right")
                            .foregroundColor(.appTextSecondary)
                    }
                    .padding()
                    .background(Color.appLightGray)
                    .cornerRadius(AppCornerRadius.medium)
                }
                
                // Save Button
                Button {
                    savePet()
                } label: {
                    HStack {
                        if isLoading {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("Save Changes")
                        }
                    }
                }
                .buttonStyle(PrimaryButtonStyle(isDisabled: name.isEmpty || isLoading))
                .disabled(name.isEmpty || isLoading)
                
                // Delete Button
                Button {
                    showDeleteConfirm = true
                } label: {
                    Text("Delete Pet")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appDanger)
                }
                .padding(.top, AppSpacing.md)
            }
            .padding()
        }
        .background(Color.appBackground)
        .navigationTitle("Edit Pet")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") {
                    dismiss()
                }
            }
        }
        .alert("Delete Pet?", isPresented: $showDeleteConfirm) {
            Button("Cancel", role: .cancel) { }
            Button("Delete", role: .destructive) {
                deletePet()
            }
        } message: {
            Text("This will delete \(pet.name) and all associated scan history. This action cannot be undone.")
        }
        .confirmationDialog("Change Photo", isPresented: $showPhotoOptions) {
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
    
    private func savePet() {
        let totalAgeMonths = (ageYears * 12) + ageMonths
        // Convert lbs to kg for storage
        let weightInLbs = Double(weightLbs)
        let weight = weightInLbs.map { $0 * 0.453592 }  // lbs to kg
        
        // Compress photo for storage
        let photoData = petPhoto?.jpegData(compressionQuality: 0.5)
        
        // Use latest health conditions from appState (may have been updated via ManageConditionsView)
        let latestConditions = appState.pets.first(where: { $0.id == pet.id })?.healthConditions ?? pet.healthConditions
        
        let updatedPet = Pet(
            id: pet.id,
            name: name,
            petType: petType,
            breed: breed.isEmpty ? nil : breed,
            ageMonths: totalAgeMonths > 0 ? totalAgeMonths : nil,
            weightKg: weight,
            sex: sex,
            activityLevel: activityLevel,
            isPrimary: pet.isPrimary,
            healthConditions: latestConditions,
            photoData: photoData
        )
        
        appState.updatePet(updatedPet)
        dismiss()
    }
    
    private func deletePet() {
        appState.deletePet(pet)
        dismiss()
    }
}

// MARK: - Manage Conditions View
struct ManageConditionsView: View {
    let pet: Pet
    
    @EnvironmentObject var appState: AppState
    @State private var conditions: [HealthCondition]
    @State private var showAddCondition = false
    
    init(pet: Pet) {
        self.pet = pet
        _conditions = State(initialValue: pet.healthConditions)
    }
    
    var body: some View {
        List {
            if conditions.isEmpty {
                Text("No health conditions added")
                    .foregroundColor(.appTextSecondary)
            } else {
                Section {
                    ForEach(conditions) { condition in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(condition.conditionType.displayName)
                                    .font(AppTypography.bodyMedium())
                                
                                Text(condition.severity.displayName)
                                    .font(AppTypography.labelSmall())
                                    .foregroundColor(.appTextSecondary)
                            }
                            
                            Spacer()
                        }
                    }
                    .onDelete(perform: deleteCondition)
                } footer: {
                    Text("Swipe left on a condition to delete it")
                        .font(AppTypography.labelSmall())
                        .foregroundColor(.appTextSecondary)
                }
            }
        }
        .navigationTitle("Health Conditions")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showAddCondition = true
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showAddCondition) {
            AddConditionSheet(pet: pet) { newCondition in
                conditions.append(newCondition)
                updatePetConditions()
            }
        }
    }
    
    private func deleteCondition(at offsets: IndexSet) {
        conditions.remove(atOffsets: offsets)
        updatePetConditions()
    }
    
    private func updatePetConditions() {
        if let index = appState.pets.firstIndex(where: { $0.id == pet.id }) {
            let updatedPet = Pet(
                id: pet.id,
                name: pet.name,
                petType: pet.petType,
                breed: pet.breed,
                ageMonths: pet.ageMonths,
                weightKg: pet.weightKg,
                sex: pet.sex,
                activityLevel: pet.activityLevel,
                isPrimary: pet.isPrimary,
                healthConditions: conditions,
                photoData: pet.photoData  // Preserve photo
            )
            appState.updatePet(updatedPet)
        }
    }
}

// MARK: - Add Condition Sheet
struct AddConditionSheet: View {
    let pet: Pet
    let onAdd: (HealthCondition) -> Void
    
    @Environment(\.dismiss) private var dismiss
    @State private var selectedCondition: ConditionType?
    @State private var severity: Severity = .moderate
    @State private var isLoading = false
    
    var body: some View {
        NavigationView {
            List {
                Section("Condition") {
                    ForEach(ConditionType.allCases, id: \.self) { condition in
                        Button {
                            selectedCondition = condition
                        } label: {
                            HStack {
                                Text(condition.displayName)
                                    .foregroundColor(.appTextPrimary)
                                
                                Spacer()
                                
                                if selectedCondition == condition {
                                    Image(systemName: "checkmark")
                                        .foregroundColor(.appTeal)
                                }
                            }
                        }
                    }
                }
                
                Section("Severity") {
                    Picker("Severity", selection: $severity) {
                        ForEach(Severity.allCases, id: \.self) { sev in
                            Text(sev.displayName).tag(sev)
                        }
                    }
                    .pickerStyle(.segmented)
                }
            }
            .navigationTitle("Add Condition")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Add") {
                        addCondition()
                    }
                    .disabled(selectedCondition == nil || isLoading)
                }
            }
        }
    }
    
    private func addCondition() {
        guard let conditionType = selectedCondition else { return }
        
        let condition = HealthCondition(
            id: UUID().uuidString,
            conditionType: conditionType,
            severity: severity,
            notes: nil
        )
        
        onAdd(condition)
        dismiss()
    }
}

#Preview {
    NavigationView {
        EditPetView(pet: Pet(
            id: "1",
            name: "Max",
            petType: .dog,
            breed: "Labrador",
            ageMonths: 36,
            weightKg: 28.5,
            sex: .neuteredMale,
            activityLevel: .moderate,
            isPrimary: true,
            healthConditions: [],
            photoData: nil
        ))
        .environmentObject(AppState())
    }
}

