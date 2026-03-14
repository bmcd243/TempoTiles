import Foundation

enum LocalModelError: Error {
  case invalidStorage
}

final class LocalModelManager {
  private let fileManager = FileManager.default
  private let modelFileName = "interval-model.mlmodel"

  private var modelsDirectory: URL {
    let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    return (base ?? fileManager.temporaryDirectory).appendingPathComponent("LocalModels", isDirectory: true)
  }

  func ensureModelDownloaded(from url: URL) async throws -> String {
    let targetDir = modelsDirectory
    try fileManager.createDirectory(at: targetDir, withIntermediateDirectories: true)
    let targetFile = targetDir.appendingPathComponent(modelFileName)

    if fileManager.fileExists(atPath: targetFile.path) {
      return targetFile.path
    }

    let (tempUrl, _) = try await URLSession.shared.download(from: url)
    try? fileManager.removeItem(at: targetFile)
    try fileManager.copyItem(at: tempUrl, to: targetFile)
    return targetFile.path
  }

  func isModelReady() -> Bool {
    let targetFile = modelsDirectory.appendingPathComponent(modelFileName)
    return fileManager.fileExists(atPath: targetFile.path)
  }
}
