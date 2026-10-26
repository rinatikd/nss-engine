// РРјРёС‚Р°С†РёСЏ РґРІСѓС… С‡Р°С‚-СЃР°Р№С‚РѕРІ РґР»СЏ e2e: /dev (contenteditable) Рё /rev (textarea). HTTPS, СЃР°РјРѕРїРѕРґРїРёСЃР°РЅРЅС‹Р№ СЃРµСЂС‚РёС„РёРєР°С‚.
import https from 'node:https';
import fs from 'node:fs';

const page = (agent, editable) => `<!doctype html><meta charset=utf-8><title>fake ${agent}</title>
<style>.assistant,.user{margin:6px;padding:6px;border:1px solid #ccc}</style>
<div id=chat></div>
${editable ? '<div id=composer contenteditable=true style="border:1px solid #000;min-height:30px"></div>' : '<textarea id=composer></textarea>'}
<button id=send disabled>Send</button><button id=stop style="display:none">Stop</button>
<script>
const agent=${JSON.stringify(agent)}, c=document.getElementById('composer'), send=document.getElementById('send'), stop=document.getElementById('stop'), chat=document.getElementById('chat');
const val=()=>c.value!==undefined?c.value:c.innerText;
const upd=()=>{send.disabled=!val().trim()};
c.addEventListener('input',upd); c.addEventListener('paste',e=>{ if(c.isContentEditable){ e.preventDefault(); document.execCommand('insertText',false,e.clipboardData.getData('text/plain')); upd(); } });
send.onclick=async()=>{
  const text=val().trim(); if(!text)return;
  const u=document.createElement('div');u.className='user';u.textContent=text;chat.append(u);
  if(c.value!==undefined)c.value='';else c.innerText='';
  upd(); send.style.display='none'; stop.style.display='';
  const a=document.createElement('div');a.className='assistant';chat.append(a);
  const r=await (await fetch('/api/reply',{method:'POST',body:JSON.stringify({agent,text})})).json();
  let i=0; const iv=setInterval(()=>{ a.innerText=r.reply.slice(0,i+=25); if(i>=r.reply.length){clearInterval(iv);a.innerText=r.reply;stop.style.display='none';send.style.display='';}},120);
};
</script>`;

export function startFakeChat({ port = 443, key, cert, reply }) {
  const received = [];
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/reply') {
      let b = ''; for await (const c of req) b += c;
      const { agent, text } = JSON.parse(b);
      received.push({ agent, text });
      const out = reply(agent, text, received.filter((r) => r.agent === agent).length);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ reply: out }));
    }
    const m = req.url.match(/^\/(dev|rev|dev2)/);
    res.writeHead(m ? 200 : 404, { 'Content-Type': 'text/html' });
    res.end(m ? page(m[1], m[1] !== 'rev') : 'not found');
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, received })));
}

