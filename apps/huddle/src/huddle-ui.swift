import AppKit
import AVFoundation
import Foundation

struct HuddleCommand: Decodable {
  let requestId: String
  let mode: String
  let title: String
  let promptPreview: String
  let ringSoundPath: String?
  let recordingPath: String?
  let maxRecordingSeconds: Int?
  let transcriptText: String?

  var screenMode: HuddleMode? {
    HuddleMode(rawValue: mode)
  }
}

struct HuddleResponse: Encodable {
  let requestId: String
  let mode: String
  let status: String
  let audioPath: String?
  let transcriptText: String?
  let keepConversationOpen: Bool?
  let submitTranscriptDirectly: Bool?
}

struct HuddleRuntimeConfig {
  let conversationId: String
  let conversationDirectory: URL

  var requestsDirectory: URL {
    conversationDirectory.appendingPathComponent("requests", isDirectory: true)
  }

  var responsesDirectory: URL {
    conversationDirectory.appendingPathComponent("responses", isDirectory: true)
  }

  var readyMarker: URL {
    conversationDirectory.appendingPathComponent("ready", isDirectory: false)
  }

  var closedMarker: URL {
    conversationDirectory.appendingPathComponent("closed", isDirectory: false)
  }
}

enum HuddleError: Error, LocalizedError {
  case microphoneDenied
  case recorderStartFailed

  var errorDescription: String? {
    switch self {
    case .microphoneDenied:
      return "Microphone access is required to record a huddle."
    case .recorderStartFailed:
      return "The huddle recorder could not start."
    }
  }
}

enum LaunchConfigurationError: Error, LocalizedError {
  case missingArgument(String)

  var errorDescription: String? {
    switch self {
    case let .missingArgument(flag):
      return "Missing required argument: \(flag)"
    }
  }
}

enum ConversationSpeaker {
  case agent
  case user
}

struct ConversationMessage {
  let speaker: ConversationSpeaker
  let text: String
}

enum HuddleMode: String {
  case idle
  case invite
  case speaking
  case record
  case transcribing
  case review
  case close
  case standby
  case terminate
}

enum WaveformMode {
  case idle
  case speaking
  case recording
}

enum ButtonEmphasis {
  case filled
  case outline
}

enum ButtonTone {
  case accent
  case positive
  case neutral
  case destructive
}

enum ButtonStyle {
  case standard(tone: ButtonTone, emphasis: ButtonEmphasis)
  case custom(
    backgroundColor: NSColor,
    borderColor: NSColor,
    foregroundColor: NSColor,
    shortcutColor: NSColor,
    cornerRadius: CGFloat
  )
}

struct ButtonConfig {
  let title: String
  let style: ButtonStyle
  var symbolName: String? = nil
  var symbolTintColor: NSColor? = nil
  var isEnabled: Bool = true
}

enum FocusTarget {
  case none
  case editor
}

struct ScreenConfig {
  let mode: HuddleMode
  let iconSymbolName: String
  let title: String
  var subtitle: String = ""
  let prompt: String
  var helper: String = ""
  let accentColor: NSColor
  var waveformMode: WaveformMode? = nil
  var primaryButton: ButtonConfig? = nil
  var secondaryButton: ButtonConfig? = nil
  var tertiaryButton: ButtonConfig? = nil
  var editorText: String? = nil
  var focusTarget: FocusTarget = .none
}

final class FlippedView: NSView {
  override var isFlipped: Bool {
    true
  }
}

final class HuddleUIController: NSObject, NSWindowDelegate {
  private let runtime: HuddleRuntimeConfig
  private let inviteTimeoutSeconds: TimeInterval = 45
  private let standbyTimeoutSeconds: TimeInterval = 45
  private let windowWidth: CGFloat = 500
  private let inviteWindowWidth: CGFloat = 430
  private let cardInset: CGFloat = 10
  private let cardWidth: CGFloat = 480
  private let inviteCardWidth: CGFloat = 410
  private let textLeft: CGFloat = 28
  private let textWidth: CGFloat = 424
  private let dualButtonWidth: CGFloat = 178
  private let tripleButtonWidth: CGFloat = 140
  private let buttonHeight: CGFloat = 42
  private let inviteButtonHeight: CGFloat = 50
  private let buttonGap: CGFloat = 10
  private let titleHeight: CGFloat = 24
  private let subtitleHeight: CGFloat = 18
  private let helperHeight: CGFloat = 18
  private let waveformHeight: CGFloat = 20
  private let inlineWaveformWidth: CGFloat = 74
  private let recordingWaveformWidth: CGFloat = 128
  private let waveformBubbleGap: CGFloat = 12
  private let recordingBubbleHeight: CGFloat = 52
  private let editorMinHeight: CGFloat = 138
  private let editorMaxHeight: CGFloat = 220
  private let iconSize: CGFloat = 28
  private let topPadding: CGFloat = 28
  private let bottomPadding: CGFloat = 22
  private let inviteBottomPadding: CGFloat = 0
  private let inviteButtonInset: CGFloat = 0
  private let titleSubtitleGap: CGFloat = 8
  private let subtitlePromptGap: CGFloat = 18
  private let promptHelperGap: CGFloat = 18
  private let helperControlsGap: CGFloat = 18
  private let waveformButtonsGap: CGFloat = 14
  private let reviewSectionGap: CGFloat = 18
  private let reviewPromptBubbleWidth: CGFloat = 288
  private let reviewEditorBubbleWidth: CGFloat = 324
  private let promptBubbleWidth: CGFloat = 336
  private let reviewBubbleHorizontalPadding: CGFloat = 14
  private let reviewBubbleVerticalPadding: CGFloat = 12
  private let historyRowGap: CGFloat = 14
  private let historyMaxHeight: CGFloat = 188
  private let window: NSWindow
  private let cardView = NSView(frame: .zero)
  private let iconView = NSImageView(frame: .zero)
  private let titleLabel = NSTextField(labelWithString: "")
  private let subtitleLabel = NSTextField(labelWithString: "")
  private let promptLabel = NSTextField(labelWithString: "")
  private let reviewPromptBubbleView = NSView(frame: .zero)
  private let reviewPromptLabel = NSTextField(wrappingLabelWithString: "")
  private let recordingBubbleView = NSView(frame: .zero)
  private let helperLabel = NSTextField(labelWithString: "")
  private let primaryButton = NSButton(title: "", target: nil, action: nil)
  private let secondaryButton = NSButton(title: "", target: nil, action: nil)
  private let tertiaryButton = NSButton(title: "", target: nil, action: nil)
  private let waveformContainer = NSView(frame: .zero)
  private let historyScrollView = NSScrollView(frame: .zero)
  private let historyContentView = FlippedView(frame: .zero)
  private let editorScrollView = NSScrollView(frame: .zero)
  private let editorView = NSTextView(frame: .zero)
  private var waveformBars: [NSView] = []
  private var waveformTimer: Timer?
  private var commandPollTimer: Timer?
  private var currentCommand: HuddleCommand?
  private var currentMode: HuddleMode = .idle
  private var recorder: AVAudioRecorder?
  private var ringPlayer: AVAudioPlayer?
  private var timeoutTimer: Timer?
  private var keyMonitor: Any?
  private var isClosing = false
  private var conversationHistory: [ConversationMessage] = []
  private var conversationHistoryDirty = true
  private var cachedHistoryContentHeight: CGFloat = 0

