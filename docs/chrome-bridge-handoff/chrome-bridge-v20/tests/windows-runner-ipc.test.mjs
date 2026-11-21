import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decoder, wire } from '../native/windows-runner-v07/ipc.mjs';

const frame = value => wire(JSON.stringify(value));

test('v07 IPC decoder handles split headers, split UTF-8 and coalesced frames',()=>{
  const expected=[{text:'тест 🧪'},{ok:true}];
  const bytes=Buffer.concat(expected.map(frame));
  const bytewise=[];
  const d=decoder(value=>bytewise.push(value));
  for(const byte of bytes) d.push(Buffer.from([byte]));
  d.end();
  const coalesced=[];
  const bulk=decoder(value=>coalesced.push(value));
  bulk.push(bytes);
  bulk.end();
  assert.deepEqual(bytewise,expected);
  assert.deepEqual(coalesced,expected);
});

test('v07 IPC rejects empty, oversized, truncated, malformed and invalid UTF-8 frames',()=>{
  assert.throws(()=>wire(''),/FRAME_LIMIT/);
  assert.throws(()=>wire('x'.repeat(4097)),/FRAME_LIMIT/);
  for(const bytes of [
    Buffer.from([0,0,0,0]),
    Buffer.from([0,0,16,1]),
    Buffer.from([0,0,0,2,123]),
    Buffer.from([0,0,0,1,123]),
    Buffer.from([0,0,0,1,255])
  ]) {
    const d=decoder(()=>{});
    assert.throws(()=>{d.push(bytes);d.end();});
  }
});

test('v07 decoder rejects trailing partial data after a valid frame',()=>{
  const d=decoder(()=>{});
  d.push(Buffer.concat([frame({ok:true}),Buffer.from([0,0])]));
  assert.throws(()=>d.end(),/TRUNCATED_FRAME/);
});
