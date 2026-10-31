import os from "node:os";
import path from "node:path";

// The server reads PH_HOME at import time. One per worker, so test files that run at the same
// time never share state, and tests never touch the user's real one.
process.env.PH_HOME = path.join(os.tmpdir(), `ph-test-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}`);
