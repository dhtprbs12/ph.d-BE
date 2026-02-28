import SwiftUI

struct PetsView: View {
    @EnvironmentObject var appState: AppState
    @State private var showAddPet = false
    @State private var petToEdit: Pet?
    
    var body: some View {
        NavigationView {
            ScrollView {
                LazyVStack(spacing: AppSpacing.md) {
                    if appState.pets.isEmpty {
                        EmptyPetsView {
                            showAddPet = true
                        }
                        .staggeredAppear(index: 0)
                    } else {
                        ForEach(Array(appState.pets.enumerated()), id: \.element.id) { index, pet in
                            PetCard(pet: pet) {
                                petToEdit = pet
                            }
                            .staggeredAppear(index: index)
                        }
                    }
                }
                .padding()
            }
            .background(Color.appBackground)
            .navigationTitle("My Pets")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showAddPet = true
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .foregroundColor(.appTeal)
                    }
                }
            }
            .sheet(isPresented: $showAddPet) {
                NavigationView {
                    AddPetView()
                }
            }
            .sheet(item: $petToEdit) { pet in
                NavigationView {
                    EditPetView(pet: pet)
                }
            }
        }
    }
}

// MARK: - Empty Pets View
struct EmptyPetsView: View {
    let onAddPet: () -> Void
    
    var body: some View {
        VStack(spacing: AppSpacing.lg) {
            Image(systemName: "pawprint.circle")
                .font(.system(size: 80))
                .foregroundColor(.appTextSecondary.opacity(0.5))
            
            Text("No Pets Yet")
                .font(AppTypography.displaySmall())
                .foregroundColor(.appTextPrimary)
            
            Text("Add your first pet to get personalized food analysis")
                .font(AppTypography.bodyMedium())
                .foregroundColor(.appTextSecondary)
                .multilineTextAlignment(.center)
            
            Button("Add Pet") {
                onAddPet()
            }
            .buttonStyle(PrimaryButtonStyle())
            .frame(width: 200)
        }
        .padding(.vertical, AppSpacing.xxl)
    }
}

// MARK: - Pet Card
struct PetCard: View {
    let pet: Pet
    let onEdit: () -> Void
    
    @EnvironmentObject var appState: AppState
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack(spacing: AppSpacing.md) {
                // Pet Avatar
                PetAvatarView(pet: pet, size: 60)
                
                VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                    HStack {
                        Text(pet.name)
                            .font(AppTypography.displaySmall())
                            .foregroundColor(.appTextPrimary)
                        
                        if pet.isPrimary {
                            Text("PRIMARY")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundColor(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.appTeal)
                                .cornerRadius(4)
                        }
                    }
                    
                    Text(pet.petType.displayName)
                        .font(AppTypography.bodyMedium())
                        .foregroundColor(.appTextSecondary)
                }
                
                Spacer()
                
                Button {
                    onEdit()
                } label: {
                    Image(systemName: "pencil.circle.fill")
                        .font(.title2)
                        .foregroundColor(.appTeal)
                }
            }
            .padding()
            
            Divider()
            
            // Details
            HStack(spacing: AppSpacing.lg) {
                if let breed = pet.breed {
                    DetailItem(icon: "tag", label: "Breed", value: breed)
                }
                
                DetailItem(icon: "calendar", label: "Age", value: pet.displayAge)
                
                DetailItem(icon: "scalemass", label: "Weight", value: pet.displayWeight)
            }
            .padding()
            
            // Health Conditions
            if !pet.healthConditions.isEmpty {
                Divider()
                
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    Text("Health Conditions")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    WrappingHStack(items: pet.healthConditions, spacing: AppSpacing.xs)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            
            // Actions
            if !pet.isPrimary {
                Divider()
                
                Button {
                    setPrimary()
                } label: {
                    HStack {
                        Image(systemName: "star")
                        Text("Set as Primary")
                    }
                    .font(AppTypography.labelMedium())
                    .foregroundColor(.appTeal)
                }
                .padding()
            }
        }
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.large)
        .cardShadow()
    }
    
    private func setPrimary() {
        appState.setPrimaryPet(pet)
    }
}

// MARK: - Detail Item
struct DetailItem: View {
    let icon: String
    let label: String
    let value: String
    
    var body: some View {
        VStack(spacing: AppSpacing.xxs) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundColor(.appTeal)
            
            Text(label)
                .font(AppTypography.labelSmall())
                .foregroundColor(.appTextSecondary)
            
            Text(value)
                .font(AppTypography.bodySmall())
                .foregroundColor(.appTextPrimary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Condition Badge
struct ConditionBadge: View {
    let condition: HealthCondition
    
    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(severityColor)
                .frame(width: 6, height: 6)
            
            Text(condition.conditionType.displayName)
                .font(AppTypography.labelSmall())
        }
        .padding(.horizontal, AppSpacing.sm)
        .padding(.vertical, AppSpacing.xxs)
        .background(severityColor.opacity(0.1))
        .cornerRadius(AppCornerRadius.full)
    }
    
    private var severityColor: Color {
        switch condition.severity {
        case .mild: return .appCaution
        case .moderate: return .appOrange
        case .severe: return .appDanger
        }
    }
}

// MARK: - Flow Layout (iOS 15 compatible using LazyVGrid)
struct FlowLayout<Content: View>: View {
    let spacing: CGFloat
    let content: Content
    
    init(spacing: CGFloat = 8, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }
    
    var body: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 100), spacing: spacing)],
            alignment: .leading,
            spacing: spacing
        ) {
            content
        }
    }
}

// MARK: - Wrapping HStack for HealthConditions
struct WrappingHStack: View {
    let items: [HealthCondition]
    let spacing: CGFloat
    
    init(items: [HealthCondition], spacing: CGFloat = 8) {
        self.items = items
        self.spacing = spacing
    }
    
    var body: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 100), spacing: spacing)],
            alignment: .leading,
            spacing: spacing
        ) {
            ForEach(items) { condition in
                ConditionBadge(condition: condition)
            }
        }
    }
}

#Preview {
    PetsView()
        .environmentObject(AppState())
}

