const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Rcs380=require('../rcs380.js');
const ack=[0,0,255,0,255,0];
function usb(chunks) {
  return {writes:[],async transferOut(ep,data) {this.writes.push(Array.from(data));return {status:'ok',bytesWritten:data.length};},
    async transferIn() {assert(chunks.length,'Unexpected USB read');const b=Uint8Array.from(chunks.shift());return {status:'ok',data:new DataView(b.buffer)};},async close(){}};
}
(async()=>{
  const packet=Rcs380.frame([0xD7,0x21,1,2]);
  const d=usb([[...ack,...packet.slice(0,5)],Array.from(packet.slice(5))]);
  const r=new Rcs380(d,1,2);
  assert.deepEqual(await r.command(0x20),[1,2]);
  assert.deepEqual(d.writes[0],Array.from(Rcs380.frame([0xD6,0x20])));
  const bad=Array.from(packet); bad[bad.length-2]^=1;
  await assert.rejects(new Rcs380(usb([[...ack,...bad]]),1,2).command(0x20),/checksum/);
  // ATS with TA and TC but no TB must use default FWI, not fixed byte 3.
  r.setAts([4,0x58,0x80,0]);assert.equal(r.miu,253);
  r.setAts([3,0x22,0x40]);assert.equal(r.miu,29);
  assert.throws(()=>r.setAts([2,0x28]),/Missing/);
  r.active=true;r.miu=2;r.bn=0;
  const sent=[]; const responses=[[0xA2],[0x13,0xAA],[0x02,0x90,0]];
  r.exchange=async frame=>{sent.push(frame);return responses.shift();};
  assert.deepEqual(await r.transceive([1,2,3]),[0xAA,0x90,0]);
  assert.deepEqual(sent,[[0x12,1,2],[0x03,3],[0xA2]]);
  // Regression: real RC-S380 trace acknowledges I(0,chained) with A2.
  // The following I-block must have BN=1 and contain only the APDU tail.
  const long=new Rcs380({},1,2);long.active=true;long.miu=253;
  const frames=[];const replies=[[0xA2],[3,0x90,0]];
  long.exchange=async frame=>{frames.push(frame);return replies.shift();};
  const imageApdu=Array.from({length:257},(_,i)=>i&255);
  assert.deepEqual(await long.transceive(imageApdu),[0x90,0]);
  assert.equal(frames.length,2);assert.equal(frames[0][0],0x12);
  assert.deepEqual(frames[1],[3,...imageApdu.slice(253)]);
  const timeout=new Rcs380(usb([[...ack,...Rcs380.frame([0xD7,5,0x80,0,0,0])]]),1,2);
  await assert.rejects(timeout.rf([2]),/status=0x80/);
  const w=new Rcs380({},1,2); const waits=[];let n=0;
  w.rf=async(frame,t)=>{waits.push([frame,t]);return ++n===1?[0xF2,3]:[2,0x90,0];};
  assert.deepEqual(await w.exchange([2,1],500000),[2,0x90,0]);
  assert.deepEqual(waits[1][0],[0xF2,3]);assert(waits[1][1]>=w.fwtUs*3);
  // Type A 7-byte UID, selection, RATS and CRC/bit-count changes.
  const a=new Rcs380({},1,2);const settings=[],rf=[];
  a.setting=async(code,data)=>settings.push([code,data]);
  a.protocol=async data=>settings.push([2,data]);
  const answers=[[0x44,0],[0x88,1,2,3,0x88^1^2^3],[4],[4,5,6,7,4^5^6^7],[0x20],[2,8]];
  a.rf=async data=>{rf.push(data);return answers.shift();};
  await a.activate();assert.deepEqual(a.uid,[1,2,3,4,5,6,7]);assert(a.active);assert.equal(a.miu,253);
  assert.deepEqual(rf[0],[0x26]);assert.deepEqual(rf.at(-1),[0xE0,0x80]);
  // Whole HTML script parses (UTF-8/Japanese preserved).
  const html=fs.readFileSync(__dirname+'/../ezsign-rcs380-writer.html','utf8');
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
  assert(html.includes('productId: 0x06C1'));
  console.log('PASS: framing, split/coalesced USB, checksums, ATS, Type A cascade, APDU/response chaining, WTX, HTML syntax');
})().catch(e=>{console.error(e);process.exitCode=1;});
