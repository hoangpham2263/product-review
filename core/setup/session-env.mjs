// Imported FIRST by src/mac/server.mjs: fixes the session environment before core/platform.mjs copies process.env into toolEnv, so every
// PowerShell child (PR_WORKSPACE, PR_SESSION) works in this session's workspace. See core/setup/session.mjs.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentSession, sessionWorkspace } from "./session.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const session = currentSession();
process.env.PR_SESSION = session;
process.env.PR_WORKSPACE = sessionWorkspace(root, session);
export { root, session };
