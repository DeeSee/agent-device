import XCTest
import AgentDeviceSnapshotPresentation

struct SystemModalElementFacts {
  let type: XCUIElement.ElementType
  let label: String
  let identifier: String
  let frame: CGRect
  let enabled: Bool
}

enum SystemModalElementPolicy {
  static func isActionCandidate(
    _ facts: SystemModalElementFacts,
    actionableTypes: Set<XCUIElement.ElementType>
  ) -> Bool {
    actionableTypes.contains(facts.type) && !facts.frame.isNull && !facts.frame.isEmpty
  }

  static func isInformative(
    _ facts: SystemModalElementFacts,
    readableTypes: Set<XCUIElement.ElementType>
  ) -> Bool {
    readableTypes.contains(facts.type) &&
      !facts.frame.isNull &&
      !facts.frame.isEmpty &&
      !facts.label.isEmpty
  }

  static func preferredTitle(_ facts: SystemModalElementFacts) -> String {
    if !facts.label.isEmpty { return facts.label }
    if !facts.identifier.isEmpty { return facts.identifier }
    return "System Alert"
  }

  static func actionKey(_ facts: SystemModalElementFacts) -> String {
    "\(facts.type.rawValue)-\(facts.frame.origin.x)-\(facts.frame.origin.y)-\(facts.frame.size.width)-\(facts.frame.size.height)-\(facts.label)"
  }

  static func contentKey(_ facts: SystemModalElementFacts) -> String {
    "\(actionKey(facts))-\(facts.identifier)"
  }
}

extension RunnerTests {
  // MARK: - Blocking System Modal Snapshot

  func blockingSystemAlertSnapshot(deadline: Date = .distantFuture) -> DataPayload? {
    #if os(macOS)
      return nil
    #else
    guard case .resolved(let resolvedModal) = resolveBlockingSystemModal(deadline: deadline) else {
      return nil
    }
    let modalNode = makeSystemModalSnapshotNode(
      facts: resolvedModal.rootFacts,
      index: 0,
      type: "Alert",
      labelOverride: SystemModalElementPolicy.preferredTitle(resolvedModal.rootFacts),
      depth: 0,
      hittableOverride: true
    )
    var nodes: [PresentedNode] = [modalNode]

    for action in resolvedModal.actions {
      let actionNode = makeSystemModalSnapshotNode(
        facts: action.facts,
        index: nodes.count,
        type: elementTypeName(action.facts.type),
        depth: 1,
        parentIndex: 0,
        hittableOverride: true
      )
      nodes.append(actionNode)
    }

    for content in informativeSystemModalFacts(
      in: resolvedModal.root,
      deadline: deadline
    ) {
      let contentNode = makeSystemModalSnapshotNode(
        facts: content,
        index: nodes.count,
        type: elementTypeName(content.type),
        depth: 1,
        parentIndex: 0,
        hittableOverride: false
      )
      nodes.append(contentNode)
    }

    return DataPayload(nodes: nodes, truncated: false)
    #endif
  }

  func firstBlockingSystemModal(
    in springboard: XCUIApplication,
    deadline: Date = .distantFuture
  ) -> XCUIElement? {
    let alerts = safeElementsQuery {
      springboard.alerts.allElementsBoundByIndex
    }
    for alert in alerts {
      if safeIsBlockingSystemModal(alert, in: springboard) {
        return alert
      }
    }

    // Don't start the second (sheet) enumeration once the shared probe deadline is spent (#1244).
    if Date() >= deadline {
      NSLog("AGENT_DEVICE_RUNNER_SYSTEM_MODAL_PROBE_DEADLINE stage=sheets")
      return nil
    }

    let sheets = safeElementsQuery {
      springboard.sheets.allElementsBoundByIndex
    }
    for sheet in sheets {
      if safeIsBlockingSystemModal(sheet, in: springboard) {
        return sheet
      }
    }

    return nil
  }

  func safeElementsQuery(_ fetch: () -> [XCUIElement]) -> [XCUIElement] {
    safely("MODAL_QUERY", [], fetch)
  }

  func materializeBlockingSystemModal(
    root: XCUIElement,
    ownerApp: XCUIApplication,
    deadline: Date
  ) -> ResolvedBlockingSystemModal? {
    guard let rootFacts = safeSystemModalElementFacts(root) else { return nil }

    let candidates = materializedSystemModalElements(
      in: root,
      matching: actionableTypes,
      deadline: deadline
    )

    var actionKeys = Set<String>()
    var actions: [ResolvedSystemModalAction] = []
    for candidate in candidates {
      let facts = candidate.facts
      if SystemModalElementPolicy.isActionCandidate(
        facts,
        actionableTypes: actionableTypes
      ) {
        let isHittable = safely("MODAL_ACTION", false) { candidate.element.isHittable }
        if isHittable {
          let key = SystemModalElementPolicy.actionKey(facts)
          if actionKeys.insert(key).inserted {
            actions.append(ResolvedSystemModalAction(element: candidate.element, facts: facts))
          }
        }
      }
    }

    return ResolvedBlockingSystemModal(
      root: root,
      rootFacts: rootFacts,
      ownerApp: ownerApp,
      actions: actions
    )
  }

