import SwiftUI

struct PrivacyPolicyView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Privacy Policy")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundColor(.appTextPrimary)
                
                Text("Last updated: February 2026")
                    .font(.system(size: 14))
                    .foregroundColor(.appTextSecondary)
                
                section(title: "Information We Collect", content: """
                We collect information you provide directly:
                
                • Pet profiles (name, type, breed, age, weight, health conditions)
                • Images of pet food labels (processed for ingredient extraction)
                • Usage data and scan history
                
                We use a device identifier to associate your data with your device. We do not collect personal information such as your name, email, or phone number.
                """)
                
                section(title: "How We Use Your Information", content: """
                Your information is used to:
                
                • Analyze pet food ingredients
                • Provide personalized recommendations based on your pet's profile
                • Improve our ingredient database and analysis accuracy
                • Enhance app functionality and user experience
                """)
                
                section(title: "Data Storage", content: """
                • Pet profiles and scan history are stored securely on our servers
                • Images of food labels are processed and not permanently stored
                • You can delete your data at any time through the app settings
                """)
                
                section(title: "Third-Party Services", content: """
                We use third-party services for:
                
                • Image processing and text extraction
                • Analytics to improve our service
                
                These services have their own privacy policies and data practices.
                """)
                
                section(title: "Data Security", content: """
                We implement industry-standard security measures to protect your data. However, no method of electronic transmission or storage is 100% secure.
                """)
                
                section(title: "Children's Privacy", content: """
                Our app is not directed to children under 13. We do not knowingly collect personal information from children.
                """)
                
                section(title: "Changes to This Policy", content: """
                We may update this privacy policy from time to time. We will notify you of any changes by posting the new policy in the app.
                """)
                
                section(title: "Contact Us", content: """
                If you have questions about this privacy policy, please contact us at:
                
                \(AppConfig.supportEmail)
                """)
                
                // Disclaimer
                VStack(alignment: .leading, spacing: 8) {
                    Text("Disclaimer")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.appDanger)
                    
                    Text("The analysis results, scores, grades, and recommendations provided by this app are for informational purposes only. They do not constitute veterinary advice, diagnosis, or treatment. Always consult a qualified veterinarian for specific dietary recommendations for your pet. We are not liable for any decisions made based on the information provided by this app.")
                        .font(.system(size: 14))
                        .foregroundColor(.appTextSecondary)
                }
                .padding(16)
                .background(Color.appDanger.opacity(0.1))
                .cornerRadius(12)
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
        PrivacyPolicyView()
    }
}