  init(runtime: HuddleRuntimeConfig) {
    self.runtime = runtime
    let frame = NSRect(x: 0, y: 0, width: windowWidth, height: 278)
    window = NSWindow(
      contentRect: frame,
      styleMask: [.titled, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    super.init()
    buildWindow(frame: frame)
  }

  func start() {
    prepareRuntimeFiles()
    startCommandPolling()
    installKeyMonitor()
    NSApplication.shared.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  func windowWillClose(_ notification: Notification) {
    closeApplication()
  }

  private func buildWindow(frame: NSRect) {
    window.center()
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isMovableByWindowBackground = true
    window.isOpaque = false
    window.backgroundColor = .clear
    window.level = .floating
    window.delegate = self
    window.standardWindowButton(.closeButton)?.isHidden = true
    window.standardWindowButton(.miniaturizeButton)?.isHidden = true
    window.standardWindowButton(.zoomButton)?.isHidden = true

    let rootView = NSView(frame: frame)
    rootView.wantsLayer = true
    rootView.layer?.backgroundColor = NSColor.clear.cgColor
    window.contentView = rootView

    cardView.frame = NSRect(x: cardInset, y: cardInset, width: cardWidth, height: 258)
    cardView.wantsLayer = true
    cardView.layer?.backgroundColor = NSColor(calibratedWhite: 0.98, alpha: 1).cgColor
    cardView.layer?.cornerRadius = 24
    cardView.layer?.masksToBounds = true
    cardView.layer?.borderWidth = 1
    cardView.layer?.borderColor = NSColor(calibratedWhite: 0.9, alpha: 1).cgColor
    rootView.addSubview(cardView)

    iconView.frame = NSRect(x: 28, y: 200, width: 28, height: 28)
    iconView.contentTintColor = NSColor.systemBlue
    cardView.addSubview(iconView)

    titleLabel.frame = NSRect(x: 72, y: 202, width: 380, height: 24)
    titleLabel.font = .systemFont(ofSize: 22, weight: .semibold)
    titleLabel.textColor = NSColor(calibratedWhite: 0.08, alpha: 1)
    cardView.addSubview(titleLabel)

    subtitleLabel.frame = NSRect(x: 72, y: 178, width: 380, height: 18)
    subtitleLabel.font = .systemFont(ofSize: 12, weight: .medium)
    subtitleLabel.textColor = NSColor.systemBlue
    cardView.addSubview(subtitleLabel)

    promptLabel.frame = NSRect(x: textLeft, y: 108, width: textWidth, height: 58)
    promptLabel.font = .systemFont(ofSize: 14, weight: .regular)
    promptLabel.textColor = NSColor(calibratedWhite: 0.15, alpha: 1)
    promptLabel.lineBreakMode = .byWordWrapping
    promptLabel.maximumNumberOfLines = 0
    cardView.addSubview(promptLabel)

    reviewPromptBubbleView.wantsLayer = true
    reviewPromptBubbleView.layer?.cornerRadius = 18
    reviewPromptBubbleView.layer?.masksToBounds = true
    reviewPromptBubbleView.layer?.borderWidth = 1
    reviewPromptBubbleView.isHidden = true
    cardView.addSubview(reviewPromptBubbleView)

    reviewPromptLabel.font = .systemFont(ofSize: 14, weight: .regular)
    reviewPromptLabel.textColor = NSColor(calibratedWhite: 0.15, alpha: 1)
    reviewPromptLabel.lineBreakMode = .byWordWrapping
    reviewPromptLabel.maximumNumberOfLines = 0
    reviewPromptBubbleView.addSubview(reviewPromptLabel)

    recordingBubbleView.wantsLayer = true
    recordingBubbleView.layer?.cornerRadius = 20
    recordingBubbleView.layer?.masksToBounds = true
    recordingBubbleView.layer?.borderWidth = 1
    recordingBubbleView.isHidden = true
    cardView.addSubview(recordingBubbleView)

    helperLabel.frame = NSRect(x: textLeft, y: 82, width: textWidth, height: 18)
    helperLabel.font = .systemFont(ofSize: 12, weight: .regular)
    helperLabel.textColor = .secondaryLabelColor
    cardView.addSubview(helperLabel)

    waveformContainer.frame = NSRect(x: textLeft, y: 30, width: 110, height: 20)
    cardView.addSubview(waveformContainer)
    buildWaveform()

    historyScrollView.borderType = .noBorder
    historyScrollView.hasVerticalScroller = true
    historyScrollView.drawsBackground = false
    historyScrollView.isHidden = true
    historyScrollView.documentView = historyContentView
    cardView.addSubview(historyScrollView)

    editorScrollView.borderType = .noBorder
    editorScrollView.hasVerticalScroller = true
    editorScrollView.drawsBackground = false
    editorScrollView.isHidden = true
    editorScrollView.wantsLayer = true
    editorScrollView.layer?.cornerRadius = 14
    editorScrollView.layer?.borderWidth = 1
    editorScrollView.layer?.borderColor = NSColor.systemBlue.withAlphaComponent(0.18).cgColor
    editorScrollView.layer?.backgroundColor = NSColor.white.cgColor

    editorView.minSize = NSSize(width: 0, height: editorMinHeight)
    editorView.maxSize = NSSize(width: textWidth, height: .greatestFiniteMagnitude)
    editorView.isVerticallyResizable = true
    editorView.isHorizontallyResizable = false
    editorView.autoresizingMask = [.width]
    editorView.drawsBackground = false
    editorView.font = .systemFont(ofSize: 14, weight: .regular)
    editorView.textColor = NSColor(calibratedWhite: 0.12, alpha: 1)
    editorView.textContainerInset = NSSize(width: 8, height: 10)
    editorView.textContainer?.widthTracksTextView = true
    editorView.textContainer?.containerSize = NSSize(width: textWidth - 16, height: .greatestFiniteMagnitude)
    editorScrollView.documentView = editorView
    cardView.addSubview(editorScrollView)

    primaryButton.bezelStyle = .rounded
    primaryButton.isBordered = false
    primaryButton.font = .systemFont(ofSize: 13, weight: .semibold)
    primaryButton.target = self
    primaryButton.action = #selector(handlePrimaryAction)
    cardView.addSubview(primaryButton)

    secondaryButton.bezelStyle = .rounded
    secondaryButton.isBordered = false
    secondaryButton.font = .systemFont(ofSize: 13, weight: .semibold)
    secondaryButton.target = self
    secondaryButton.action = #selector(handleSecondaryAction)
    cardView.addSubview(secondaryButton)

    tertiaryButton.bezelStyle = .rounded
    tertiaryButton.isBordered = false
    tertiaryButton.font = .systemFont(ofSize: 13, weight: .semibold)
    tertiaryButton.target = self
    tertiaryButton.action = #selector(handleTertiaryAction)
    cardView.addSubview(tertiaryButton)

    applyIdleState()
  }

  private func buildWaveform() {
    waveformBars.forEach { $0.removeFromSuperview() }
    waveformBars = []

    for _ in 0..<5 {
      let bar = NSView(frame: .zero)
      bar.wantsLayer = true
      bar.layer?.cornerRadius = 4
      bar.layer?.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.35).cgColor
      waveformContainer.addSubview(bar)
      waveformBars.append(bar)
    }
  }

  private func clearTimeout() {
    timeoutTimer?.invalidate(); timeoutTimer = nil
  }

  private func scheduleTimeout(after interval: TimeInterval, selector: Selector) {
    clearTimeout()
    timeoutTimer = Timer.scheduledTimer(
      timeInterval: interval,
      target: self,
      selector: selector,
      userInfo: nil,
      repeats: false
    )
  }

  private func prepareRuntimeFiles() {
    try? FileManager.default.createDirectory(
      at: runtime.requestsDirectory,
      withIntermediateDirectories: true
    )
    try? FileManager.default.createDirectory(
      at: runtime.responsesDirectory,
      withIntermediateDirectories: true
    )
    try? FileManager.default.removeItem(at: runtime.closedMarker)
    FileManager.default.createFile(atPath: runtime.readyMarker.path, contents: Data())
  }

  private func startCommandPolling() {
    commandPollTimer?.invalidate()
    commandPollTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
      self?.consumeNextCommand()
    }
  }

  private func consumeNextCommand() {
    guard !isClosing else {
      return
    }

    let urls: [URL]
    do {
      urls = try FileManager.default.contentsOfDirectory(
        at: runtime.requestsDirectory,
        includingPropertiesForKeys: nil
      )
      .filter { $0.pathExtension == "json" }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
    } catch {
      return
    }

    guard let nextURL = urls.first else {
      return
    }

    let command: HuddleCommand
    do {
      let data = try Data(contentsOf: nextURL)
      command = try JSONDecoder().decode(HuddleCommand.self, from: data)
    } catch {
      try? FileManager.default.removeItem(at: nextURL)
      return
    }

    try? FileManager.default.removeItem(at: nextURL)
    handle(command: command)
  }

  private func installKeyMonitor() {
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
      guard let self else {
        return event
      }

      return self.handleKeyEvent(event) ? nil : event
    }
  }

