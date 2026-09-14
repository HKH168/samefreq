import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePassword } from '../functions/samefreq/password.mjs';
const context = (body, auth = {}) => ({body: async()=>body, req:new Request('https://example.com'), anon:{auth}, reply:(d,status=200)=>new Response(JSON.stringify(d),{status})});
test('unconfirmed signup never produces a login session',async()=>{
 const r=await handlePassword(context({email:'a@example.com',password:'password123',mode:'signup'},{signUp:async()=>({data:{user:{id:'u'},session:null}})}));
 const d=await r.json(); assert.equal(d.ok,false);assert.equal(d.confirmation_required,true);assert.equal(d.token,undefined);
});
test('invalid password is rejected before auth request',async()=>{
 const r=await handlePassword(context({email:'a@example.com',password:'x'}));assert.equal(r.status,400);
});
test('password setting requires a verified owner',async()=>{
 const r=await handlePassword(context({mode:'set',password:'password123'}));assert.equal(r.status,401);
});
test('login returns real access and refresh tokens',async()=>{
 const r=await handlePassword(context({email:'a@example.com',password:'password123'},{signInWithPassword:async()=>({data:{user:{id:'real-id'},session:{access_token:'access',refresh_token:'refresh',expires_at:42}}})}));
 const d=await r.json();assert.equal(d.token,'access');assert.equal(d.refresh_token,'refresh');assert.equal(d.user.id,'real-id');
});
