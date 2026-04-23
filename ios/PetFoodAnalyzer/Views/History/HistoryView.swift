import SwiftUI

struct HistoryView: View {
    @EnvironmentObject var appState: AppState
    @State private var history: [ScanHistoryItem] = []
    @State private var isLoading = true
    @State private var selectedPetFilter: Pet?
    @State private var selectedResult: ScanResult?
    @State private var isLoadingResult = false
    @State private var showResult = false
    
    var body: some View {
        NavigationView {
            Group {
                if isLoading {
                    ProgressView("Loading history...")
                } else if history.isEmpty {
                    EmptyHistoryView()
                } else {
                    ScrollView {
                        LazyVStack(spacing: AppSpacing.md) {
                            ForEach(Array(history.enumerated()), id: \.element.id) { index, item in
                                HistoryCard(item: item)
                                    .staggeredAppear(index: index, baseDelay: 0.05)
                                    .onTapGesture {
                                        loadResult(for: item)
                                    }
                            }
                        }
                        .padding()
                    }
                }
            }
            .overlay {
                if isLoadingResult {
                    ZStack {
                        Color.black.opacity(0.3).ignoresSafeArea()
                        VStack(spacing: 12) {
                            ProgressView()
                                .scaleEffect(1.2)
                            Text("Loading analysis...")
                                .font(AppTypography.bodyMedium())
                                .foregroundColor(.white)
                        }
                        .padding(24)
                        .background(.ultraThinMaterial)
                        .cornerRadius(16)
                    }
                }
            }
            .background(Color.appBackground)
            .navigationTitle("Scan History")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            selectedPetFilter = nil
                            loadHistory()
                        } label: {
                            Label("All Pets", systemImage: "pawprint.fill")
                        }
                        
                        Divider()
                        
                        ForEach(appState.pets) { pet in
                            Button {
                                selectedPetFilter = pet
                                loadHistory()
                            } label: {
                                Label(
                                    "\(pet.petType.icon) \(pet.name)",
                                    systemImage: selectedPetFilter?.id == pet.id ? "checkmark.circle.fill" : "circle"
                                )
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "line.3.horizontal.decrease.circle")
                            if let pet = selectedPetFilter {
                                Text(pet.name)
                                    .font(.system(size: 14, weight: .medium))
                            }
                        }
                        .foregroundColor(.appTeal)
                    }
                }
            }
            .onAppear {
                loadHistory()
            }
            .refreshable {
                await refreshHistory()
            }
            .background(
                NavigationLink(
                    destination: Group {
                        if let result = selectedResult {
                            ResultView(result: result)
                                .environmentObject(appState)
                        }
                    },
                    isActive: $showResult
                ) { EmptyView() }
            )
        }
    }
    
    private func loadResult(for item: ScanHistoryItem) {
        guard let productId = item.productId, !isLoadingResult else { return }
        isLoadingResult = true

        Task {
            do {
                let result: ScanResult
                
                let matchingPet = appState.pets.first { pet in
                    pet.name == (item.petName ?? "") && pet.petType.rawValue == (item.petType ?? "")
                }
                
                if let pet = matchingPet {
                    result = try await ProductServiceClient.shared.analyzeProduct(productId: productId, pet: pet)
                } else {
                    let petType = item.petType ?? "dog"
                    let petName = item.petName ?? "Pet"
                    result = try await ProductServiceClient.shared.analyzeProduct(productId: productId, petType: petType, petName: petName)
                }
                await MainActor.run {
                    selectedResult = result
                    isLoadingResult = false
                    showResult = true
                }
            } catch {
                print("Failed to load result: \(error)")
                await MainActor.run {
                    isLoadingResult = false
                }
            }
        }
    }
    
    private func loadHistory() {
        isLoading = true
        
        Task {
            do {
                let items = try await ScanService.shared.getScanHistory(
                    petName: selectedPetFilter?.name,
                    petType: selectedPetFilter?.petType.rawValue,
                    limit: 50
                )
                
                await MainActor.run {
                    history = items
                    isLoading = false
                }
            } catch {
                await MainActor.run {
                    isLoading = false
                }
            }
        }
    }
    
    private func refreshHistory() async {
        do {
            let items = try await ScanService.shared.getScanHistory(
                petName: selectedPetFilter?.name,
                petType: selectedPetFilter?.petType.rawValue,
                limit: 50
            )
            
            await MainActor.run {
                history = items
            }
        } catch {
            print("Failed to refresh: \(error)")
        }
    }
}

