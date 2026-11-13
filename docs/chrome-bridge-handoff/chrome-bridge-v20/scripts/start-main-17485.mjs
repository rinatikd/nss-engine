// Isolated main-profile lab server entrypoint. Does not alter PR102/prod.
// Explicit CLI arguments, new state ownership marker and strict extension pin.
import fs from 'node:fs';
import path from 'node:path';
import { createBridge, loadConfig } from '../server/bridge.mjs';

const PORT=17485;
const MARKER='.chrome-bridge-main-17485-owned';
const EXT=/^[a-p]{32}$/;
function options(argv) {
  if (argv.length!==4 || argv[0]!=='--state' || argv[2]!=='--extension-id')
    throw Error('USAGE: node start-main-17485.mjs --state NEW_ISOLATED_DIRECTORY --extension-id CHROME_EXTENSION_ID');
  return {state:path.resolve(argv[1]),extensionId:argv[3]};
}
function guardState(state) {
  const normalized=state.toLowerCase().replaceAll('\\','/');
  if (!path.isAbsolute(state) || !normalized.includes('chrome') ||
      !normalized.includes('17485') ||
      /(?:^|\/)(?:\.chrome-bridge|chrome-bridge-pr102|chrome-bridge-rc1)(?:\/|$)/i.test(normalized))
    throw Error('UNSAFE_OR_SHARED_STATE_PATH');
  const marker=path.join(state,MARKER);
  if (fs.existsSync(state)) {
    if (!fs.statSync(state).isDirectory() || fs.lstatSync(state).isSymbolicLink())
      throw Error('STATE_NOT_SECURE_DIRECTORY');
    if (!fs.existsSync(marker) || fs.readFileSync(marker,'utf8').trim()!=='MAIN_CHROME_17485')
      throw Error('STATE_NOT_OWNED_BY_THIS_LAB');
  } else {
    fs.mkdirSync(state,{recursive:true,mode:0o700});
    fs.writeFileSync(marker,'MAIN_CHROME_17485\n',{flag:'wx',mode:0o600});
  }
}
const {state,extensionId}=options(process.argv.slice(2));
if (!EXT.test(extensionId)) throw Error('EXTENSION_ID_REQUIRED');
if (process.env.CHROME_BRIDGE_CODEX_POLICY) throw Error('CODEX_POLICY_NOT_PERMITTED_IN_MAIN_READONLY_LAB');
if (process.env.CHROME_BRIDGE_PORT && Number(process.env.CHROME_BRIDGE_PORT)!==PORT)
  throw Error('SERVER_PORT_CONFLICT');
if (process.env.CHROME_BRIDGE_HOME &&
    path.resolve(process.env.CHROME_BRIDGE_HOME)!==state)
  throw Error('SERVER_STATE_CONFLICT');
if (process.env.CHROME_BRIDGE_EXTENSION_ID &&
    process.env.CHROME_BRIDGE_EXTENSION_ID!==extensionId)
  throw Error('EXTENSION_PIN_CONFLICT');
guardState(state);
const config=loadConfig(state);
if (config.extensionId && config.extensionId!==extensionId)
  throw Error('STATE_EXTENSION_ID_CONFLICT');
if (!config.extensionId) {
  config.extensionId=extensionId;
  // Persist the pin for later starts without copying any existing credentials.
  fs.writeFileSync(path.join(state,'config.json'),
    JSON.stringify(config,null,2),{mode:0o600});
}
const server=createBridge(config,{stateDir:state});
server.once('error', e => {console.error('MAIN_LAB_LISTEN_FAILED:',e.code || e.name);process.exitCode=1;});
server.listen(PORT,'127.0.0.1',()=>
  console.error('MAIN_CHROME_17485_READY: loopback bound, extension origin pinned; read grants OFF'));
