import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {canonicalUserWorkspace} from './workspace-policy.mjs';

test('accepts any existing user-selected directory without a configured root list',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'psdirect-any-workspace-'));
 try{
  const other=path.join(root,'project');await mkdir(other);
  assert.equal(canonicalUserWorkspace(other),other);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('rejects a missing workspace and a file path',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'psdirect-invalid-workspace-'));
 const file=path.join(root,'file.txt');await writeFile(file,'x');
 try{
  assert.throws(()=>canonicalUserWorkspace(path.join(root,'missing')),/WORKSPACE_NOT_FOUND/);
  assert.throws(()=>canonicalUserWorkspace(file),/WORKSPACE_NOT_DIRECTORY/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('resolves a workspace junction before approval',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'psdirect-link-root-'));
 const target=await mkdtemp(path.join(tmpdir(),'psdirect-link-target-'));
 try{
  const link=path.join(root,'project-link');
  try{await symlink(target,link,'dir');}
  catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code))return;throw error;}
  assert.equal(canonicalUserWorkspace(link),target);
 }finally{
  await rm(root,{recursive:true,force:true});
  await rm(target,{recursive:true,force:true});
 }
});

test('denies filesystem volume roots and OS protected folders, not ordinary user folders',()=>{
 const fakeRealpath=p=>path.win32.normalize(p);
 const fakeStat=()=>({isDirectory:()=>true});
 const env={
  SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',
  ProgramFiles:'C:\\Program Files','ProgramFiles(x86)':'C:\\Program Files (x86)',
  ProgramW6432:'C:\\Program Files'
 };
 assert.throws(()=>canonicalUserWorkspace('C:\\',{
  platform:'win32',env,realpath:fakeRealpath,stat:fakeStat
 }),/WORKSPACE_VOLUME_ROOT_DENIED/);
 assert.throws(()=>canonicalUserWorkspace('C:\\Windows\\System32',{
  platform:'win32',env,realpath:fakeRealpath,stat:fakeStat
 }),/WORKSPACE_PROTECTED_SYSTEM_LOCATION/);
 assert.equal(canonicalUserWorkspace('C:\\Users\\Rinat\\Downloads\\NSS_Engine',{
  platform:'win32',env,realpath:fakeRealpath,stat:fakeStat
 }),'C:\\Users\\Rinat\\Downloads\\NSS_Engine');
});

test('rejects UNC/device workspaces including canonical network targets',()=>{
 const fakeStat=()=>({isDirectory:()=>true});
 const env={SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',
  ProgramFiles:'C:\\Program Files','ProgramFiles(x86)':'C:\\Program Files (x86)',
  ProgramW6432:'C:\\Program Files'};
 const common={platform:'win32',env,stat:fakeStat};
 assert.throws(()=>canonicalUserWorkspace('\\\\server\\share',{
  ...common,realpath:p=>path.win32.normalize(p)
 }),/WORKSPACE_NETWORK_PATH_DENIED/);
 assert.throws(()=>canonicalUserWorkspace('//server/share',{
  ...common,realpath:p=>path.win32.normalize(p)
 }),/WORKSPACE_NETWORK_PATH_DENIED/);
 assert.throws(()=>canonicalUserWorkspace('C:\\Users\\Rinat\\network-link',{
  ...common,realpath:()=> '\\\\?\\UNC\\server\\share'
 }),/WORKSPACE_NETWORK_PATH_DENIED/);
 assert.throws(()=>canonicalUserWorkspace('\\\\.\\PhysicalDrive0',{
  ...common,realpath:p=>path.win32.normalize(p)
 }),/WORKSPACE_DEVICE_PATH_DENIED/);
});
