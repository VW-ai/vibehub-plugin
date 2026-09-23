import Foundation
import Security

// No secret is ever written to stdout/stderr or accepted in argv. Descriptor 3
// is an inherited private pipe to the parent runtime, only used by `read`.
func reply(_ state: String) -> Never {
    FileHandle.standardOutput.write(Data(("{\"state\":\"" + state + "\"}\n").utf8))
    exit(0)
}
SecKeychainSetUserInteractionAllowed(false)
let data = FileHandle.standardInput.readDataToEndOfFile()
guard data.count <= 16384,
      let input = try? JSONSerialization.jsonObject(with: data) as? [String: String],
      let op = input["operation"], ["put", "remove", "status", "read"].contains(op),
      let ref = input["reference"],
      ref.range(of: "^vhcred_[a-f0-9]{64}$", options: .regularExpression) != nil
else { reply("error") }
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "team.vibehub.semantic-runtime.providers.v0",
    kSecAttrAccount as String: ref,
    kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
]
func status(_ code: OSStatus) -> Never {
    if code == errSecSuccess { reply("configured") }
    if code == errSecItemNotFound { reply("missing") }
    reply("error")
}
if op == "put" {
    guard let secret = input["secret"], !secret.isEmpty, secret.utf8.count <= 8192,
          !secret.contains("\n"), !secret.contains("\r"), !secret.contains("\0") else { reply("error") }
    let value = Data(secret.utf8)
    let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: value] as CFDictionary)
    if update == errSecItemNotFound {
        var add = query
        add[kSecValueData as String] = value
        status(SecItemAdd(add as CFDictionary, nil))
    }
    status(update)
}
if op == "remove" {
    let result = SecItemDelete(query as CFDictionary)
    if result == errSecSuccess || result == errSecItemNotFound { reply("missing") }
    reply("error")
}
var lookup = query
lookup[kSecMatchLimit as String] = kSecMatchLimitOne
lookup[kSecReturnData as String] = op == "read"
var item: CFTypeRef?
let result = SecItemCopyMatching(lookup as CFDictionary, &item)
if result == errSecSuccess && op == "read" {
    guard let secret = item as? Data, secret.count <= 8192 else { reply("error") }
    FileHandle(fileDescriptor: 3, closeOnDealloc: true).write(secret)
}
status(result)
