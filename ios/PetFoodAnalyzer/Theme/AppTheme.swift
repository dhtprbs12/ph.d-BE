import SwiftUI

// MARK: - Color Palette
// Theme: "Natural Care" - Professional, trustworthy, pet-friendly
extension Color {
    // Brand Colors - Forest & Nature Inspired
    static let appPrimary = Color(hex: "2D6A4F")        // Forest Green - Trust & Health
    static let appPrimaryLight = Color(hex: "40916C")   // Lighter green for accents
    static let appAccent = Color(hex: "F4A261")         // Warm Amber - Friendly & Caring
    static let appAccentSoft = Color(hex: "E9C46A")     // Soft Gold - Warmth
    
    // Legacy aliases (for backward compatibility)
    static let appTeal = appPrimary
    static let appOrange = appAccent
    
    // Status Colors - Nature-inspired
    static let appSafe = Color(hex: "40916C")           // Natural Green - Healthy
    static let appCaution = Color(hex: "E9C46A")        // Soft Amber - Attention
    static let appWarning = Color(hex: "F4A261")        // Warm Amber - Warning
    static let appDanger = Color(hex: "E76F51")         // Terracotta - Danger (softer red)
    
    // Background Colors - Warm & Clean
    static let appBackground = Color(hex: "FDFBF7")     // Warm Cream - Welcoming
    static let appCardBackground = Color.white
    static let appLightGray = Color(hex: "F5F3EF")      // Warm Light Gray
    static let appDivider = Color(hex: "E8E4DD")        // Subtle divider
    
    // Text Colors - Organic feel
    static let appTextPrimary = Color(hex: "1B2B27")    // Dark Forest - Readable
    static let appTextSecondary = Color(hex: "5C6B66")  // Muted Green-Gray
    
    // Grade Colors (accepts String for flexibility)
    static func gradeColor(_ grade: String) -> Color {
        switch grade.uppercased() {
        case "A": return Color(hex: "2D6A4F")   // Forest Green - Excellent
        case "B": return Color(hex: "40916C")   // Light Green - Good
        case "C": return Color(hex: "E9C46A")   // Soft Amber - Acceptable
        case "D": return Color(hex: "F4A261")   // Warm Amber - Caution
        case "F": return Color(hex: "E76F51")   // Terracotta - Not Recommended
        default: return Color(hex: "5C6B66")
        }
    }
    
    // Grade description helper
    static func gradeDescription(_ grade: String) -> String {
        switch grade.uppercased() {
        case "A": return "Excellent Choice"
        case "B": return "Good Choice"
        case "C": return "Acceptable"
        case "D": return "Use Caution"
        case "F": return "Not Recommended"
        default: return "Unknown"
        }
    }
    
    // Pet type icon helper
    static func petTypeIcon(_ petType: String) -> String {
        switch petType.lowercased() {
        case "dog": return "🐕"
        case "cat": return "🐱"
        default: return "🐾"
        }
    }
    
    // Risk Level Colors (accepts String for flexibility)
    static func riskColor(_ level: String) -> Color {
        switch level.lowercased() {
        case "safe": return Color(hex: "2D6A4F")      // Forest Green
        case "low": return Color(hex: "40916C")       // Light Green
        case "moderate": return Color(hex: "E9C46A")  // Soft Amber
        case "high": return Color(hex: "F4A261")      // Warm Amber
        case "danger": return Color(hex: "E76F51")    // Terracotta
        default: return Color(hex: "5C6B66")
        }
    }
    
    // Hex initializer
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 3:
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6:
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8:
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }
}

// MARK: - Typography
// Clean, professional typography with clear hierarchy
struct AppTypography {
    // Display - Headlines (SF Pro Display)
    static func displayLarge() -> Font {
        .system(size: 32, weight: .bold, design: .default)
    }
    
    static func displayMedium() -> Font {
        .system(size: 26, weight: .semibold, design: .default)
    }
    
    static func displaySmall() -> Font {
        .system(size: 20, weight: .semibold, design: .default)
    }
    
