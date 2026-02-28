import SwiftUI

struct TermsOfServiceView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Terms of Service")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundColor(.appTextPrimary)
                
                Text("Last updated: February 2026")
                    .font(.system(size: 14))
                    .foregroundColor(.appTextSecondary)
                
                // Important Disclaimer Banner
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundColor(.appDanger)
                        Text("Important Disclaimer")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.appDanger)
                    }
                    
                    Text("This app provides informational content only. The analysis results, scores, grades, and recommendations ARE NOT veterinary advice and should NOT be used as a substitute for professional veterinary consultation. We expressly disclaim any liability for decisions made based on information provided by this app.")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(.appTextPrimary)
                }
                .padding(16)
                .background(Color.appDanger.opacity(0.15))
                .cornerRadius(12)
                
                section(title: "Acceptance of Terms", content: """
                By using PetFood Analyzer, you agree to these Terms of Service. If you do not agree, please do not use the app.
                """)
                
                section(title: "Description of Service", content: """
                PetFood Analyzer provides:
                
                • Pet food ingredient analysis
                • Safety assessments based on publicly available data
                • Personalized recommendations based on pet profiles
                
                This service is provided "as is" for informational purposes only.
                """)
                
                section(title: "No Veterinary Advice", content: """
                THE INFORMATION PROVIDED BY THIS APP DOES NOT CONSTITUTE VETERINARY ADVICE.
                
                • Analysis results are generated using databases and algorithms
                • Scores and grades are estimates based on general ingredient safety data
                • Recommendations are not tailored to your pet's complete medical history
                
                Always consult a licensed veterinarian before making dietary decisions for your pet, especially if your pet has health conditions, allergies, or special dietary needs.
                """)
                
                section(title: "Limitation of Liability", content: """
                TO THE MAXIMUM EXTENT PERMITTED BY LAW:
                
                • We are not liable for any harm, illness, or adverse effects to your pet resulting from dietary decisions based on our app's analysis
                • We are not liable for inaccuracies in ingredient data or analysis results
                • We are not liable for any direct, indirect, incidental, or consequential damages
                
                You use this app at your own risk and assume full responsibility for any decisions made based on the information provided.
                """)
                
                section(title: "User Responsibilities", content: """
                You agree to:
                
                • Provide accurate information about your pet's profile
                • Verify ingredient information with the actual product packaging
                • Consult a veterinarian for health-related dietary decisions
                • Use the app responsibly and in accordance with these terms
                """)
                
                section(title: "Intellectual Property", content: """
                All content, features, and functionality of this app are owned by us and protected by intellectual property laws. You may not copy, modify, or distribute any part of the app without permission.
                """)
                
                section(title: "Modifications to Service", content: """
                We reserve the right to modify, suspend, or discontinue the service at any time without notice. We may also update these terms, and continued use constitutes acceptance of changes.
                """)
                
                section(title: "Governing Law", content: """
                These terms are governed by the laws of the jurisdiction in which we operate, without regard to conflict of law principles.
                """)
                
                section(title: "Contact", content: """
                For questions about these terms, contact us at:
                
                \(AppConfig.supportEmail)
                """)
            }
            .padding(20)
        }
        .background(Color.appBackground)
        .navigationBarTitleDisplayMode(.inline)
    }
    
    private func section(title: String, content: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 18, weight: .semibold))
                .foregroundColor(.appTextPrimary)
            
            Text(content)
                .font(.system(size: 14))
                .foregroundColor(.appTextSecondary)
                .lineSpacing(4)
        }
    }
}

#Preview {
    NavigationView {
        TermsOfServiceView()
    }
}

