import Foundation

enum AppConfig {
    // Update these after App Store approval:
    static let appStoreURL = "https://apps.apple.com/app/petfood-analyzer/idYOUR_REAL_ID"
    static let appStoreID = "YOUR_REAL_ID"
    
    // Optional: Short link for sharing
    static let shareURL: String? = nil
    
    // Support email
    static let supportEmail = "support@petfoodanalyzer.com"
    
    // App Version (from Bundle)
    static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }
    
    // Build Number (from Bundle)
    static var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
    }
}