  private func informativeSystemModalFacts(
    in root: XCUIElement,
    deadline: Date
  ) -> [SystemModalElementFacts] {
    let readableTypes = Set(readableSystemModalTypes)
    let predicateValues = readableTypes.map { NSNumber(value: $0.rawValue) }
    let predicate = NSPredicate(format: "elementType IN %@", predicateValues)
    let elements = safeElementsQuery {
      root.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
    }

    var keys = Set<String>()
    var counts: [XCUIElement.ElementType: Int] = [:]
    var facts: [SystemModalElementFacts] = []
    for element in elements {
      guard Date() < deadline else { break }
      guard facts.count < readableTypes.count * 2 else { break }
      let type = safely("MODAL_CONTENT_TYPE", XCUIElement.ElementType.any) {
        element.elementType
      }
      guard readableTypes.contains(type), counts[type, default: 0] < 2 else {
        continue
      }
      guard let candidate = safeSystemModalElementFacts(element),
            SystemModalElementPolicy.isInformative(
              candidate,
              readableTypes: readableTypes
            )
      else {
        continue
      }
      let key = SystemModalElementPolicy.contentKey(candidate)
      guard keys.insert(key).inserted else { continue }
      counts[candidate.type, default: 0] += 1
      facts.append(candidate)
    }
    return facts
  }

  private func materializedSystemModalElements(
    in root: XCUIElement,
    matching types: Set<XCUIElement.ElementType>,
    deadline: Date
  ) -> [(element: XCUIElement, facts: SystemModalElementFacts)] {
    let predicateValues = types.map { NSNumber(value: $0.rawValue) }
    let predicate = NSPredicate(format: "elementType IN %@", predicateValues)
    let elements = safeElementsQuery {
      root.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
    }

    var materialized: [(element: XCUIElement, facts: SystemModalElementFacts)] = []
    for element in elements {
      guard Date() < deadline else { break }
      guard let facts = safeSystemModalElementFacts(element) else { continue }
      materialized.append((element, facts))
    }
    return materialized
  }

  private func safeSystemModalElementFacts(_ element: XCUIElement) -> SystemModalElementFacts? {
    safely("MODAL_FACTS") {
      guard let snapshot = try? element.snapshot() else { return nil }
      return SystemModalElementFacts(
        type: snapshot.elementType,
        label: snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines),
        identifier: snapshot.identifier.trimmingCharacters(in: .whitespacesAndNewlines),
        frame: snapshot.frame,
        enabled: snapshot.isEnabled
      )
    }
  }

  private func safeIsBlockingSystemModal(_ element: XCUIElement, in springboard: XCUIApplication) -> Bool {
    safely("MODAL_CHECK", false) { isBlockingSystemModal(element, in: springboard) }
  }

  private func isBlockingSystemModal(_ element: XCUIElement, in springboard: XCUIApplication) -> Bool {
    guard element.exists else { return false }
    let frame = element.frame
    if frame.isNull || frame.isEmpty { return false }

    let viewport = springboard.frame
    if viewport.isNull || viewport.isEmpty { return false }

    let center = CGPoint(x: frame.midX, y: frame.midY)
    if !viewport.contains(center) { return false }

    return true
  }

  func actionableElements(in element: XCUIElement) -> [XCUIElement] {
    var seen = Set<String>()
    var actions: [XCUIElement] = []
    let descendants = actionableTypes.flatMap { modalDescendants(in: element, matching: $0) }
    for candidate in descendants {
      if !safeIsActionableCandidate(candidate, seen: &seen) { continue }
      actions.append(candidate)
    }
    return actions
  }

  private func safeIsActionableCandidate(_ candidate: XCUIElement, seen: inout Set<String>) -> Bool {
    safely("MODAL_ACTION", false) {
      if !candidate.exists || !candidate.isHittable { return false }
      if !actionableTypes.contains(candidate.elementType) { return false }
      let frame = candidate.frame
      if frame.isNull || frame.isEmpty { return false }
      let key = "\(candidate.elementType.rawValue)-\(frame.origin.x)-\(frame.origin.y)-\(frame.size.width)-\(frame.size.height)-\(candidate.label)"
      if seen.contains(key) { return false }
      seen.insert(key)
      return true
    }
  }

  private var readableSystemModalTypes: [XCUIElement.ElementType] {
    [.staticText, .textView]
  }

  private func modalDescendants(
    in element: XCUIElement,
    matching type: XCUIElement.ElementType,
    limit: Int? = nil
  ) -> [XCUIElement] {
    let elements = safeElementsQuery {
      element.descendants(matching: type).allElementsBoundByIndex
    }
    guard let limit else {
      return elements
    }
    return Array(elements.prefix(limit))
  }

  private func makeSystemModalSnapshotNode(
    facts: SystemModalElementFacts,
    index: Int,
    type: String,
    labelOverride: String? = nil,
    depth: Int,
    parentIndex: Int? = nil,
    hittableOverride: Bool? = nil
  ) -> PresentedNode {
    let label = labelOverride ?? facts.label
    return SnapshotPresentation.singleElementRead(
      RawAXNode(
        index: index,
        type: type,
        label: label.isEmpty ? nil : label,
        identifier: facts.identifier.isEmpty ? nil : facts.identifier,
        value: nil,
        rect: SnapshotRect(facts.frame),
        enabled: facts.enabled,
        focused: nil,
        selected: nil,
        hittable: hittableOverride ?? false,
        depth: depth,
        parentIndex: parentIndex,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    )
  }

}

