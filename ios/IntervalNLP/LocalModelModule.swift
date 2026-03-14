import ExpoModulesCore
import Foundation

public class LocalModelModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LocalModel")

    AsyncFunction("ensureModelDownloaded") { (urlString: String) async throws -> String in
      guard let url = URL(string: urlString) else {
        throw NSError(domain: "LocalModel", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid model URL."])
      }
      let manager = try LocalModelManager()
      return try await manager.ensureModelDownloaded(from: url)
    }

    AsyncFunction("isModelReady") { () -> Bool in
      do {
        let manager = try LocalModelManager()
        return manager.isModelReady()
      } catch {
        return false
      }
    }

    AsyncFunction("runInference") { (_: String) async throws -> String in
      throw NSError(
        domain: "LocalModel",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "On-device runtime not configured yet."]
      )
    }
  }
}