  private func handleKeyEvent(_ event: NSEvent) -> Bool {
    let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    let characters = event.charactersIgnoringModifiers?.lowercased() ?? ""
    let isReturn = event.keyCode == 36 || event.keyCode == 76
    let isSpace = event.keyCode == 49

    switch currentMode {
    case .invite:
      if modifiers.isEmpty && characters == "a" {
        handlePrimaryAction()
        return true
      }

      if modifiers.isEmpty && characters == "d" {
        handleSecondaryAction()
        return true
      }
    case .record:
      if modifiers.isEmpty && isReturn {
        finishRecording(submitTranscriptDirectly: true)
        return true
      }

      if modifiers.isEmpty && isSpace {
        finishRecording(submitTranscriptDirectly: false)
        return true
      }
    case .speaking:
      if modifiers.isEmpty && isSpace {
        writeCurrentResponse(
          mode: "speaking",
          status: "accepted"
        )
        return true
      }
    case .review:
      if modifiers.contains(.command) && modifiers.contains(.option) && isReturn {
        handleTertiaryAction()
        return true
      }

      if modifiers.contains(.command) && isReturn {
        handlePrimaryAction()
        return true
      }
    case .close:
      if modifiers.isEmpty && isReturn {
        handlePrimaryAction()
        return true
      }

      if modifiers.isEmpty && characters == "k" {
        handleSecondaryAction()
        return true
      }
    default:
      break
    }

    return false
  }

  private func handle(command: HuddleCommand) {
    currentCommand = command
    NSApplication.shared.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)

