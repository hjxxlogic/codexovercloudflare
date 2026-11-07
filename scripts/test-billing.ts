// Each scenario owns its server, credentials, native processes and temp state.
// Keep the real production timers and assertions; overlap independent waits.
import { spawn, type ChildProcess } from 'node:child_process';

const active = new Set<ChildProcess>();
const forward = (signal: NodeJS.Signals) => {
  for (const child of active) child.kill(signal);
};
const interrupt = () => forward('SIGINT');
const terminate = () => forward('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
try {
  const results = await Promise.allSettled(
    ['native-demand', 'native-refresh', 'native-retry'].map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const started = performance.now();
          console.log(`START: ${name}`);
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', `tests/${name}.ts`],
            { stdio: 'inherit' },
          );
          active.add(child);
          child.once('error', reject);
          child.once('close', (code, signal) => {
            active.delete(child);
            const seconds = ((performance.now() - started) / 1000).toFixed(1);
            console.log(`END: ${name} (${seconds}s), exit ${code ?? signal}`);
            if (code === 0) resolve();
            else reject(new Error(`${name}: exit ${code ?? signal}`));
          });
        }),
    ),
  );
  for (const result of results)
    if (result.status === 'rejected') {
      console.error(result.reason);
      process.exitCode = 1;
    }
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
}
