import SwiftUI
import UIKit

// MARK: - Share Preview Screen
struct SharePreviewView: View {
    let result: ScanResult
    @Environment(\.dismiss) private var dismiss
    @State private var showShareSheet = false
    @State private var productImage: UIImage?
    @State private var renderedImage: UIImage?
    
    private var productImageUrl: URL? {
        guard let urlStr = result.product?.imageUrl, !urlStr.isEmpty else { return nil }
        if urlStr.hasPrefix("http") { return URL(string: urlStr) }
        let base = APIConfig.baseURL.replacingOccurrences(of: "/api", with: "")
        return URL(string: "\(base)\(urlStr)")
    }
    
    var body: some View {
        ZStack {
            Color.black.opacity(0.95).ignoresSafeArea()
            
            VStack(spacing: 24) {
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(width: 36, height: 36)
                            .background(Color.white.opacity(0.15))
                            .clipShape(Circle())
                    }
                    Spacer()
                    Text("Share Result")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(.white)
                    Spacer()
                    Color.clear.frame(width: 36, height: 36)
                }
                .padding(.horizontal)
                
                Spacer()
                
                // Preview of the card (SwiftUI version for display)
                ShareCardPreview(result: result, productImage: productImage)
                
                Spacer()
                
                Button {
                    renderedImage = ShareCardRenderer.render(result: result, productImage: productImage)
                    showShareSheet = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 18, weight: .semibold))
                        Text("Share")
                            .font(.system(size: 16, weight: .semibold))
                    }
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Color(red: 0.13, green: 0.55, blue: 0.53))
                    .cornerRadius(14)
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 16)
            }
        }
        .sheet(isPresented: $showShareSheet) {
            if let img = renderedImage, let url = saveToTemp(img) {
                ShareSheet(items: [url])
            }
        }
        .task { await downloadImage() }
    }
    
    private func downloadImage() async {
        guard let url = productImageUrl else { return }
        if let (data, _) = try? await URLSession.shared.data(from: url),
           let img = UIImage(data: data) {
            await MainActor.run { productImage = img }
        }
    }
    
    private func saveToTemp(_ image: UIImage) -> URL? {
        guard let data = image.pngData() else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("petfood-result.png")
        try? data.write(to: url)
        return url
    }
}

// MARK: - SwiftUI Preview Card (displayed on screen only)
private struct ShareCardPreview: View {
    let result: ScanResult
    var productImage: UIImage?
    
