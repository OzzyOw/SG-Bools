// Small terminal prompts for the admin scripts.
import readline from 'node:readline';

/** Ask a question and return the answer line. */
export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

/** Ask for a secret without echoing it. Falls back to reading a line when stdin is not a terminal (piped). */
export function askHidden(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return ask(question);
  stdout.write(question);
  return new Promise((resolve) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130); // Ctrl+C
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
