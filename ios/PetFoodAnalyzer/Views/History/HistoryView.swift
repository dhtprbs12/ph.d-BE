import SwiftUI

struct HistoryView: View {
    @EnvironmentObject var appState: AppState
    @State private var history: [ScanHistoryItem] = []
    @State private var isLoading = true
    @State private var selectedPetFilter: Pet?
    
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
                            }
                        }
                        .padding()
                    }
                }
            }
            .background(Color.appBackground)
            .navigationTitle("Scan History")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("All Pets") {
                            selectedPetFilter = nil
                            loadHistory()
                        }
                        
                        ForEach(appState.pets) { pet in
                            Button {
                                selectedPetFilter = pet
                                loadHistory()
                            } label: {
                                HStack {
                                    Text(pet.petType.icon)
                                    Text(pet.name)
                                }
                            }
                        }
                    } label: {
                        Image(systemName: "line.3.horizontal.decrease.circle")
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
        }
    }
    
    private func loadHistory() {
        isLoading = true
        
        Task {
            do {
                let items = try await ScanService.shared.getScanHistory(
                    petId: selectedPetFilter?.id,
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
                petId: selectedPetFilter?.id,
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

