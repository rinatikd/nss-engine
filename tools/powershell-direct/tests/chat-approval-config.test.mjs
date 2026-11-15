import test from 'node:test';
import assert from 'node:assert/strict';
import {configureSignedChatApproval} from './chat-approval-config.mjs';
test('disabled unless explicit ENABLE=1',()=>{
 assert.equal(configureSignedChatApproval({}),null);
 assert.throws(()=>configureSignedChatApproval({
  PS_DIRECT_CHAT_APPROVAL_ENABLE:'true'
 }),/CHAT_APPROVAL_INVALID_SWITCH/);
});
test('cannot enable without separate trust, key file, subject and replay dir',()=>{
 assert.throws(()=>configureSignedChatApproval({
  PS_DIRECT_CHAT_APPROVAL_ENABLE:'1'
 }),/CHAT_APPROVAL_TRUST_NOT_PROVISIONED/);
});