    private var score: Int { result.analysis.finalScore }
    private var grade: String { result.analysis.grade }
    private var petEmoji: String { result.pet.petType.lowercased() == "dog" ? "🐕" : "🐱" }
    private var scoreColor: Color {
        switch grade {
        case "A": return Color(red: 0.2, green: 0.7, blue: 0.3)
        case "B": return Color(red: 0.4, green: 0.7, blue: 0.2)
        case "C": return Color(red: 0.9, green: 0.7, blue: 0.1)
        case "D": return Color(red: 0.9, green: 0.5, blue: 0.1)
        default: return Color(red: 0.9, green: 0.2, blue: 0.2)
        }
    }
    private let teal = Color(red: 0.13, green: 0.55, blue: 0.53)
    
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(petEmoji) \(result.pet.name)'s Food Check")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.white)
                Spacer()
            }
            .padding(.horizontal, 20).padding(.vertical, 16)
            .background(LinearGradient(colors: [teal, teal.opacity(0.85)], startPoint: .leading, endPoint: .trailing))
            
            VStack(spacing: 12) {
                if let img = productImage {
                    Image(uiImage: img).resizable().aspectRatio(contentMode: .fill)
                        .frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 10))
                }
                if let b = result.extracted?.brand ?? result.product?.brand {
                    Text(b.uppercased()).font(.system(size: 11, weight: .medium)).foregroundColor(.gray).tracking(1)
                }
                Text(result.extracted?.productName ?? result.product?.name ?? "Pet Food")
                    .font(.system(size: 17, weight: .bold)).multilineTextAlignment(.center).lineLimit(2)
                
                ZStack {
                    Circle().stroke(scoreColor.opacity(0.15), lineWidth: 10).frame(width: 100, height: 100)
                    Circle().trim(from: 0, to: CGFloat(score) / 100)
                        .stroke(scoreColor, style: StrokeStyle(lineWidth: 10, lineCap: .round))
                        .frame(width: 100, height: 100).rotationEffect(.degrees(-90))
                    VStack(spacing: 0) {
                        Text("\(score)").font(.system(size: 36, weight: .bold, design: .rounded)).foregroundColor(scoreColor)
                        Text("Grade \(grade)").font(.system(size: 12, weight: .semibold)).foregroundColor(scoreColor)
                    }
                }
                
                if let positives = result.analysis.positives, !positives.isEmpty {
                    ForEach(positives.prefix(3), id: \.self) { t in
                        HStack(alignment: .top, spacing: 6) {
                            Text("✅").font(.system(size: 11))
                            Text(t).font(.system(size: 12)).foregroundColor(Color(white: 0.25)).lineLimit(2)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20)
                    }
                }
                
                Spacer(minLength: 4)
                Rectangle().fill(Color(white: 0.88)).frame(height: 1)
                HStack(spacing: 4) {
                    Text("🐾").font(.system(size: 14))
                    Text("PHD").font(.system(size: 13, weight: .semibold)).foregroundColor(teal)
                }.padding(.top, 4)
                Text("Know what's in your pet's food").font(.system(size: 10)).foregroundColor(.gray)
            }
            .padding(.vertical, 12)
            .background(Color.white)
        }
        .frame(width: 320, height: 440)
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .shadow(color: .black.opacity(0.2), radius: 12, x: 0, y: 6)
    }
}

// MARK: - UIKit Renderer (draws card to image using Core Graphics)
enum ShareCardRenderer {
    static func render(result: ScanResult, productImage: UIImage?) -> UIImage {
        let w: CGFloat = 352
        let h: CGFloat = 472
        let pad: CGFloat = 16
        let cardW: CGFloat = 320
        let cardH: CGFloat = 440
        
        let score = result.analysis.finalScore
        let grade = result.analysis.grade
        let petName = result.pet.name
        let petEmoji = result.pet.petType.lowercased() == "dog" ? "🐕" : "🐱"
        let productName = result.extracted?.productName ?? result.product?.name ?? "Pet Food"
        let brand = result.extracted?.brand ?? result.product?.brand
        let positives = Array((result.analysis.positives ?? []).prefix(3))
        let warnings = Array((result.analysis.keyIssues ?? []).prefix(2))
        
        let gradeUIColor: UIColor = {
            switch grade {
            case "A": return UIColor(red: 0.2, green: 0.7, blue: 0.3, alpha: 1)
            case "B": return UIColor(red: 0.4, green: 0.7, blue: 0.2, alpha: 1)
            case "C": return UIColor(red: 0.9, green: 0.7, blue: 0.1, alpha: 1)
            case "D": return UIColor(red: 0.9, green: 0.5, blue: 0.1, alpha: 1)
            default: return UIColor(red: 0.9, green: 0.2, blue: 0.2, alpha: 1)
            }
        }()
        let teal = UIColor(red: 0.13, green: 0.55, blue: 0.53, alpha: 1)
        
        let format = UIGraphicsImageRendererFormat()
        format.scale = UIScreen.main.scale
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: format)
        
