import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const runId = randomBytes(6).toString('hex');
const project = `callzo-verify-${runId}`;
const env = { ...process.env, API_PORT: '0', MONTHLY_CAP_CENTS: '500' };
function run(command, args, optional = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 || optional ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
const compose = (args, optional = false) => run('docker', ['compose', '-p', project, ...args], optional);
let created = false;
try {
  await run(process.execPath, ['scripts/setup-env.mjs']);
  await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  created = true;
  await compose(['-f', 'compose.test.yaml', 'up', '--build', '--abort-on-container-exit', '--exit-code-from', 'test']);
  await compose(['up', '--build', '-d', '--wait', '--wait-timeout', '120', 'api']);
  await compose(['run', '--rm', '--no-deps', 'simulator']);
  const verify = ['exec', '-T', '-e', `VERIFY_RUN_ID=${runId}`, '-e', 'EXPECT_SIMULATOR_EVENTS=1',
    'api', 'node', 'dist/verify.js'];
  await compose(verify);
  await compose(['restart', 'api']);
  await compose(['up', '-d', '--wait', '--wait-timeout', '60', 'api']);
  await compose([...verify, '--check-persisted']);
  await compose(['exec', '-T', 'api', 'node', 'dist/reconcile.js']);
  console.log('Native integration, simulator, HTTP verification, restart persistence, and reconciliation passed.');
} catch (error) {
  console.error(error.message);
  if (created) await compose(['logs', '--tail', '40', 'api'], true);
  process.exitCode = 1;
} finally {
  // Only remove resources in this invocation's randomly named test project.
  if (created) {
    await compose(['down', '--volumes', '--remove-orphans'], true);
    await compose(['-f', 'compose.test.yaml', 'down', '--volumes', '--remove-orphans'], true);
  }
}
