/* RC-S380/S Port-100 transport. Wire format checked against nfcpy 1.0.4.
 * Independent implementation; no nfcpy source is bundled.
 */
class Rcs380 {
  constructor(device, epIn, epOut, trace = () => {}) {
    Object.assign(this, {device, epIn, epOut, trace});
    this.pending = new Uint8Array();
    this.uid = [];
    this.miu = 13;
    this.fwtUs = 5000;
    this.bn = 0;
    this.active = false;
  }
  static frame(data) {
    const lo = data.length & 255, hi = data.length >>> 8;
    return Uint8Array.from([0,0,255,255,255,lo,hi,(-lo-hi)&255,
      ...data,(-data.reduce((a,b)=>a+b,0))&255,0]);
  }
  async write(data) {
    const r = await this.device.transferOut(this.epOut, data);
    if (r.status !== 'ok' || r.bytesWritten !== data.length) throw new Error('RC-S380 USB write failed');
  }
  async readFrame() {
    for (;;) {
      const b = this.pending;
      if (b.length >= 6) {
        if (b[0] !== 0 || b[1] !== 0 || b[2] !== 255) throw new Error('Invalid Port-100 preamble');
        if (b[3] === 0 && b[4] === 255 && b[5] === 0) {
          this.pending = b.slice(6); return null;
        }
        if (b[3] !== 255 || b[4] !== 255) throw new Error('Invalid Port-100 frame');
        if (b.length >= 8) {
          const n = b[5] | b[6] << 8;
          if (((b[5]+b[6]+b[7])&255) !== 0 || n > 4096) throw new Error('Invalid Port-100 length');
          if (b.length >= n+10) {
            const data = b.slice(8,8+n);
            if (((data.reduce((a,v)=>a+v,0)+b[8+n])&255) !== 0 || b[9+n] !== 0) throw new Error('Port-100 checksum error');
            this.pending = b.slice(n+10); return data;
          }
        }
      }
      const r = await this.device.transferIn(this.epIn, 4096);
      if (r.status !== 'ok' || !r.data || !r.data.byteLength) throw new Error('RC-S380 USB read failed');
      const next = new Uint8Array(r.data.buffer,r.data.byteOffset,r.data.byteLength);
      this.pending = Uint8Array.from([...this.pending,...next]);
    }
  }
  async command(code, data = []) {
    let timer;
    try {
      return await Promise.race([this.commandIO(code,data), new Promise((_,reject)=>{
        timer=setTimeout(()=>{
          this.active=false;
          this.device.close().catch(()=>{});
          reject(new Error('RC-S380 USB timeout; disconnect and reconnect'));
        },15000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async commandIO(code, data = []) {
    this.trace('Port-100 TX', [0xD6,code,...data]);
    await this.write(Rcs380.frame([0xD6,code,...data]));
    let ack = false, r;
    for (let i=0;i<8;i++) {
      r=await this.readFrame();
      if (r===null) { ack=true; continue; }
      if (ack && r[0]===0xD7 && r[1]===code+1) break;
      if (!this.starting) throw new Error('Port-100 ACK/response mismatch; reconnect reader');
    }
    if (!r || r[0] !== 0xD7 || r[1] !== code+1) throw new Error('Unexpected Port-100 response');
    this.trace('Port-100 RX', Array.from(r));
    return Array.from(r.slice(2));
  }
  async setting(code, data) {
    const r = await this.command(code,data);
    if (r.length !== 1 || r[0] !== 0) throw new Error(`Port-100 setting ${code.toString(16)} failed: ${r}`);
  }
  async init() {
    // ACK aborts a previous transaction. Skip stale startup packets until
    // the ACK and matching SetCommandType response have both arrived.
    this.starting=true;
    await this.write(Uint8Array.from([0,0,255,0,255,0]));
    try { await this.setting(0x2A,[1]); }
    finally { this.starting=false; }
    this.firmware = await this.command(0x20);
    await this.command(0x22);
    await this.setting(6,[0]);
  }
  async protocol(data) { await this.setting(2,data); }
  async rf(data, timeoutUs = 500000) {
    const units = Math.min(65535,(Math.ceil(timeoutUs/1000)+1)*10);
    const r = await this.command(4,[units&255,units>>>8,...data]);
    if (r.length < 4) throw new Error('Short InCommRF status');
    const status = (r[0]|r[1]<<8|r[2]<<16|r[3]<<24)>>>0;
    if (status) throw new Error(`InCommRF status=0x${status.toString(16)}`);
    if (r.length < 5) throw new Error('Short InCommRF response');
    return r.slice(5);
  }
  async activate() {
    this.active = false; this.bn = 0; this.uid = [];
    await this.setting(6,[0]);
    await new Promise(r=>setTimeout(r,300));
    await this.setting(0,[2,3,15,3]);
    await this.protocol([0,24,1,1,2,1,3,0,4,0,5,0,6,0,7,8,8,0,9,0,10,0,11,0,12,0,14,4,15,0,16,0,17,0,18,0,19,6]);
    await this.protocol([0,6,1,0,2,0,5,1,7,7]);
    const atqa = await this.rf([0x26],30000);
    if (atqa.length !== 2) throw new Error('No Type A tag');
    await this.protocol([7,8,4,1]);
    let selected = false;
    for (const cascade of [0x93,0x95,0x97]) {
      await this.protocol([1,0,2,0]);
      const uid = await this.rf([cascade,0x20],30000);
      if (uid.length !== 5 || (uid[0]^uid[1]^uid[2]^uid[3]) !== uid[4]) throw new Error('Invalid UID/BCC (place one tag)');
      await this.protocol([1,1,2,1]);
      const sak = await this.rf([cascade,0x70,...uid],30000);
      if (sak.length !== 1) throw new Error('Invalid SAK');
      this.uid.push(...uid.slice((sak[0]&4)?1:0,4));
      if (!(sak[0]&4)) {
        // Explicit Type4A activation: do not rely on generic tag detection.
        selected = true; break;
      }
    }
    if (!selected) throw new Error('Type A cascade incomplete');
    const ats = await this.rf([0xE0,0x80],30000);
    this.setAts(ats);
    this.active = true;
    return ats;
  }
  setAts(ats) {
    if (ats.length < 2 || ats[0] !== ats.length || (ats[1]&15)>8) throw new Error('Invalid ATS');
    const fsc = [16,24,32,40,48,64,96,128,256][ats[1]&15];
    let i = 2, fwi = 4;
    if (ats[1]&0x10) i++;
    if (ats[1]&0x20) {
      if (i >= ats.length) throw new Error('Missing ATS TB');
      fwi = ats[i++]>>>4;
    }
    if (ats[1]&0x40) i++;
    if (i>ats.length || fwi>14) throw new Error('Invalid ATS parameters');
    this.miu = fsc-3;
    this.fwtUs = 4096/13.56 * 2**fwi;
  }
  async exchange(frame, timeoutUs) {
    let r = await this.rf(frame,timeoutUs);
    for (let i=0; r.length && (r[0]&0xF7)===0xF2; i++) {
      const multiplier = r[1]&63;
      if (i>=20 || r.length!==2 || (r[0]&8) || !multiplier || multiplier>59) throw new Error('Invalid/excessive WTX');
      r = await this.rf(r,Math.ceil(this.fwtUs*multiplier+5000));
    }
    if (!r.length) throw new Error('Empty ISO-DEP response');
    return r;
  }
  async transceive(apdu, timeoutUs=500000) {
    if (!this.active) throw new Error('Activate Type A first');
    try { return await this.transceiveActive(apdu,timeoutUs); }
    catch(e) { this.active=false; throw e; }
  }
  async transceiveActive(apdu, timeoutUs) {
    let response;
    for (let off=0; off<apdu.length; off+=this.miu) {
      const more = off+this.miu<apdu.length;
      const frame = [0x02|this.bn|(more?0x10:0),...apdu.slice(off,off+this.miu)];
      for (let tries=0;;tries++) {
        response = await this.exchange(frame,timeoutUs);
        const pcb=response[0];
        if ((pcb&0xFE)===0xB2 || (pcb&0xFE)===0xA2) {
          if (more && (pcb&0xFE)===0xA2 && (pcb&1)===this.bn) { this.bn^=1; break; }
          if (tries>=2 || (pcb&1)!==(this.bn^1)) throw new Error('Unexpected ISO-DEP R-block');
          continue;
        }
        if (more || (pcb&0xEE)!==2 || (pcb&1)!==this.bn) throw new Error('Unexpected ISO-DEP I-block');
        this.bn^=1; break;
      }
    }
    const result=[];
    for (let count=0;;count++) {
      if (count>1024) throw new Error('ISO-DEP response chain too long');
      result.push(...response.slice(1));
      if (!(response[0]&0x10)) return result;
      response = await this.exchange([0xA2|this.bn],timeoutUs);
      if ((response[0]&0xEE)!==2 || (response[0]&1)!==this.bn) throw new Error('Invalid chained response');
      this.bn^=1;
    }
  }
}
if (typeof module !== 'undefined') module.exports = Rcs380;
