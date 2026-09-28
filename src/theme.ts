export type Background = "dark" | "light" | "unknown";

export interface GhostPalette {
  line: string;
  face: string;
  crown: string;
}

// Each palette gives at least 4.4:1 on its background. The neutral one gives about 3.8:1 on both.
export const GHOST_PALETTES: Record<Background, GhostPalette> = {
  dark: { line: "#A78BFA", face: "#EDE9FE", crown: "#FACC15" },
  light: { line: "#7C3AED", face: "#4C1D95", crown: "#A16207" },
  unknown: { line: "#8B5CF6", face: "#8B5CF6", crown: "#A56F03" },
};

/** The query that asks the terminal for its background color (OSC 11). */
export const BACKGROUND_QUERY = "\u001B]11;?\u0007";

const luminance = (red: number, green: number, blue: number) => {
  const linear = (channel: number) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
};

/**
 * Reads the reply to BACKGROUND_QUERY, for example "\x1b]11;rgb:1e1e/1e1e/2e2e\x07".
 * Each channel has 1 to 4 hexadecimal digits.
 */
export function backgroundFromReply(reply: string): Background {
  const match = /\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
  if (!match) return "unknown";
  const [red, green, blue] = match.slice(1).map((hex) => parseInt(hex, 16) / (16 ** hex.length - 1)) as [number, number, number];
  return luminance(red, green, blue) > 0.18 ? "light" : "dark";
}

/**
 * Reads COLORFGBG, which some terminals set to "<foreground>;<background>" with ANSI color numbers.
 * The colors 7 and 9 to 15 are light, the others are dark.
 */
export function backgroundFromColorFgBg(value: string | undefined): Background {
  const last = value?.split(";").at(-1);
  if (!last || !/^\d+$/.test(last)) return "unknown";
  const color = Number(last);
  return color === 7 || (color >= 9 && color <= 15) ? "light" : "dark";
}

/** Tells if a key press from Ink is a piece of the reply to BACKGROUND_QUERY that came late. */
export const isBackgroundReply = (input: string) => /\]11;rgb:|^rgb:[0-9a-f/]*$/i.test(input);

interface TerminalInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "readable", listener: () => void): unknown;
  off(event: "readable", listener: () => void): unknown;
  read(): Buffer | string | null;
  unshift(chunk: Buffer | string): unknown;
}

// The reply ends with BEL or with ESC and a backslash.
const REPLY = /\u001B\]11;[^\u0007\u001B]*(?:\u0007|\u001B\\)/;

/**
 * Asks the terminal for its background color, and falls back on COLORFGBG.
 * A terminal that does not know the query sends nothing, so the wait stops after timeoutMs.
 * Call it before Ink starts: Ink then takes over the raw mode of stdin.
 * The function reads with "readable" and puts back the keys typed during the wait, so Ink gets them.
 * A "data" listener or a pause() leaves stdin in a flowing state that stops the keys of the app.
 */
export async function detectBackground(
  stdin: TerminalInput,
  stdout: { write(text: string): unknown },
  env: Record<string, string | undefined>,
  timeoutMs = 150,
): Promise<Background> {
  const fallback = backgroundFromColorFgBg(env.COLORFGBG);
  if (!stdin.isTTY || !stdin.setRawMode) return fallback;
  stdin.setRawMode(true);
  const received = await new Promise<string>((resolve) => {
    let text = "";
    const done = () => {
      clearTimeout(timer);
      stdin.off("readable", onReadable);
      resolve(text);
    };
    const onReadable = () => {
      for (let chunk = stdin.read(); chunk !== null; chunk = stdin.read()) text += chunk.toString();
      if (REPLY.test(text)) done();
    };
    const timer = setTimeout(done, timeoutMs);
    stdin.on("readable", onReadable);
    stdout.write(BACKGROUND_QUERY);
  });
  stdin.setRawMode(false);
  const keys = received.replace(REPLY, "");
  if (keys) stdin.unshift(keys);
  const detected = backgroundFromReply(received);
  return detected === "unknown" ? fallback : detected;
}
