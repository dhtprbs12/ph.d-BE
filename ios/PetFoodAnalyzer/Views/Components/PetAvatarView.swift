import SwiftUI

struct PetAvatarView: View {
    let pet: Pet
    var size: CGFloat = 60
    var showEditBadge: Bool = false
    
    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if let photo = pet.photo {
                Image(uiImage: photo)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else {
                // Fallback to emoji icon
                Circle()
                    .fill(pet.petType == .dog ? Color.appOrange.opacity(0.2) : Color.appTeal.opacity(0.2))
                    .frame(width: size, height: size)
                    .overlay(
                        Text(pet.petType.icon)
                            .font(.system(size: size * 0.5))
                    )
            }
            
            if showEditBadge {
                Circle()
                    .fill(Color.appTeal)
                    .frame(width: size * 0.3, height: size * 0.3)
                    .overlay(
                        Image(systemName: "camera.fill")
                            .font(.system(size: size * 0.15))
                            .foregroundColor(.white)
                    )
                    .offset(x: 2, y: 2)
            }
        }
    }
}

// Smaller version for lists
struct PetAvatarSmall: View {
    let pet: Pet
    
    var body: some View {
        PetAvatarView(pet: pet, size: 40)
    }
}

// Large version for profile
struct PetAvatarLarge: View {
    let pet: Pet
    var showEditBadge: Bool = false
    
    var body: some View {
        PetAvatarView(pet: pet, size: 100, showEditBadge: showEditBadge)
    }
}

#Preview {
    VStack(spacing: 20) {
        PetAvatarView(pet: Pet(
            id: "1",
            name: "Max",
            petType: .dog,
            activityLevel: .moderate,
            isPrimary: true,
            healthConditions: []
        ), size: 80)
        
        PetAvatarView(pet: Pet(
            id: "2",
            name: "Luna",
            petType: .cat,
            activityLevel: .low,
            isPrimary: false,
            healthConditions: []
        ), size: 80, showEditBadge: true)
    }
}

