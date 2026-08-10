import Foundation
import WorkbenchRepositorySession

/// Rewrites the one authorized session URL to address a Ticket and inspector
/// layer, using the only URL contract the shared frontend has:
/// `?ticket=<id>&view=<execution|contract|log>`.
///
/// The shell adds no parameter of its own and forks no frontend. Pan/zoom is
/// deliberately absent: the frontend keeps the viewport closure-local and
/// exposes no viewport contract, so a deep link addresses a Ticket and a layer
/// and honestly claims nothing about where the graph is scrolled.
///
/// The bearer token lives in the base URL's fragment and is carried across
/// unchanged; it is never logged, printed, or persisted.
public enum FocusedSessionURL {
  public static func make(base: URL, ticket: String?, view: InspectorTab?) -> URL {
    guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
      return base
    }
    if let ticket, isCanonicalTicketId(ticket) {
      components.queryItems = [
        URLQueryItem(name: "ticket", value: ticket),
        URLQueryItem(name: "view", value: (view ?? .execution).rawValue),
      ]
    } else {
      components.queryItems = nil
    }
    if components.path.isEmpty { components.path = "/" }
    return components.url ?? base
  }
}

extension HostSessionReady {
  /// This session's authorized URL, addressed at a Ticket and layer.
  public func focusedURL(ticket: String?, view: InspectorTab?) -> URL {
    FocusedSessionURL.make(base: authorizedURL, ticket: ticket, view: view)
  }
}