        return renderer.image { ctx in
            let c = ctx.cgContext
            
            // White background
            UIColor.white.setFill()
            c.fill(CGRect(x: 0, y: 0, width: w, height: h))
            
            let cardRect = CGRect(x: pad, y: pad, width: cardW, height: cardH)
            
            // Card shadow
            c.saveGState()
            c.setShadow(offset: CGSize(width: 0, height: 4), blur: 12, color: UIColor.black.withAlphaComponent(0.15).cgColor)
            let cardPath = UIBezierPath(roundedRect: cardRect, cornerRadius: 20)
            UIColor.white.setFill()
            cardPath.fill()
            c.restoreGState()
            
            // Clip to card
            c.saveGState()
            cardPath.addClip()
            
            // White content background (below header)
            UIColor.white.setFill()
            c.fill(cardRect)
            
            // Header gradient (clipped to header rect only)
            let headerRect = CGRect(x: pad, y: pad, width: cardW, height: 52)
            c.saveGState()
            c.clip(to: headerRect)
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                                      colors: [teal.cgColor, teal.withAlphaComponent(0.85).cgColor] as CFArray,
                                      locations: [0, 1])!
            c.drawLinearGradient(gradient, start: CGPoint(x: pad, y: pad), end: CGPoint(x: pad + cardW, y: pad), options: [])
            c.restoreGState()
            
            // Re-clip to card for remaining content
            c.saveGState()
            cardPath.addClip()
            