    // Title - Section Headers
    static func titleLarge() -> Font {
        .system(size: 18, weight: .semibold, design: .default)
    }
    
    static func titleMedium() -> Font {
        .system(size: 16, weight: .semibold, design: .default)
    }
    
    // Body - Content Text
    static func bodyLarge() -> Font {
        .system(size: 17, weight: .regular, design: .default)
    }
    
    static func bodyMedium() -> Font {
        .system(size: 15, weight: .regular, design: .default)
    }
    
    static func bodySmall() -> Font {
        .system(size: 13, weight: .regular, design: .default)
    }
    
    // Numeric - Scores & Numbers (Rounded for friendliness)
    static func scoreDisplay() -> Font {
        .system(size: 56, weight: .bold, design: .rounded)
    }
    
    static func gradeDisplay() -> Font {
        .system(size: 64, weight: .bold, design: .rounded)
    }
    
    static func numericLarge() -> Font {
        .system(size: 28, weight: .semibold, design: .rounded)
    }
    
    static func numericMedium() -> Font {
        .system(size: 20, weight: .medium, design: .rounded)
    }
    
    // Labels - UI Elements
    static func labelLarge() -> Font {
        .system(size: 14, weight: .semibold, design: .default)
    }
    
    static func labelMedium() -> Font {
        .system(size: 12, weight: .medium, design: .default)
    }
    
    static func labelSmall() -> Font {
        .system(size: 11, weight: .medium, design: .default)
    }
    
    // Caption - Fine print
    static func caption() -> Font {
        .system(size: 11, weight: .regular, design: .default)
    }
}

// MARK: - Spacing
struct AppSpacing {
    static let xxs: CGFloat = 4
    static let xs: CGFloat = 8
    static let sm: CGFloat = 12
    static let md: CGFloat = 16
    static let lg: CGFloat = 24
    static let xl: CGFloat = 32
    static let xxl: CGFloat = 48
}

// MARK: - Corner Radius
struct AppCornerRadius {
    static let small: CGFloat = 8
    static let medium: CGFloat = 12
    static let large: CGFloat = 16
    static let xl: CGFloat = 24
    static let full: CGFloat = 9999
}

// MARK: - Shadows
// Refined, subtle shadows for depth without distraction
extension View {
    func appShadow(radius: CGFloat = 8, y: CGFloat = 2) -> some View {
        self.shadow(color: Color(hex: "2D6A4F").opacity(0.08), radius: radius, x: 0, y: y)
    }
    
    func cardShadow() -> some View {
        self
            .shadow(color: Color(hex: "2D6A4F").opacity(0.04), radius: 8, x: 0, y: 2)
            .shadow(color: Color(hex: "2D6A4F").opacity(0.02), radius: 1, x: 0, y: 1)
    }
    
    func elevatedShadow() -> some View {
        self
            .shadow(color: Color(hex: "2D6A4F").opacity(0.08), radius: 16, x: 0, y: 8)
            .shadow(color: Color(hex: "2D6A4F").opacity(0.04), radius: 4, x: 0, y: 2)
    }
}

