# Tab Tape v0.1 implementation contract

All extension files are directly loadable; plain ES modules, no dependencies or bundler. Chrome 116+ MV3. UI language Simplified Chinese. Project confined to tab-tape/.

## UI → service worker

`chrome.runtime.sendMessage({target: 'background', type, ...fields})` returns `{ok:true, ...result}` or `{ok:false,error:string}`.

- GET_STATE `{includeRecordings?:boolean}` → `{state, recordings?}`
- START `{tabId:number}` → `{state}` (popup obtains active tab ID with chrome.tabs.query)
- STOP → `{state}` (finishes local recording; user downloads separately)
- EXPORT `{id:string,format:'float32'|'pcm24'}` → `{downloadId}`
- DELETE `{id:string}` → `{}` (UI asks confirmation, disabled for active item)

State: `{status:'idle'|'starting'|'recording'|'stopping'|'error',id:null|string,tabId:null|number,title:string,sampleRate:number,channels:2,frames:number,bytes:number,peaks:[number,number],error:null|string,warning:null|string}`. Duration is frames/sampleRate. Poll every 300ms; includeRecordings only initially, when status changes, or every 3 seconds. Recorded size cap: 1 GiB. Can start next take after idle/error. Recording target remains the original tab.

Record metadata: `{id,title,createdAt:number,sampleRate,channels:2,status:'recording'|'complete'|'interrupted',frames,bytes,error?:string}`. UI provides 32-bit float WAV default and 24-bit PCM WAV alternative, individual delete, recovery indication. No pause/edit/mic/server/cloud.

## Audio/data API (lib/recordings.js)

`createSession(metadata)`, `appendChunk(id,sequence,buffer)` (Float32 LE interleaved stereo; atomically update committed frames+bytes), `finishSession(id,status,error?)`, `listSessions()`, `getSession(id)`, `deleteSession(id)`, `recoverSessions(activeId=null)` (mark any other recording interrupted), `buildWavBlob(id,format='float32')` (reject active/zero-length, no lossy codecs). All async. Append returns updated metadata. Export valid RIFF WAV; float WAV includes fact chunk. List newest first. Reject > RIFF limits. Make pure helpers available in lib/wav.js for independent tests.

## AudioWorklet (audio/pcm-worklet.js)

Register name `pcm-recorder`. Node configured `{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],channelCount:2,channelCountMode:'explicit'}`. Output is silence (separate source→destination monitoring path). Receives `{type:'start'}` then captures; receives `{type:'stop'}` flushes final partial chunk before `{type:'stopped'}`. Posts `{type:'chunk',buffer:ArrayBuffer,frames:number,peaks:[L,R]}` with transferable interleaved Float32 bytes. 4096-frame chunks. Missing channels duplicate mono; missing input captures silence after start. Ignore further input after stop. Root orchestrator persists chunks and monitors queue.
