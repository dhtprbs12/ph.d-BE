import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @State private var showResetAlert = false
    
    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: AppSpacing.lg) {
                    // App Info Card
                    VStack(spacing: 0) {
                        HStack {
                            Image(systemName: "pawprint.circle.fill")
                                .font(.system(size: 50))
                                .foregroundStyle(
                                    LinearGradient(
                                        colors: [.appPrimary, .appPrimary.opacity(0.7)],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                            
                            VStack(alignment: .leading, spacing: 4) {
                                Text("PHD")
                                    .font(AppTypography.bodyLarge())
                                    .fontWeight(.semibold)
                                    .foregroundColor(.appTextPrimary)
                                Text("Version 1.0.0")
                                    .font(AppTypography.bodySmall())
                                    .foregroundColor(.appTextSecondary)
                            }
                            .padding(.leading, 8)
                            
                            Spacer()
                        }
                        .padding()
                    }
                    .background(Color.appCardBackground)
                    .cornerRadius(AppCornerRadius.large)
                    .cardShadow()
                    .padding(.horizontal)
                    .staggeredAppear(index: 0)
                    
                    // Your Stats Section
                    SettingsSection(title: "Your Stats") {
                        SettingsRow(
                            icon: "pawprint",
                            iconColor: .appPrimary,
                            title: "Pets",
                            value: "\(appState.pets.count)"
                        )
                    }
                    .staggeredAppear(index: 1)
                    
                    // About Section
                    SettingsSection(title: "About") {
                        Link(destination: URL(string: "https://example.com/privacy")!) {
                            SettingsRow(
                                icon: "hand.raised",
                                iconColor: .appPrimary,
                                title: "Privacy Policy",
                                showChevron: true
                            )
                        }
                        
                        Divider()
                            .padding(.leading, 44)
                        
                        Link(destination: URL(string: "https://example.com/terms")!) {
                            SettingsRow(
                                icon: "doc.text",
                                iconColor: .appPrimary,
                                title: "Terms of Service",
                                showChevron: true
                            )
                        }
                        
                        Divider()
                            .padding(.leading, 44)
                        
                        SettingsRow(
                            icon: "star",
                            iconColor: .appAccent,
                            title: "Rate App",
                            showChevron: true
                        )
                    }
                    .staggeredAppear(index: 2)
                    
                    // Data Section
                    SettingsSection(title: "Data") {
                        Button {
                            showResetAlert = true
                        } label: {
                            SettingsRow(
                                icon: "arrow.counterclockwise",
                                iconColor: .appDanger,
                                title: "Reset App",
                                titleColor: .appDanger
                            )
                        }
                    }
                    .staggeredAppear(index: 3)
                    
                    // Footer
                    VStack(spacing: 4) {
                        Text("Made with ❤️ for pet lovers")
                            .font(AppTypography.bodySmall())
                            .foregroundColor(.appTextSecondary)
                    }
                    .padding(.vertical, AppSpacing.lg)
                    .staggeredAppear(index: 4)
                }
                .padding(.top)
            }
            .background(Color.appBackground)
            .navigationTitle("Settings")
            .alert("Reset App", isPresented: $showResetAlert) {
                Button("Cancel", role: .cancel) { }
                Button("Reset", role: .destructive) {
                    appState.resetApp()
                }
            } message: {
                Text("This will delete all your pets and reset the app to its initial state. This action cannot be undone.")
            }
        }
    }
}

// MARK: - Settings Section
struct SettingsSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    
    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            Text(title.uppercased())
                .font(AppTypography.labelSmall())
                .foregroundColor(.appTextSecondary)
                .padding(.horizontal)
            
            VStack(spacing: 0) {
                content
            }
            .background(Color.appCardBackground)
            .cornerRadius(AppCornerRadius.large)
            .cardShadow()
        }
        .padding(.horizontal)
    }
}

// MARK: - Settings Row
struct SettingsRow: View {
    let icon: String
    var iconColor: Color = .appPrimary
    let title: String
    var titleColor: Color = .appTextPrimary
    var value: String? = nil
    var showChevron: Bool = false
    
    var body: some View {
        HStack(spacing: AppSpacing.md) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundColor(iconColor)
                .frame(width: 28)
            
            Text(title)
                .font(AppTypography.bodyMedium())
                .foregroundColor(titleColor)
            
            Spacer()
            
            if let value = value {
                Text(value)
                    .font(AppTypography.bodyMedium())
                    .foregroundColor(.appTextSecondary)
            }
            
            if showChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.appTextSecondary)
            }
        }
        .padding()
        .contentShape(Rectangle())
    }
}

#Preview {
    SettingsView()
        .environmentObject(AppState())
}
