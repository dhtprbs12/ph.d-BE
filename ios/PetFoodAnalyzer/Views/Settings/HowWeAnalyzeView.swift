import SwiftUI

struct HowWeAnalyzeView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // Header
                VStack(alignment: .leading, spacing: 8) {
                    Text("How We Analyze")
                        .font(.system(size: 28, weight: .bold))
                        .foregroundColor(.appTextPrimary)
                    
                    Text("Understand how we evaluate pet food safety")
                        .font(.system(size: 16))
                        .foregroundColor(.appTextSecondary)
                }
                .padding(.bottom, 8)
                
                // Our Process
                sectionCard(
                    icon: "magnifyingglass",
                    title: "Our Analysis Process",
                    content: """
                    We analyze pet food using a combination of:
                    
                    • Ingredient database with safety profiles
                    • AAFCO (Association of American Feed Control Officials) guidelines
                    • FDA pet food safety standards
                    • Veterinary nutrition research
                    
                    Each ingredient is evaluated for safety, nutritional value, and potential concerns based on your pet's specific health profile.
                    """
                )
                
                // Scoring System
                sectionCard(
                    icon: "chart.bar.fill",
                    title: "Scoring System",
                    content: """
                    Our scores range from 0-100:
                    
                    • We start with a base score and adjust based on ingredient quality
                    • Real protein sources add points
                    • Artificial additives reduce points
                    • We personalize based on your pet's health conditions
                    """
                )
                
                // Grade Scale
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        Image(systemName: "star.fill")
                            .foregroundColor(.appPrimary)
                        Text("Grade Scale")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(.appTextPrimary)
                    }
                    
                    VStack(spacing: 8) {
                        gradeRow(grade: "A", range: "85-100", description: "Excellent choice", color: .appSafe)
                        gradeRow(grade: "B", range: "70-84", description: "Good choice", color: .appPrimaryLight)
                        gradeRow(grade: "C", range: "55-69", description: "Acceptable", color: .appAccentSoft)
                        gradeRow(grade: "D", range: "40-54", description: "Below average", color: .appAccent)
                        gradeRow(grade: "F", range: "0-39", description: "Not recommended", color: .appDanger)
                    }
                }
                .padding(16)
                .background(Color.appCardBackground)
                .cornerRadius(12)
                
                // Data Sources
                sectionCard(
                    icon: "book.fill",
                    title: "Our Data Sources",
                    content: """
                    We reference trusted sources including:
                    
                    • AAFCO nutrient profiles
                    • FDA Center for Veterinary Medicine
                    • Peer-reviewed veterinary nutrition studies
                    • Ingredient safety databases
                    
                    Our database is regularly updated to reflect the latest research and safety guidelines.
                    """
                )
                
                // Disclaimer
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Image(systemName: "info.circle.fill")
                            .foregroundColor(.appTextSecondary)
                        Text("Important Note")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.appTextSecondary)
                    }
                    
                    Text("Our analysis is for informational purposes only and should not replace professional veterinary advice. Always consult your veterinarian for specific dietary recommendations for your pet.")
                        .font(.system(size: 13))
                        .foregroundColor(.appTextSecondary)
                }
                .padding(16)
                .background(Color.appTextSecondary.opacity(0.1))
                .cornerRadius(12)
            }
            .padding(20)
        }
        .background(Color.appBackground)
        .navigationBarTitleDisplayMode(.inline)
    }
    
    private func sectionCard(icon: String, title: String, content: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .foregroundColor(.appPrimary)
                Text(title)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.appTextPrimary)
            }
            
            Text(content)
                .font(.system(size: 14))
                .foregroundColor(.appTextSecondary)
                .lineSpacing(4)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appCardBackground)
        .cornerRadius(12)
    }
    
    private func gradeRow(grade: String, range: String, description: String, color: Color) -> some View {
        HStack {
            Text(grade)
                .font(.system(size: 16, weight: .bold))
                .foregroundColor(.white)
                .frame(width: 32, height: 32)
                .background(color)
                .cornerRadius(8)
            
            Text(range)
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.appTextPrimary)
                .frame(width: 60, alignment: .leading)
            
            Text(description)
                .font(.system(size: 14))
                .foregroundColor(.appTextSecondary)
            
            Spacer()
        }
    }
}

#Preview {
    NavigationView {
        HowWeAnalyzeView()
    }
}

