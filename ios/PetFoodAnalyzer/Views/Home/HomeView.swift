import SwiftUI
import UIKit

struct HomeView: View {
    @EnvironmentObject var appState: AppState
    @State private var showPetSelector = false
    @State private var showTwoStepScan = false
    @State private var showFoodCheck = false
    @State private var navigateToProductSearch = false
    @State private var scanResult: ScanResult?
    @State private var showScanResult = false
    @State private var communityStats: CommunityStats?
    @State private var userStats: UserStats?
    
    private var deviceId: String {
        UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
    }
    
    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: AppSpacing.lg) {
                    // User Badge Card (at the top)
                    if let stats = userStats {
                        UserBadgeCard(stats: stats)
                            .padding(.horizontal)
                            .staggeredAppear(index: 0)
                    }
                    
                    // Pet Selector Card
                    if let pet = appState.selectedPet {
                        PetSelectorCard(pet: pet) {
                            showPetSelector = true
                        }
                        .staggeredAppear(index: 1)
                    } else {
                        NoPetCard()
                            .staggeredAppear(index: 1)
                    }
                    
                    // Community Trust Banner
                    CommunityTrustBanner(stats: communityStats)
                        .padding(.horizontal)
                        .staggeredAppear(index: 2)
                    
                    // Section Header
                    VStack(alignment: .leading, spacing: AppSpacing.xs) {
                        Text("Analyze Food")
                            .font(AppTypography.displaySmall())
                            .foregroundColor(.appTextPrimary)
                        
                        Text("Check ingredients or find safe options")
                            .font(AppTypography.bodyMedium())
                            .foregroundColor(.appTextSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .staggeredAppear(index: 3)
                    
                    // All Action Cards - consistent spacing
                    VStack(spacing: AppSpacing.md) {
                        ScanModeCard(
                            icon: "camera.fill",
                            title: "Label Scan",
                            description: "Scan front & back labels",
                            color: .appTeal,
                            isEnabled: appState.selectedPet != nil
                        ) {
                            showTwoStepScan = true
                        }
                        .staggeredAppear(index: 4)
                        
                        ScanModeCard(
                            icon: "questionmark.circle",
                            title: "Food Check",
                            description: "Snap a photo of any food",
                            color: .appAccent,
                            isEnabled: appState.selectedPet != nil
                        ) {
                            showFoodCheck = true
                        }
                        .staggeredAppear(index: 5)
                        
                        if appState.selectedPet != nil {
                            FindSafeFoodCard(pet: appState.selectedPet!) {
                                navigateToProductSearch = true
                            }
                            .staggeredAppear(index: 6)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.bottom, AppSpacing.lg)
                }
                .padding(.top)
            }
            .background(Color.appBackground)
            .navigationTitle("PetFood Analyzer")
            .navigationBarTitleDisplayMode(.large)
            .task {
                await loadCommunityStats()
                await loadUserStats()
            }
            .sheet(isPresented: $showPetSelector) {
                PetSelectorSheet()
            }
            .background(
                Group {
                    NavigationLink(
                        destination: ProductSearchView(),
                        isActive: $navigateToProductSearch
                    ) { EmptyView() }
                    
                    NavigationLink(
                        destination: Group {
                            if let result = scanResult {
                                ResultView(result: result)
                            }
                        },
                        isActive: $showScanResult
                    ) { EmptyView() }
                }
            )
            .fullScreenCover(isPresented: $showTwoStepScan) {
                if let pet = appState.selectedPet {
                    TwoStepScanView(
                        pet: pet,
                        onComplete: { result in
                            scanResult = result
                            showTwoStepScan = false
                            showScanResult = true
                            // Refresh user stats after scan
                            Task {
                                await loadUserStats()
                            }
                        },
                        onCancel: {
                            showTwoStepScan = false
                        }
                    )
                }
            }
            .fullScreenCover(isPresented: $showFoodCheck) {
                FoodCheckView()
            }
        }
    }
    
    private func loadCommunityStats() async {
        do {
            communityStats = try await APIService.shared.fetchCommunityStats()
        } catch {
            // Silently fail - banner will still show FDA/AAFCO
            print("Failed to load community stats: \(error)")
        }
    }
    
    private func loadUserStats() async {
        do {
            userStats = try await APIService.shared.fetchUserStats(deviceId: deviceId)
        } catch {
            // Silently fail - badge card won't show
            print("Failed to load user stats: \(error)")
        }
    }
}

// MARK: - User Badge Card
struct UserBadgeCard: View {
    let stats: UserStats
    
