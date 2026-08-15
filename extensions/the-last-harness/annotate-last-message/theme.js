import { getMarkdownTheme, getSelectListTheme, getSettingsListTheme, } from "@earendil-works/pi-coding-agent";
const FALLBACK = {
    "--mdHeading": "#f4c95d",
    "--mdLink": "#7dd3fc",
    "--mdLinkUrl": "#8a8a8a",
    "--mdCode": "#9b7bff",
    "--mdCodeBlock": "inherit",
    "--mdCodeBlockBorder": "#6f42c1",
    "--mdQuote": "#8a8a8a",
    "--mdQuoteBorder": "#6f42c1",
    "--mdHr": "#585858",
    "--mdListBullet": "#f4c95d",
    "--mdBold": "inherit",
    "--mdItalic": "inherit",
    "--accent": "#f4c95d",
    "--muted": "#8a8a8a",
    "--dim": "#585858",
};
const BASIC_ANSI_COLORS = {
    30: "#000000",
    31: "#cc0000",
    32: "#4e9a06",
    33: "#c4a000",
    34: "#3465a4",
    35: "#75507b",
    36: "#06989a",
    37: "#d3d7cf",
    90: "#555753",
    91: "#ef2929",
    92: "#8ae234",
    93: "#fce94f",
    94: "#729fcf",
    95: "#ad7fa8",
    96: "#34e2e2",
    97: "#eeeeec",
};
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
function toHex2(n) {
    return n.toString(16).padStart(2, "0");
}
function xterm256ToHex(n) {
    if (n < 0 || n > 255)
        return null;
    if (n < 16) {
        const key = n < 8 ? 30 + n : 90 + (n - 8);
        return BASIC_ANSI_COLORS[key] ?? null;
    }
    if (n >= 232) {
        const v = 8 + (n - 232) * 10;
        const h = toHex2(v);
        return `#${h}${h}${h}`;
    }
    const idx = n - 16;
    const b = idx % 6;
    const g = Math.floor(idx / 6) % 6;
    const r = Math.floor(idx / 36) % 6;
    return `#${toHex2(CUBE_LEVELS[r])}${toHex2(CUBE_LEVELS[g])}${toHex2(CUBE_LEVELS[b])}`;
}
const ESC = "\u001b";
const SGR_PREFIX_RE = new RegExp(`^${ESC}\\[([0-9;]+)m`);
export function parseAnsiColor(text) {
    const match = SGR_PREFIX_RE.exec(text);
    if (!match)
        return null;
    const raw = match[1];
    if (!raw)
        return null;
    const params = raw.split(";").map(Number);
    const [p0, p1, p2, p3, p4] = params;
    if (p0 === 38 && p1 === 2 && params.length >= 5) {
        const r = p2 ?? 0;
        const g = p3 ?? 0;
        const b = p4 ?? 0;
        if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255)
            return null;
        return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
    }
    if (p0 === 38 && p1 === 5 && params.length >= 3) {
        return xterm256ToHex(p2 ?? 0);
    }
    if ((p0 >= 30 && p0 <= 37) || (p0 >= 90 && p0 <= 97)) {
        return BASIC_ANSI_COLORS[p0] ?? null;
    }
    return null;
}
const SENTINEL = "X";
const MD_THEME_CSS_VARS = [
    { key: "heading", cssVar: "--mdHeading" },
    { key: "link", cssVar: "--mdLink" },
    { key: "linkUrl", cssVar: "--mdLinkUrl" },
    { key: "code", cssVar: "--mdCode" },
    { key: "codeBlock", cssVar: "--mdCodeBlock" },
    { key: "codeBlockBorder", cssVar: "--mdCodeBlockBorder" },
    { key: "quote", cssVar: "--mdQuote" },
    { key: "quoteBorder", cssVar: "--mdQuoteBorder" },
    { key: "hr", cssVar: "--mdHr" },
    { key: "listBullet", cssVar: "--mdListBullet" },
    { key: "bold", cssVar: "--mdBold" },
    { key: "italic", cssVar: "--mdItalic" },
];
export function buildCssVarsFromThemes(mdTheme, slTheme, ssTheme) {
    const vars = { ...FALLBACK };
    if (mdTheme !== null) {
        for (const { key, cssVar } of MD_THEME_CSS_VARS) {
            try {
                const fn = mdTheme[key];
                if (typeof fn !== "function")
                    continue;
                const wrapped = fn(SENTINEL);
                const parsed = parseAnsiColor(wrapped);
                if (parsed !== null)
                    vars[cssVar] = parsed;
            }
            catch {
            }
        }
    }
    if (slTheme !== null) {
        try {
            const parsed = parseAnsiColor(slTheme.selectedText(SENTINEL));
            if (parsed !== null)
                vars["--accent"] = parsed;
        }
        catch {
        }
        try {
            const parsed = parseAnsiColor(slTheme.description(SENTINEL));
            if (parsed !== null)
                vars["--muted"] = parsed;
        }
        catch {
        }
    }
    if (ssTheme !== null) {
        try {
            const parsed = parseAnsiColor(ssTheme.hint(SENTINEL));
            if (parsed !== null)
                vars["--dim"] = parsed;
        }
        catch {
        }
    }
    return vars;
}
export function getThemeCssVars() {
    let mdTheme = null;
    let slTheme = null;
    let ssTheme = null;
    try {
        mdTheme = getMarkdownTheme();
    }
    catch {
    }
    try {
        slTheme = getSelectListTheme();
    }
    catch {
    }
    try {
        ssTheme = getSettingsListTheme();
    }
    catch {
    }
    return buildCssVarsFromThemes(mdTheme, slTheme, ssTheme);
}
