const test=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http');
const {serveStatic}=require('../src/server/http/static-files.cjs');
const {secureRequest}=require('../src/server/http/security.cjs');
const {clientRelease}=require('../src/server/http/client-release.cjs');
const {publicRoot}=require('./helpers/interface-assets.cjs');
test('real Chromium loads the protected AudioWorklet under production CSP and transfers synthetic PCM',
 {skip:process.env.CARTOTECA_WORKLET_BROWSER!=='1'},async t=>{
  const version=await clientRelease(publicRoot);
  const script=`document.querySelector('button').addEventListener('click',async()=>{
    let context,source,node;
    try{
      context=new AudioContext({sampleRate:16000});
      await context.audioWorklet.addModule('/assistant-capture-worklet.js?v=${version}');
      node=new AudioWorkletNode(context,'cartoteca-assistant-capture-v1',{
        channelCount:1,channelCountMode:'explicit',numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
      const frames=[];
      const result=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('No PCM from audio worklet')),5000);
        node.onprocessorerror=()=>{clearTimeout(timer);reject(Error('Processor error'));};
        node.port.onmessage=({data})=>{
          node.port.postMessage({type:'ack'});frames.push(data);
          if(frames.length===2){clearTimeout(timer);resolve({frames:frames.map(frame=>({
            type:frame.type,length:frame.samples.length,time:frame.time,
            voiced:frame.samples.some(value=>Math.abs(value)>.005)}))});}
        };
      });
      source=context.createOscillator();source.frequency.value=440;
      source.connect(node);node.connect(context.destination);source.start();
      await context.resume();window.probeResult=await result;
    }catch(error){window.probeResult={error:error.message};}
    finally{source?.stop();source?.disconnect();node?.disconnect();node?.port.close();await context?.close();}
  });`;
  const server=http.createServer(async(req,res)=>{
    try{
      secureRequest(req,res,'');const url=new URL(req.url,'http://'+req.headers.host);
      if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html'});
        return res.end('<!doctype html><button>Run synthetic audio</button><script src="/probe.js"></script>');}
      if(url.pathname==='/probe.js'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(script);}
      if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
      await serveStatic(req,res,url,req.headers.cookie==='synthetic=1'?{}:null,publicRoot);
    }catch(error){res.writeHead(error.status||500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  for(const method of ['GET','HEAD']){
    assert.equal((await fetch(base+'/assistant-capture-worklet.js?v='+version,{method})).status,401);
    const current=await fetch(base+'/assistant-capture-worklet.js?v='+version,{method,headers:{Cookie:'synthetic=1'}});
    assert.equal(current.status,200);assert.equal(current.headers.get('cache-control'),'private, max-age=31536000, immutable');
    assert.equal((await fetch(base+'/assistant-capture-worklet.js?v=stale',{method,headers:{Cookie:'synthetic=1'}})).status,409);
  }
  const {chromium}=require('playwright'),browser=await chromium.launch({headless:true,...(process.env.CARTOTECA_CHROMIUM_CHANNEL?{channel:process.env.CARTOTECA_CHROMIUM_CHANNEL}:{})});
  t.after(()=>browser.close());const context=await browser.newContext();
  await context.addCookies([{name:'synthetic',value:'1',url:base}]);const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto(base);await page.locator('button').click();
  await page.waitForFunction(()=>Boolean(window.probeResult),{},{timeout:10000});
  const result=await page.evaluate(()=>window.probeResult);assert.equal(result.error,undefined);
  assert.equal(result.frames.length,2);
  for(const frame of result.frames){assert.equal(frame.type,'pcm');assert.equal(frame.length,512);assert.equal(frame.voiced,true);}
  assert.ok(result.frames[1].time>result.frames[0].time);assert.deepEqual(errors,[]);
});
