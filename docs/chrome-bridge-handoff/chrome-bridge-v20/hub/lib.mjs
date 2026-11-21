// Small, dependency-free parsers used by the local multi-agent hub.
function balancedJsonCandidates(text) {
  const out=[];
  let start=-1, depth=0, quoted=false, escaped=false;
  for(let i=0;i<text.length;i++) {
    const ch=text[i];
    if(start<0) {
      if(ch==='{') { start=i; depth=1; quoted=false; escaped=false; }
      continue;
    }
    if(quoted) {
      if(escaped) escaped=false;
      else if(ch==='\\') escaped=true;
      else if(ch==='"') quoted=false;
      continue;
    }
    if(ch==='"') quoted=true;
    else if(ch==='{') depth++;
    else if(ch==='}') {
      depth--;
      if(depth===0) {
        out.push(text.slice(start,i+1));
        start=-1;
      }
    }
  }
  return out;
}

export function extractVerdict(input) {
  if(typeof input!=='string') return null;
  const fence=String.fromCharCode(96).repeat(3);
  const fenced=[...input.matchAll(new RegExp(fence+'(?:json)?\\s*([\\s\\S]*?)\\s*'+fence,'gi'))].map(m=>m[1]);
  const candidates=[...fenced,...balancedJsonCandidates(input)];
  for(const candidate of candidates) {
    try {
      const value=JSON.parse(candidate);
      if(value && !Array.isArray(value) && typeof value==='object' &&
         Number.isFinite(value.score) && typeof value.verdict==='string')
        return value;
    } catch {}
  }
  return null;
}

export function extractFiles(input) {
  if(typeof input!=='string') throw Error('Invalid file payload');
  const out=[];
  const pattern=/^=== FILE: ([^\r\n]+) ===\r?\n([\s\S]*?)^=== END FILE ===\s*$/gm;
  let match;
  while((match=pattern.exec(input))!==null) {
    const filePath=match[1].trim();
    const normalized=filePath.replace(/\\/g,'/');
    const parts=normalized.split('/');
    if(!filePath || normalized.startsWith('/') || /^[A-Za-z]:/.test(filePath) ||
       parts.some(part=>part==='..'||part==='.'||part===''))
      throw Error('Unsafe file path');
    out.push({path:normalized,content:match[2]});
  }
  if(!out.length) throw Error('No files found');
  return out;
}

export function deepRender(value, variables) {
  if(typeof value==='string') {
    return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,(_all,key)=>{
      const result=key.split('.').reduce((current,part)=>
        current && Object.prototype.hasOwnProperty.call(current,part) ? current[part] : undefined,variables);
      return result===undefined || result===null ? '' : String(result);
    });
  }
  if(Array.isArray(value)) return value.map(item=>deepRender(item,variables));
  if(value && typeof value==='object') {
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,deepRender(item,variables)]));
  }
  return value;
}
