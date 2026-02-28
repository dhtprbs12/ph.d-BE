import Foundation

// MARK: - API Configuration
enum APIConfig {
    // Toggle this to switch between local dev and production
    static let useProduction = false

    static var baseURL: String {
        if useProduction {
            return "https://YOUR_RAILWAY_DOMAIN.up.railway.app/api"
        }
        #if targetEnvironment(simulator)
        return "http://localhost:3000/api"
        #else
        return "http://192.168.1.113:3000/api"
        #endif
    }
}

// MARK: - API Errors
enum APIError: Error, LocalizedError {
    case invalidURL
    case noData
    case decodingError(Error)
    case serverError(String, Data?)  // Include raw data for custom parsing
    case unauthorized
    case notFound
    case networkError(Error)
    
    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .noData:
            return "No data received"
        case .decodingError(let error):
            return "Failed to decode response: \(error.localizedDescription)"
        case .serverError(let message, _):
            return message
        case .unauthorized:
            return "Please log in to continue"
        case .notFound:
            return "Resource not found"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        }
    }
}

// MARK: - API Service
class APIService {
    static let shared = APIService()
    
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    
    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120  // 2 minutes (AI + many ingredients can take time)
        config.timeoutIntervalForResource = 180 // 3 minutes
        self.session = URLSession(configuration: config)
        
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }
    
    // MARK: - Token Management
    var authToken: String? {
        get { UserDefaults.standard.string(forKey: "authToken") }
        set {
            if let token = newValue {
                UserDefaults.standard.set(token, forKey: "authToken")
            } else {
                UserDefaults.standard.removeObject(forKey: "authToken")
            }
        }
    }
    
    // MARK: - Request Building
    private func buildRequest(
        endpoint: String,
        method: String = "GET",
        body: Data? = nil,
        requiresAuth: Bool = true
    ) throws -> URLRequest {
        guard let url = URL(string: "\(APIConfig.baseURL)\(endpoint)") else {
            throw APIError.invalidURL
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        if requiresAuth, let token = authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        request.httpBody = body
        
        return request
    }
    
    // MARK: - Generic Request
    func request<T: Decodable>(
        endpoint: String,
        method: String = "GET",
        body: Encodable? = nil,
        requiresAuth: Bool = true
    ) async throws -> T {
        var bodyData: Data? = nil
        if let body = body {
            bodyData = try encoder.encode(body)
        }
        
        let request = try buildRequest(
            endpoint: endpoint,
            method: method,
            body: bodyData,
            requiresAuth: requiresAuth
        )
        
        do {
            let (data, response) = try await session.data(for: request)
            
            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIError.noData
            }
            
            switch httpResponse.statusCode {
            case 200...299:
                do {
                    return try decoder.decode(T.self, from: data)
                } catch {
                    print("Decoding error: \(error)")
                    print("Response data: \(String(data: data, encoding: .utf8) ?? "nil")")
                    throw APIError.decodingError(error)
                }
            case 401:
                throw APIError.unauthorized
            case 404:
                throw APIError.notFound
            default:
                if let errorResponse = try? decoder.decode(ErrorResponse.self, from: data) {
                    throw APIError.serverError(errorResponse.error, data)
                }
                throw APIError.serverError("Server error: \(httpResponse.statusCode)", data)
            }
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.networkError(error)
        }
    }
    
    // MARK: - Multipart Upload
    func uploadImage<T: Decodable>(
        endpoint: String,
        imageData: Data,
        imageName: String = "image",
        additionalFields: [String: String] = [:]
    ) async throws -> T {
        guard let url = URL(string: "\(APIConfig.baseURL)\(endpoint)") else {
            throw APIError.invalidURL
        }
        
        let boundary = UUID().uuidString
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        
        if let token = authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        var body = Data()
        
        // Add additional fields
        for (key, value) in additionalFields {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }
        
        // Add image
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"\(imageName)\"; filename=\"photo.jpg\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(imageData)
        body.append("\r\n".data(using: .utf8)!)
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        
        request.httpBody = body
        
        let (data, response) = try await session.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode >= 200 && httpResponse.statusCode < 300 else {
            if let errorResponse = try? decoder.decode(ErrorResponse.self, from: data) {
                throw APIError.serverError(errorResponse.error, data)
            }
            throw APIError.serverError("Upload failed", data)
        }
        
        return try decoder.decode(T.self, from: data)
    }
}

// MARK: - Error Response
struct ErrorResponse: Codable {
    let error: String
    var message: String?
}

// MARK: - Generic Responses
struct MessageResponse: Codable {
    let message: String
}

struct PetsResponse: Codable {
    let pets: [Pet]
}

struct PetResponse: Codable {
    let pet: Pet
}

struct ProductsResponse: Codable {
    let products: [Product]
}

struct ProductResponse: Codable {
    let product: Product
    var reviewStats: ReviewStats?
}

struct ReviewsResponse: Codable {
    let reviews: [Review]
    let stats: ReviewStats
}

struct ScanHistoryResponse: Codable {
    let history: [ScanHistoryItem]
}

struct AlternativesResponse: Codable {
    let alternatives: [AlternativeProduct]
}

// MARK: - Community Stats Extension
extension APIService {
    func fetchCommunityStats() async throws -> CommunityStats {
        return try await request(
            endpoint: "/scan/stats",
            method: "GET",
            requiresAuth: false
        )
    }
    
    func fetchUserStats(deviceId: String) async throws -> UserStats {
        guard let url = URL(string: "\(APIConfig.baseURL)/scan/user-stats?deviceId=\(deviceId)") else {
            throw APIError.invalidURL
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(deviceId, forHTTPHeaderField: "X-Device-Id")
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode >= 200 && httpResponse.statusCode < 300 else {
            throw APIError.serverError("Failed to fetch user stats", data)
        }
        
        return try JSONDecoder().decode(UserStats.self, from: data)
    }
}

