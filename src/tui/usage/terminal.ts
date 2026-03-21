export function clearScreen(): string {
  return "\x1b[2J\x1b[H";
}

export function enterAlternateScreen(): string {
  return "\x1b[?1049h";
}

export function leaveAlternateScreen(): string {
  return "\x1b[?1049l";
}

export function hideCursor(): string {
  return "\x1b[?25l";
}

export function showCursor(): string {
  return "\x1b[?25h";
}

export function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function eraseDown(): string {
  return "\x1b[J";
}

export function getWidth(): number {
  return process.stdout.columns || 80;
}

export function getHeight(): number {
  return process.stdout.rows || 24;
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}
