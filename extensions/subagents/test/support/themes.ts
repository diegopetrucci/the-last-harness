import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";

const plainForegrounds: ConstructorParameters<typeof Theme>[0] = {
  accent: "",
  border: "",
  borderAccent: "",
  borderMuted: "",
  success: "",
  error: "",
  warning: "",
  muted: "",
  dim: "",
  text: "",
  thinkingText: "",
  userMessageText: "",
  customMessageText: "",
  customMessageLabel: "",
  toolTitle: "",
  toolOutput: "",
  mdHeading: "",
  mdLink: "",
  mdLinkUrl: "",
  mdCode: "",
  mdCodeBlock: "",
  mdCodeBlockBorder: "",
  mdQuote: "",
  mdQuoteBorder: "",
  mdHr: "",
  mdListBullet: "",
  toolDiffAdded: "",
  toolDiffRemoved: "",
  toolDiffContext: "",
  syntaxComment: "",
  syntaxKeyword: "",
  syntaxFunction: "",
  syntaxVariable: "",
  syntaxString: "",
  syntaxNumber: "",
  syntaxType: "",
  syntaxOperator: "",
  syntaxPunctuation: "",
  thinkingOff: "",
  thinkingMinimal: "",
  thinkingLow: "",
  thinkingMedium: "",
  thinkingHigh: "",
  thinkingXhigh: "",
  thinkingMax: "",
  bashMode: "",
};

const plainBackgrounds: ConstructorParameters<typeof Theme>[1] = {
  selectedBg: "",
  userMessageBg: "",
  customMessageBg: "",
  toolPendingBg: "",
  toolSuccessBg: "",
  toolErrorBg: "",
};

/**
 * Build an upstream Theme instance whose styling methods are deterministic and
 * emit plain text. Using the SDK class keeps render fixtures faithful to the
 * object passed by an actual ExtensionContext while avoiding terminal colors in
 * string assertions.
 */
export function createPlainTheme(
  onForeground: (color: ThemeColor, text: string) => string = (_color, text) => text,
  onBold: (text: string) => string = (text) => text,
): Theme {
  class PlainTheme extends Theme {
    constructor() {
      super(plainForegrounds, plainBackgrounds, "truecolor");
    }

    override fg(color: ThemeColor, text: string): string {
      return onForeground(color, text);
    }

    override bold(text: string): string {
      return onBold(text);
    }
  }

  return new PlainTheme();
}
