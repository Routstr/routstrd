const HOME = process.env.HOME || process.env.USERPROFILE || "";

export const CONFIG_DIR = process.env.ROUTSTRD_DIR || `${HOME}/.routstrd`;
export const SOCKET_PATH = process.env.ROUTSTRD_SOCKET || `${CONFIG_DIR}/routstrd.sock`;
export const PID_FILE = process.env.ROUTSTRD_PID || `${CONFIG_DIR}/routstrd.pid`;
export const DB_PATH = `${CONFIG_DIR}/routstr.db`;
export const CONFIG_FILE = `${CONFIG_DIR}/config.json`;

export interface RoutstrdConfig {
  port: number;
  provider: string | null;
  cocodPath: string | null;
}

export const DEFAULT_CONFIG: RoutstrdConfig = {
  port: 8008,
  provider: null,
  cocodPath: null,
};
