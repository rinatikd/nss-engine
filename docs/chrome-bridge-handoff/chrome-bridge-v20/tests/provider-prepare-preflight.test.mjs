import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const page=fs.readFileSync(path.join(here,'../extension/page.js'),'utf8');

test('provider_prepare validates exactly one visible enabled Send control before composer mutation',()=>{
  const start=page.indexOf("if (name === 'provider_prepare')");
  const end=page.indexOf("if (name === 'provider_commit')",start);
  assert.ok(start>=0&&end>start,'provider_prepare implementation must exist');
  const body=page.slice(start,end);
  const sendCheck=body.indexOf("const sendButtons = qa(A.send).filter(vis)");
  const sendReject=body.indexOf("throw Error('PROVIDER_SEND_BUTTON_NOT_READY')");
  const composerFocus=body.indexOf('composer.focus()');
  const composerWrite=body.indexOf("set.call(composer, args.message)");
  assert.ok(sendCheck>=0&&sendReject>sendCheck,'Send selector must be checked');
  assert.ok(composerFocus>sendReject,'Send preflight must precede composer focus');
  assert.ok(composerWrite>sendReject,'Send preflight must precede composer write');
  assert.equal((body.match(/const sendButtons =/g)||[]).length,1,
    'Send preflight should have one authoritative check before mutation');
});
