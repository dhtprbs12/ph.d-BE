import SwiftUI

struct DisclaimerView: View {
    let onAccept: () -> Void
    @State private var scrolledToBottom = false
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.shield.fill")
                    .font(.system(size: 40))
                    .foregroundColor(.appTeal)
                
                Text("Before You Begin")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundColor(.appTextPrimary)
                
                Text("Please read and accept our terms")
                    .font(.system(size: 15))
                    .foregroundColor(.appTextSecondary)
            }
            .padding(.top, 40)
            .padding(.bottom, 20)
            
            // Scrollable content
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    disclaimerSection(
                        icon: "info.circle.fill",
                        title: "For Informational Purposes Only",
                        content: "PHD provides general information about pet food ingredients and nutritional analysis. The scores, grades, and recommendations provided by this app are for educational and informational purposes only and should not be considered as professional veterinary advice, diagnosis, or treatment."
                    )
                    
                    disclaimerSection(
                        icon: "stethoscope",
                        title: "Not a Substitute for Veterinary Care",
                        content: "This app is not a substitute for professional veterinary advice. Always consult a qualified veterinarian before making any changes to your pet's diet, especially if your pet has health conditions, allergies, or special dietary needs."
                    )
                    
                    disclaimerSection(
                        icon: "chart.bar.fill",
                        title: "Accuracy of Information",
                        content: "While we strive to provide accurate ingredient analysis based on AAFCO guidelines, we do not guarantee the completeness or accuracy of any information provided. Product formulations may change, and individual pet needs vary."
                    )
                    
                    disclaimerSection(
                        icon: "hand.raised.fill",
                        title: "Limitation of Liability",
                        content: "PHD and its developers shall not be liable for any adverse effects, harm, or damages resulting from the use of information provided by this app. You assume full responsibility for any decisions made regarding your pet's nutrition."
                    )
                    
                    disclaimerSection(
                        icon: "person.fill.checkmark",
                        title: "Your Acknowledgment",
                        content: "By tapping \"I Understand & Agree\" below, you acknowledge that you have read, understood, and agree to these terms. You confirm that you will use this app as a supplementary informational tool and not as a replacement for professional veterinary guidance."
                    )
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
                
                GeometryReader { geo in
                    Color.clear
                        .onAppear {
                            scrolledToBottom = true
                        }
                }
                .frame(height: 1)
            }
            
            // Accept button
            VStack(spacing: 12) {
                Divider()
                
                Button(action: onAccept) {
                    Text("I Understand & Agree")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.appTeal)
                        .cornerRadius(14)
                }
                .padding(.horizontal, 20)
                
                Text("You must agree to continue using PHD")
                    .font(.system(size: 12))
                    .foregroundColor(.appTextSecondary)
            }
            .padding(.bottom, 30)
        }
        .background(Color.appBackground)
    }
    
    private func disclaimerSection(icon: String, title: String, content: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundColor(.appTeal)
                    .frame(width: 24)
                
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.appTextPrimary)
            }
            
            Text(content)
                .font(.system(size: 14))
                .foregroundColor(.appTextSecondary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appCardBackground)
        .cornerRadius(12)
    }
}
