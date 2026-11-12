const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(){
  let Processor;const messages=[];
  class Base{constructor(){this.port={onmessage:null,postMessage(message){messages.push(message);}};}}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/client/worklets/assistant-capture.js'),'utf8'),{
    AudioWorkletProcessor:Base,Float32Array,currentTime:0,sampleRate:16000,
    registerProcessor(name,processor){assert.equal(name,'cartoteca-assistant-capture-v1');Processor=processor;},
  });
  const processor=new Processor();
  return {processor,messages,run(samples){const output=new Float32Array(samples.length).fill(1);
    const active=processor.process([[samples]],[[output]]);assert.ok(output.every(value=>value===0));return active;},
    ack(){processor.port.onmessage({data:{type:'ack'}});}};
}
test('variable render quanta preserve every mono sample in original 512-frame batches and emit silence',()=>{
  const f=fixture(),samples=Float32Array.from({length:1024},(_,i)=>i/1024);
  f.run(samples.subarray(0,257));assert.equal(f.messages.length,0);
  f.run(samples.subarray(257,700));assert.equal(f.messages.length,1);
  f.run(samples.subarray(700));assert.equal(f.messages.length,2);
  assert.deepEqual(f.messages.flatMap(message=>Array.from(message.samples)),Array.from(samples));
  assert.ok(f.messages.every(message=>message.type==='pcm'&&Number.isFinite(message.time)));
});
test('transport bounds queued PCM and stops on overflow instead of silently losing speech',()=>{
  const f=fixture();for(let i=0;i<32;i++)assert.equal(f.run(new Float32Array(512)),true);
  assert.equal(f.run(new Float32Array(512)),false);
  assert.equal(f.messages.length,33);assert.equal(f.messages[32].type,'overflow');
  assert.equal(f.processor.active,false);assert.ok(f.processor.frame.every(value=>value===0));
});
test('acknowledgements allow continued capture and stop clears the partial frame',()=>{
  const f=fixture();for(let i=0;i<64;i++){assert.equal(f.run(new Float32Array(512)),true);f.ack();}
  f.run(new Float32Array(20).fill(.2));f.processor.port.onmessage({data:{type:'stop'}});
  assert.equal(f.processor.offset,0);assert.equal(f.run(new Float32Array(512)),false);
  assert.equal(f.messages.length,64);assert.ok(f.processor.frame.every(value=>value===0));
});