    var body: some View {
        HStack(spacing: AppSpacing.md) {
            // Badge Icon
            Text(stats.badge.icon)
                .font(.system(size: 36))
            
            VStack(alignment: .leading, spacing: 4) {
                // Title
                Text(stats.badge.title)
                    .font(.system(size: 18, weight: .bold))
                    .foregroundColor(stats.badge.swiftUIColor)
                
                // Scan count
                Text("\(stats.scanCount) scans completed")
                    .font(.system(size: 13))
                    .foregroundColor(.appTextSecondary)
            }
            
            Spacer()
            
            // Progress to next level
            if let nextAt = stats.badge.nextAt, let progress = stats.badge.progress {
                VStack(alignment: .trailing, spacing: 4) {
                    Text("Level \(stats.badge.level)")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.appTextSecondary)
                    
                    // Progress bar
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.appLightGray)
                            .frame(width: 60, height: 8)
                        
                        RoundedRectangle(cornerRadius: 4)
                            .fill(stats.badge.swiftUIColor)
                            .frame(width: 60 * CGFloat(progress) / 100, height: 8)
                    }
                    
                    Text("\(nextAt - stats.scanCount) to next")
                        .font(.system(size: 10))
                        .foregroundColor(.appTextSecondary)
                }
            } else {
                // Max level badge
                VStack(spacing: 2) {
                    Image(systemName: "crown.fill")
                        .font(.system(size: 20))
                        .foregroundColor(.yellow)
                    Text("MAX")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.appTextSecondary)
                }
            }
        }
        .padding()
        .background(
            LinearGradient(
                colors: [stats.badge.swiftUIColor.opacity(0.1), stats.badge.swiftUIColor.opacity(0.05)],
                startPoint: .leading,
                endPoint: .trailing
            )
        )
        .cornerRadius(AppCornerRadius.large)
        .overlay(
            RoundedRectangle(cornerRadius: AppCornerRadius.large)
                .stroke(stats.badge.swiftUIColor.opacity(0.3), lineWidth: 1)
        )
    }
}

// MARK: - Community Trust Banner
struct CommunityTrustBanner: View {
    let stats: CommunityStats?
    
    var body: some View {
        HStack(spacing: AppSpacing.lg) {
            // Total Community Scans - only show when impressive (100+)
            if let stats = stats, stats.totalScans >= 100 {
                HStack(spacing: AppSpacing.xs) {
                    Image(systemName: "person.3.fill")
                        .font(.system(size: 14))
                        .foregroundColor(.appPrimary)
                    
                    Text("\(stats.formattedTotalScans) community scans")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.appTextPrimary)
                }
            }
            
            // FDA/AAFCO Guidelines Badge
            HStack(spacing: AppSpacing.xs) {
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 14))
                    .foregroundColor(.appSafe)
                
                Text("FDA & AAFCO Guidelines")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.appTextPrimary)
            }
        }
        .padding(.horizontal, AppSpacing.md)
        .padding(.vertical, AppSpacing.sm)
        .frame(maxWidth: .infinity)
        .background(Color.appPrimary.opacity(0.08))
        .cornerRadius(AppCornerRadius.medium)
    }
}

// MARK: - Pet Selector Card
struct PetSelectorCard: View {
    let pet: Pet
    let onTap: () -> Void
    
    var body: some View {
        Button(action: onTap) {
            HStack(spacing: AppSpacing.md) {
                // Pet Avatar
                PetAvatarView(pet: pet, size: 56)
                
                VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                    Text("Analyzing for")
                        .font(AppTypography.labelMedium())
                        .foregroundColor(.appTextSecondary)
                    
                    Text(pet.name)
                        .font(AppTypography.displaySmall())
                        .foregroundColor(.appTextPrimary)
                    
                    HStack(spacing: AppSpacing.xs) {
                        Text(pet.petType.displayName)
                        if let breed = pet.breed {
                            Text("•")
                            Text(breed)
                        }
                    }
                    .font(AppTypography.bodySmall())
                    .foregroundColor(.appTextSecondary)
                }
                
                Spacer()
                
                HStack(spacing: AppSpacing.xs) {
                    Text("Change")
                        .font(AppTypography.labelSmall())
                        .foregroundColor(.appPrimary)
                    
                    Image(systemName: "chevron.down")
                        .font(.system(size: 12))
                        .foregroundColor(.appPrimary)
                }
            }
            .padding()
            .background(Color.appCardBackground)
            .cornerRadius(AppCornerRadius.large)
            .cardShadow()
        }
        .buttonStyle(.plain)
        .padding(.horizontal)
    }
}