            // Header text
            let headerText = "\(petEmoji) \(petName)'s Food Check"
            let headerAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 18, weight: .semibold),
                .foregroundColor: UIColor.white
            ]
            (headerText as NSString).draw(at: CGPoint(x: pad + 20, y: pad + 16), withAttributes: headerAttrs)
            
            // Content area
            var yPos = pad + headerRect.height + 16
            
            // Product image
            if let img = productImage {
                let imgSize: CGFloat = 56
                let imgX = pad + (cardW - imgSize) / 2
                let imgRect = CGRect(x: imgX, y: yPos, width: imgSize, height: imgSize)
                c.saveGState()
                let imgPath = UIBezierPath(roundedRect: imgRect, cornerRadius: 10)
                imgPath.addClip()
                img.draw(in: imgRect)
                c.restoreGState()
                yPos += imgSize + 8
            }
            
            // Brand
            if let brand = brand {
                let brandAttrs: [NSAttributedString.Key: Any] = [
                    .font: UIFont.systemFont(ofSize: 11, weight: .medium),
                    .foregroundColor: UIColor.gray,
                    .kern: 1.0
                ]
                let brandStr = brand.uppercased() as NSString
                let brandSize = brandStr.size(withAttributes: brandAttrs)
                brandStr.draw(at: CGPoint(x: pad + (cardW - brandSize.width) / 2, y: yPos), withAttributes: brandAttrs)
                yPos += brandSize.height + 3
            }
            
            // Product name
            let nameAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 17, weight: .bold),
                .foregroundColor: UIColor.black
            ]
            let nameStr = productName as NSString
            let nameMaxRect = CGRect(x: pad + 20, y: yPos, width: cardW - 40, height: 50)
            let nameSize = nameStr.boundingRect(with: nameMaxRect.size, options: .usesLineFragmentOrigin, attributes: nameAttrs, context: nil)
            let nameX = pad + (cardW - nameSize.width) / 2
            nameStr.draw(in: CGRect(x: nameX, y: yPos, width: nameSize.width, height: nameSize.height), withAttributes: nameAttrs)
            yPos += nameSize.height + 16
            
            // Score circle
            let circleSize: CGFloat = 100
            let lineWidth: CGFloat = 10
            let circleX = pad + (cardW - circleSize) / 2
            let circleRect = CGRect(x: circleX, y: yPos, width: circleSize, height: circleSize).insetBy(dx: lineWidth / 2, dy: lineWidth / 2)
            
            // Background ring
            c.setStrokeColor(gradeUIColor.withAlphaComponent(0.15).cgColor)
            c.setLineWidth(lineWidth)
            c.strokeEllipse(in: circleRect)
            
            // Score arc
            let center = CGPoint(x: circleX + circleSize / 2, y: yPos + circleSize / 2)
            let radius = (circleSize - lineWidth) / 2
            let startAngle = -CGFloat.pi / 2
            let endAngle = startAngle + (CGFloat(score) / 100) * 2 * CGFloat.pi
            c.setStrokeColor(gradeUIColor.cgColor)
            c.setLineWidth(lineWidth)
            c.setLineCap(.round)
            c.addArc(center: center, radius: radius, startAngle: startAngle, endAngle: endAngle, clockwise: false)
            c.strokePath()
            
            // Score number
            let scoreAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 36, weight: .bold),
                .foregroundColor: gradeUIColor
            ]
            let scoreStr = "\(score)" as NSString
            let scoreSize = scoreStr.size(withAttributes: scoreAttrs)
            scoreStr.draw(at: CGPoint(x: center.x - scoreSize.width / 2, y: center.y - scoreSize.height / 2 - 6), withAttributes: scoreAttrs)
            
            // Grade label
            let gradeAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 12, weight: .semibold),
                .foregroundColor: gradeUIColor
            ]
            let gradeStr = "Grade \(grade)" as NSString
            let gradeSize = gradeStr.size(withAttributes: gradeAttrs)
            gradeStr.draw(at: CGPoint(x: center.x - gradeSize.width / 2, y: center.y + scoreSize.height / 2 - 10), withAttributes: gradeAttrs)
            
            yPos += circleSize + 14
            
            // Highlights
            let highlightAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 12),
                .foregroundColor: UIColor(white: 0.25, alpha: 1)
            ]
            let emojiAttrs: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 11)]
            
            for text in positives {
                ("✅" as NSString).draw(at: CGPoint(x: pad + 20, y: yPos), withAttributes: emojiAttrs)
                let textRect = CGRect(x: pad + 38, y: yPos, width: cardW - 58, height: 34)
                (text as NSString).draw(in: textRect, withAttributes: highlightAttrs)
                yPos += 18
            }
            for text in warnings {
                ("⚠️" as NSString).draw(at: CGPoint(x: pad + 20, y: yPos), withAttributes: emojiAttrs)
                let textRect = CGRect(x: pad + 38, y: yPos, width: cardW - 58, height: 34)
                (text as NSString).draw(in: textRect, withAttributes: highlightAttrs)
                yPos += 18
            }
            
            // Footer
            let footerY = pad + cardH - 40
            c.setStrokeColor(UIColor(white: 0.88, alpha: 1).cgColor)
            c.setLineWidth(1)
            c.move(to: CGPoint(x: pad + 20, y: footerY))
            c.addLine(to: CGPoint(x: pad + cardW - 20, y: footerY))
            c.strokePath()
            
            let footerLabelAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 13, weight: .semibold),
                .foregroundColor: teal
            ]
            let footerEmoji = "🐾" as NSString
            let footerLabel = "PHD" as NSString
            let footerEmojiSize = footerEmoji.size(withAttributes: [.font: UIFont.systemFont(ofSize: 14)])
            let footerLabelSize = footerLabel.size(withAttributes: footerLabelAttrs)
            let footerTotalW = footerEmojiSize.width + 4 + footerLabelSize.width
            let footerX = pad + (cardW - footerTotalW) / 2
            footerEmoji.draw(at: CGPoint(x: footerX, y: footerY + 8), withAttributes: [.font: UIFont.systemFont(ofSize: 14)])
            footerLabel.draw(at: CGPoint(x: footerX + footerEmojiSize.width + 4, y: footerY + 8), withAttributes: footerLabelAttrs)
            
            let taglineAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 10),
                .foregroundColor: UIColor(white: 0.55, alpha: 1)
            ]
            let tagline = "Know what's in your pet's food" as NSString
            let taglineSize = tagline.size(withAttributes: taglineAttrs)
            tagline.draw(at: CGPoint(x: pad + (cardW - taglineSize.width) / 2, y: footerY + 26), withAttributes: taglineAttrs)
            
            c.restoreGState()
        }
    }
}

// MARK: - Share Sheet
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