    switch command.screenMode {
    case .invite:
      configureInvite(command)
    case .speaking:
      showCommandScreen(.speaking, command: command)
    case .record:
      do {
        try configureRecording(command)
      } catch {
        writeCurrentResponse(
          mode: "record",
          status: "cancelled"
        )
        closeApplication()
      }
    case .transcribing:
      showCommandScreen(.transcribing, command: command)
    case .review:
      showCommandScreen(.review, command: command)
    case .close:
      showCommandScreen(.close, command: command)
    case .terminate:
      closeApplication()
    default:
      closeApplication()
    }
  }

  private func configureInvite(_ command: HuddleCommand) {
    clearTimeout()
    stopRingSound()
    playRingSound(customPath: command.ringSoundPath)
    applyScreenConfig(screenConfig(for: .invite, command: command))
    scheduleTimeout(after: inviteTimeoutSeconds, selector: #selector(handleInviteTimeout))
  }

  private func configureRecording(_ command: HuddleCommand) throws {
    stopRingSound()
    applyScreenConfig(screenConfig(for: .record, command: command))
    try startRecording(command: command)
  }

  private func configureStandby() {
    scheduleTimeout(after: standbyTimeoutSeconds, selector: #selector(handleStandbyTimeout))
    stopRingSound()
    applyScreenConfig(screenConfig(for: .standby))
  }

  private func applyIdleState() {
    clearTimeout()
    applyScreenConfig(screenConfig(for: .idle))
  }

  private func showCommandScreen(_ mode: HuddleMode, command: HuddleCommand) {
    clearTimeout()
    stopRingSound()
    applyScreenConfig(screenConfig(for: mode, command: command))
  }

  private func screenConfig(for mode: HuddleMode, command: HuddleCommand? = nil) -> ScreenConfig {
    let prompt = command?.promptPreview ?? ""

    switch mode {
    case .invite:
      return ScreenConfig(
        mode: .invite,
        iconSymbolName: "phone.fill",
        title: "Incoming huddle",
        prompt: prompt,
        accentColor: .systemBlue,
        primaryButton: inviteButton("Join Huddle (A)", color: .systemGreen, symbolName: "phone.fill"),
        secondaryButton: inviteButton("Decline (D)", color: .systemRed, symbolName: "phone.down.fill")
      )
    case .speaking:
      return ScreenConfig(
        mode: .speaking,
        iconSymbolName: "speaker.wave.2.fill",
        title: "Codex is talking",
        prompt: prompt,
        helper: "Press Space to skip ahead and respond.",
        accentColor: .systemBlue,
        waveformMode: .speaking
      )
    case .record:
      return ScreenConfig(
        mode: .record,
        iconSymbolName: "mic.fill",
        title: "Your turn",
        prompt: prompt,
        helper: "Space reviews. Enter sends immediately.",
        accentColor: .systemRed,
        waveformMode: .recording,
        primaryButton: standardButton("Review (Space)", tone: .accent, emphasis: .outline),
        secondaryButton: standardButton("Cancel", tone: .neutral, emphasis: .outline),
        tertiaryButton: standardButton("Send (↩)", tone: .positive, emphasis: .filled)
      )
    case .transcribing:
      return ScreenConfig(
        mode: .transcribing,
        iconSymbolName: "waveform.and.magnifyingglass",
        title: "Transcribing answer",
        prompt: prompt,
        helper: "This only takes a moment.",
        accentColor: .systemBlue,
        waveformMode: .speaking
      )
    case .review:
      return ScreenConfig(
        mode: .review,
        iconSymbolName: "text.bubble.fill",
        title: "Review transcript",
        prompt: prompt,
        helper: "Command-Enter sends. Enter adds a new line.",
        accentColor: .systemBlue,
        waveformMode: .idle,
        primaryButton: standardButton("Send (⌘↩)", tone: .positive, emphasis: .filled),
        secondaryButton: standardButton("Cancel", tone: .neutral, emphasis: .outline),
        tertiaryButton: standardButton("Keep Open (⌘⌥↩)", tone: .accent, emphasis: .outline),
        editorText: command?.transcriptText ?? "",
        focusTarget: .editor
      )
    case .close:
      return ScreenConfig(
        mode: .close,
        iconSymbolName: "phone.down.circle.fill",
        title: "Close conversation?",
        prompt: prompt.isEmpty ? "Codex asked to close this huddle conversation." : prompt,
        helper: "Only close if you are done. Keep it open to wait for a follow-up.",
        accentColor: .systemOrange,
        primaryButton: standardButton("Close (↩)", tone: .destructive, emphasis: .filled),
        secondaryButton: standardButton("Keep Open (K)", tone: .accent, emphasis: .outline)
      )
    case .standby:
      return ScreenConfig(
        mode: .standby,
        iconSymbolName: "phone.connection.fill",
        title: "Conversation open",
        subtitle: "Conversation \(runtime.conversationId)",
        prompt: "Waiting for the agent to respond in this conversation.",
        helper:
          "The existing window will answer automatically when that follow-up arrives, then close after 45 seconds of no follow-up.",
        accentColor: .systemBlue,
        primaryButton: standardButton("Hang Up", tone: .neutral, emphasis: .outline)
      )
    case .idle:
      return ScreenConfig(
        mode: .idle,
        iconSymbolName: "phone.fill",
        title: "Codex Huddle",
        prompt: "",
        accentColor: .systemBlue
      )
    case .terminate:
      fatalError("Terminate mode should close the application before rendering")
    }
  }

  private func standardButton(
    _ title: String,
    tone: ButtonTone,
    emphasis: ButtonEmphasis
  ) -> ButtonConfig {
    ButtonConfig(title: title, style: .standard(tone: tone, emphasis: emphasis))
  }

  private func inviteButton(_ title: String, color: NSColor, symbolName: String) -> ButtonConfig {
    ButtonConfig(
      title: title,
      style: .custom(
        backgroundColor: color.withAlphaComponent(0.96),
        borderColor: color.withAlphaComponent(0.96),
        foregroundColor: .white,
        shortcutColor: NSColor.white.withAlphaComponent(0.76),
        cornerRadius: 0
      ),
      symbolName: symbolName,
      symbolTintColor: .white
    )
  }

  private func applyScreenConfig(_ config: ScreenConfig) {
    currentMode = config.mode
    setIcon(symbolName: config.iconSymbolName)
    titleLabel.stringValue = config.title
    subtitleLabel.stringValue = config.subtitle
    promptLabel.stringValue = config.prompt
    reviewPromptLabel.stringValue = config.prompt
    helperLabel.stringValue = config.helper
    configureButton(primaryButton, with: config.primaryButton)
    configureButton(secondaryButton, with: config.secondaryButton)
    configureButton(tertiaryButton, with: config.tertiaryButton)
    if config.mode == .review {
      editorView.string = config.editorText ?? ""
    }
    applyAccentColor(config.accentColor)
    layoutContent()
    updateWaveform(config.waveformMode)
    switch config.focusTarget {
    case .editor:
      window.makeFirstResponder(editorView)
    case .none:
      window.makeFirstResponder(nil)
    }
  }

  private func configureButton(_ button: NSButton, with config: ButtonConfig?) {
    guard let config else {
      button.isHidden = true
      button.isEnabled = false
      button.title = ""
      clearButtonSymbol(button)
      return
    }

    button.isHidden = false
    button.isEnabled = config.isEnabled
    button.title = config.title
    if let symbolName = config.symbolName, let symbolTintColor = config.symbolTintColor {
      setButtonSymbol(button, symbolName: symbolName, tintColor: symbolTintColor)
    } else {
      clearButtonSymbol(button)
    }
    styleButton(button, using: config.style)
  }

  private func styleButton(_ button: NSButton, using style: ButtonStyle) {
    switch style {
    case let .standard(tone, emphasis):
      styleActionButton(button, tone: tone, emphasis: emphasis)
    case let .custom(backgroundColor, borderColor, foregroundColor, shortcutColor, cornerRadius):
      styleCustomActionButton(
        button,
        backgroundColor: backgroundColor,
        borderColor: borderColor,
        foregroundColor: foregroundColor,
        shortcutColor: shortcutColor,
        cornerRadius: cornerRadius
      )
    }
  }

  private func updateWaveform(_ mode: WaveformMode?) {
    guard let mode else { stopWaveform(); return }
    startWaveform(mode: mode)
  }

  private func setIcon(symbolName: String) {
    iconView.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: symbolName)
  }

  private func setButtonSymbol(_ button: NSButton, symbolName: String, tintColor: NSColor) {
    let configuration = NSImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
    let image = NSImage(
      systemSymbolName: symbolName,
      accessibilityDescription: symbolName
    )?.withSymbolConfiguration(configuration)
    image?.isTemplate = true
    button.image = image
    button.contentTintColor = tintColor
    button.imagePosition = .imageLeading
    button.imageScaling = .scaleProportionallyDown
    button.imageHugsTitle = true
  }

  private func clearButtonSymbol(_ button: NSButton) {
    button.image = nil
    button.contentTintColor = nil
    button.imagePosition = .noImage
  }

  private func applyAccentColor(_ color: NSColor) {
    iconView.contentTintColor = color
    subtitleLabel.textColor = color
    editorScrollView.layer?.borderColor = color.withAlphaComponent(0.18).cgColor
    styleConversationViews(accentColor: color)
  }

  private func styleConversationViews(accentColor: NSColor) {
    reviewPromptBubbleView.layer?.backgroundColor = NSColor.white.cgColor
    reviewPromptBubbleView.layer?.borderColor = NSColor(calibratedWhite: 0.84, alpha: 1).cgColor
    editorScrollView.layer?.cornerRadius = 20
    editorScrollView.layer?.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.08).cgColor
    editorScrollView.layer?.borderColor = NSColor.systemBlue.withAlphaComponent(0.24).cgColor
    recordingBubbleView.layer?.backgroundColor = accentColor.withAlphaComponent(0.08).cgColor
    recordingBubbleView.layer?.borderColor = accentColor.withAlphaComponent(0.24).cgColor
  }

  private func resolveButtonToneColor(_ tone: ButtonTone) -> NSColor {
    switch tone {
    case .accent:
      return .systemBlue
    case .positive:
      return .systemGreen
    case .neutral:
      return NSColor(calibratedWhite: 0.48, alpha: 1)
    case .destructive:
      return .systemRed
    }
  }

  private func styleActionButton(
    _ button: NSButton,
    tone: ButtonTone,
    emphasis: ButtonEmphasis
  ) {
    button.wantsLayer = true
    button.layer?.cornerRadius = 14
    button.layer?.masksToBounds = true
    button.focusRingType = .none

    let toneColor = resolveButtonToneColor(tone)

    let foregroundColor: NSColor
    let shortcutColor: NSColor

    switch emphasis {
    case .filled:
      if tone == .neutral {
        button.layer?.backgroundColor = NSColor(calibratedWhite: 0.93, alpha: 1).cgColor
        button.layer?.borderColor = NSColor(calibratedWhite: 0.84, alpha: 1).cgColor
        foregroundColor = NSColor(calibratedWhite: 0.28, alpha: 1)
        shortcutColor = NSColor(calibratedWhite: 0.45, alpha: 1)
      } else {
        button.layer?.backgroundColor = toneColor.cgColor
        button.layer?.borderColor = toneColor.cgColor
        foregroundColor = .white
        shortcutColor = NSColor.white.withAlphaComponent(0.76)
      }
      button.layer?.borderWidth = 1
    case .outline:
      button.layer?.backgroundColor = NSColor.white.cgColor
      button.layer?.borderColor = toneColor.withAlphaComponent(0.32).cgColor
      button.layer?.borderWidth = 1
      foregroundColor = toneColor
      shortcutColor = toneColor.withAlphaComponent(0.6)
    }

    button.attributedTitle = styledButtonTitle(
      button.title,
      foregroundColor: foregroundColor,
      shortcutColor: shortcutColor
    )
    button.alphaValue = button.isEnabled ? 1.0 : 0.6
  }

  private func styleCustomActionButton(
    _ button: NSButton,
    backgroundColor: NSColor,
    borderColor: NSColor,
    foregroundColor: NSColor,
    shortcutColor: NSColor,
    cornerRadius: CGFloat
  ) {
    button.wantsLayer = true
    button.layer?.cornerRadius = cornerRadius
    button.layer?.masksToBounds = true
    button.focusRingType = .none
    button.layer?.backgroundColor = backgroundColor.cgColor
    button.layer?.borderColor = borderColor.cgColor
    button.layer?.borderWidth = 1
    button.attributedTitle = styledButtonTitle(
      button.title,
      foregroundColor: foregroundColor,
      shortcutColor: shortcutColor
    )
    button.alphaValue = button.isEnabled ? 1.0 : 0.6
  }

  private func styledButtonTitle(
    _ title: String,
    foregroundColor: NSColor,
    shortcutColor: NSColor
  ) -> NSAttributedString {
    let attributed = NSMutableAttributedString(
      string: title,
      attributes: [
        .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
        .foregroundColor: foregroundColor
      ]
    )

    if let shortcutRange = title.range(of: "\\s*\\([^)]+\\)$", options: .regularExpression) {
      attributed.addAttributes(
        [
          .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium),
          .foregroundColor: shortcutColor
        ],
        range: NSRange(shortcutRange, in: title)
      )
    }

    return attributed
  }

  private func playRingSound(customPath: String?) {
    if let customPath {
      if startRingPlayer(at: URL(fileURLWithPath: customPath)) {
        return
      }
    }

    let fallbackPaths = [
      "/System/Library/Sounds/Submarine.aiff",
      "/System/Library/Sounds/Glass.aiff"
    ]

    for soundPath in fallbackPaths {
      if startRingPlayer(at: URL(fileURLWithPath: soundPath)) {
        return
      }
    }
  }

  private func stopRingSound() {
    ringPlayer?.stop()
    ringPlayer = nil
  }

  private func startRingPlayer(at url: URL) -> Bool {
    do {
      let player = try AVAudioPlayer(contentsOf: url)
      player.numberOfLoops = -1
      player.volume = 1.0
      player.prepareToPlay()
      guard player.play() else {
        return false
      }

      ringPlayer = player
      return true
    } catch {
      return false
    }
  }

  private func startWaveform(mode: WaveformMode) {
    waveformTimer?.invalidate()
    waveformTimer = Timer.scheduledTimer(withTimeInterval: 0.14, repeats: true) { [weak self] _ in
      self?.animateWaveform(mode: mode)
    }
    animateWaveform(mode: mode)
  }

  private func stopWaveform() {
    waveformTimer?.invalidate()
    waveformTimer = nil
    waveformContainer.isHidden = true
  }

  private func animateWaveform(mode: WaveformMode) {
    let baseColor: NSColor = mode == .recording ? .systemRed : .systemBlue
    let baseAlpha: CGFloat = mode == .idle ? 0.2 : 0.95
    let containerHeight = max(waveformContainer.bounds.height, waveformHeight)
    let containerWidth = max(waveformContainer.bounds.width, 40)
    let barWidth: CGFloat = 8
    let totalBarsWidth = CGFloat(waveformBars.count) * barWidth
    let spacing = waveformBars.count > 1
      ? max((containerWidth - totalBarsWidth) / CGFloat(waveformBars.count - 1), 6)
      : 0
    let ranges: [ClosedRange<CGFloat>] = {
      switch mode {
      case .speaking:
        return [8...18, 10...20, 6...16, 10...20, 8...18]
      case .recording:
        return [10...20, 12...22, 8...18, 12...22, 10...20]
      case .idle:
        return [8...10, 8...12, 8...10, 8...12, 8...10]
      }
    }()

    for (index, bar) in waveformBars.enumerated() {
      let height = CGFloat.random(in: ranges[index])
      let barX = CGFloat(index) * (barWidth + spacing)
      bar.animator().frame = NSRect(
        x: barX,
        y: max((containerHeight - height) / 2, 0),
        width: barWidth,
        height: height
      )
      bar.layer?.backgroundColor = baseColor.withAlphaComponent(baseAlpha).cgColor
    }
  }

  private func layoutContent() {
    let bottomY = currentActionBottomPadding()
    let buttonTop = bottomY + currentActionButtonHeight()
    let cardWidth = currentCardWidth()
    let windowWidth = currentWindowWidth()
    let textWidth = currentTextWidth()
    let titleWidth = currentTitleWidth()
    let helperVisible = !helperLabel.stringValue.isEmpty
    let subtitleVisible = !subtitleLabel.stringValue.isEmpty
    let subtitleLayoutHeight: CGFloat = subtitleVisible ? subtitleHeight : 0
    let titleToSubtitleGap: CGFloat = subtitleVisible ? titleSubtitleGap : 0
    let helperLayoutHeight: CGFloat = helperVisible ? helperHeight : 0
    let helperToPromptGap: CGFloat = helperVisible ? promptHelperGap : 0
    let historyContentHeight = rebuildConversationHistoryView(contentWidth: textWidth)
    let historyVisible = historyContentHeight > 0
    let historyVisibleHeight = min(historyContentHeight, historyMaxHeight)
    let historySpacing: CGFloat = historyVisible ? reviewSectionGap : 0
    let helperY: CGFloat
    let promptY: CGFloat
    let promptFrameHeight: CGFloat
    let promptBubbleVisible: Bool
    let historyY: CGFloat
    let subtitleY: CGFloat
    let titleY: CGFloat
    let requiredCardHeight: CGFloat

    if currentMode == .review || currentMode == .record {
      let promptHeight = measuredReviewPromptHeight()
      promptFrameHeight = 0
      promptBubbleVisible = true

      let middleContentHeight = currentMode == .review
        ? measuredEditorHeight()
        : recordingBubbleHeight

      helperY = buttonTop + helperControlsGap
      let middleContentY = helperY + helperHeight + reviewSectionGap
      promptY = middleContentY + middleContentHeight + reviewSectionGap
      historyY = promptY + promptHeight + historySpacing
      subtitleY = historyY + historyVisibleHeight + subtitlePromptGap
      titleY = subtitleY + subtitleLayoutHeight + titleToSubtitleGap
      requiredCardHeight = titleY + titleHeight + topPadding

      historyScrollView.isHidden = !historyVisible
      waveformContainer.isHidden = currentMode == .review
      editorScrollView.isHidden = currentMode != .review
      recordingBubbleView.isHidden = currentMode != .record
      promptLabel.isHidden = true
      reviewPromptBubbleView.isHidden = false

      reviewPromptBubbleView.frame = NSRect(
        x: textLeft,
        y: promptY,
        width: reviewPromptBubbleWidth,
        height: promptHeight
      )
      reviewPromptLabel.frame = NSRect(
        x: reviewBubbleHorizontalPadding,
        y: reviewBubbleVerticalPadding,
        width: reviewPromptBubbleWidth - (reviewBubbleHorizontalPadding * 2),
        height: promptHeight - (reviewBubbleVerticalPadding * 2)
      )
      historyScrollView.frame = NSRect(
        x: textLeft,
        y: historyY,
        width: textWidth,
        height: historyVisibleHeight
      )

      let middleContentX = cardWidth - textLeft - reviewEditorBubbleWidth
      if currentMode == .review {
        editorScrollView.frame = NSRect(
          x: middleContentX,
          y: middleContentY,
          width: reviewEditorBubbleWidth,
          height: middleContentHeight
        )
        editorView.frame = NSRect(x: 0, y: 0, width: reviewEditorBubbleWidth, height: middleContentHeight)
        editorView.textContainer?.containerSize = NSSize(
          width: reviewEditorBubbleWidth - 16,
          height: .greatestFiniteMagnitude
        )
      } else {
        recordingBubbleView.frame = NSRect(
          x: middleContentX,
          y: middleContentY,
          width: reviewEditorBubbleWidth,
          height: recordingBubbleHeight
        )
        waveformContainer.frame = NSRect(
          x: recordingBubbleView.frame.minX + ((reviewEditorBubbleWidth - recordingWaveformWidth) / 2),
          y: recordingBubbleView.frame.minY + ((recordingBubbleHeight - waveformHeight) / 2),
          width: recordingWaveformWidth,
          height: waveformHeight
        )
      }
    } else {
      promptBubbleVisible = shouldShowAgentPromptBubble()
      let promptHeight = promptBubbleVisible ? measuredPromptBubbleHeight() : measuredPromptHeight()
      promptFrameHeight = promptHeight
      let waveformY = buttonTop + waveformButtonsGap
      let controlsTop = waveformY + waveformHeight
      helperY = controlsTop + (helperVisible ? helperControlsGap : 0)
      promptY = helperY + helperLayoutHeight + helperToPromptGap
      historyY = promptY + promptHeight + historySpacing
      subtitleY = historyY + historyVisibleHeight + subtitlePromptGap
      titleY = subtitleY + subtitleLayoutHeight + titleToSubtitleGap
      requiredCardHeight = titleY + titleHeight + topPadding

      historyScrollView.isHidden = !historyVisible
      waveformContainer.isHidden =
        currentMode == .invite || currentMode == .idle || currentMode == .standby || currentMode == .close
      editorScrollView.isHidden = true
      recordingBubbleView.isHidden = true
      promptLabel.isHidden = promptBubbleVisible
      reviewPromptBubbleView.isHidden = !promptBubbleVisible
      if promptBubbleVisible {
        let bubbleWidth = currentPromptBubbleWidth()
        reviewPromptBubbleView.frame = NSRect(
          x: textLeft,
          y: promptY,
          width: bubbleWidth,
          height: promptHeight
        )
        reviewPromptLabel.frame = NSRect(
          x: reviewBubbleHorizontalPadding,
          y: reviewBubbleVerticalPadding,
          width: bubbleWidth - (reviewBubbleHorizontalPadding * 2),
          height: promptHeight - (reviewBubbleVerticalPadding * 2)
        )
        if currentMode == .speaking || currentMode == .transcribing {
          waveformContainer.frame = NSRect(
            x: textLeft + bubbleWidth + waveformBubbleGap,
            y: promptY + ((promptHeight - waveformHeight) / 2),
            width: inlineWaveformWidth,
            height: waveformHeight
          )
        }
      }
      historyScrollView.frame = NSRect(
        x: textLeft,
        y: historyY,
        width: textWidth,
        height: historyVisibleHeight
      )
      if currentMode != .speaking && currentMode != .transcribing {
        waveformContainer.frame = NSRect(x: textLeft, y: waveformY, width: 110, height: waveformHeight)
      }
    }

    let windowHeight = requiredCardHeight + (cardInset * 2)
    let currentFrame = window.frame
    let newOriginY = currentFrame.origin.y + (currentFrame.height - windowHeight)
    window.setFrame(
      NSRect(x: currentFrame.origin.x, y: newOriginY, width: windowWidth, height: windowHeight),
      display: true,
      animate: false
    )

    cardView.frame = NSRect(x: cardInset, y: cardInset, width: cardWidth, height: requiredCardHeight)
    iconView.frame = NSRect(x: 28, y: titleY - 2, width: iconSize, height: iconSize)
    titleLabel.frame = NSRect(x: 72, y: titleY, width: titleWidth, height: titleHeight)
    subtitleLabel.isHidden = !subtitleVisible
    subtitleLabel.frame = NSRect(x: 72, y: subtitleY, width: titleWidth, height: subtitleHeight)
    promptLabel.frame = NSRect(x: textLeft, y: promptY, width: textWidth, height: promptFrameHeight)
    helperLabel.isHidden = !helperVisible
    helperLabel.frame = NSRect(x: textLeft, y: helperY, width: textWidth, height: helperLayoutHeight)
    if historyVisible {
      let historyOffsetY = max(historyContentHeight - historyVisibleHeight, 0)
      historyScrollView.contentView.scroll(to: NSPoint(x: 0, y: historyOffsetY))
      historyScrollView.reflectScrolledClipView(historyScrollView.contentView)
    }
    layoutButtons(bottomY: bottomY)
  }

  private func layoutButtons(bottomY: CGFloat) {
    if currentMode == .invite {
      let buttonWidth = (currentCardWidth() - (inviteButtonInset * 2)) / 2
      secondaryButton.frame = NSRect(
        x: inviteButtonInset,
        y: bottomY,
        width: buttonWidth,
        height: currentActionButtonHeight()
      )
      primaryButton.frame = NSRect(
        x: inviteButtonInset + buttonWidth,
        y: bottomY,
        width: buttonWidth,
        height: currentActionButtonHeight()
      )
      return
    }

    let visibleButtons = [secondaryButton, tertiaryButton, primaryButton].filter { !$0.isHidden }
    let width = visibleButtons.count == 3 ? tripleButtonWidth : dualButtonWidth
    let totalButtonWidth = (CGFloat(visibleButtons.count) * width) + (CGFloat(max(visibleButtons.count - 1, 0)) * buttonGap)
    var currentX = (cardWidth - totalButtonWidth) / 2

    for button in visibleButtons {
      button.frame = NSRect(x: currentX, y: bottomY, width: width, height: currentActionButtonHeight())
      currentX += width + buttonGap
    }
  }

  private func currentActionButtonHeight() -> CGFloat {
    currentMode == .invite ? inviteButtonHeight : buttonHeight
  }

  private func currentActionBottomPadding() -> CGFloat {
    currentMode == .invite ? inviteBottomPadding : bottomPadding
  }

  private func currentWindowWidth() -> CGFloat {
    currentMode == .invite ? inviteWindowWidth : windowWidth
  }

  private func currentCardWidth() -> CGFloat {
    currentMode == .invite ? inviteCardWidth : cardWidth
  }

  private func currentTextWidth() -> CGFloat {
    currentCardWidth() - (textLeft * 2)
  }

  private func currentTitleWidth() -> CGFloat {
    currentCardWidth() - 100
  }

  private func measuredPromptHeight() -> CGFloat {
    if promptLabel.stringValue.isEmpty {
      return 0
    }

    let text = promptLabel.stringValue as NSString
    let font = promptLabel.font ?? .systemFont(ofSize: 14, weight: .regular)
    let textWidth = currentTextWidth()
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font
    ]

    let rect = text.boundingRect(
      with: NSSize(width: textWidth, height: 500),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      attributes: attributes
    )

    return max(58, ceil(rect.height) + 4)
  }

  private func measuredPromptBubbleHeight() -> CGFloat {
    measuredBubbleHeight(
      text: reviewPromptLabel.stringValue,
      width: currentPromptBubbleWidth()
    )
  }

  private func measuredReviewPromptHeight() -> CGFloat {
    measuredBubbleHeight(
      text: reviewPromptLabel.stringValue,
      width: reviewPromptBubbleWidth
    )
  }

  private func measuredBubbleHeight(text: String, width: CGFloat) -> CGFloat {
    let promptText = text as NSString
    let font = reviewPromptLabel.font ?? .systemFont(ofSize: 14, weight: .regular)
    let rect = promptText.boundingRect(
      with: NSSize(width: width - (reviewBubbleHorizontalPadding * 2), height: 500),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      attributes: [.font: font]
    )
    let estimatedHeight = ceil(rect.height) + (reviewBubbleVerticalPadding * 2)
    return max(52, estimatedHeight)
  }

  private func currentPromptBubbleWidth() -> CGFloat {
    if currentMode == .review {
      return reviewPromptBubbleWidth
    }

    return min(currentTextWidth(), promptBubbleWidth)
  }

  private func shouldShowAgentPromptBubble() -> Bool {
    switch currentMode {
    case .invite, .speaking, .record, .transcribing, .close:
      return !reviewPromptLabel.stringValue.isEmpty
    default:
      return false
    }
  }

  private func measuredEditorHeight() -> CGFloat {
    let text = editorView.string as NSString
    let font = editorView.font ?? .systemFont(ofSize: 14, weight: .regular)
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font
    ]
    let editorMeasureWidth = currentMode == .review
      ? reviewEditorBubbleWidth - 20
      : textWidth - 20

    let rect = text.boundingRect(
      with: NSSize(width: editorMeasureWidth, height: 800),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      attributes: attributes
    )

    let estimatedHeight = ceil(rect.height) + 32
    return min(editorMaxHeight, max(editorMinHeight, estimatedHeight))
  }

  private func appendConversationTurn(userText: String) {
    let promptText = reviewPromptLabel.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalizedUserText = userText.trimmingCharacters(in: .whitespacesAndNewlines)

    if !promptText.isEmpty {
      conversationHistory.append(
        ConversationMessage(
          speaker: .agent,
          text: promptText
        )
      )
      conversationHistoryDirty = true
    }

    if !normalizedUserText.isEmpty {
      conversationHistory.append(
        ConversationMessage(
          speaker: .user,
          text: normalizedUserText
        )
      )
      conversationHistoryDirty = true
    }
  }

  private func rebuildConversationHistoryView(contentWidth: CGFloat) -> CGFloat {
    guard conversationHistoryDirty else {
      return cachedHistoryContentHeight
    }
    conversationHistoryDirty = false

    historyContentView.subviews.forEach { $0.removeFromSuperview() }

    guard !conversationHistory.isEmpty else {
      historyContentView.frame = NSRect(x: 0, y: 0, width: contentWidth, height: 1)
      cachedHistoryContentHeight = 0
      return 0
    }

    var currentY: CGFloat = 0

    for message in conversationHistory {
      let row = buildConversationHistoryRow(message: message, contentWidth: contentWidth)
      row.frame.origin = NSPoint(x: 0, y: currentY)
      historyContentView.addSubview(row)
      currentY += row.frame.height + historyRowGap
    }

    let contentHeight = max(currentY - historyRowGap, 0)
    historyContentView.frame = NSRect(x: 0, y: 0, width: contentWidth, height: contentHeight)
    cachedHistoryContentHeight = contentHeight
    return contentHeight
  }

  private func buildConversationHistoryRow(
    message: ConversationMessage,
    contentWidth: CGFloat
  ) -> NSView {
    let rowView = FlippedView(frame: .zero)
    let isAgentMessage = message.speaker == .agent
    let bubbleWidth = isAgentMessage ? reviewPromptBubbleWidth : reviewEditorBubbleWidth
    let bubbleX = isAgentMessage ? 0 : max(contentWidth - bubbleWidth, 0)
    let bubbleTextWidth = bubbleWidth - (reviewBubbleHorizontalPadding * 2)
    let font = NSFont.systemFont(ofSize: 14, weight: .regular)
    let text = message.text as NSString
    let rect = text.boundingRect(
      with: NSSize(width: bubbleTextWidth, height: 600),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      attributes: [.font: font]
    )
    let bubbleHeight = max(52, ceil(rect.height) + (reviewBubbleVerticalPadding * 2))
    let rowHeight = bubbleHeight
    rowView.frame = NSRect(x: 0, y: 0, width: contentWidth, height: rowHeight)

    let bubbleView = NSView(
      frame: NSRect(
        x: bubbleX,
        y: 0,
        width: bubbleWidth,
        height: bubbleHeight
      )
    )
    bubbleView.wantsLayer = true
    bubbleView.layer?.cornerRadius = isAgentMessage ? 18 : 20
    bubbleView.layer?.masksToBounds = true
    bubbleView.layer?.borderWidth = 1
    bubbleView.layer?.backgroundColor = (
      isAgentMessage
        ? NSColor.white
        : NSColor.systemBlue.withAlphaComponent(0.08)
    ).cgColor
    bubbleView.layer?.borderColor = (
      isAgentMessage
        ? NSColor(calibratedWhite: 0.84, alpha: 1)
        : NSColor.systemBlue.withAlphaComponent(0.24)
    ).cgColor
    rowView.addSubview(bubbleView)

    let textLabel = NSTextField(wrappingLabelWithString: message.text)
    textLabel.font = font
    textLabel.textColor = NSColor(calibratedWhite: 0.15, alpha: 1)
    textLabel.frame = NSRect(
      x: reviewBubbleHorizontalPadding,
      y: reviewBubbleVerticalPadding,
      width: bubbleTextWidth,
      height: bubbleHeight - (reviewBubbleVerticalPadding * 2)
    )
    bubbleView.addSubview(textLabel)

    return rowView
  }

  @objc private func handlePrimaryAction() {
    switch currentMode {
    case .invite:
      stopRingSound()
      clearTimeout()
      writeCurrentResponse(
        mode: "invite",
        status: "accepted"
      )
    case .record:
      finishRecording(submitTranscriptDirectly: false)
    case .review:
      submitReview(keepConversationOpen: false)
    case .close:
      writeCurrentResponse(
        mode: "close",
        status: "accepted"
      )
      closeApplication()
    case .standby:
      closeApplication()
    default:
      break
    }
  }

  @objc private func handleSecondaryAction() {
    switch currentMode {
    case .invite:
      stopRingSound()
      clearTimeout()
      writeCurrentResponse(
        mode: "invite",
        status: "declined"
      )
      closeApplication()
    case .record:
      cancelRecording()
    case .review:
      writeCurrentResponse(
        mode: "review",
        status: "cancelled"
      )
      closeApplication()
    case .close:
      writeCurrentResponse(
        mode: "close",
        status: "kept_open"
      )
      configureStandby()
    default:
      break
    }
  }

  @objc private func handleTertiaryAction() {
    switch currentMode {
    case .record:
      finishRecording(submitTranscriptDirectly: true)
    case .review:
      submitReview(keepConversationOpen: true)
    default:
      return
    }
  }

  private func submitReview(keepConversationOpen: Bool) {
    let submittedTranscript = editorView.string.trimmingCharacters(in: .whitespacesAndNewlines)
    if keepConversationOpen {
      appendConversationTurn(userText: submittedTranscript)
    }

    writeCurrentResponse(
      mode: "review",
      status: "accepted",
      transcriptText: submittedTranscript,
      keepConversationOpen: keepConversationOpen
    )

    if keepConversationOpen {
      configureStandby()
    } else {
      closeApplication()
    }
  }

  private func requestMicrophonePermission() throws {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    switch status {
    case .authorized:
      return
    case .notDetermined:
      let semaphore = DispatchSemaphore(value: 0)
      var granted = false
      AVCaptureDevice.requestAccess(for: .audio) { approved in
        granted = approved
        semaphore.signal()
      }
      semaphore.wait()
      if !granted {
        throw HuddleError.microphoneDenied
      }
    default:
      throw HuddleError.microphoneDenied
    }
  }

  private func startRecording(command: HuddleCommand) throws {
    try requestMicrophonePermission()
    guard let recordingPath = command.recordingPath else {
      throw HuddleError.recorderStartFailed
    }

    let outputURL = URL(fileURLWithPath: recordingPath)
    try FileManager.default.createDirectory(
      at: outputURL.deletingLastPathComponent(),
      withIntermediateDirectories: true,
      attributes: nil
    )

    let settings: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
      AVSampleRateKey: 44_100,
      AVNumberOfChannelsKey: 1,
      AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
    ]

    let recorder = try AVAudioRecorder(url: outputURL, settings: settings)
    recorder.prepareToRecord()
    if !recorder.record() {
      throw HuddleError.recorderStartFailed
    }

    self.recorder = recorder
    scheduleTimeout(
      after: TimeInterval(max(command.maxRecordingSeconds ?? 90, 1)),
      selector: #selector(finishRecordingFromTimer)
    )
  }

  @objc private func finishRecordingFromTimer() {
    finishRecording(submitTranscriptDirectly: false)
  }

  private func finishRecording(submitTranscriptDirectly: Bool) {
    clearTimeout()
    recorder?.stop()
    recorder = nil
    primaryButton.isEnabled = false
    secondaryButton.isEnabled = false
    tertiaryButton.isEnabled = false
    writeCurrentResponse(
      mode: "record",
      status: "accepted",
      audioPath: currentCommand?.recordingPath,
      submitTranscriptDirectly: submitTranscriptDirectly
    )
  }

  @objc private func cancelRecording() {
    clearTimeout()
    recorder?.stop()
    recorder = nil
    if let recordingPath = currentCommand?.recordingPath {
      try? FileManager.default.removeItem(atPath: recordingPath)
    }
    writeCurrentResponse(
      mode: "record",
      status: "cancelled"
    )
    closeApplication()
  }

  private func writeCurrentResponse(
    mode: String,
    status: String,
    audioPath: String? = nil,
    transcriptText: String? = nil,
    keepConversationOpen: Bool? = nil,
    submitTranscriptDirectly: Bool? = nil
  ) {
    guard let command = currentCommand else {
      return
    }

    writeResponse(
      HuddleResponse(
        requestId: command.requestId,
        mode: mode,
        status: status,
        audioPath: audioPath,
        transcriptText: transcriptText,
        keepConversationOpen: keepConversationOpen,
        submitTranscriptDirectly: submitTranscriptDirectly
      )
    )
  }

  private func writeResponse(_ response: HuddleResponse) {
    guard let data = try? JSONEncoder().encode(response) else {
      return
    }

    let destination = runtime.responsesDirectory.appendingPathComponent("\(response.requestId).json")
    try? data.write(to: destination, options: .atomic)
  }

  private func closeApplication() {
    if isClosing {
      return
    }

    isClosing = true
    stopRingSound()
    waveformTimer?.invalidate()
    commandPollTimer?.invalidate()
    clearTimeout()
    recorder?.stop()
    if let keyMonitor {
      NSEvent.removeMonitor(keyMonitor)
      self.keyMonitor = nil
    }
    try? FileManager.default.removeItem(at: runtime.readyMarker)
    FileManager.default.createFile(atPath: runtime.closedMarker.path, contents: Data())
    window.orderOut(nil)
    NSApplication.shared.terminate(nil)
  }

  @objc private func handleInviteTimeout() {
    clearTimeout()
    stopRingSound()
    writeCurrentResponse(
      mode: "invite",
      status: "missed"
    )
    closeApplication()
  }

  @objc private func handleStandbyTimeout() {
    clearTimeout()
    closeApplication()
  }
}

