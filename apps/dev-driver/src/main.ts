import { CliUsageError, runCli } from "./cli.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

try {
  await runCli(process.argv.slice(2), {
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin,
    writeStdout: text => process.stdout.write(text),
    writeStderr: text => process.stderr.write(text),
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`dev-driver: ${message}\n`);
  if (error instanceof CliUsageError) {
    process.stderr.write("usage: pnpm dev -- [--model MODEL] [--protocol openai_responses|openai_chat_completions] PROMPT\n");
  }
  process.exitCode = 1;
}
