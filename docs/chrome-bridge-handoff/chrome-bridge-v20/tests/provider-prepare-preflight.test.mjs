import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const page=fs.readFileSync(path.join(here,'../extension/page.js'),'utf8');
const mutation=fs.readFileSync(path.join(here,'../extension/mutation-dispatch.js'),'utf8');
const bridge=fs.readFileSync(path.join(here,'../server/bridge.mjs'),'utf8');
const journal=fs.readFileSync(path.join(here,'../server/provider-journal.mjs'),'utf8');

test('provider_prepare identifies one visible actionable Send selector before composer mutation',()=>{
  const start=page.indexOf("if (name === 'provider_prepare')");
  const end=page.indexOf("if (name === 'provider_commit')",start);
  assert.ok(start>=0&&end>start,'provider_prepare implementation must exist');
  const body=page.slice(start,end);
  const selectorStart=body.indexOf('const sendSelector =');
  const sendCheck=body.indexOf('const initialSendButtons = qa(sendSelector).filter(vis)');
  const composerFocus=body.indexOf('composer.focus()');
  const composerWrite=body.indexOf("set.call(composer, args.message)");
  assert.ok(selectorStart>=0&&sendCheck>selectorStart,'Send selector preflight must exist');
  assert.ok(sendCheck<composerFocus,'Send selector must be checked before composer focus');
  assert.ok(sendCheck<composerWrite,'Send selector must be checked before composer write');
  const preMutation=body.slice(selectorStart,composerFocus);
  assert.match(preMutation,/PROVIDER_SEND_SELECTOR_UNCALIBRATED/);
  assert.match(preMutation,/PROVIDER_SEND_SELECTOR_NOT_UNIQUE/);
  assert.match(preMutation,/PROVIDER_SEND_SELECTOR_NOT_ACTIONABLE/);
  assert.doesNotMatch(preMutation,/\.disabled|aria-disabled/,
    'a button disabled only because the composer is empty must still calibrate');
});

test('provider_prepare requires an enabled unique Send control after input and verifies rollback on failure',()=>{
  const start=page.indexOf("if (name === 'provider_prepare')");
  const end=page.indexOf("if (name === 'provider_commit')",start);
  const body=page.slice(start,end);
  const write=body.indexOf('composer.focus()');
  const ready=body.indexOf('const readySendButtons = qa(sendSelector).filter(vis)');
  const disabled=body.indexOf('readySendButtons[0].disabled');
  const rollback=body.indexOf("PROVIDER_PREPARE_ROLLBACK_UNVERIFIED");
  assert.ok(write>=0&&ready>write,'post-input Send check must follow composer input');
  assert.ok(disabled>ready,'post-input Send check must require enabled button');
  assert.ok(rollback>disabled,'failed readiness must report an unverified rollback');
  assert.match(body,/dispatchState: 'NOT_PERFORMED'/);
  assert.match(body,/sideEffect: cleared \? 'composer-cleared' : 'composer-draft-may-remain'/);
});

test('provider_prepare failures after injection remain no-send outcomes while provider_commit stays conservative',()=>{
  assert.match(mutation,/cmd\.name==='provider_prepare'[\s\S]*?error\.dispatchState='NOT_PERFORMED'/);
  assert.match(mutation,/composer-draft-state-unverified/);
  const rpcCatch=bridge.slice(bridge.indexOf("const providerMutation = params.name === 'provider_prepare'"),bridge.indexOf("    } else return",bridge.indexOf("const providerMutation = params.name === 'provider_prepare'")));
  assert.match(rpcCatch,/params\.name === 'provider_prepare' \? 'NOT_PERFORMED' : 'UNKNOWN'/);
  assert.match(rpcCatch,/validDispatchState/);
  const prepareCatch=bridge.slice(bridge.indexOf("const state=error?.dispatchState==='BLOCKED'?"),
    bridge.indexOf("async provider_commit",bridge.indexOf("const state=error?.dispatchState==='BLOCKED'?")));
  assert.match(prepareCatch,/error\?\.sideEffect/);
  const commitCatch=bridge.slice(bridge.indexOf("const state=error?.dispatchState==='BLOCKED'?",bridge.indexOf("async provider_commit")),
    bridge.indexOf("async provider_status",bridge.indexOf("async provider_commit")));
  assert.match(commitCatch,/error\?\.sideEffect/);
  assert.match(page,/providerPrepareMutationStarted = true/);
  assert.match(page,/failure\.sideEffect = providerPrepareMutationStarted \? 'composer-draft-state-unverified' : 'none'/);
  assert.match(page,/providerCommitClickStarted = true;/);
  assert.match(page,/mutationSideEffectStarted = true;\s*sendButtons\[0\]\.click\(\)/);
  assert.match(page,/failure\.dispatchState = providerCommitClickStarted \? 'UNKNOWN' : 'NOT_PERFORMED'/);
  assert.match(page,/send-click-may-have-fired/);
  assert.match(journal,/typeof data\.sideEffect==='string'\?\{sideEffect:data\.sideEffect\}:\{\}/);
  assert.match(journal,/tx\.sideEffect\?\{sideEffect:tx\.sideEffect\}:\{\}/);
});
