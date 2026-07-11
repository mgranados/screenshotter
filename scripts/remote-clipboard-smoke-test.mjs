#!/usr/bin/env node
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyPreparedScreen } from "../bin/screenshotter.mjs";

const workDir = mkdtempSync(join(tmpdir(), "screenshotter-remote-clipboard-"));
const binDir = join(workDir, "bin");
const dataDir = join(workDir, "store");
const imagePath = join(workDir, "optimized.jpg");
const commandLog = join(workDir, "commands.jsonl");
const clipboardPath = join(workDir, "clipboard.txt");
const sshPath = join(binDir, "fake-ssh.mjs");
const scpPath = join(binDir, "fake-scp.mjs");
const pbcopyPath = join(binDir, "pbcopy");
const originalEnv = {
  PATH: process.env.PATH,
  SCREENSHOTTER_SSH_BIN: process.env.SCREENSHOTTER_SSH_BIN,
  SCREENSHOTTER_SCP_BIN: process.env.SCREENSHOTTER_SCP_BIN,
  SCREENSHOTTER_TEST_COMMAND_LOG: process.env.SCREENSHOTTER_TEST_COMMAND_LOG,
  SCREENSHOTTER_TEST_CLIPBOARD: process.env.SCREENSHOTTER_TEST_CLIPBOARD,
};

try {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(imagePath, Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex"), { mode: 0o600 });
  writeExecutable(sshPath, fakeSshSource());
  writeExecutable(scpPath, fakeScpSource());
  writeExecutable(pbcopyPath, fakePbcopySource());

  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  process.env.SCREENSHOTTER_SSH_BIN = sshPath;
  process.env.SCREENSHOTTER_SCP_BIN = scpPath;
  process.env.SCREENSHOTTER_TEST_COMMAND_LOG = commandLog;
  process.env.SCREENSHOTTER_TEST_CLIPBOARD = clipboardPath;

  const result = await copyPreparedScreen({
    id: "scr_remote_fixture",
    optimizedPath: imagePath,
    sourcePath: "/Users/local/Desktop/source.png",
    mimeType: "image/jpeg",
    textContext: {
      provider: "macos-accessibility",
      source: "macOS Accessibility",
      text: "Remote screen text",
    },
    textSources: [],
  }, {
    clipboardMode: "attachments",
    remoteTarget: "devbox-test",
    withText: true,
    dataDir,
  });

  assert(result.status === "remote-attachments", "remote transport should report remote attachment status");
  assert(result.textCopied === true, "remote transport should report copied text context");

  const clipboard = readFileSync(clipboardPath, "utf8");
  assert(clipboard.includes("[[screenshotter-remote-v1]]"), "clipboard should contain the remote adapter marker");
  assert(clipboard.includes("/home/test/.cache/screenshotter/inbox/scr_remote_fixture-screen-context.md"), "clipboard should contain the remote context path");
  assert(clipboard.includes("/home/test/.cache/screenshotter/inbox/optimized.jpg"), "clipboard should contain the remote image path");
  assert(!clipboard.includes("/Users/local"), "clipboard should not contain local-only paths");

  const commands = readFileSync(commandLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert(commands.some((entry) => entry.kind === "ssh" && entry.args.at(-1).includes("mkdir -p")), "remote transport should create a private inbox");
  assert(commands.some((entry) => entry.kind === "scp" && entry.args.some((arg) => arg.includes("devbox-test:"))), "remote transport should upload both files with scp");
  assert(commands.some((entry) => entry.kind === "ssh" && entry.args.at(-1).startsWith("chmod 600")), "remote transport should secure uploaded files");

  await assertRejects(
    () => copyPreparedScreen({ optimizedPath: imagePath }, {
      clipboardMode: "attachments",
      remoteTarget: "bad target; touch /tmp/nope",
      dryRun: true,
    }),
    "invalid remote targets must be rejected before execution",
  );

  console.log("remote clipboard smoke test passed");
} finally {
  restoreEnv(originalEnv);
  rmSync(workDir, { recursive: true, force: true });
}

function writeExecutable(filePath, source) {
  writeFileSync(filePath, source);
  chmodSync(filePath, 0o755);
}

function fakeSshSource() {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.SCREENSHOTTER_TEST_COMMAND_LOG, JSON.stringify({ kind: "ssh", args: process.argv.slice(2) }) + "\\n");
if (process.argv.at(-1).includes("mkdir -p")) process.stdout.write("/home/test/.cache/screenshotter/inbox");
`;
}

function fakeScpSource() {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.SCREENSHOTTER_TEST_COMMAND_LOG, JSON.stringify({ kind: "scp", args: process.argv.slice(2) }) + "\\n");
`;
}

function fakePbcopySource() {
  return `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
writeFileSync(process.env.SCREENSHOTTER_TEST_CLIPBOARD, Buffer.concat(chunks));
`;
}

function restoreEnv(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function assertRejects(operation, message) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