// MARK: - Empty History View
struct EmptyHistoryView: View {
    var body: some View {
        VStack(spacing: AppSpacing.lg) {
            Image(systemName: "clock.badge.questionmark")
                .font(.system(size: 60))
                .foregroundColor(.appTextSecondary.opacity(0.5))
            
            Text("No Scans Yet")
                .font(AppTypography.displaySmall())
                .foregroundColor(.appTextPrimary)
            
            Text("Your scan history will appear here")
                .font(AppTypography.bodyMedium())
                .foregroundColor(.appTextSecondary)
        }
        .padding()
    }
}

// MARK: - History Card
struct HistoryCard: View {
    let item: ScanHistoryItem
    
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: AppSpacing.md) {
                // Score Circle
                ZStack {
                    Circle()
                        .fill(Color.gradeColor(item.grade).opacity(0.15))
                        .frame(width: 56, height: 56)
                    
                    VStack(spacing: 0) {
                        Text("\(item.finalScore)")
                            .font(AppTypography.numericLarge())
                            .foregroundColor(Color.gradeColor(item.grade))
                        
                        Text(item.grade)
                            .font(AppTypography.labelSmall())
                            .foregroundColor(Color.gradeColor(item.grade))
                    }
                }
                
                VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                    Text(item.productName ?? "Unknown Product")
                        .font(AppTypography.bodyLarge())
                        .fontWeight(.medium)
                        .foregroundColor(.appTextPrimary)
                        .lineLimit(2)
                    
                    if let brand = item.productBrand {
                        Text(brand)
                            .font(AppTypography.labelSmall())
                            .foregroundColor(.appTextSecondary)
                    }
                    
                    HStack(spacing: AppSpacing.sm) {
                        // Scan Type Badge
                        HStack(spacing: 4) {
                            Image(systemName: scanTypeIcon)
                                .font(.system(size: 10))
                            Text(scanTypeLabel)
                        }
                        .font(AppTypography.labelSmall())
                        .foregroundColor(.appTextSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color.appLightGray)
                        .cornerRadius(AppCornerRadius.small)
                        
                        // Pet Badge
                        if let petName = item.petName, let petType = item.petType {
                            HStack(spacing: 4) {
                                Text(Color.petTypeIcon(petType))
                                    .font(.system(size: 10))
                                Text(petName)
                            }
                            .font(AppTypography.labelSmall())
                            .foregroundColor(.appTextSecondary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.appLightGray)
                            .cornerRadius(AppCornerRadius.small)
                        }
                    }
                }
                
                Spacer()
            }
            .padding()
            
            Divider()
            
            // Date
            HStack {
                Text(formattedDate)
                    .font(AppTypography.labelSmall())
                    .foregroundColor(.appTextSecondary)
                
                Spacer()
                
                Image(systemName: "chevron.right")
                    .font(.system(size: 12))
                    .foregroundColor(.appTextSecondary)
            }
            .padding(.horizontal)
            .padding(.vertical, AppSpacing.sm)
            .background(Color.appLightGray.opacity(0.5))
        }
        .background(Color.appCardBackground)
        .cornerRadius(AppCornerRadius.large)
        .cardShadow()
    }
    
    private var scanTypeIcon: String {
        switch item.scanType.lowercased() {
        case "barcode": return "barcode"
        case "label_photo", "label": return "camera"
        case "manual_input", "manual": return "text.alignleft"
        default: return "questionmark"
        }
    }
    
    private var scanTypeLabel: String {
        switch item.scanType.lowercased() {
        case "barcode": return "Barcode"
        case "label_photo", "label": return "Label"
        case "manual_input", "manual": return "Manual"
        default: return "Scan"
        }
    }
    
    private var formattedDate: String {
        // Simple date formatting - in production use DateFormatter
        let dateString = item.createdAt
        if let date = ISO8601DateFormatter().date(from: dateString) {
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .short
            return formatter.string(from: date)
        }
        return dateString
    }
}

#Preview {
    HistoryView()
        .environmentObject(AppState())
}

