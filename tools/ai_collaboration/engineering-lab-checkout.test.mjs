import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {preflightLabCheckout} from './engineering-runner.mjs';
import {validateEngineeringRequest} from './engineering-plan.mjs';

const source='C:\\Engineering\\ChromeBridge-Recovery-Install-20261114';
const plan=()=>({operation:'lab-checkout-pr115',cwd:source});
const fakeFs=({exists=false,parent='C:\\Engineering',isDir=true,lstatError='ENOENT'}={})=>({
 existsSync:()=>exists,
 lstatSync:()=>{
  if(lstatError){const e=Error(lstatError);e.code=lstatError;throw e;}
  return {isDirectory:()=>true};
 },
 realpathSync:{native:()=>parent},
 statSync:()=>({isDirectory:()=>isDir})
});
test('bounded lab checkout accepts only an exact trusted source and no target',()=>{
 const good={requestId:'lab-pr115-20261115-r1',operation:'lab-checkout-pr115',workspace:source};
 assert.equal(validateEngineeringRequest(good),good);
 for(const args of [
  {...good,target:'other'},
  {...good,scriptArgs:['--upload-pack=evil']},
  {...good,port:17486},
  {...good,operation:'git-clone'},
 ]){
  if(args.scriptArgs)assert.throws(()=>validateEngineeringRequest(args),/UNSAFE_SCRIPT_ARGUMENTS/);
  else assert.throws(()=>validateEngineeringRequest(args));
 }
});
test('lab preflight passes only fresh destination under canonical parent',()=>{
 assert.doesNotThrow(()=>preflightLabCheckout(plan(),{fsImpl:fakeFs()}));
});
test('lab preflight rejects existing destination, parent redirection and non-directory',()=>{
 for(const fixture of [
  {exists:true}, {parent:'C:\\Engineering-Junction'},
  {isDir:false}, {lstatError:null}
 ]){
  assert.throws(()=>preflightLabCheckout(plan(),{fsImpl:fakeFs(fixture)}),/LAB_/);
 }
});
test('lab preflight rejects source outside fixed safe checkout',()=>{
 assert.throws(()=>preflightLabCheckout({
  ...plan(),cwd:'C:\\Engineering\\Other'
 },{fsImpl:fakeFs()}),/LAB_SOURCE_WORKSPACE_NOT_ALLOWED/);
});