// MARK: - Button Styles
struct PrimaryButtonStyle: ButtonStyle {
    var color: Color = .appPrimary
    var isDisabled: Bool = false
    
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .foregroundColor(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(
                Group {
                    if isDisabled {
                        Color(hex: "5C6B66").opacity(0.4)
                    } else {
                        LinearGradient(
                            colors: [color, color.opacity(0.9)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    }
                }
            )
            .cornerRadius(AppCornerRadius.medium)
            .shadow(color: isDisabled ? .clear : color.opacity(0.3), radius: 8, x: 0, y: 4)
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .opacity(configuration.isPressed ? 0.95 : 1.0)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    var color: Color = .appPrimary
    
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .foregroundColor(color)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(color.opacity(0.08))
            .cornerRadius(AppCornerRadius.medium)
            .overlay(
                RoundedRectangle(cornerRadius: AppCornerRadius.medium)
                    .stroke(color.opacity(0.3), lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .opacity(configuration.isPressed ? 0.8 : 1.0)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

// Tertiary button for less prominent actions
struct TertiaryButtonStyle: ButtonStyle {
    var color: Color = .appPrimary
    
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .medium))
            .foregroundColor(color)
            .padding(.vertical, 12)
            .padding(.horizontal, 16)
            .scaleEffect(configuration.isPressed ? 0.97 : 1.0)
            .opacity(configuration.isPressed ? 0.7 : 1.0)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }
}

// MARK: - Card Style Modifier
struct CardModifier: ViewModifier {
    var padding: CGFloat = AppSpacing.md
    
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Color.appCardBackground)
            .cornerRadius(AppCornerRadius.large)
            .cardShadow()
    }
}

extension View {
    func cardStyle(padding: CGFloat = AppSpacing.md) -> some View {
        modifier(CardModifier(padding: padding))
    }
}

// MARK: - Badge Style
struct BadgeModifier: ViewModifier {
    var color: Color = .appPrimary
    
    func body(content: Content) -> some View {
        content
            .font(AppTypography.labelSmall())
            .foregroundColor(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(color.opacity(0.1))
            .cornerRadius(AppCornerRadius.full)
    }
}

extension View {
    func badgeStyle(color: Color = .appPrimary) -> some View {
        modifier(BadgeModifier(color: color))
    }
}

// MARK: - Divider Style
struct AppDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color.appDivider)
            .frame(height: 1)
    }
}

// MARK: - Animations
struct AppAnimations {
    // Standard spring for cards and buttons
    static let cardSpring = Animation.spring(response: 0.4, dampingFraction: 0.75)
    
    // Bouncy spring for playful elements
    static let bouncySpring = Animation.spring(response: 0.5, dampingFraction: 0.6)
    
    // Quick spring for micro-interactions
    static let quickSpring = Animation.spring(response: 0.25, dampingFraction: 0.8)
    
    // Staggered delay helper
    static func staggerDelay(index: Int, baseDelay: Double = 0.05) -> Double {
        return Double(index) * baseDelay
    }
}

// MARK: - Staggered Appear Modifier
struct StaggeredAppearModifier: ViewModifier {
    let index: Int
    let baseDelay: Double
    @State private var isVisible = false
    
    func body(content: Content) -> some View {
        content
            .opacity(isVisible ? 1 : 0)
            .offset(y: isVisible ? 0 : 20)
            .scaleEffect(isVisible ? 1 : 0.95)
            .onAppear {
                withAnimation(AppAnimations.cardSpring.delay(AppAnimations.staggerDelay(index: index, baseDelay: baseDelay))) {
                    isVisible = true
                }
            }
    }
}

extension View {
    func staggeredAppear(index: Int, baseDelay: Double = 0.08) -> some View {
        modifier(StaggeredAppearModifier(index: index, baseDelay: baseDelay))
    }
}

// MARK: - Pulse Animation Modifier
struct PulseModifier: ViewModifier {
    @State private var isPulsing = false
    let duration: Double
    
    func body(content: Content) -> some View {
        content
            .scaleEffect(isPulsing ? 1.02 : 1.0)
            .onAppear {
                withAnimation(Animation.easeInOut(duration: duration).repeatForever(autoreverses: true)) {
                    isPulsing = true
                }
            }
    }
}

extension View {
    func pulse(duration: Double = 1.5) -> some View {
        modifier(PulseModifier(duration: duration))
    }
}

// MARK: - Score Circle Animation
struct AnimatedScoreModifier: ViewModifier {
    let targetScore: Int
    @State private var currentScore: Int = 0
    @State private var hasAnimated = false
    
    func body(content: Content) -> some View {
        content
            .onAppear {
                guard !hasAnimated else { return }
                hasAnimated = true
                
                // Animate the score counting up
                withAnimation(.easeOut(duration: 1.0)) {
                    currentScore = targetScore
                }
            }
    }
}