// MARK: - No Pet Card
struct NoPetCard: View {
    var body: some View {
        VStack(spacing: AppSpacing.md) {
            Image(systemName: "pawprint")
                .font(.system(size: 40))
                .foregroundColor(.appTextSecondary)
            
            Text("Add a Pet First")
                .font(AppTypography.bodyLarge())
                .foregroundColor(.appTextPrimary)
            
            Text("Create a pet profile to get personalized food analysis")
                .font(AppTypography.bodySmall())
                .foregroundColor(.appTextSecondary)
                .multilineTextAlignment(.center)
            
            NavigationLink(destination: AddPetView()) {
                Text("Add Pet")
            }
            .buttonStyle(PrimaryButtonStyle())
            .frame(width: 150)
        }
        .padding(AppSpacing.xl)
        .frame(maxWidth: .infinity)
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.large)
        .cardShadow()
        .padding(.horizontal)
    }
}

// MARK: - Scan Mode Card
struct ScanModeCard: View {
    let icon: String
    let title: String
    let description: String
    let color: Color
    var isEnabled: Bool = true
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            HStack(spacing: AppSpacing.md) {
                // Icon
                ZStack {
                    RoundedRectangle(cornerRadius: AppCornerRadius.medium)
                        .fill(color.opacity(0.15))
                        .frame(width: 60, height: 60)
                    
                    Image(systemName: icon)
                        .font(.system(size: 26))
                        .foregroundColor(color)
                }
                
                VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                    Text(title)
                        .font(AppTypography.bodyLarge())
                        .fontWeight(.semibold)
                        .foregroundColor(.appTextPrimary)
                    
                    Text(description)
                        .font(AppTypography.bodySmall())
                        .foregroundColor(.appTextSecondary)
                }
                
                Spacer()
                
                Image(systemName: "chevron.right")
                    .foregroundColor(.appTextSecondary)
            }
            .padding()
            .background(Color.appCardBackground)
            .cornerRadius(AppCornerRadius.large)
            .cardShadow()
            .opacity(isEnabled ? 1.0 : 0.6)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
    }
}

// MARK: - Find Safe Food Card
struct FindSafeFoodCard: View {
    let pet: Pet
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            VStack(spacing: AppSpacing.md) {
                HStack(spacing: AppSpacing.md) {
                    // Icon - matched to ScanModeCard (60x60)
                    ZStack {
                        RoundedRectangle(cornerRadius: AppCornerRadius.medium)
                            .fill(Color.appSafe.opacity(0.15))
                            .frame(width: 60, height: 60)
                        
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 26))
                            .foregroundColor(.appSafe)
                    }
                    
                    VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                        Text("Find Safe Food")
                            .font(AppTypography.bodyLarge())
                            .fontWeight(.semibold)
                            .foregroundColor(.appTextPrimary)
                        
                        Text("Search products safe for \(pet.name)")
                            .font(AppTypography.bodySmall())
                            .foregroundColor(.appTextSecondary)
                    }
                    
                    Spacer()
                    
                    Image(systemName: "chevron.right")
                        .foregroundColor(.appTextSecondary)
                }
                
                // Smart filters preview
                if !pet.healthConditions.isEmpty {
                    HStack(spacing: AppSpacing.xs) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 12))
                            .foregroundColor(.appTeal)
                        
                        Text("Filters auto-applied from \(pet.name)'s profile")
                            .font(AppTypography.labelSmall())
                            .foregroundColor(.appTeal)
                        
                        Spacer()
                    }
                    .padding(.horizontal, AppSpacing.sm)
                    .padding(.vertical, AppSpacing.xs)
                    .background(Color.appTeal.opacity(0.08))
                    .cornerRadius(AppCornerRadius.small)
                }
            }
            .padding()
            .background(Color.appCardBackground)
            .cornerRadius(AppCornerRadius.large)
            .cardShadow()
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Pet Selector Sheet
struct PetSelectorSheet: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        NavigationView {
            List {
                ForEach(appState.pets) { pet in
                    Button {
                        appState.selectPet(pet)
                        dismiss()
                    } label: {
                        HStack {
                            PetAvatarView(pet: pet, size: 44)
                            
                            VStack(alignment: .leading) {
                                Text(pet.name)
                                    .font(AppTypography.bodyLarge())
                                    .foregroundColor(.appTextPrimary)
                                
                                Text(pet.petType.displayName)
                                    .font(AppTypography.bodySmall())
                                    .foregroundColor(.appTextSecondary)
                            }
                            
                            Spacer()
                            
                            if pet.id == appState.selectedPet?.id {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(.appTeal)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Select Pet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
}

#Preview {
    HomeView()
        .environmentObject(AppState())
}

