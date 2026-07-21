import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  View,
  Text,
  ActivityIndicator,
  Dimensions,
  AccessibilityInfo,
  TouchableOpacity,
} from "react-native";
import { WebView } from "react-native-webview";
import { ChevronDown } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { logActivity, getSnippets } from "../../../main-axios";
import { showToast } from "../../../utils/toast";
import { useTerminalCustomization } from "../../../contexts/TerminalCustomizationContext";
import { BACKGROUNDS, ACCENT, TEXT_COLORS } from "../../../constants/designTokens";
import {
  TOTPDialog,
  SSHAuthDialog,
  HostKeyVerificationDialog,
  PassphraseDialog,
  WarpgateDialog,
} from "@/app/tabs/dialogs";
import { TERMINAL_THEMES, TERMINAL_FONTS } from "@/constants/terminal-themes";
import { MOBILE_DEFAULT_TERMINAL_CONFIG } from "@/constants/terminal-config";
import type { TerminalConfig } from "@/types";
import {
  NativeWebSocketManager,
  type TerminalHostConfig,
  type HostKeyData,
} from "./NativeWebSocketManager";
import { loadXtermAssets } from "./loadXtermAssets";
import { useConnectionLog, ConnectionLog } from "../_shared/useConnectionLog";

interface TerminalProps {
  hostConfig: {
    id: number;
    name: string;
    ip: string;
    port: number;
    username: string;
    authType: "password" | "key" | "credential" | "none";
    password?: string;
    key?: string;
    keyPassword?: string;
    keyType?: string;
    credentialId?: number;
    jumpHosts?: { hostId: number }[];
    forceKeyboardInteractive?: boolean;
    overrideCredentialUsername?: boolean;
    terminalConfig?: Partial<TerminalConfig>;
  };
  isVisible: boolean;
  title?: string;
  onClose?: () => void;
  onBackgroundColorChange?: (color: string) => void;
  /** Stable tab instance id (cross-device session tracking). */
  tabInstanceId?: string;
  /** Backend session id to attach to on first connect (reviving a tab). */
  initialSessionId?: string | null;
  /** Fired when the backend session id is created/attached/cleared. */
  onSessionIdChange?: (sessionId: string | null) => void;
}

export type TerminalHandle = {
  sendInput: (data: string) => void;
  fit: () => void;
  isDialogOpen: () => boolean;
  notifyBackgrounded: () => void;
  notifyForegrounded: () => void;
  scrollToBottom: () => void;
  isSelecting: () => boolean;
};

