import test from 'node:test';
import assert from 'node:assert/strict';
import {NAMED_SUITE_TOOLS,createNamedSuiteHandlers} from './local_mcp_dispatch.mjs';

test('MCP tool schemas have no shell, command or approval properties',()=>{
  assert.equal(NAMED_SUITE_TOOLS.length,2);
  const submit=NAMED_SUITE_TOOLS[0];
  assert.deepEqual(Object.keys(submit.inputSchema.properties).sort(),
    ['requestId','suite','workspace']);
  assert.equal(submit.inputSchema.additionalProperties,false);
  assert.equal(submit.inputSchema.properties.suite.enum.includes('chrome-pr113-node'),true);
});

test('submit passes fixed identity and workspace, not model-authored approval',async()=>{
  let captured;
  const handlers=createNamedSuiteHandlers({
    async submit(args){captured=args;return {state:'PENDING_LOCAL_APPROVAL'};},
    async status(){return {state:'NOT_FOUND'};}
  });
  const r=await handlers.powershell_named_suite_submit({
    requestId:'pr113-tests-001',suite:'chrome-pr113-node',
    workspace:'C:\\Engineering\\ChromeBridge-PR113-Lab'
  });
  assert.equal(r.state,'PENDING_LOCAL_APPROVAL');
  assert.equal(Object.hasOwn(captured,'approved'),false);
});

test('reject injection and arbitrary commands at MCP adapter boundary',async()=>{
  let calls=0;
  const h=createNamedSuiteHandlers({
    async submit(){calls++;},async status(){calls++;}
  });
  await assert.rejects(h.powershell_named_suite_submit({
    requestId:'pr113-tests-002',suite:'powershell.exe -Command test',
    workspace:'C:\\Engineering'
  }),/SUITE_NOT_ALLOWLISTED/);
  await assert.rejects(h.powershell_named_suite_submit({
    requestId:'pr113-tests-003',suite:'chrome-pr113-node',
    workspace:'C:\\Engineering',approved:true
  }),/INVALID_TOOL_ARGUMENTS/);
  assert.equal(calls,0);
});

test('status reads only, does not dispatch a job',async()=>{
  let submits=0,reads=0;
  const h=createNamedSuiteHandlers({
    async submit(){submits++;},
    async status(id){reads++;return {requestId:id,state:'FINISHED'};}
  });
  assert.equal((await h.powershell_named_suite_status({requestId:'pr113-tests-004'})).state,'FINISHED');
  assert.equal(reads,1);assert.equal(submits,0);
});
