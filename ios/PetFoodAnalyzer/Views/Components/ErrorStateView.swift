import SwiftUI

struct ErrorStateView: View {
    let title: String
    let message: String
    var retryAction: (() -> Void)?
    
    init(title: String = "Something went wrong", message: String, retryAction: (() -> Void)? = nil) {
        self.title = title
        self.message = message
        self.retryAction = retryAction
    }
    
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundColor(.appDanger)
            
            Text(title)
                .font(.system(size: 18, weight: .semibold))
                .foregroundColor(.appTextPrimary)
            
            Text(message)
                .font(.system(size: 14))
                .foregroundColor(.appTextSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            
            if let retryAction = retryAction {
                Button(action: retryAction) {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.clockwise")
                        Text("Try Again")
                    }
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(.white)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 12)
                    .background(Color.appPrimary)
                    .cornerRadius(10)
                }
                .padding(.top, 8)
            }
        }
        .padding(24)
    }
}

#Preview {
    ErrorStateView(
        title: "Failed to Load",
        message: "We couldn't load your data. Please check your connection and try again.",
        retryAction: { print("Retry tapped") }
    )
}

