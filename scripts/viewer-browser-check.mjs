// Headless acceptance harness: all Discord identity/RPC is mocked; supply a local
// video-only test MP4 matching the 205-second fixture. Never uses a browser profile.
const { createViewerServer } = await import(new URL('../dist/apps/viewer-server/src/server.js', import.meta.url));
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const [videoFile, mode = 'integration'] = process.argv.slice(2);
if (!videoFile || !['integration', 'desktop', 'mobile'].includes(mode)) throw new Error('Usage: node scripts/viewer-browser-check.mjs <205-second-video-only.mp4> [integration|desktop|mobile]');
const port = mode === 'mobile' ? 19095 : 19094, origin = 'http://127.0.0.1:' + port;
const bytes = await readFile(videoFile);
const privateUrl = 'https://r1---fixture.googlevideo.com/videoplayback?expire=' + Math.floor(Date.now()/1000+3600);
let entry = randomUUID(), position = 5000, changedAt = Date.now(), playback = 'playing', report;
const state = () => ({serverTime:Date.now(),voiceChannelId:'30000001',runId:'test',waitingForYoutube:playback==='waiting',track:['ended','waiting'].includes(playback)?null:{entryId:entry,videoId:'2I3PLVuKNtw',title:'Sastanàqqàm',artist:'Tinariwen',durationMs:205000,positionMs:position+(playback==='playing'?Date.now()-changedAt:0),observedAt:Date.now(),state:playback}});
const fetcher = async (url,options={}) => {
 if(String(url).endsWith('/oauth2/token'))return Response.json({access_token:'fixture-access',expires_in:3600,scope:'identify'});
 if(String(url).endsWith('/users/@me'))return Response.json({id:'20000001'});
 if(String(url)!==privateUrl)throw new Error('Unexpected test request');
 const range = new Headers(options.headers).get('range');
 const match=/^bytes=(\d*)-(\d*)$/.exec(range??'');
 const start=match&&match[1]?Number(match[1]):0, end=match&&match[2]?Math.min(bytes.length-1,Number(match[2])):bytes.length-1;
 return new Response(options.method==='HEAD'?null:bytes.subarray(start,end+1),{status:range?206:200,headers:{'Content-Type':'video/mp4','Content-Length':String(end-start+1),...(range?{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}:{})}});
};
const server=createViewerServer({clientId:'12345678',clientSecret:'fixture-client-secret',publicOrigin:origin,socketPath:'unused',assetsDir:new URL('../dist/viewer/', import.meta.url).pathname,bridge:async path=>path==='/state'?state():{id:'2I3PLVuKNtw',url:privateUrl,height:720,codec:'avc1',durationMs:205000,expiresAt:Date.now()+3600000},fetcher});
const handlers=server.listeners('request');server.removeAllListeners('request');
const parentScript=`
const frame=document.querySelector('iframe');let closed=false;const wait=ms=>new Promise(r=>setTimeout(r,ms));
window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||!Array.isArray(event.data))return;const [op,data]=event.data;
 const reply=payload=>event.source.postMessage([1,payload],location.origin);
 if(op===0)reply({cmd:'DISPATCH',evt:'READY',nonce:null,data:{v:1,config:{api_endpoint:'//discord.com/api',environment:'production'}}});
 if(op===2){closed=true;return;}
 if(op===1){let payload={};if(data.cmd==='AUTHORIZE')payload={code:'fixture-code-'+Date.now()};
 if(data.cmd==='AUTHENTICATE')payload={access_token:'fixture-access',user:{id:'20000001',username:'Fixture',discriminator:'0',public_flags:0},scopes:['identify'],expires:'2030-01-01T00:00:00Z',application:{id:'12345678',description:'Fixture',name:'MusicMaid'}};
 reply({cmd:data.cmd,evt:null,nonce:data.nonce,data:payload});}
});
if(new URLSearchParams(location.search).get('mode')==='integration'){
 (async()=>{const checks={};try{
 let video;for(let n=0;n<80;n++){await wait(200);video=frame.contentDocument?.querySelector('video');if(video?.readyState>=2&&!video.paused)break;}
 checks.playing=Boolean(video&&video.readyState>=2&&!video.paused);checks.width=video?.videoWidth;checks.muted=video?.muted;checks.initialPosition=video?.currentTime;
 await fetch('/_test/change?step=pause');await wait(2000);checks.paused=video.paused;
 await fetch('/_test/change?step=seek');await wait(2000);checks.seek=Math.abs(video.currentTime-27000/1000)<1.5;
 await fetch('/_test/change?step=next');await wait(3000);checks.nextYoutubeStayedOpen=!closed&&!video.paused&&video.currentTime<7;
 await fetch('/_test/change?step=gap');await wait(2000);checks.waitsThroughOtherSource=!closed&&video.paused;
 await fetch('/_test/change?step=next');await wait(3000);checks.resumesLaterYoutube=!closed&&!video.paused;
 await fetch('/_test/change?step=end');await wait(3000);checks.closedAfterYoutubeRun=closed;
 }catch(e){checks.error=String(e);}await fetch('/_test/report',{method:'POST',body:JSON.stringify(checks)});})();
}
`;
server.on('request',async(req,res)=>{
 const url=new URL(req.url,origin);
 if(url.pathname==='/_test/')return res.writeHead(200,{'Content-Type':'text/html'}).end(`<!doctype html><html><body style="margin:0;background:#10100f"><iframe style="border:0;width:100vw;height:100vh" allow="autoplay;fullscreen" src="/?frame_id=fixture&instance_id=fixture&platform=desktop&guild_id=10000001&channel_id=30000001"></iframe><img style="position:absolute;width:1px;height:1px;opacity:0" src="/_test/wait"><script src="/_test/test.js"></script></body></html>`);
 if(url.pathname==='/_test/test.js')return res.writeHead(200,{'Content-Type':'text/javascript'}).end(parentScript);
 if(url.pathname==='/_test/wait'){setTimeout(()=>res.writeHead(200,{'Content-Type':'image/png'}).end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=','base64')),mode==='integration'?28000:6500);return;}
 if(url.pathname==='/_test/change'){
 const step=url.searchParams.get('step');if(step==='pause'){position=state().track.positionMs;playback='paused';}if(step==='seek')position=27000;if(step==='next'){entry=randomUUID();position=0;playback='playing';}if(step==='end')playback='ended';if(step==='gap')playback='waiting';changedAt=Date.now();return res.writeHead(200).end('ok');
 }
 if(url.pathname==='/_test/report'){let data='';for await(const chunk of req)data+=chunk;report=JSON.parse(data);return res.writeHead(200).end('ok');}
 for(const handler of handlers)handler.call(server,req,res);
});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
const profile=await mkdtemp('/tmp/musicmaid-firefox-');
await writeFile(profile+'/user.js','user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("datareporting.policy.dataSubmissionEnabled", false);\nuser_pref("network.proxy.type", 0);\n');
const screenshot='/tmp/musicmaid-browser-fixture-'+mode+'.png';
const browser=spawn('/usr/bin/firefox',['--headless','--no-remote','--profile',profile,'--window-size',mode==='mobile'?'390,844':'1280,900','--screenshot',screenshot,origin+'/_test/?mode='+mode],{stdio:['ignore','pipe','pipe'],env:{...process.env,MOZ_HEADLESS:'1'}});
let browserErrors='';browser.stderr.on('data',chunk=>browserErrors+=chunk.toString());
const timeout=setTimeout(()=>browser.kill('SIGTERM'),45000);
const exit=await new Promise(resolve=>browser.on('exit',resolve));clearTimeout(timeout);
server.closeAllConnections();server.close();
console.log(JSON.stringify({mode,exit,report,screenshot,browserError:exit?browserErrors.slice(-500):undefined}));
if(mode==='integration'&&(!report?.playing||!report?.paused||!report?.seek||!report?.nextYoutubeStayedOpen||!report?.closedAfterYoutubeRun||!report?.waitsThroughOtherSource||!report?.resumesLaterYoutube))process.exitCode=1;