const TerminalComponent = forwardRef<TerminalHandle, TerminalProps>(
  (
    {
      hostConfig,
      isVisible,
      title = "Terminal",
      onClose,
      onBackgroundColorChange,
      tabInstanceId,
      initialSessionId,
      onSessionIdChange,
    },
    ref,
  ) => {
    const webViewRef = useRef<WebView>(null);
    const wsManagerRef = useRef<NativeWebSocketManager | null>(null);
    const terminalColsRef = useRef(80);
    const terminalRowsRef = useRef(24);
    const pendingDataRef = useRef<string[]>([]);
    const dataFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );

    const { config } = useTerminalCustomization();
    const log = useConnectionLog();
    const [webViewKey, setWebViewKey] = useState(0);
    const [screenDimensions, setScreenDimensions] = useState(
      Dimensions.get("window"),
    );
    type ConnectionState =
      | "connecting"
      | "connected"
      | "reconnecting"
      | "disconnected"
      | "failed";
    const [connectionState, setConnectionState] =
      useState<ConnectionState>("connecting");
    const [retryCount, setRetryCount] = useState(0);
    const [hasReceivedData, setHasReceivedData] = useState(false);
    const [htmlContent, setHtmlContent] = useState("");
    const [terminalBackgroundColor, setTerminalBackgroundColor] =
      useState<string>(BACKGROUNDS.DARKEST);

    const [totpRequired, setTotpRequired] = useState(false);
    const [totpPrompt, setTotpPrompt] = useState("");
    const [isPasswordPrompt, setIsPasswordPrompt] = useState(false);
    const [showAuthDialog, setShowAuthDialog] = useState(false);
    const [authDialogReason, setAuthDialogReason] = useState<
      "no_keyboard" | "auth_failed" | "timeout"
    >("auth_failed");
    const [passphraseRequired, setPassphraseRequired] = useState(false);
    const [warpgateAuth, setWarpgateAuth] = useState<{
      url: string;
      securityKey: string;
    } | null>(null);
    const [showScrollToBottomButton, setShowScrollToBottomButton] =
      useState(false);
    const [hostKeyVerification, setHostKeyVerification] = useState<{
      scenario: "new" | "changed";
      data: HostKeyData;
    } | null>(null);

    const xtermAssetsRef = useRef<{
      xtermJs: string;
      xtermCss: string;
      fitAddonJs: string;
    } | null>(null);

    const [isScreenReaderEnabled, setIsScreenReaderEnabled] = useState(false);
    const isScreenReaderEnabledRef = useRef(false);
    const [accessibilityText, setAccessibilityText] = useState("");
    const accessibilityBufferRef = useRef<string[]>([]);
    const accessibilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );

    useEffect(() => {
      AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
        setIsScreenReaderEnabled(enabled);
        isScreenReaderEnabledRef.current = enabled;
      });
      const subscription = AccessibilityInfo.addEventListener(
        "screenReaderChanged",
        (enabled) => {
          setIsScreenReaderEnabled(enabled);
          isScreenReaderEnabledRef.current = enabled;
        },
      );
      return () => subscription.remove();
    }, []);

    const writeToAccessibility = useCallback((rawData: string) => {
      const cleaned = rawData
        .replace(/\x1b\[[0-9;]*[mGKHJABCDsu]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "")
        .replace(/\x1b[()][AB012]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .trim();

      if (!cleaned) return;

      const lines = cleaned.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length === 0) return;

      accessibilityBufferRef.current.push(...lines);
      if (accessibilityBufferRef.current.length > 5) {
        accessibilityBufferRef.current =
          accessibilityBufferRef.current.slice(-5);
      }

      if (accessibilityTimerRef.current) {
        clearTimeout(accessibilityTimerRef.current);
      }
      accessibilityTimerRef.current = setTimeout(() => {
        accessibilityTimerRef.current = null;
        const text = accessibilityBufferRef.current.join("\n");
        accessibilityBufferRef.current = [];
        setAccessibilityText(text);
        AccessibilityInfo.announceForAccessibility(text);
      }, 500);
    }, []);

    useEffect(() => {
      const subscription = Dimensions.addEventListener(
        "change",
        ({ window }) => {
          setScreenDimensions(window);
        },
      );

      return () => subscription?.remove();
    }, []);

    const handleConnectionFailure = useCallback(
      (errorMessage: string) => {
        showToast.error(errorMessage);
        setConnectionState("failed");
        if (onClose) {
          onClose();
        }
      },
      [onClose],
    );

    const generateHTML = useCallback((assets: { xtermJs: string; xtermCss: string; fitAddonJs: string }) => {
      const { width, height } = screenDimensions;

      const terminalConfig: Partial<TerminalConfig> = {
        ...MOBILE_DEFAULT_TERMINAL_CONFIG,
        ...config,
        ...hostConfig.terminalConfig,
      };

      const baseFontSize = config.fontSize || 16;
      const charWidth = baseFontSize * 0.6;
      const lineHeight = baseFontSize * 1.2;
      const terminalWidth = Math.floor(width / charWidth);
      const terminalHeight = Math.floor(height / lineHeight);

      void terminalWidth;
      void terminalHeight;

      const themeName = terminalConfig.theme || "termix";
      const themeColors =
        TERMINAL_THEMES[themeName]?.colors || TERMINAL_THEMES.termix.colors;

      const bgColor = themeColors.background;
      setTerminalBackgroundColor(bgColor);
      if (onBackgroundColorChange) {
        onBackgroundColorChange(bgColor);
      }

      const fontConfig = TERMINAL_FONTS.find(
        (f) => f.value === terminalConfig.fontFamily,
      );
      const fontFamily = fontConfig?.fallback || TERMINAL_FONTS[0].fallback;

      return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terminal</title>
  <style>${assets.xtermCss}</style>
  <script>${assets.xtermJs}</script>
  <script>${assets.fitAddonJs}</script>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: ${themeColors.background};
      font-family: ${fontFamily};
      overflow: hidden;
      width: 100vw;
      height: 100vh;
    }

    #terminal {
      width: 100vw;
      height: 100vh;
      min-height: 100vh;
      padding: 4px 4px 20px 4px;
      margin: 0;
      box-sizing: border-box;
    }

    .xterm {
      width: 100% !important;
      height: 100% !important;
    }

    .xterm-viewport {
      width: 100% !important;
      height: 100% !important;
      -webkit-overflow-scrolling: touch;
    }

    .xterm {
      font-feature-settings: "liga" 1, "calt" 1;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .xterm .xterm-screen {
      font-family: ${fontFamily} !important;
      font-variant-ligatures: contextual;
    }

    .xterm .xterm-screen .xterm-char {
      font-feature-settings: "liga" 1, "calt" 1;
    }

    .xterm .xterm-viewport::-webkit-scrollbar {
      width: 8px;
      background: transparent;
    }
    .xterm .xterm-viewport::-webkit-scrollbar-thumb {
      background: rgba(180,180,180,0.7);
      border-radius: 4px;
    }
    .xterm .xterm-viewport::-webkit-scrollbar-thumb:hover {
      background: rgba(120,120,120,0.9);
    }
    .xterm .xterm-viewport {
      scrollbar-width: thin;
      scrollbar-color: rgba(180,180,180,0.7) transparent;
    }
    * {
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: none;
    }
    html, body, #terminal, .xterm {
      user-select: text;
      -webkit-user-select: text;
      -ms-user-select: text;
      -moz-user-select: text;
    }

    .termix-selection-handle {
      position: fixed;
      display: none;
      width: 44px;
      height: 56px;
      margin-left: -22px;
      z-index: 1000;
      touch-action: none;
      -webkit-user-select: none;
      user-select: none;
    }
    .termix-selection-handle-stem {
      position: absolute;
      left: 20px;
      top: 0;
      width: 4px;
      height: 22px;
      border-radius: 2px;
      background: ${ACCENT};
    }
    .termix-selection-handle-knob {
      position: absolute;
      left: 10px;
      top: 18px;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: ${ACCENT};
      box-shadow: 0 2px 7px rgba(0,0,0,0.45);
    }

    #termix-toolbar {
      position: fixed;
      display: none;
      z-index: 1001;
      flex-direction: row;
      align-items: stretch;
      background: ${BACKGROUNDS.CARD};
      border: 1px solid ${ACCENT};
      border-radius: 4px;
      padding: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      touch-action: manipulation;
      -webkit-user-select: none;
      user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    #termix-toolbar.visible { display: flex; }
    .termix-toolbar-button {
      padding: 8px 14px;
      color: ${TEXT_COLORS.PRIMARY};
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      min-width: 56px;
      text-align: center;
    }
    .termix-toolbar-button + .termix-toolbar-button {
      border-left: 1px solid rgba(255,255,255,0.15);
    }
    .termix-toolbar-button:active { opacity: 0.7; }

    body.termix-handle-dragging,
    body.termix-handle-dragging #terminal,
    body.termix-handle-dragging .xterm {
      touch-action: none !important;
      overscroll-behavior: none;
    }

    input, textarea, [contenteditable], .xterm-helper-textarea {
      position: absolute !important;
      left: -9999px !important;
      top: -9999px !important;
      width: 1px !important;
      height: 1px !important;
      opacity: 0 !important;
      pointer-events: none !important;
      color: transparent !important;
      background: transparent !important;
      border: none !important;
      outline: none !important;
      caret-color: transparent !important;
      -webkit-text-fill-color: transparent !important;
    }

  </style>
</head>
<body>
  <div id="terminal"></div>

  <script>
    const screenWidth = ${width};
    const screenHeight = ${height};

    const baseFontSize = ${baseFontSize};

    const terminal = new Terminal({
      cursorBlink: ${terminalConfig.cursorBlink || false},
      cursorStyle: '${terminalConfig.cursorStyle || "bar"}',
      scrollback: ${terminalConfig.scrollback || 10000},
      fontSize: baseFontSize,
      fontFamily: ${JSON.stringify(fontFamily)},
      letterSpacing: ${terminalConfig.letterSpacing || 0},
      lineHeight: ${terminalConfig.lineHeight || 1.2},
      theme: {
        background: '${themeColors.background}',
        foreground: '${themeColors.foreground}',
        cursor: '${themeColors.cursor || themeColors.foreground}',
        cursorAccent: '${themeColors.cursorAccent || themeColors.background}',
        selectionBackground: '${themeColors.selectionBackground || "rgba(255, 255, 255, 0.3)"}',
        selectionForeground: '${themeColors.selectionForeground || ""}',
        black: '${themeColors.black}',
        red: '${themeColors.red}',
        green: '${themeColors.green}',
        yellow: '${themeColors.yellow}',
        blue: '${themeColors.blue}',
        magenta: '${themeColors.magenta}',
        cyan: '${themeColors.cyan}',
        white: '${themeColors.white}',
        brightBlack: '${themeColors.brightBlack}',
        brightRed: '${themeColors.brightRed}',
        brightGreen: '${themeColors.brightGreen}',
        brightYellow: '${themeColors.brightYellow}',
        brightBlue: '${themeColors.brightBlue}',
        brightMagenta: '${themeColors.brightMagenta}',
        brightCyan: '${themeColors.brightCyan}',
        brightWhite: '${themeColors.brightWhite}'
      },
      allowTransparency: true,
      convertEol: true,
      screenReaderMode: true,
      windowsMode: false,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: false,
      rightClickSelectsWord: false,
      fastScrollModifier: 'alt',
      fastScrollSensitivity: 5,
      allowProposedApi: true,
      disableStdin: true,
      cursorInactiveStyle: '${terminalConfig.cursorStyle || "bar"}'
    });

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(document.getElementById('terminal'));

    fitAddon.fit();
    terminal.write('\x1b[?25h');

    setTimeout(() => {
      const inputs = document.querySelectorAll('input, textarea, .xterm-helper-textarea');
      inputs.forEach(input => {
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('spellcheck', 'false');
        input.style.color = 'transparent';
        input.style.caretColor = 'transparent';
        input.style.webkitTextFillColor = 'transparent';
      });
    }, 100);

    let isScrolledToBottom = true;
    let scrollStateFrame = null;

    function getIsScrolledToBottom() {
      try {
        return terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      } catch(e) {
        return true;
      }
    }

    function postScrollState() {
      const nextIsAtBottom = getIsScrolledToBottom();
      if (nextIsAtBottom === isScrolledToBottom) {
        return;
      }

      isScrolledToBottom = nextIsAtBottom;
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'scrollState',
          data: { isAtBottom: isScrolledToBottom }
        }));
      }
    }

    function scheduleScrollStateUpdate() {
      if (scrollStateFrame !== null) {
        return;
      }

      scrollStateFrame = requestAnimationFrame(function() {
        scrollStateFrame = null;
        postScrollState();
      });
    }

    terminal.onScroll(function() {
      scheduleScrollStateUpdate();
      scheduleScrollHandleRefresh();
    });

    // connectionEpoch is incremented each time notifyConnected fires.
    // The write callback captures its epoch at call time; if it no longer
    // matches the current epoch the connection already moved on, so we skip
    // the dataReceived notification to avoid spurious state changes.
    let connectionEpoch = 0;
    let notifiedEpoch = -1;
    window.writeToTerminal = function(data) {
      const shouldStickToBottom = getIsScrolledToBottom();
      const capturedEpoch = connectionEpoch;
      try {
        terminal.write(data, function() {
          if (notifiedEpoch !== capturedEpoch) {
            notifiedEpoch = capturedEpoch;
            if (window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'dataReceived' }));
            }
          }
          if (shouldStickToBottom) {
            terminal.scrollToBottom();
          }
          scheduleScrollStateUpdate();
        });
      } catch(e) {}
    };

    window.notifyConnected = function(fromBackground, isReattach) {
      connectionEpoch += 1;
      hideHandles();
      hideToolbar();
      terminal.clear();
      if (isReattach) {
        terminal.write('\\x1b[2J\\x1b[H\\x1b[?25h');
      } else {
        terminal.reset();
        terminal.write('\\x1b[2J\\x1b[H\\x1b[?25h');
      }
    };

    const terminalElement = document.getElementById('terminal');

    window.resetScroll = function() {
      terminal.scrollToBottom();
      scheduleScrollStateUpdate();
    }

    document.addEventListener('focusin', function(e) {
      if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (e.target && e.target.blur) {
          e.target.blur();
        }
        return false;
      }
    }, true);

    document.addEventListener('focus', function(e) {
      if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (e.target && e.target.blur) {
          e.target.blur();
        }
        return false;
      }
    }, true);

    terminalElement.addEventListener('contextmenu', function(e){
      e.preventDefault();
      e.stopPropagation();
      return false;
    }, { passive: false });

    // In-WebView selection model. xterm.js renders to canvas so Android cannot
    // attach its native selection handles; this code implements Termius-style
    // draggable handles, long-press/double/triple tap selection gestures, and
    // a Copy / Paste / Select All toolbar entirely inside the WebView.
    var isCurrentlySelecting = false;
    var activeHandle = null;
    var fixedBoundary = null;
    var latestHandleTouch = null;
    var autoScrollTimer = null;
    var lastTapTime = 0;
    var lastTapX = 0;
    var lastTapY = 0;
    var tapCount = 0;

    function createHandle(kind) {
      var handle = document.createElement('div');
      handle.className = 'termix-selection-handle termix-selection-handle-' + kind;
      handle.setAttribute('role', 'slider');
      handle.setAttribute('aria-label', kind === 'start' ? 'Selection start' : 'Selection end');
      var stem = document.createElement('div');
      stem.className = 'termix-selection-handle-stem';
      var knob = document.createElement('div');
      knob.className = 'termix-selection-handle-knob';
      handle.appendChild(stem);
      handle.appendChild(knob);
      document.body.appendChild(handle);
      return handle;
    }

    var startHandle = createHandle('start');
    var endHandle = createHandle('end');
    var termixBody = document.body;
    // The toolbar is defined inline in the HTML, but Android WebView re-runs
    // layout when the soft keyboard opens or closes. Building the toolbar
    // once at runtime (and rebuilding it only when the selection state
    // changes) keeps it stable across keyboard transitions.
    var termixToolbar = null;
    (function() {
      var existing = document.getElementById('termix-toolbar');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      var bar = document.createElement('div');
      bar.id = 'termix-toolbar';
      ['copy', 'paste', 'select-all'].forEach(function(action) {
        var btn = document.createElement('div');
        btn.className = 'termix-toolbar-button';
        btn.setAttribute('data-action', action);
        btn.textContent = action === 'select-all' ? 'Select All' :
          action.charAt(0).toUpperCase() + action.slice(1);
        bar.appendChild(btn);
      });
      document.body.appendChild(bar);
      termixToolbar = bar;
    })();

    function hideHandles() {
      startHandle.style.display = 'none';
      endHandle.style.display = 'none';
    }

    function getCellDimensions() {
      try {
        return terminal._core._renderService.dimensions.css.cell;
      } catch (e) {
        return null;
      }
    }

    function pixelToBufferCell(x, y) {
      var rect = terminalElement.getBoundingClientRect();
      var cell = getCellDimensions();
      if (!cell || !cell.width || !cell.height) return null;
      var viewportRow = Math.floor((y - rect.top - 4) / cell.height);
      var col = Math.floor((x - rect.left - 4) / cell.width);
      col = Math.max(0, Math.min(terminal.cols - 1, col));
      viewportRow = Math.max(0, Math.min(terminal.rows - 1, viewportRow));
      return {
        x: col,
        y: terminal.buffer.active.viewportY + viewportRow
      };
    }

    function compareCells(a, b) {
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    }

    function previousCell(cell) {
      if (cell.x > 0) return { x: cell.x - 1, y: cell.y };
      return { x: terminal.cols - 1, y: Math.max(0, cell.y - 1) };
    }

    function nextCell(cell) {
      if (cell.x < terminal.cols - 1) return { x: cell.x + 1, y: cell.y };
      return { x: 0, y: cell.y + 1 };
    }

    function selectRange(start, endExclusive) {
      if (compareCells(start, endExclusive) >= 0) return;
      var length = ((endExclusive.y - start.y) * terminal.cols) +
        (endExclusive.x - start.x);
      terminal.select(start.x, start.y, Math.max(1, length));
    }

    function isWordCharacter(character) {
      return /[A-Za-z0-9_@#$%&+.,:;=-]/.test(character || '');
    }

    function selectWordAt(clientX, clientY) {
      var cell = pixelToBufferCell(clientX, clientY);
      if (!cell) return;
      var line = terminal.buffer.active.getLine(cell.y);
      if (!line) return;
      var text = line.translateToString(false);
      if (!text || cell.x >= text.length) return;
      var left = cell.x;
      var right = cell.x;
      if (!isWordCharacter(text.charAt(cell.x))) {
        if (left > 0 && isWordCharacter(text.charAt(left - 1))) {
          left -= 1;
          right = left;
        } else {
          terminal.select(cell.x, cell.y, 1);
          return;
        }
      }
      while (left > 0 && isWordCharacter(text.charAt(left - 1))) left -= 1;
      while (right + 1 < text.length && isWordCharacter(text.charAt(right + 1))) right += 1;
      terminal.select(left, cell.y, right - left + 1);
    }

    function selectLineAt(clientX, clientY) {
      var cell = pixelToBufferCell(clientX, clientY);
      if (!cell) return;
      // Select the entire rendered row width. The line's translateToString
      // length reflects the content written, not the visible column count,
      // so we cap it at terminal.cols to avoid including trailing whitespace.
      terminal.select(0, cell.y, terminal.cols);
    }

    function positionHandle(handle, point, isEnd) {
      var cell = getCellDimensions();
      if (!cell) return false;
      var viewportRow = point.y - terminal.buffer.active.viewportY;
      var rect = terminalElement.getBoundingClientRect();
      var boundaryX = point.x;
      var boundaryRow = viewportRow;
      // xterm's end point is exclusive and can sit at column 0 of the next row.
      if (isEnd && boundaryX === 0 && boundaryRow > 0) {
        boundaryX = terminal.cols;
        boundaryRow -= 1;
      }
      // Clamp the handle to the visible viewport so it never disappears,
      // including when Select All is used and the end of the selection is
      // off-screen below the buffer.
      if (boundaryRow < 0) {
        boundaryRow = 0;
        boundaryX = 0;
      } else if (boundaryRow >= terminal.rows) {
        boundaryRow = terminal.rows - 1;
        if (isEnd) boundaryX = terminal.cols;
        else boundaryX = Math.min(terminal.cols - 1, Math.max(0, boundaryX));
      }
      handle.style.left = (rect.left + 4 + boundaryX * cell.width) + 'px';
      handle.style.top = (rect.top + 4 + (boundaryRow + 1) * cell.height - 4) + 'px';
      handle.style.display = 'block';
      return true;
    }

    function showToolbarNear(position) {
      if (!termixToolbar) return;
      var cell = getCellDimensions();
      var rect = terminalElement.getBoundingClientRect();
      var viewportWidth = window.innerWidth;
      var viewportHeight = window.innerHeight;
      // The toolbar is sticky-anchored: it always sits at the bottom of the
      // visible terminal area with a small margin above the on-screen
      // keyboard. This matches the Termius/iOS behaviour and avoids ever
      // covering the selected text or the prompt above the cursor.
      // - On a normal screen this places the toolbar just above the
      //   bottom of the WebView.
      // - When the soft keyboard is open we sit it 12px above the keyboard.
      var keyboardHeight = window.__termixKeyboardHeight || 0;
      var safeBottom = viewportHeight - keyboardHeight;
      var margin = 12;
      var y = Math.max(8, safeBottom - 56 - margin);
      termixToolbar.classList.add('visible');
      // Two-frame anchor so the WebView has finished laying out the toolbar
      // (Android can report zero width while the soft keyboard is opening).
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          if (!termixToolbar) return;
          var barWidth = termixToolbar.offsetWidth || 240;
          var left = Math.max(8, Math.min(viewportWidth / 2 - barWidth / 2, viewportWidth - barWidth - 8));
          termixToolbar.style.left = left + 'px';
          termixToolbar.style.top = y + 'px';
        });
      });
    }

    function hideToolbar() {
      if (termixToolbar) termixToolbar.classList.remove('visible');
    }

    function refreshSelectionUi(showToolbar) {
      var text = terminal.getSelection();
      var position = terminal.getSelectionPosition();
      if (!text || !position) {
        hideHandles();
        hideToolbar();
        isCurrentlySelecting = false;
        return;
      }
      isCurrentlySelecting = true;
      positionHandle(startHandle, position.start, false);
      positionHandle(endHandle, position.end, true);
      if (showToolbar) showToolbarNear(position);
      else hideToolbar();
    }

    function updateSelectionFromHandle(clientX, clientY) {
      if (!activeHandle || !fixedBoundary) return;
      var target = pixelToBufferCell(clientX, clientY);
      if (!target) return;
      if (activeHandle === 'start') {
        if (compareCells(target, fixedBoundary) >= 0) {
          target = previousCell(fixedBoundary);
        }
        selectRange(target, fixedBoundary);
      } else {
        var endExclusive = nextCell(target);
        if (compareCells(endExclusive, fixedBoundary) <= 0) {
          endExclusive = nextCell(fixedBoundary);
        }
        selectRange(fixedBoundary, endExclusive);
      }
      refreshSelectionUi(true);
    }

    function stopAutoScroll() {
      if (autoScrollTimer) {
        clearInterval(autoScrollTimer);
        autoScrollTimer = null;
      }
    }

    function updateAutoScroll(clientY) {
      stopAutoScroll();
      var rect = terminalElement.getBoundingClientRect();
      var direction = clientY < rect.top + 48 ? -1 :
        (clientY > rect.bottom - 48 ? 1 : 0);
      if (!direction) return;
      autoScrollTimer = setInterval(function() {
        if (!activeHandle || !latestHandleTouch) return;
        terminal.scrollLines(direction);
        updateSelectionFromHandle(latestHandleTouch.x, latestHandleTouch.y);
      }, 70);
    }

    function beginHandleDrag(kind, event) {
      var position = terminal.getSelectionPosition();
      if (!position || !event.touches || !event.touches.length) return;
      event.preventDefault();
      event.stopPropagation();
      activeHandle = kind;
      fixedBoundary = kind === 'start' ? position.end : position.start;
      latestHandleTouch = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY
      };
      termixBody.classList.add('termix-handle-dragging');
      hideToolbar();
    }

    function moveHandle(event) {
      if (!activeHandle || !event.touches || !event.touches.length) return;
      event.preventDefault();
      event.stopPropagation();
      latestHandleTouch = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY
      };
      updateSelectionFromHandle(latestHandleTouch.x, latestHandleTouch.y);
      updateAutoScroll(latestHandleTouch.y);
    }

    function endHandleDrag(event) {
      if (!activeHandle) return;
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      activeHandle = null;
      fixedBoundary = null;
      latestHandleTouch = null;
      stopAutoScroll();
      termixBody.classList.remove('termix-handle-dragging');
      refreshSelectionUi(true);
    }

    startHandle.addEventListener('touchstart', function(e) { beginHandleDrag('start', e); }, { passive: false });
    endHandle.addEventListener('touchstart', function(e) { beginHandleDrag('end', e); }, { passive: false });
    document.addEventListener('touchmove', moveHandle, { passive: false, capture: true });
    document.addEventListener('touchend', endHandleDrag, { passive: false, capture: true });
    document.addEventListener('touchcancel', endHandleDrag, { passive: false, capture: true });

    // Word/line gestures over the terminal area.
    var gestureStartX = 0;
    var gestureStartY = 0;
    var gestureMoved = false;
    var longPressTimer = null;

    terminalElement.addEventListener('touchstart', function(event) {
      if (!event.touches || event.touches.length !== 1) return;
      if (event.target && event.target.closest && event.target.closest('.termix-selection-handle')) return;
      gestureStartX = event.touches[0].clientX;
      gestureStartY = event.touches[0].clientY;
      gestureMoved = false;
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = setTimeout(function() {
        if (!gestureMoved && !activeHandle) {
          selectWordAt(gestureStartX, gestureStartY);
        }
      }, 450);
    }, { passive: true });

    terminalElement.addEventListener('touchmove', function(event) {
      if (!event.touches || event.touches.length !== 1) return;
      var dx = Math.abs(event.touches[0].clientX - gestureStartX);
      var dy = Math.abs(event.touches[0].clientY - gestureStartY);
      if (dx > 12 || dy > 12) {
        gestureMoved = true;
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }
    }, { passive: true });

    terminalElement.addEventListener('touchend', function(event) {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      if (gestureMoved || activeHandle) return;
      if (!event.changedTouches || event.changedTouches.length !== 1) return;
      var touch = event.changedTouches[0];
      var now = Date.now();
      var nearLastTap = Math.abs(touch.clientX - lastTapX) < 28 &&
        Math.abs(touch.clientY - lastTapY) < 28;
      if (now - lastTapTime < 360 && nearLastTap) {
        tapCount += 1;
      } else {
        tapCount = 1;
      }
      lastTapTime = now;
      lastTapX = touch.clientX;
      lastTapY = touch.clientY;
      if (tapCount === 2) {
        event.preventDefault();
        setTimeout(function() { selectWordAt(touch.clientX, touch.clientY); }, 0);
      } else if (tapCount >= 3) {
        event.preventDefault();
        tapCount = 0;
        setTimeout(function() { selectLineAt(touch.clientX, touch.clientY); }, 0);
      }
    }, { passive: false });

    // In-WebView toolbar actions.
    function postAction(type, data) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: type,
          data: data || {}
        }));
      }
    }

    if (termixToolbar) {
      termixToolbar.addEventListener('click', function(event) {
        var target = event.target;
        if (!target || !target.getAttribute) return;
        var action = target.getAttribute('data-action');
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        if (action === 'copy') {
          var text = terminal.getSelection();
          if (text) postAction('terminal:request-copy', { text: text });
        } else if (action === 'paste') {
          postAction('terminal:request-paste', {});
        } else if (action === 'select-all') {
          terminal.selectAll();
        }
      });
    }

    terminal.onSelectionChange(function() {
      if (activeHandle) {
        refreshSelectionUi(false);
        return;
      }
      if (terminal.getSelection()) {
        // Show toolbar shortly after the selection settles.
        setTimeout(function() {
          if (terminal.getSelection()) refreshSelectionUi(true);
        }, 140);
      } else {
        refreshSelectionUi(false);
      }
    });

    // Refresh handle and toolbar positions on every scroll tick. xterm's
    // onSelectionChange only fires on selection mutation, so handles would
    // otherwise remain fixed at the cell coordinates from the last paint.
    var scrollHandleFrame = null;
    function scheduleScrollHandleRefresh() {
      if (scrollHandleFrame !== null) return;
      scrollHandleFrame = requestAnimationFrame(function() {
        scrollHandleFrame = null;
        if (terminal.getSelection()) refreshSelectionUi(false);
      });
    }
    terminal.onScroll(function() {
      scheduleScrollStateUpdate();
      scheduleScrollHandleRefresh();
    });

    function handleResize() {
      fitAddon.fit();
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'resize',
          data: { cols: terminal.cols, rows: terminal.rows }
        }));
      }
      // The cell grid just changed, so re-anchor any visible selection UI.
      if (terminal.getSelection()) refreshSelectionUi(false);
    }

    window.nativeFit = function() {
      try { handleResize(); } catch(e) {}
    }

    window.addEventListener('resize', handleResize);

    window.addEventListener('orientationchange', function() {
      setTimeout(handleResize, 100);
    });

    // Touch-scroll acceleration for iOS WebView.
    // Suppressed while a selection handle is being dragged so the drag
    // extends the xterm selection rather than scrolling the terminal.
    (function() {
      var scrollTouchY = null;
      var lineH = terminal._core._renderService.dimensions.css.cell.height || ${baseFontSize * 1.2};
      terminalElement.addEventListener('touchstart', function(e) {
        if (activeHandle) return;
        if (e.touches.length === 1) scrollTouchY = e.touches[0].clientY;
      }, { passive: true, capture: true });
      terminalElement.addEventListener('touchmove', function(e) {
        if (activeHandle) return;
        if (scrollTouchY === null || e.touches.length !== 1) return;
        var dy = scrollTouchY - e.touches[0].clientY;
        scrollTouchY = e.touches[0].clientY;
        var lines = Math.trunc(dy / lineH);
        if (lines !== 0) terminal.scrollLines(lines);
      }, { passive: true, capture: true });
      terminalElement.addEventListener('touchend', function() {
        scrollTouchY = null;
      }, { passive: true, capture: true });
    })();

    terminal.clear();
    terminal.reset();
    terminal.write('\\x1b[2J\\x1b[H');

    setTimeout(function() {
      fitAddon.fit();
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'terminalReady',
          data: { cols: terminal.cols, rows: terminal.rows }
        }));
      }
    }, 150);
  </script>
