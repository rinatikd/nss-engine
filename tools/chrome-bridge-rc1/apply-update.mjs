// Creates a separate candidate from the exact original release. Never modifies source.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const kit=path.dirname(fileURLToPath(import.meta.url));
const digest=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
function relative(root,name){
 if(typeof name!=='string'||!name||name.includes('\\')||name.includes(':')||path.posix.isAbsolute(name)||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('INVALID_MANIFEST_PATH');
 return path.join(root,...name.split('/'));
}
function assertNoLinkedAncestors(target){
 const parsed=path.parse(target);let current=parsed.root;
 for(const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('SOURCE_LINK_NOT_ALLOWED');
 }
}
function contains(base,target){const rel=path.relative(base,target);return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));}
function readRegular(root,name){
 const target=relative(root,name);let current=root;
 if(fs.lstatSync(root).isSymbolicLink())throw Error('SOURCE_LINK_NOT_ALLOWED');
 for(const part of name.split('/')){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('SOURCE_LINK_NOT_ALLOWED');}
 if(!fs.statSync(target).isFile())throw Error('SOURCE_FILE_REQUIRED');
 return fs.readFileSync(target);
}
try{
 const args=process.argv.slice(2),options={};
 for(let i=0;i<args.length;i+=2){if(!['--source','--output'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('Use --source <original chrome-bridge folder> --output <new candidate folder>');options[args[i]]=args[i+1];}
 if(!options['--source']||!options['--output'])throw Error('SOURCE_AND_OUTPUT_REQUIRED');
 const source=path.resolve(options['--source']),output=path.resolve(options['--output']);
 assertNoLinkedAncestors(source);assertNoLinkedAncestors(output);
 if(contains(source,output)||contains(output,source)||contains(kit,output)||contains(output,kit))throw Error('OUTPUT_MUST_BE_SEPARATE');
 if(fs.existsSync(output))throw Error('OUTPUT_ALREADY_EXISTS_CHOOSE_NEW_FOLDER');
 const manifest=JSON.parse(fs.readFileSync(path.join(kit,'update-manifest.json'),'utf8'));
 if(manifest.schemaVersion!==1)throw Error('UNSUPPORTED_MANIFEST');
 // Capture and hash exact bytes before creating output. Unlisted local files,
 // including credentials and runtime state, are never copied.
 const content=new Map();
 for(const [name,expected] of Object.entries(manifest.originalFiles)){
  const raw=readRegular(source,name);
  if(digest(raw)!==expected)throw Error('ORIGINAL_SOURCE_MISMATCH: '+name);
  content.set(name,raw);
 }
 for(const [name,expected] of Object.entries(manifest.updatedFiles)){
  const raw=readRegular(path.join(kit,'overlay'),name);
  if(digest(raw)!==expected)throw Error('UPDATE_INTEGRITY_FAILURE: '+name);
  content.set(name,raw);
 }
 fs.mkdirSync(output,{recursive:true,mode:0o700});
 for(const [name,raw] of content){const target=relative(output,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,raw,{flag:'wx'});}
 for(const [name,raw] of content){if(digest(fs.readFileSync(relative(output,name)))!==digest(raw))throw Error('OUTPUT_VERIFICATION_FAILED: '+name);}
 fs.writeFileSync(path.join(output,'CANDIDATE_READY.json'),JSON.stringify({version:manifest.version,files:content.size,verified:true,createdAt:new Date().toISOString(),originalArchiveSha256:manifest.originalArchiveSha256},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({version:manifest.version,files:content.size,verified:true,output,originalUnchanged:true,nativeWindowsVerified:false,liveWebsitesVerified:false},null,2));
}catch(error){
 console.error(error.message?.match(/^(Use |SOURCE_|INVALID_|OUTPUT_|UNSUPPORTED_|ORIGINAL_|UPDATE_)/)?error.message:'UPDATE_FAILED: source missing, unreadable or incomplete; original files were not modified.');process.exitCode=1;
}
