import Foundation
import Security

guard CommandLine.arguments.count == 4 else {
    FileHandle.standardError.write(Data("Usage: sticky-pad-keychain store|read|delete SERVICE ACCOUNT\n".utf8))
    exit(64)
}

let operation = CommandLine.arguments[1]
let service = CommandLine.arguments[2]
let account = CommandLine.arguments[3]
let identity: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account
]

switch operation {
case "store":
    let secret = FileHandle.standardInput.readDataToEndOfFile()
    guard !secret.isEmpty else {
        FileHandle.standardError.write(Data("Refusing to store an empty credential.\n".utf8))
        exit(65)
    }

    let replacement: [String: Any] = [
        kSecValueData as String: secret,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
    ]
    let updateStatus = SecItemUpdate(identity as CFDictionary, replacement as CFDictionary)
    if updateStatus == errSecItemNotFound {
        var newItem = identity
        replacement.forEach { newItem[$0.key] = $0.value }
        let addStatus = SecItemAdd(newItem as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            FileHandle.standardError.write(Data("Keychain add failed with status \(addStatus).\n".utf8))
            exit(66)
        }
    } else if updateStatus != errSecSuccess {
        FileHandle.standardError.write(Data("Keychain update failed with status \(updateStatus).\n".utf8))
        exit(67)
    }
    print("Stored the Sticky Pad tunnel credential in macOS Keychain.")

case "read":
    var query = identity
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
        FileHandle.standardError.write(Data("Sticky Pad tunnel credential is unavailable.\n".utf8))
        exit(68)
    }
    guard status == errSecSuccess, let secret = result as? Data, !secret.isEmpty else {
        FileHandle.standardError.write(Data("Keychain read failed with status \(status).\n".utf8))
        exit(70)
    }
    FileHandle.standardOutput.write(secret)

case "delete":
    let status = SecItemDelete(identity as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        FileHandle.standardError.write(Data("Keychain delete failed with status \(status).\n".utf8))
        exit(69)
    }

default:
    FileHandle.standardError.write(Data("Operation must be store, read, or delete.\n".utf8))
    exit(64)
}