</body>
</html>
    `;
    }, [
      hostConfig,
      screenDimensions,
      config.fontSize,
      config.fontFamily,
      onBackgroundColorChange,
    ]);

    useEffect(() => {
      loadXtermAssets().then((assets) => {
        xtermAssetsRef.current = assets;
        setHtmlContent(generateHTML(assets));
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handlePostConnectionSetup = useCallback(async () => {
      const terminalConfig: Partial<TerminalConfig> = {
        ...MOBILE_DEFAULT_TERMINAL_CONFIG,
        ...config,
        ...hostConfig.terminalConfig,
      };

      setTimeout(async () => {
        if (terminalConfig.environmentVariables?.length) {
          terminalConfig.environmentVariables.forEach((envVar, index) => {
            setTimeout(
              () => {
                const key = envVar.key;
                const value = envVar.value;
                wsManagerRef.current?.sendInput(`export ${key}="${value}"\n`);
              },
              100 * (index + 1),
            );
          });
        }

        if (terminalConfig.startupSnippetId) {
          const snippetDelay =
            100 * (terminalConfig.environmentVariables?.length || 0) + 200;
          setTimeout(async () => {
            try {
              const snippets = await getSnippets();
              const snippet = snippets.find(
                (s: any) => s.id === terminalConfig.startupSnippetId,
              );
              if (snippet) {
                wsManagerRef.current?.sendInput(`${snippet.content}\n`);
              }
            } catch (err) {
              console.warn("Failed to execute startup snippet:", err);
            }
          }, snippetDelay);
        }

        if (terminalConfig.autoMosh && terminalConfig.moshCommand) {
          const moshDelay =
            100 * (terminalConfig.environmentVariables?.length || 0) +
            (terminalConfig.startupSnippetId ? 400 : 200);
          setTimeout(() => {
            wsManagerRef.current?.sendInput(`${terminalConfig.moshCommand!}\n`);
          }, moshDelay);
        }
      }, 500);
    }, [config, hostConfig.terminalConfig]);

    const handleTotpSubmit = useCallback(
      (code: string) => {
        wsManagerRef.current?.sendTotpResponse(code, isPasswordPrompt);
        setTotpRequired(false);
        setTotpPrompt("");
        setIsPasswordPrompt(false);
        setConnectionState("connecting");
      },
      [isPasswordPrompt],
    );

    const handleAuthDialogSubmit = useCallback(
      (credentials: {
        password?: string;
        sshKey?: string;
        keyPassword?: string;
      }) => {
        wsManagerRef.current?.sendReconnectWithCredentials(
          credentials,
          terminalColsRef.current,
          terminalRowsRef.current,
        );
        setShowAuthDialog(false);
        setConnectionState("connecting");
      },
      [],
    );

    const handleWebViewMessage = useCallback(async (event: any) => {
      try {
        const message = JSON.parse(event.nativeEvent.data);

        switch (message.type) {
          case "terminalReady":
            terminalColsRef.current = message.data.cols;
            terminalRowsRef.current = message.data.rows;
            wsManagerRef.current?.connect(message.data.cols, message.data.rows);
            break;

          case "resize":
            terminalColsRef.current = message.data.cols;
            terminalRowsRef.current = message.data.rows;
            wsManagerRef.current?.sendResize(
              message.data.cols,
              message.data.rows,
            );
            break;

          case "scrollState":
            setShowScrollToBottomButton(!message.data.isAtBottom);
            break;

          case "terminal:request-copy":
            if (message.data && typeof message.data.text === "string") {
              Clipboard.setStringAsync(message.data.text).catch(() => {
                showToast.error("Failed to copy");
              });
            }
            break;

          case "terminal:request-paste":
            try {
              const text = await Clipboard.getStringAsync();
              if (text) {
                wsManagerRef.current?.sendInput(text);
              }
            } catch (error) {
              showToast.error("Failed to paste");
            }
            break;

          case "terminal:keyboard-change":
            if (
              message.data &&
              typeof message.data.height === "number" &&
              webViewRef.current
            ) {
              webViewRef.current.injectJavaScript(
                "window.__termixKeyboardHeight = " + message.data.height + "; " +
                "var t = document.getElementById('termix-toolbar'); " +
                "if (t && t.classList.contains('visible')) { " +
                "  var y = Math.max(8, window.innerHeight - " + message.data.height + " - 56 - 12); " +
                "  t.style.top = y + 'px'; " +
                "} true;",
              );
            }
            break;
        }
      } catch (error) {
        console.error("[Terminal] Error parsing WebView message:", error);
      }
    }, []);

    useEffect(() => {
      wsManagerRef.current?.destroy();

      wsManagerRef.current = new NativeWebSocketManager({
        hostConfig: hostConfig as TerminalHostConfig,
        tabInstanceId,
        initialSessionId,
        onSessionIdChange,
        onStateChange: (state, data) => {
          switch (state) {
            case "connecting": {
              const retryCount = (data?.retryCount as number) || 0;
              setConnectionState(retryCount > 0 ? "reconnecting" : "connecting");
              setRetryCount(retryCount);
              log.append({
                level: "info",
                message: retryCount > 0
                  ? `Reconnecting… (attempt ${retryCount})`
                  : `Connecting to ${hostConfig.name}…`,
              });
              break;
            }
            case "connected": {
              const fromBackground = data?.fromBackground as boolean;
              const isReattach = data?.isReattach as boolean;
              setConnectionState("connected");
              setRetryCount(0);
              if (!isReattach) {
                setHasReceivedData(false);
              }
              log.append({ level: "success", message: "Connected" });
              webViewRef.current?.injectJavaScript(
                `window.notifyConnected(${fromBackground}, ${isReattach}); true;`,
              );
              logActivity("terminal", hostConfig.id, hostConfig.name).catch(
                () => {},
              );
              break;
            }
            case "dataReceived":
              setHasReceivedData(true);
              break;
          }
        },
        onData: (data) => {
          pendingDataRef.current.push(data);
          if (!dataFlushTimerRef.current) {
            dataFlushTimerRef.current = setTimeout(() => {
              dataFlushTimerRef.current = null;
              const batch = pendingDataRef.current.join("");
              pendingDataRef.current = [];
              webViewRef.current?.injectJavaScript(
                `window.writeToTerminal(${JSON.stringify(batch)}); true;`,
              );
            }, 16);
          }
          if (isScreenReaderEnabledRef.current) {
            writeToAccessibility(data);
          }
        },
        onTotpRequired: (prompt, isPassword) => {
          setTotpPrompt(prompt);
          setIsPasswordPrompt(isPassword);
          setTotpRequired(true);
        },
        onAuthDialogNeeded: (reason) => {
          setAuthDialogReason(reason);
          setShowAuthDialog(true);
          setConnectionState("disconnected");
        },
        onHostKeyVerificationRequired: (scenario, data) => {
          setHostKeyVerification({ scenario, data });
        },
        onPassphraseRequired: () => {
          setPassphraseRequired(true);
        },
        onWarpgateAuthRequired: (url, securityKey) => {
          setWarpgateAuth({ url, securityKey });
        },
        onPostConnectionSetup: () => handlePostConnectionSetup(),
        onDisconnected: (hostName) => {
          setConnectionState("disconnected");
          showToast.warning(`Disconnected from ${hostName}`);
          if (onClose) onClose();
        },
        onConnectionFailed: (message) => {
          log.append({ level: "error", message });
          handleConnectionFailure(message);
        },
        onConnectionLog: (entry) => log.ingest([entry]),
      });

      log.clear();
      setWebViewKey((prev) => prev + 1);
      setConnectionState("connecting");
      setHasReceivedData(false);
      setRetryCount(0);
      setShowScrollToBottomButton(false);
      // Clear any stale auth/verification dialogs from a previous connection attempt.
      setHostKeyVerification(null);
      setTotpRequired(false);
      setShowAuthDialog(false);
      setPassphraseRequired(false);
      setWarpgateAuth(null);

      if (xtermAssetsRef.current) {
        setHtmlContent(generateHTML(xtermAssetsRef.current));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hostConfig.id]);

    useEffect(() => {
      return () => {
        wsManagerRef.current?.destroy();
        wsManagerRef.current = null;
        if (dataFlushTimerRef.current) {
          clearTimeout(dataFlushTimerRef.current);
          dataFlushTimerRef.current = null;
        }
        if (accessibilityTimerRef.current) {
          clearTimeout(accessibilityTimerRef.current);
          accessibilityTimerRef.current = null;
        }
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        sendInput: (data: string) => {
          wsManagerRef.current?.sendInput(data);
        },
        fit: () => {
          try {
            webViewRef.current?.injectJavaScript(
              `window.nativeFit && window.nativeFit(); true;`,
            );
          } catch (e) {}
        },
        isDialogOpen: () => {
          return (
            totpRequired ||
            showAuthDialog ||
            hostKeyVerification !== null ||
            passphraseRequired ||
            warpgateAuth !== null
          );
        },
        notifyBackgrounded: () => {
          wsManagerRef.current?.notifyBackgrounded();
        },
        notifyForegrounded: () => {
          wsManagerRef.current?.notifyForegrounded();
        },
        scrollToBottom: () => {
          try {
            setShowScrollToBottomButton(false);
            webViewRef.current?.injectJavaScript(
              `window.resetScroll && window.resetScroll(); true;`,
            );
          } catch (e) {}
        },
        isSelecting: () => false,
      }),
      [totpRequired, showAuthDialog, hostKeyVerification],
    );

    return (
      <View
        style={{
          flex: isVisible ? 1 : 0,
          width: "100%",
          height: "100%",
          position: isVisible ? "relative" : "absolute",
          top: isVisible ? 0 : 0,
          left: isVisible ? 0 : 0,
          right: isVisible ? 0 : 0,
          bottom: isVisible ? 0 : 0,
          backgroundColor: terminalBackgroundColor,
        }}
      >
        <View
          style={{
            flex: 1,
            width: "100%",
            height: "100%",
            opacity: isVisible ? 1 : 0,
            position: "relative",
            zIndex: isVisible ? 1 : -1,
            backgroundColor: terminalBackgroundColor,
          }}
        >
          <View
            style={{ flex: 1, backgroundColor: terminalBackgroundColor }}
            pointerEvents={
              totpRequired || showAuthDialog || hostKeyVerification !== null
                ? "none"
                : "auto"
            }
          >
            <WebView
              key={`terminal-${hostConfig.id}-${webViewKey}`}
              ref={webViewRef}
              source={{ html: htmlContent }}
              style={{
                flex: 1,
                width: "100%",
                height: "100%",
                backgroundColor: terminalBackgroundColor,
                opacity:
                  connectionState === "connected" && hasReceivedData ? 1 : 0,
              }}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              startInLoadingState={false}
              scalesPageToFit={false}
              allowsInlineMediaPlayback={true}
              mediaPlaybackRequiresUserAction={false}
              keyboardDisplayRequiresUserAction={false}
              hideKeyboardAccessoryView={true}
              cacheEnabled={false}
              cacheMode="LOAD_NO_CACHE"
              androidLayerType="hardware"
              onMessage={handleWebViewMessage}
              onError={(syntheticEvent) => {
                const { nativeEvent } = syntheticEvent;
                handleConnectionFailure(
                  `WebView error: ${nativeEvent.description}`,
                );
              }}
              onHttpError={(syntheticEvent) => {
                const { nativeEvent } = syntheticEvent;
                handleConnectionFailure(
                  `WebView HTTP error: ${nativeEvent.statusCode}`,
                );
              }}
              scrollEnabled={true}
              overScrollMode="never"
              bounces={false}
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled={false}
              textZoom={100}
              setSupportMultipleWindows={false}
            />
          </View>

          {showScrollToBottomButton &&
            isVisible &&
            connectionState === "connected" &&
            !totpRequired &&
            !showAuthDialog &&
            hostKeyVerification === null && (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Scroll to bottom"
                onPress={() => {
                  setShowScrollToBottomButton(false);
                  webViewRef.current?.injectJavaScript(
                    `window.resetScroll && window.resetScroll(); true;`,
                  );
                }}
                style={{
                  position: "absolute",
                  right: 14,
                  bottom: 16,
                  width: 40,
                  height: 40,
                  borderRadius: 0,
                  backgroundColor: BACKGROUNDS.CARD,
                  borderWidth: 1,
                  borderColor: ACCENT,
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 20,
                  shadowColor: "#000",
                  shadowOpacity: 0.3,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 3 },
                  elevation: 6,
                }}
              >
                <ChevronDown size={20} color={ACCENT} />
              </TouchableOpacity>
            )}

          {/* Spinner shown until terminal has rendered its first output */}
          {(connectionState === "connecting" || connectionState === "reconnecting" || !hasReceivedData) &&
            connectionState !== "failed" && (
            <View
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                justifyContent: "center",
                alignItems: "center",
                backgroundColor: terminalBackgroundColor,
                zIndex: 120,
              }}
            >
              <ActivityIndicator size="large" color={ACCENT} />
              <Text
                style={{
                  color: TEXT_COLORS.PRIMARY,
                  fontSize: 16,
                  fontWeight: "600",
                  marginTop: 20,
                  textAlign: "center",
                  letterSpacing: 0.3,
                }}
              >
                {connectionState === "reconnecting"
                  ? "Reconnecting..."
                  : "Connecting..."}
              </Text>
              <Text
                style={{
                  color: TEXT_COLORS.SECONDARY,
                  fontSize: 13,
                  marginTop: 6,
                  textAlign: "center",
                }}
              >
                {hostConfig.name}
                {"  ·  "}
                {hostConfig.ip}
              </Text>
            </View>
          )}

          <ConnectionLog
            entries={log.entries}
            isConnecting={connectionState === "connecting" || connectionState === "reconnecting"}
            isConnected={connectionState === "connected"}
            hasConnectionError={connectionState === "failed"}
            onClear={log.clear}
          />
        </View>

        {isScreenReaderEnabled && (
          <View
            accessible={true}
            accessibilityLabel={accessibilityText}
            accessibilityLiveRegion="polite"
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              opacity: 0,
              top: -1000,
              left: -1000,
            }}
          />
        )}

        <TOTPDialog
          visible={totpRequired}
          onSubmit={handleTotpSubmit}
          onCancel={() => {
            setTotpRequired(false);
            setTotpPrompt("");
            setIsPasswordPrompt(false);
            if (onClose) onClose();
          }}
          prompt={totpPrompt}
          isPasswordPrompt={isPasswordPrompt}
        />

        <SSHAuthDialog
          visible={showAuthDialog}
          onSubmit={handleAuthDialogSubmit}
          onCancel={() => {
            setShowAuthDialog(false);
            if (onClose) onClose();
          }}
          hostInfo={{
            name: hostConfig.name,
            ip: hostConfig.ip,
            port: hostConfig.port,
            username: hostConfig.username,
          }}
          reason={authDialogReason}
        />

        <HostKeyVerificationDialog
          visible={hostKeyVerification !== null}
          scenario={hostKeyVerification?.scenario ?? "new"}
          data={hostKeyVerification?.data ?? null}
          onAccept={() => {
            wsManagerRef.current?.sendHostKeyResponse("accept");
            setHostKeyVerification(null);
          }}
          onReject={() => {
            wsManagerRef.current?.sendHostKeyResponse("reject");
            setHostKeyVerification(null);
            if (onClose) onClose();
          }}
        />

        <PassphraseDialog
          visible={passphraseRequired}
          onSubmit={(passphrase) => {
            wsManagerRef.current?.sendPassphraseResponse(passphrase);
            setPassphraseRequired(false);
          }}
          onCancel={() => {
            setPassphraseRequired(false);
            if (onClose) onClose();
          }}
          hostInfo={{
            name: hostConfig.name,
            ip: hostConfig.ip,
            port: hostConfig.port,
            username: hostConfig.username,
          }}
        />

        <WarpgateDialog
          visible={warpgateAuth !== null}
          url={warpgateAuth?.url ?? ""}
          securityKey={warpgateAuth?.securityKey ?? ""}
          onContinue={() => {
            wsManagerRef.current?.sendWarpgateContinue();
            setWarpgateAuth(null);
          }}
          onCancel={() => {
            setWarpgateAuth(null);
            if (onClose) onClose();
          }}
        />
      </View>
    );
  },
);

TerminalComponent.displayName = "Terminal";

export { TerminalComponent as Terminal };
export default TerminalComponent;