func parseRuntimeConfig() throws -> HuddleRuntimeConfig {
  let arguments = Array(CommandLine.arguments.dropFirst())
  var conversationId: String?
  var conversationDirectory: String?
  var index = 0

  while index < arguments.count {
    let argument = arguments[index]

    switch argument {
    case "--conversation-id":
      let nextIndex = index + 1
      guard nextIndex < arguments.count else {
        throw LaunchConfigurationError.missingArgument("--conversation-id")
      }
      conversationId = arguments[nextIndex]
      index += 2
    case "--conversation-dir":
      let nextIndex = index + 1
      guard nextIndex < arguments.count else {
        throw LaunchConfigurationError.missingArgument("--conversation-dir")
      }
      conversationDirectory = arguments[nextIndex]
      index += 2
    default:
      index += 1
    }
  }

  guard let conversationId else {
    throw LaunchConfigurationError.missingArgument("--conversation-id")
  }

  guard let conversationDirectory else {
    throw LaunchConfigurationError.missingArgument("--conversation-dir")
  }

  return HuddleRuntimeConfig(
    conversationId: conversationId,
    conversationDirectory: URL(fileURLWithPath: conversationDirectory, isDirectory: true)
  )
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

do {
  let runtime = try parseRuntimeConfig()
  let controller = HuddleUIController(runtime: runtime)
  controller.start()
  app.run()
} catch {
  fputs("\(error.localizedDescription)\n", stderr)
  exit(1)
}
