import os from 'node:os';
import path from 'node:path';

// One local desktop per user. The override also isolates integration tests.
export const dataDir = path.resolve(process.env.DSH_WAIBAO_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-waibao'));
export const connectionFile = path.join(dataDir, 'desktop-connection.json');
