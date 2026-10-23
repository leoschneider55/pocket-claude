import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'pocket-vision-preview-'));
process.env.POCKET_HOME = home;
process.env.POCKET_LOG_DIR = join(home, 'logs');
process.env.POCKET_NO_KEYCHAIN = '1';
process.env.POCKET_SKILLS_DIR = join(home, 'no-skills');
process.env.POCKET_WORKSPACE = join(home, 'workspace');
const { generateIdentity, parsePairingUri, serializeIdentity, b64 } = await import('../packages/protocol/src/index.js');
const { DeviceLink, joinAccount } = await import('../packages/transport/src/index.js');
const { startNodeRelay } = await import('../apps/relay/src/node-server.js');
const { Brain } = await import('../apps/brain/src/daemon.js');
const { ensureDirs } = await import('../apps/brain/src/store.js');
ensureDirs();
const relay = await startNodeRelay({ port: 0, host: '127.0.0.1' });
const brain = new Brain(generateIdentity(), { relayUrl: relay.url, devices: [], users: [], allowlist: [], sessions: [], replay: {} }, { persist: false, claudeOptions: { pathToClaudeCodeExecutable: join(home, 'no-claude') } });
brain.start();
async function until(fn: () => unknown, label: string) {
  const deadline = Date.now() + 15000;
  while (!fn()) { if (Date.now() > deadline) throw Error(`Timeout: ${label}`); await new Promise(r => setTimeout(r, 25)); }
}
await until(() => brain.status().relayConnected, 'brain');
const devices: InstanceType<typeof DeviceLink>[] = [];
async function paired(role: 'client' | 'executor', name: string) {
  const code = parsePairingUri(brain.startPairing().uri).code;
  const joined = await joinAccount({ relayUrl: relay.url, code, name, role });
  const link = new DeviceLink({ relayUrl: relay.url, accountId: joined.bundle.accountId, deviceId: joined.deviceId, role, identity: joined.identity, peers: { [joined.bundle.brainDeviceId]: joined.bundle.brainEncPub } });
  devices.push(link); link.connect();
  await until(() => link.isReady, name);
  return { joined, link, send: (message: any) => link.send(joined.bundle.brainDeviceId, message) };
}
const pc = await paired('executor', 'Demo Windows PC');
pc.link.on('message', ({ message }) => {
  if (message.type === 'screen.watch.control') {
    const p = message.payload;
    pc.send({ type: 'screen.watch.status', payload: { sessionId: p.sessionId, watchId: p.watchId, deviceId: pc.joined.deviceId, state: p.enabled ? 'watching' : 'off', settings: p.settings, ...(p.goal ? { goal: p.goal } : {}), ...(!p.enabled ? { reason: 'user' } : {}) } });
  }
});
pc.send({ type: 'executor.status', payload: { workspaces: [], os: 'win32', shell: 'none', capabilities: ['clipboard', 'screenshot', 'computer', 'watch', 'overlay'] } });
const phone = await paired('client', 'Demo phone');
let sessionId = '';
phone.link.on('message', ({ message }) => { if (message.type === 'session.created') sessionId = message.payload.session.sessionId; });
phone.send({ type: 'session.create', payload: { title: 'Claude смотрит · проверка' } });
await until(() => sessionId, 'chat');
phone.send({ type: 'session.configure', payload: { sessionId, executorId: pc.joined.deviceId } });
const creds = { relayUrl: relay.url, accountId: phone.joined.bundle.accountId, deviceId: phone.joined.deviceId, identity: serializeIdentity(phone.joined.identity), brainDeviceId: phone.joined.bundle.brainDeviceId, brainEncPub: phone.joined.bundle.brainEncPub };
phone.link.close();
const seed = `localStorage.setItem('pocketclaude.credentials', ${JSON.stringify(JSON.stringify(creds))}); localStorage.setItem('pc.biometric', '0'); localStorage.removeItem('pc.snapshot'); localStorage.removeItem('pc.replay'); 'synthetic preview seeded';`;
execFileSync('agent-browser', ['eval', seed], { stdio: 'pipe' });
execFileSync('agent-browser', ['open', `http://127.0.0.1:8081/direct/${sessionId}`], { stdio: 'pipe' });
writeFileSync('.hoplite/vision-fixture-state.json', JSON.stringify({ sessionId, pcId: pc.joined.deviceId, route: `/direct/${sessionId}` }));
console.log(JSON.stringify({ ready: true, sessionId, synthetic: true }));
const close = async () => { for (const link of devices) link.close(); brain.stop(); await relay.close(); process.exit(0); };
process.on('SIGINT', close); process.on('SIGTERM', close);
setTimeout(close, 60 * 60 * 1000);
